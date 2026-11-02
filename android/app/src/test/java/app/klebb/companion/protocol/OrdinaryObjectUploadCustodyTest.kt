// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.cert.Certificate
import java.time.Instant
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Invented original wire vectors exercise paired transport, not Room or native collection. */
class OrdinaryObjectUploadCustodyTest {
    private val protocol = SharedWire.protocol()
    private val bank = SharedWire.read("durable-history-independent-vectors.json")
    private val large = bank["largeRecord"].objectValue()
    private val assembled = (SharedWire.read("object-protocol-v1.json")["cases"] as List<*>)
        .map { it.objectValue() }.single { it["id"] == "assembled original large record inclusive" }
    private val declaration = assembled["declaration"].objectValue()
    private val binding = declaration["binding"].objectValue()
    private val expectedDigest =
        "sha256:45ee44258c3e7f0491bc4e9ebdc2effe4df5e97ba50beb8fcfdef90ba51460e5"
    private val partSizes = listOf(524288L, 524288L, 1296L)
    private val partDigests = listOf(
        "sha256:383522fa7578e3dc7ed188a95a1189abd4f9df432ce8a5c77a4ac575919d8131",
        "sha256:def7e95362758e28519425841fed896629bd07e36ef22198b0f33211caeb6be5",
        "sha256:0f8b17aa801af6bdafed5aeb38e686948a6ebbfd8d478ed156e8341ebceb6840")
    private val originalPayload: ByteArray by lazy {
        val construction = assembled["construction"].objectValue()
        (construction["prefix"] as String + "P".repeat(1048704) +
            construction["suffix"] as String).toByteArray(Charsets.UTF_8)
    }
    private fun digest(bytes: ByteArray) = "sha256:" +
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun bytes(value: JsonObject) = ControlJson.text(value).toByteArray(Charsets.UTF_8)
    private fun originalWire(id: String) =
        (SharedWire.read("authority-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.single { it["id"] == id }["wire"] as String
    private fun installPairing(session: InMemoryPairingSession) {
        val grant = StrictJson.parse(originalWire("approved-grant").toByteArray()).objectValue() +
            binding.filterKeys {
                it in setOf("tenantId", "instanceId", "sourceStoreId", "restoreEpoch")
            } + ("categories" to listOf("BodyWaterMassRecord"))
        session.prepareGrant(bytes(grant))
        val paired = StrictJson.parse(originalWire("paired").toByteArray()).objectValue() +
            binding.filterKeys { it != "generation" } + mapOf(
                "categories" to listOf("BodyWaterMassRecord"),
                "streams" to mapOf("BodyWaterMassRecord" to mapOf(
                    "generation" to "1", "acknowledgedSequence" to "0")))
        session.acceptPairing(session.beginExchange(), bytes(paired))
    }
    private fun paired() = InMemoryPairingSession(protocol,
        { Instant.parse("2026-10-28T03:55:00Z") }, { binding["installationId"] as String }).also {
        it.approveDestination("https://health.example.test")
        installPairing(it)
    }
    private fun part(index: Int): ByteArray {
        val start = partSizes.take(index).sum().toInt()
        return originalPayload.copyOfRange(start, start + partSizes[index].toInt())
    }
    private fun partFrame(index: Int): JsonObject = linkedMapOf(
        "version" to 1L, "kind" to "object-part") + declaration + linkedMapOf(
        "partIndex" to index.toLong(), "partBase64" to Base64.getEncoder().encodeToString(part(index)),
        "partDigest" to partDigests[index])
    private fun partReceipt(index: Int): JsonObject = linkedMapOf(
        "version" to 1L, "kind" to "object-part-receipt") + declaration + linkedMapOf(
        "partIndex" to index.toLong(), "partDigest" to partDigests[index],
        "partBytes" to partSizes[index])
    private fun finaliseFrame(): JsonObject = linkedMapOf(
        "version" to 1L, "kind" to "object-finalise") + declaration +
        ("parts" to large["manifest"])
    private fun durableReceipt() = large["expectedReceipt"].objectValue()
    private fun upload(session: InMemoryPairingSession, finalise: Boolean,
        transport: PairingTransport, wire: ByteArray): HealthFrame =
        if (finalise) session.uploadObjectFinalise(transport, wire)
        else session.uploadObjectPart(transport, wire)
    private fun frame(finalise: Boolean) = if (finalise) finaliseFrame() else partFrame(0)
    private fun receipt(finalise: Boolean) = if (finalise) durableReceipt() else partReceipt(0)

    private class ReplyProbe(answer: ByteArray, status: Int = 200,
        destination: String = "https://health.example.test", atOpen: () -> Unit = {},
        atReply: () -> Unit = {}, lostReply: Boolean = false) {
        val sent = ByteArrayOutputStream()
        var opens = 0
        var path: String? = null
        var method: String? = null
        var headers: Map<String, List<String>> = emptyMap()
        val transport = PairingTransport(ApprovedOrigin.parse(destination)) { url ->
            opens++
            path = url.path
            atOpen()
            object : HttpsURLConnection(url) {
                override fun connect() {}
                override fun disconnect() {}
                override fun usingProxy() = false
                override fun getCipherSuite() = "TLS_TEST"
                override fun getLocalCertificates(): Array<Certificate>? = null
                override fun getServerCertificates(): Array<Certificate> = emptyArray()
                override fun getOutputStream() = sent
                override fun getResponseCode(): Int {
                    this@ReplyProbe.method = requestMethod
                    headers = requestProperties.mapValues { it.value.toList() }
                    atReply()
                    return status
                }
                override fun getInputStream(): ByteArrayInputStream {
                    if (lostReply) throw ProtocolException("timeout")
                    return ByteArrayInputStream(answer)
                }
                override fun getErrorStream() = ByteArrayInputStream(answer)
            }
        }
    }
    private fun expect(code: String, action: () -> Unit) =
        assertEquals(code, assertThrows(ProtocolException::class.java) { action() }.code)
    private fun assertRoute(probe: ReplyProbe, path: String, original: ByteArray) {
        assertEquals(1, probe.opens)
        assertEquals("/api/connectors/health-connect/v1/$path", probe.path)
        assertEquals("POST", probe.method)
        assertEquals(listOf("1"), probe.headers["Klebb-Health-Protocol"])
        assertEquals(listOf("1"), probe.headers["Klebb-Health-Generation"])
        assertEquals(listOf(binding["restoreEpoch"]), probe.headers["Klebb-Health-Restore-Epoch"])
        assertEquals(listOf("Bearer klebb_hc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            probe.headers["Authorization"])
        assertArrayEquals(original, probe.sent.toByteArray())
    }
    private fun verifyLiteralFixture() {
        assertEquals(1049872, originalPayload.size)
        assertEquals(expectedDigest, digest(originalPayload))
        assertEquals(expectedDigest, declaration["objectDigest"])
        assertEquals(1049872L, declaration["totalBytes"])
        assertEquals(3L, declaration["partCount"])
        assertEquals(partSizes, (large["manifest"] as List<*>).map {
            it.objectValue()["bytes"]
        })
        assertEquals(partDigests, (large["manifest"] as List<*>).map {
            it.objectValue()["digest"]
        })
        for (index in partSizes.indices) assertEquals(partDigests[index], digest(part(index)))
        assertEquals("0", large["expectedBeforeFinalise"].objectValue()["frontier"])
        assertEquals("1", large["expectedAfterFinalise"].objectValue()["frontier"])
    }
    private fun ordinaryHealthyControl() {
        val cases = SharedWire.read("durable-receipt-v1.json")["cases"] as List<*>
        val initial = cases.map { it.objectValue() }.single { it["id"] == "initial-raw-only" }
        val wire = bytes(linkedMapOf("version" to 1L, "kind" to "batch",
            "payloadJson" to initial["payloadJson"],
            "payloadDigest" to "sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf"))
        val expected = initial["expectedReceipt"].objectValue()
        val probe = ReplyProbe(bytes(expected))
        assertEquals(expected, paired().uploadBatch(probe.transport, wire).fields)
        assertRoute(probe, "batches", wire)
    }
    /** Positive object admission runs first; receipt attacks cannot pass through an early refusal. */
    private fun objectHealthyControl() {
        ordinaryHealthyControl()
        verifyLiteralFixture()
        val session = paired()
        for (index in partSizes.indices) {
            val wire = bytes(partFrame(index))
            val expected = partReceipt(index)
            val probe = ReplyProbe(bytes(expected))
            val accepted = upload(session, false, probe.transport, wire)
            assertEquals("object-part-receipt", accepted.kind)
            assertEquals(expected, accepted.fields)
            assertEquals("0", session.batchScope("BodyWaterMassRecord").acknowledgedSequence)
            assertRoute(probe, "object-parts", wire)
        }
        val wire = bytes(finaliseFrame())
        val probe = ReplyProbe(bytes(durableReceipt()))
        val accepted = upload(session, true, probe.transport, wire)
        assertEquals("durable-receipt", accepted.kind)
        assertEquals(durableReceipt(), accepted.fields)
        assertEquals("1", accepted.fields["sequence"])
        assertEquals(expectedDigest, accepted.fields["payloadDigest"])
        assertRoute(probe, "object-finalise", wire)
        // No queue or Cloud frontier is implemented by this transport fixture.
    }

    @Test fun originalLargePartsAndFinaliseUseExactPairedObjectRoutes() {
        objectHealthyControl()
    }
    @Test fun partReceiptMustMatchEveryBindingField() {
        objectHealthyControl()
        for (key in listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "generation", "restoreEpoch")) {
            val foreign = binding + (key to if (key == "generation") "2" else "foreign-field")
            val session = paired()
            expect("binding-mismatch") {
                upload(session, false, ReplyProbe(bytes(partReceipt(0) + ("binding" to foreign))).transport,
                    bytes(partFrame(0)))
            }
            expect("not-paired") { session.capabilityRequest() }
        }
    }
    @Test fun partReceiptMustMatchTheWholeDeclarationAndPart() {
        objectHealthyControl()
        val expected = partReceipt(0)
        val mutations = listOf(
            expected + ("sequence" to "2"),
            expected + ("batchId" to "another-batch"),
            expected + ("objectId" to "another-object"),
            expected + ("identity" to (declaration["identity"].objectValue() + ("nativeRecordId" to "another-record"))),
            expected + ("partCount" to 2L),
            expected + ("totalBytes" to 1049873L),
            expected + ("partIndex" to 1L),
            expected + ("partBytes" to 524287L))
        for (changed in mutations) {
            val session = paired()
            expect("binding-mismatch") {
                upload(session, false, ReplyProbe(bytes(changed)).transport, bytes(partFrame(0)))
            }
            expect("not-paired") { session.capabilityRequest() }
        }
        for (key in listOf("objectDigest", "partDigest")) {
            expect("digest-mismatch") {
                upload(paired(), false, ReplyProbe(bytes(expected + (key to "sha256:" + "0".repeat(64)))).transport,
                    bytes(partFrame(0)))
            }
        }
    }
    @Test fun partReceiptCannotAcknowledgeAnOrdinaryBatchOrFinalise() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val wrong = if (finalise) partReceipt(0) else durableReceipt()
            expect("binding-mismatch") {
                upload(paired(), finalise, ReplyProbe(bytes(wrong)).transport, bytes(frame(finalise)))
            }
        }
        val initial = (SharedWire.read("durable-receipt-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.single { it["id"] == "initial-raw-only" }
        expect("binding-mismatch") {
            paired().uploadBatch(ReplyProbe(bytes(partReceipt(0))).transport, bytes(linkedMapOf(
                "version" to 1L, "kind" to "batch", "payloadJson" to initial["payloadJson"],
                "payloadDigest" to "sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf")))
        }
    }
    @Test fun finaliseReceiptMustMatchEveryBindingFieldAndCompletePayloadDigest() {
        objectHealthyControl()
        for (key in listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "generation", "restoreEpoch")) {
            val foreign = binding + (key to if (key == "generation") "2" else "foreign-field")
            expect("binding-mismatch") {
                upload(paired(), true, ReplyProbe(bytes(durableReceipt() + ("binding" to foreign))).transport,
                    bytes(finaliseFrame()))
            }
        }
        for (wrong in listOf(durableReceipt() + ("sequence" to "2"),
            durableReceipt() + ("batchId" to "another-batch"))) {
            expect("binding-mismatch") {
                upload(paired(), true, ReplyProbe(bytes(wrong)).transport, bytes(finaliseFrame()))
            }
        }
        expect("digest-mismatch") {
            upload(paired(), true, ReplyProbe(bytes(durableReceipt() +
                ("payloadDigest" to "sha256:" + "0".repeat(64)))).transport, bytes(finaliseFrame()))
        }
    }
    @Test fun wrongTypeMalformedVersionAndUnknownReceiptFieldsCannotAccept() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val original = receipt(finalise)
            val foreign = original + ("recordType" to "WeightRecord")
            expect("scope-denied") {
                upload(paired(), finalise, ReplyProbe(bytes(foreign)).transport, bytes(frame(finalise)))
            }
            expect("unsupported-version") {
                upload(paired(), finalise, ReplyProbe(bytes(original + ("version" to 2L))).transport,
                    bytes(frame(finalise)))
            }
            expect("invalid-message") {
                upload(paired(), finalise, ReplyProbe(bytes(original + ("unknown" to "refuse"))).transport,
                    bytes(frame(finalise)))
            }
            expect("invalid-message") {
                upload(paired(), finalise, ReplyProbe("{\"version\":".toByteArray()).transport,
                    bytes(frame(finalise)))
            }
        }
    }
    @Test fun failedHttpAndRevokedAuthorityKeepTheirExactRefusals() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            expect("request-refused") {
                upload(paired(), finalise, ReplyProbe(bytes(receipt(finalise)), status = 503).transport,
                    bytes(frame(finalise)))
            }
            val session = paired()
            expect("revoked") {
                upload(session, finalise, ReplyProbe(
                    """{"version":1,"kind":"error","code":"revoked","retryable":false}""".toByteArray(),
                    status = 401).transport, bytes(frame(finalise)))
            }
            expect("not-paired") { session.capabilityRequest() }
        }
    }
    @Test fun foreignOutgoingBindingOrDestinationNeverOpensAConnection() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val session = paired()
            val probe = ReplyProbe(bytes(receipt(finalise)),
                atOpen = { throw AssertionError("foreign binding transmitted") })
            val foreign = frame(finalise) + ("binding" to (binding + ("installationId" to "foreign-install")))
            expect("binding-mismatch") { upload(session, finalise, probe.transport, bytes(foreign)) }
            assertEquals(0, probe.opens)
            assertEquals("BodyWaterMassRecord", session.statusRequest("BodyWaterMassRecord").recordType)
            val destination = ReplyProbe(bytes(receipt(finalise)), destination = "https://other.example.test",
                atOpen = { throw AssertionError("foreign destination opened") })
            expect("invalid-destination") {
                upload(paired(), finalise, destination.transport, bytes(frame(finalise)))
            }
            assertEquals(0, destination.opens)
        }
    }
    @Test fun malformedOutgoingPartsAndManifestsRefuseBeforeTransmission() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val wrongKind = ReplyProbe(bytes(receipt(finalise)))
            expect("invalid-message") {
                upload(paired(), finalise, wrongKind.transport, bytes(frame(!finalise)))
            }
            assertEquals(0, wrongKind.opens)
        }
        val partProbe = ReplyProbe(bytes(partReceipt(0)))
        expect("digest-mismatch") {
            upload(paired(), false, partProbe.transport,
                bytes(partFrame(0) + ("partDigest" to "sha256:" + "0".repeat(64))))
        }
        assertEquals(0, partProbe.opens)
        val finalProbe = ReplyProbe(bytes(durableReceipt()))
        expect("invalid-message") {
            upload(paired(), true, finalProbe.transport,
                bytes(finaliseFrame() + ("parts" to (large["manifest"] as List<*>).reversed())))
        }
        assertEquals(0, finalProbe.opens)
    }
    @Test fun callerMutationCannotChangeTheValidatedObjectUploadSnapshot() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val original = bytes(frame(finalise))
            val retained = original.copyOf()
            val probe = ReplyProbe(bytes(receipt(finalise)), atOpen = { original.fill(0) })
            assertEquals(receipt(finalise), upload(paired(), finalise, probe.transport, original).fields)
            assertRoute(probe, if (finalise) "object-finalise" else "object-parts", retained)
            assertTrue(original.all { it == 0.toByte() })
        }
    }
    @Test fun lostReplyLeavesCallerWireIdenticalForTheFreshPairedRetry() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val original = bytes(frame(finalise))
            val retained = original.copyOf()
            val session = paired()
            val lost = ReplyProbe(bytes(receipt(finalise)), lostReply = true)
            expect("timeout") { upload(session, finalise, lost.transport, original) }
            expect("not-paired") { session.capabilityRequest() }
            assertArrayEquals(retained, original)
            assertArrayEquals(retained, lost.sent.toByteArray())
            val retry = ReplyProbe(bytes(receipt(finalise)))
            assertEquals(receipt(finalise), upload(paired(), finalise, retry.transport, original).fields)
            assertArrayEquals(retained, retry.sent.toByteArray())
        }
    }
    @Test fun stopBeforeWriteAndDuringReplyPreventsLateObjectAcceptance() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val before = paired()
            val beforeProbe = ReplyProbe(bytes(receipt(finalise)), atOpen = { before.clear() })
            expect("cancelled") { upload(before, finalise, beforeProbe.transport, bytes(frame(finalise))) }
            assertArrayEquals(byteArrayOf(), beforeProbe.sent.toByteArray())
            val during = paired()
            expect("cancelled") {
                upload(during, finalise, ReplyProbe(bytes(receipt(finalise)),
                    atReply = { during.clear() }).transport, bytes(frame(finalise)))
            }
        }
    }
    @Test fun obsoleteObjectUploadCannotClearAReplacementPairing() {
        objectHealthyControl()
        for (finalise in listOf(false, true)) {
            val session = paired()
            expect("cancelled") {
                upload(session, finalise, ReplyProbe(bytes(receipt(finalise)), atOpen = {
                    session.approveDestination("https://health.example.test")
                    installPairing(session)
                }).transport, bytes(frame(finalise)))
            }
            assertEquals("BodyWaterMassRecord", session.statusRequest("BodyWaterMassRecord").recordType)
        }
    }
}
