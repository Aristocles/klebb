// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class InMemoryPairingSessionTest {
    private fun wire(id: String): ByteArray =
        (SharedWire.read("authority-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.first { it["id"] == id }["wire"].let { (it as String).toByteArray() }
    private fun session() = InMemoryPairingSession(SharedWire.protocol(),
        { Instant.parse("2026-10-28T03:55:00Z") }, { "install-a" }).also {
        it.approveDestination("https://health.example.test")
    }
    private fun paired(): InMemoryPairingSession = session().also {
        it.prepareGrant(wire("approved-grant"))
        it.acceptPairing(it.beginExchange(), wire("paired"))
    }

    @Test
    fun lifecycleClearPreventsFurtherCredentialRequests() {
        val session = paired()
        val request = session.capabilityRequest()
        session.clear()
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
        assertEquals(null, session.destination)
        assertEquals(emptySet<String>(), session.categories)
        assertEquals(emptyMap<String, String>(), request.headers)
    }

    @Test
    fun lateExchangeReplyCannotRestoreAuthorityAfterClear() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        session.clear()
        assertEquals("cancelled", assertThrows(ProtocolException::class.java) {
            session.acceptPairing(attempt, wire("paired"))
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }

    @Test
    fun serverRevocationClearsCredentialAndPendingAuthority() {
        val session = paired()
        val request = session.capabilityRequest()
        assertEquals("revoked", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request,
                """{"version":1,"kind":"error","code":"revoked","retryable":false}""".toByteArray())
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }

    @Test
    fun unapprovedDestinationAndExpiredGrantRefuseBeforeExchange() {
        val session = InMemoryPairingSession(SharedWire.protocol(),
            { Instant.parse("2026-10-28T04:00:00.000000001Z") }, { "install-a" })
        session.approveDestination("https://health.example.test")
        assertEquals("expired-grant", assertThrows(ProtocolException::class.java) {
            session.prepareGrant(wire("approved-grant"))
        }.code)
        session.approveDestination("https://elsewhere.example.test")
        assertEquals("invalid-destination", assertThrows(ProtocolException::class.java) {
            session.prepareGrant(wire("approved-grant"))
        }.code)
    }

    @Test
    fun exchangeBodyEchoesApprovedNamespaceAndCannotBeRenderedAsAuthority() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        val body = StrictJson.parse(attempt.body).objectValue()
        assertEquals("store-a", body["sourceStoreId"])
        assertEquals("install-a", body["installationId"])
        assertEquals(listOf("StepsRecord"), body["categories"])
        assertFalse(attempt.toString().contains("AAAAAAAA"))
        session.acceptPairing(attempt, wire("paired"))
        val request = session.statusRequest("StepsRecord")
        assertEquals("7", request.headers["Klebb-Health-Generation"])
        assertEquals("epoch-a", request.headers["Klebb-Health-Restore-Epoch"])
        assertEquals("1", request.headers["Klebb-Health-Protocol"])
        assertFalse(request.toString().contains("klebb_hc1_"))
        assertFalse(session.toString().contains("klebb_hc1_"))
    }

    @Test
    fun lateStatusReplyCannotRestoreAStoppedSession() {
        val session = paired()
        val request = session.statusRequest("StepsRecord")
        session.clear()
        assertEquals("cancelled", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request, wire("stream-status"))
        }.code)
        assertEquals(emptyMap<String, String>(), request.headers)
    }

    @Test
    fun failedHttpExchangeCannotInstallAnOtherwiseValidCredential() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        assertEquals("request-refused", assertThrows(ProtocolException::class.java) {
            session.acceptPairing(attempt, wire("paired"), 503)
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
        org.junit.Assert.assertTrue(attempt.body.all { it == 0.toByte() })
    }

    @Test
    fun capabilityReplyFromAnotherConnectorCannotRetainAuthority() {
        val session = paired()
        val request = session.capabilityRequest()
        val actual = StrictJson.parse(wire("connector-capabilities")).objectValue()
        val wrongConnector = ControlJson.text(actual + ("connectorId" to "another-connector")).toByteArray()
        assertEquals("binding-mismatch", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request, wrongConnector)
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }

    @Test
    fun firstOrdinaryPageUsesOneAuthenticatedBeginAndBoundCompleteForBothTypes() {
        for (type in listOf("WeightRecord", "StepsRecord")) firstPageHappyPath(type, "1", false)
    }

    @Test
    fun emptyFirstPageCanCompleteWithoutPretendingHistoryOrAcknowledgement() {
        for (type in listOf("WeightRecord", "StepsRecord")) firstPageHappyPath(type, "0", true)
    }

    @Test
    fun fiveMinuteFirstPageChallengeAcceptsClientOneSecondBehindServer() {
        val serverNow = Instant.parse("2026-10-28T03:55:00Z")
        val clientNow = Instant.parse("2026-10-28T03:54:59Z")
        assertEquals(serverNow, clientNow.plusSeconds(1))
        assertEquals(Instant.parse("2026-10-28T04:00:00Z"), serverNow.plusSeconds(300))
        val client = InMemoryPairingSession(SharedWire.protocol(), { clientNow }, { "install-a" }).also {
            it.approveDestination("https://health.example.test")
        }
        val saved = MemoryPairingPersistence()
        client.attachPersistence(saved)
        firstPageHappyPath("WeightRecord", "1", false, client)
        val restored = InMemoryPairingSession(SharedWire.protocol(), { clientNow }, { "install-a" })
        restored.restoreDurableState(checkNotNull(saved.saved))
        assertEquals("enabled", checkNotNull(restored.readinessCompleted("WeightRecord"))["sharing"])
        assertEquals("5", restored.batchScope("WeightRecord").binding["generation"])
        assertEquals("7", restored.batchScope("StepsRecord").binding["generation"])
    }

    @Test
    fun selectedStopRetiresPendingBeginAndOnlyItsOwnedRequests() {
        val session = pairedForStop()
        val challenge = beginWeightForStop(session)
        val weight = session.batchScope("WeightRecord")
        val sibling = session.batchScope("StepsRecord")
        val weightRequest = session.statusRequest("WeightRecord")
        val siblingRequest = session.statusRequest("StepsRecord")
        val stop = session.stopCategory("WeightRecord")
        assertEquals(weight.binding, stop.binding)
        assertEquals("0", stop.acknowledgedSequence)
        org.junit.Assert.assertSame(challenge, stop.challenge)
        org.junit.Assert.assertSame(stop, session.localCategoryStop("WeightRecord"))
        assertEquals(setOf("WeightRecord"), session.stoppedCategories())
        assertFalse(session.isCurrentBatchScope(weight))
        assertFalse(session.isCurrentFirstPage(challenge))
        assertEquals(null, session.firstPageChallenge("WeightRecord"))
        assertEquals(null, session.readinessCompleted("WeightRecord"))
        assertEquals(emptyMap<String, String>(), weightRequest.headers)
        assertEquals("7", siblingRequest.headers["Klebb-Health-Generation"])
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        assertEquals("category-stopped", assertThrows(ProtocolException::class.java) {
            session.batchScope("WeightRecord")
        }.code)
        assertEquals("readiness-unverified", assertThrows(ProtocolException::class.java) {
            session.completeFirstPage(stopTransport(emptyList()), challenge, emptyMap())
        }.code)
        session.cancelOwnedRequest(siblingRequest)

        val nextBinding = stop.binding + ("generation" to "6")
        val replies = listOf(stopResult(stop.binding, "11"), stopResult(nextBinding, "12"))
        val connections = mutableListOf<FirstPageReply>()
        val accepted = session.confirmCategoryStop(stopTransport(replies, connections), stop)
        assertEquals(nextBinding, accepted["binding"])
        assertEquals("12", accepted["policyRevision"])
        assertEquals("stopped", accepted["sharing"])
        assertEquals("unverified", accepted["verification"])
        assertEquals(setOf("version", "kind", "recordType", "binding", "policyRevision",
            "sharing", "verification"), accepted.keys)
        assertEquals(accepted, session.confirmedCategoryStop(stop))
        org.junit.Assert.assertTrue(session.isCurrentLocalStop(stop))
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        val bodies = connections.map { StrictJson.parse(it.sent.toByteArray()).objectValue() }
        assertEquals(listOf("readiness-status", "readiness-stop"), bodies.map { it["kind"] })
        assertEquals(setOf("version", "kind", "recordType", "binding"), bodies[0].keys)
        assertEquals(stop.binding, bodies[0]["binding"])
        assertEquals(setOf("version", "kind", "recordType", "binding", "policyRevision"), bodies[1].keys)
        assertEquals(stop.binding, bodies[1]["binding"])
        assertEquals("11", bodies[1]["policyRevision"])
        for (body in bodies) {
            assertEquals(2L, body["version"])
            assertEquals("WeightRecord", body["recordType"])
        }
        for (connection in connections) {
            assertEquals("/api/connectors/health-connect/v2/streams/WeightRecord/readiness", connection.url.path)
            assertEquals("POST", connection.requestMethod)
            assertEquals("2", connection.getRequestProperty("Klebb-Health-Protocol"))
            assertEquals("Bearer ${StrictJson.parse(wire("paired")).objectValue()["credential"]}",
                connection.getRequestProperty("Authorization"))
        }

        val completed = pairedForStop()
        val completedChallenge = beginWeightForStop(completed)
        val completedSibling = completed.batchScope("StepsRecord")
        val facts: JsonObject = linkedMapOf("localReadRevision" to "1", "recordCount" to "0",
            "terminalPage" to true, "permissionFingerprintStart" to "sha256:" + "a".repeat(64),
            "permissionFingerprintEnd" to "sha256:" + "a".repeat(64), "tokenValid" to true,
            "historyWindowLimited" to true, "interveningChangeCount" to "0", "changesHaveMore" to false)
        completed.completeFirstPage(stopTransport(listOf(stopResult(completedChallenge.binding, "12") +
            mapOf("sharing" to "enabled", "verification" to "authenticated-companion-report"))),
            completedChallenge, facts)
        org.junit.Assert.assertNotNull(completed.readinessCompleted("WeightRecord"))
        completed.stopCategory("WeightRecord")
        assertEquals(null, completed.readinessCompleted("WeightRecord"))
        assertFalse(completed.isCurrentFirstPage(completedChallenge))
        org.junit.Assert.assertTrue(completed.isCurrentBatchScope(completedSibling))
    }

    @Test
    fun uncertainStopCannotBeConfirmedOrRestoreSelectedAuthority() {
        val session = pairedForStop()
        val sink = MemoryPairingPersistence()
        session.attachPersistence(sink)
        val sibling = session.batchScope("StepsRecord")
        val stop = session.stopCategory("WeightRecord")
        val replies = listOf(stopResult(stop.binding, "10"), linkedMapOf(
            "version" to 2L, "kind" to "error", "code" to "policy-revision-stale", "retryable" to false))
        assertEquals("policy-revision-stale", assertThrows(ProtocolException::class.java) {
            session.confirmCategoryStop(stopTransport(replies), stop)
        }.code)
        assertEquals(null, session.confirmedCategoryStop(stop))
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        val restored = emptyRestoredSession(checkNotNull(sink.saved))
        val restoredStop = checkNotNull(restored.localCategoryStop("WeightRecord"))
        assertEquals(null, restored.confirmedCategoryStop(restoredStop))
        assertEquals(setOf("WeightRecord"), restored.stoppedCategories())
        assertEquals("category-stopped", assertThrows(ProtocolException::class.java) {
            restored.batchScope("WeightRecord")
        }.code)
        assertEquals("category-stopped", assertThrows(ProtocolException::class.java) {
            restored.beginFirstPage(stopTransport(emptyList()), "WeightRecord", weightStopScope())
        }.code)
        assertEquals("7", restored.batchScope("StepsRecord").binding["generation"])
    }

    @Test
    fun durableStopAndLaterTransitionRestoreActualBindingsWithoutCrossGenerationAckOrdering() {
        val session = pairedForStop()
        val sink = MemoryPairingPersistence()
        session.attachPersistence(sink)
        val challenge = beginWeightForStop(session)
        val stop = session.stopCategory("WeightRecord")
        val stoppedBinding = stop.binding + ("generation" to "6")
        val stopped = session.confirmCategoryStop(stopTransport(listOf(
            stopResult(stop.binding, "11"), stopResult(stoppedBinding, "12"))), stop)
        val restored = emptyRestoredSession(checkNotNull(sink.saved))
        val restoredStop = checkNotNull(restored.localCategoryStop("WeightRecord"))
        assertFalse(restored.isCurrentLocalStop(stop))
        assertEquals(stop.binding, restoredStop.binding)
        assertEquals("0", restoredStop.acknowledgedSequence)
        assertEquals(challenge.binding, restoredStop.challenge!!.binding)
        assertEquals(stopped, restored.confirmedCategoryStop(restoredStop))
        assertEquals("7", restored.batchScope("StepsRecord").binding["generation"])

        // Decoder fixture only: this does not counterfeit a live queue-issued purge receipt.
        // The actual reenableFirstPage/Room proof path belongs to the instrumented join test.
        val state = StrictJson.parse(checkNotNull(sink.saved)).objectValue().toMutableMap()
        val freshBinding = stoppedBinding + ("generation" to "7")
        val fresh = linkedMapOf<String, Any?>(
            "version" to 2L, "kind" to "readiness-challenge", "recordType" to "WeightRecord",
            "binding" to freshBinding, "policyRevision" to "13",
            "queryJson" to challenge.queryJson, "filterDigest" to challenge.filterDigest,
            "acknowledgedSequence" to "0", "readinessId" to "hc_ready_" + "R".repeat(43),
            "expiresAt" to "2026-10-28T04:00:00.000Z")
        state["streams"] = mapOf("WeightRecord" to mapOf("binding" to freshBinding,
            "acknowledgedSequence" to "0"))
        state["challenges"] = mapOf("WeightRecord" to fresh)
        state["completed"] = emptyMap<String, Any?>()
        state["blocked"] = emptyList<String>()
        state["stops"] = emptyMap<String, Any?>()
        state["transitions"] = mapOf("WeightRecord" to mapOf("status" to stopped, "response" to fresh))
        val later = emptyRestoredSession(ControlJson.text(state).toByteArray())
        assertEquals(freshBinding, later.batchScope("WeightRecord").binding)
        assertEquals("0", later.batchScope("WeightRecord").acknowledgedSequence)
        org.junit.Assert.assertTrue(later.isCurrentFirstPage(checkNotNull(later.firstPageChallenge("WeightRecord"))))
        assertEquals("7", later.batchScope("StepsRecord").binding["generation"])
        assertEquals(emptySet<String>(), later.stoppedCategories())
    }

    @Test
    fun lostBeginRecoversActualSelectedGenerationBeforeStopWithoutChangingPurgeOwner() {
        val session = pairedForStop()
        val before = session.batchScope("WeightRecord")
        val sibling = session.batchScope("StepsRecord")
        assertThrows(Exception::class.java) {
            session.beginFirstPage(lostSecondReadinessTransport(stopResult(before.binding, "10")),
                "WeightRecord", weightStopScope())
        }
        val stop = session.stopCategory("WeightRecord")
        val recoveredBinding = before.binding + ("generation" to "5")
        val stoppedBinding = before.binding + ("generation" to "6")
        val connections = mutableListOf<FirstPageReply>()
        val accepted = session.confirmCategoryStop(stopTransport(listOf(capabilitiesForStop("5"),
            stopResult(recoveredBinding, "11"), stopResult(stoppedBinding, "12")), connections), stop)
        assertEquals(before.binding, stop.binding)
        assertEquals("10", stop.acknowledgedSequence)
        assertEquals(null, stop.challenge)
        assertEquals(stoppedBinding, accepted["binding"])
        assertEquals(accepted, session.confirmedCategoryStop(stop))
        assertEquals(3, connections.size)
        assertEquals("GET", connections[0].requestMethod)
        assertEquals("/api/connectors/health-connect/v1/capabilities", connections[0].url.path)
        assertEquals("1", connections[0].getRequestProperty("Klebb-Health-Protocol"))
        assertEquals("Bearer ${StrictJson.parse(wire("paired")).objectValue()["credential"]}",
            connections[0].getRequestProperty("Authorization"))
        assertEquals(0, connections[0].sent.size())
        val posts = connections.drop(1).map { StrictJson.parse(it.sent.toByteArray()).objectValue() }
        assertEquals(listOf("readiness-status", "readiness-stop"), posts.map { it["kind"] })
        assertEquals(recoveredBinding, posts[0]["binding"])
        assertEquals(recoveredBinding, posts[1]["binding"])
        assertEquals("11", posts[1]["policyRevision"])
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        assertEquals("7", session.batchScope("StepsRecord").binding["generation"])
        assertEquals("category-stopped", assertThrows(ProtocolException::class.java) {
            session.batchScope("WeightRecord")
        }.code)
    }

    @Test
    fun lostStopResponseRestoresFenceAndRecoversBeforeAnotherStop() {
        val session = pairedForStop()
        val sink = MemoryPairingPersistence()
        session.attachPersistence(sink)
        val stop = session.stopCategory("WeightRecord")
        assertThrows(Exception::class.java) {
            session.confirmCategoryStop(lostSecondReadinessTransport(stopResult(stop.binding, "10")), stop)
        }
        val restored = emptyRestoredSession(checkNotNull(sink.saved))
        val restoredStop = checkNotNull(restored.localCategoryStop("WeightRecord"))
        assertEquals(null, restored.confirmedCategoryStop(restoredStop))
        val actual = restoredStop.binding + ("generation" to "5")
        val stopped = restoredStop.binding + ("generation" to "6")
        val connections = mutableListOf<FirstPageReply>()
        val accepted = restored.confirmCategoryStop(stopTransport(listOf(capabilitiesForStop("5"),
            stopResult(actual, "11"), stopResult(stopped, "12")), connections), restoredStop)
        assertEquals("4", restoredStop.binding["generation"])
        assertEquals("10", restoredStop.acknowledgedSequence)
        assertEquals(stopped, accepted["binding"])
        assertEquals("12", accepted["policyRevision"])
        assertEquals("GET", connections.first().requestMethod)
        assertEquals("7", restored.batchScope("StepsRecord").binding["generation"])
        assertEquals(null, restored.firstPageChallenge("WeightRecord"))
    }

    @Test
    fun uncertainStopRefusesForeignOrIncompleteCapabilitiesBeforeAnyReadinessPost() {
        val actual = capabilitiesForStop("5")
        val forged = listOf(
            actual + ("sourceStoreId" to "other-store"),
            actual + ("destination" to "https://elsewhere.example.test"),
            actual + ("connectorId" to "other-connector"),
            actual + ("categories" to listOf("WeightRecord")),
            actual + ("streams" to mapOf("WeightRecord" to
                mapOf("generation" to "5", "acknowledgedSequence" to "0"))),
            actual + ("kind" to "stream-status"))
        for (frame in forged) {
            val session = pairedForStop()
            val before = session.batchScope("WeightRecord")
            val sibling = session.batchScope("StepsRecord")
            assertThrows(Exception::class.java) {
                session.beginFirstPage(lostSecondReadinessTransport(stopResult(before.binding, "10")),
                    "WeightRecord", weightStopScope())
            }
            val stop = session.stopCategory("WeightRecord")
            val connections = mutableListOf<FirstPageReply>()
            assertThrows(ProtocolException::class.java) {
                session.confirmCategoryStop(stopTransport(listOf(frame), connections), stop)
            }
            assertEquals(1, connections.size)
            assertEquals("GET", connections.single().requestMethod)
            assertEquals("/api/connectors/health-connect/v1/capabilities", connections.single().url.path)
            assertEquals(null, session.confirmedCategoryStop(stop))
            assertEquals(before.binding, stop.binding)
            org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        }
    }

    /** Authenticated wire decoder fixture only; no server state or native facts are attested. */
    private fun capabilitiesForStop(generation: String): JsonObject =
        StrictJson.parse(wire("connector-capabilities")).objectValue() + mapOf(
            "categories" to listOf("WeightRecord", "StepsRecord"),
            "streams" to linkedMapOf(
                "WeightRecord" to linkedMapOf("generation" to generation, "acknowledgedSequence" to "0"),
                "StepsRecord" to linkedMapOf("generation" to "7", "acknowledgedSequence" to "3")))

    private fun lostSecondReadinessTransport(status: JsonObject): PairingTransport {
        var opened = 0
        return PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            when (++opened) {
                1 -> FirstPageReply(url, ControlJson.text(status))
                2 -> LostReadinessReply(url)
                else -> throw AssertionError("Unexpected additional readiness request")
            }
        }
    }

    /** Activates the synthetic missing-response fault after the real transport writes its POST. */
    private class LostReadinessReply(url: java.net.URL) : javax.net.ssl.HttpsURLConnection(url) {
        private val sent = java.io.ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getResponseCode() = 200
        override fun getInputStream(): java.io.InputStream {
            assertEquals("POST", requestMethod)
            org.junit.Assert.assertTrue("Fixture fault must follow an outgoing body", sent.size() > 0)
            throw java.io.IOException("Synthetic lost readiness response")
        }
        override fun getOutputStream(): java.io.OutputStream = sent
        override fun getCipherSuite() = "test"
        override fun getLocalCertificates(): Array<java.security.cert.Certificate>? = null
        override fun getServerCertificates(): Array<java.security.cert.Certificate> = emptyArray()
    }

    private fun pairedForStop(): InMemoryPairingSession = session().also { session ->
        val types = listOf("WeightRecord", "StepsRecord")
        val grant = StrictJson.parse(wire("approved-grant")).objectValue() + ("categories" to types)
        val paired = StrictJson.parse(wire("paired")).objectValue() + mapOf("categories" to types,
            "streams" to linkedMapOf(
                "WeightRecord" to linkedMapOf("generation" to "4", "acknowledgedSequence" to "10"),
                "StepsRecord" to linkedMapOf("generation" to "7", "acknowledgedSequence" to "3")))
        session.prepareGrant(ControlJson.text(grant).toByteArray())
        session.acceptPairing(session.beginExchange(), ControlJson.text(paired).toByteArray())
    }

    private fun weightStopScope() = app.klebb.companion.sync.WeightReadScope(
        Instant.parse("2001-02-03T00:00:00Z"), Instant.parse("2001-02-04T00:00:00Z"), 2)

    private fun beginWeightForStop(session: InMemoryPairingSession): NativeFirstPageChallenge {
        val binding = session.batchScope("WeightRecord").binding
        val query = "{\"recordType\":\"WeightRecord\",\"window\":{\"start\":\"2001-02-03T00:00:00.000Z\",\"end\":\"2001-02-04T00:00:00.000Z\"},\"pageSize\":2}"
        val replies = listOf(stopResult(binding, "10"), linkedMapOf(
            "version" to 2L, "kind" to "readiness-challenge", "recordType" to "WeightRecord",
            "binding" to (binding + ("generation" to "5")), "policyRevision" to "11",
            "queryJson" to query, "filterDigest" to SharedWire.protocol().payloadDigest(query),
            "acknowledgedSequence" to "0", "readinessId" to "hc_ready_" + "Q".repeat(43),
            "expiresAt" to "2026-10-28T04:00:00.000Z"))
        return session.beginFirstPage(stopTransport(replies), "WeightRecord", weightStopScope())
    }

    private fun stopResult(binding: Map<String, String>, revision: String): JsonObject = linkedMapOf(
        "version" to 2L, "kind" to "readiness-result", "recordType" to "WeightRecord",
        "binding" to binding, "policyRevision" to revision, "sharing" to "stopped", "verification" to "unverified")

    private fun stopTransport(replies: List<JsonObject>,
        connections: MutableList<FirstPageReply> = mutableListOf()) =
        PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            FirstPageReply(url, ControlJson.text(replies[connections.size])).also { connections.add(it) }
        }

    private fun emptyRestoredSession(bytes: ByteArray) =
        InMemoryPairingSession(SharedWire.protocol(), { Instant.parse("2026-10-28T03:55:00Z") },
            { "install-a" }).also { it.restoreDurableState(bytes) }

    /** Plain unit memory checkpoint; not Android encrypted storage or native attestation. */
    private class MemoryPairingPersistence : PairingSessionPersistence {
        override val owner = Any()
        var saved: ByteArray? = null
        override fun checkCurrent() {}
        override fun save(state: ByteArray?) { saved = state?.copyOf() }
        override fun forget() { saved = null }
    }

    /** Session wire only: these invented report facts do not attest an SDK read or Room commit. */
    private fun firstPageHappyPath(type: String, count: String, terminal: Boolean,
        selectedSession: InMemoryPairingSession = session()) {
        val session = selectedSession
        val types = listOf("WeightRecord", "StepsRecord")
        val grant = StrictJson.parse(wire("approved-grant")).objectValue() + ("categories" to types)
        val paired = StrictJson.parse(wire("paired")).objectValue() + mapOf(
            "categories" to types,
            "streams" to linkedMapOf(
                "WeightRecord" to linkedMapOf("generation" to "4", "acknowledgedSequence" to "0"),
                "StepsRecord" to linkedMapOf("generation" to "7", "acknowledgedSequence" to "0")))
        session.prepareGrant(ControlJson.text(grant).toByteArray())
        session.acceptPairing(session.beginExchange(), ControlJson.text(paired).toByteArray())
        val old = session.batchScope(type)
        val sibling = session.batchScope(types.single { it != type })
        val scope = if (type == "WeightRecord") app.klebb.companion.sync.WeightReadScope(
            Instant.parse("2001-02-03T00:00:00Z"), Instant.parse("2001-02-04T00:00:00Z"), 2)
        else app.klebb.companion.sync.WeightReadScope(
            Instant.parse("2001-10-28T00:00:00Z"), Instant.parse("2001-10-29T00:00:00Z"), 2)
        val query = if (type == "WeightRecord")
            "{\"recordType\":\"WeightRecord\",\"window\":{\"start\":\"2001-02-03T00:00:00.000Z\",\"end\":\"2001-02-04T00:00:00.000Z\"},\"pageSize\":2}"
        else "{\"recordType\":\"StepsRecord\",\"window\":{\"start\":\"2001-10-28T00:00:00.000Z\",\"end\":\"2001-10-29T00:00:00.000Z\"},\"pageSize\":2}"
        val generation = if (type == "WeightRecord") "5" else "8"
        val binding = old.binding + ("generation" to generation)
        fun result(selected: Map<String, String>, revision: String, enabled: Boolean): JsonObject = linkedMapOf(
            "version" to 2L, "kind" to "readiness-result", "recordType" to type,
            "binding" to selected, "policyRevision" to revision,
            "sharing" to if (enabled) "enabled" else "stopped",
            "verification" to if (enabled) "authenticated-companion-report" else "unverified")
        val replies: List<JsonObject> = listOf(result(old.binding, "10", false), linkedMapOf(
            "version" to 2L, "kind" to "readiness-challenge", "readinessId" to "hc_ready_" + "Q".repeat(43),
            "recordType" to type, "binding" to binding, "policyRevision" to "11",
            "queryJson" to query, "filterDigest" to SharedWire.protocol().payloadDigest(query),
            "acknowledgedSequence" to "0", "expiresAt" to "2026-10-28T04:00:00.000Z"),
            result(binding, "12", true))
        val connections = mutableListOf<FirstPageReply>()
        val transport = PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            FirstPageReply(url, ControlJson.text(replies[connections.size])).also { connections.add(it) }
        }
        val challenge = session.beginFirstPage(transport, type, scope)
        assertEquals(binding, challenge.binding)
        assertEquals("11", challenge.policyRevision)
        assertEquals("0", challenge.acknowledgedSequence)
        org.junit.Assert.assertTrue(session.isCurrentFirstPage(challenge))
        assertFalse(session.isCurrentBatchScope(old))
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        val facts: JsonObject = linkedMapOf(
            "localReadRevision" to "1", "recordCount" to count, "terminalPage" to terminal,
            "permissionFingerprintStart" to "sha256:" + "a".repeat(64),
            "permissionFingerprintEnd" to "sha256:" + "a".repeat(64), "tokenValid" to true,
            "historyWindowLimited" to true, "interveningChangeCount" to "0", "changesHaveMore" to false)
        val accepted = session.completeFirstPage(transport, challenge, facts)
        assertEquals("enabled", accepted["sharing"])
        assertEquals("authenticated-companion-report", accepted["verification"])
        assertEquals("12", accepted["policyRevision"])
        assertEquals("0", session.batchScope(type).acknowledgedSequence)
        org.junit.Assert.assertTrue(session.isCurrentBatchScope(sibling))
        assertEquals(3, connections.size)
        val bodies = connections.map { StrictJson.parse(it.sent.toByteArray()).objectValue() }
        assertEquals(listOf("readiness-status", "readiness-begin", "readiness-complete"), bodies.map { it["kind"] })
        for (body in bodies) {
            assertEquals(2L, body["version"])
            assertEquals(type, body["recordType"])
        }
        assertEquals(setOf("version", "kind", "recordType", "binding"), bodies[0].keys)
        assertEquals(old.binding, bodies[0]["binding"])
        assertEquals(setOf("version", "kind", "recordType", "binding", "policyRevision", "queryJson",
            "filterDigest"), bodies[1].keys)
        assertEquals(old.binding, bodies[1]["binding"])
        assertEquals("10", bodies[1]["policyRevision"])
        assertEquals(query, bodies[1]["queryJson"])
        assertEquals(SharedWire.protocol().payloadDigest(query), bodies[1]["filterDigest"])
        assertEquals(setOf("version", "kind", "recordType", "readinessId", "binding", "policyRevision",
            "filterDigest", "firstPage"), bodies[2].keys)
        assertEquals(challenge.readinessId, bodies[2]["readinessId"])
        assertEquals(SharedWire.protocol().payloadDigest(query), bodies[2]["filterDigest"])
        assertEquals(binding, bodies[2]["binding"])
        assertEquals("11", bodies[2]["policyRevision"])
        assertEquals(facts, bodies[2]["firstPage"])
        for (connection in connections) {
            assertEquals("/api/connectors/health-connect/v2/streams/$type/readiness", connection.url.path)
            assertEquals("POST", connection.requestMethod)
            assertEquals("2", connection.getRequestProperty("Klebb-Health-Protocol"))
            assertEquals("Bearer ${paired["credential"]}", connection.getRequestProperty("Authorization"))
        }
    }

    private class FirstPageReply(url: java.net.URL, private val reply: String) :
        javax.net.ssl.HttpsURLConnection(url) {
        val sent = java.io.ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getResponseCode() = 200
        override fun getInputStream() = java.io.ByteArrayInputStream(reply.toByteArray())
        override fun getOutputStream(): java.io.OutputStream = sent
        override fun getCipherSuite() = "test"
        override fun getLocalCertificates(): Array<java.security.cert.Certificate>? = null
        override fun getServerCertificates(): Array<java.security.cert.Certificate> = emptyArray()
    }
}
