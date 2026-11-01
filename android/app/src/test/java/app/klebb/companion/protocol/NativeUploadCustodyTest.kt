// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.cert.Certificate
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Synthetic wire/connection answers exercise custody; they do not prove native collection. */
class NativeUploadCustodyTest {
    private val protocol = SharedWire.protocol()
    private val vectors = SharedWire.read("durable-receipt-v1.json")
    private val binding = vectors["binding"].objectValue()
    private fun vector(id: String) = (vectors["cases"] as List<*>)
        .map { it.objectValue() }.first { it["id"] == id }
    private fun originalWire(id: String) = (SharedWire.read("authority-v1.json")["cases"] as List<*>)
        .map { it.objectValue() }.first { it["id"] == id }["wire"] as String
    private fun paired(): InMemoryPairingSession {
        val session = InMemoryPairingSession(protocol,
            { Instant.parse("2026-10-28T03:55:00Z") }, { binding["installationId"] as String })
        session.approveDestination("https://health.example.test")
        val grant = StrictJson.parse(originalWire("approved-grant").toByteArray()).objectValue() +
            binding.filterKeys { it in setOf("tenantId", "instanceId", "sourceStoreId", "restoreEpoch") } +
            ("categories" to listOf("BodyWaterMassRecord"))
        session.prepareGrant(ControlJson.text(grant).toByteArray())
        val paired = StrictJson.parse(originalWire("paired").toByteArray()).objectValue() +
            binding.filterKeys { it != "generation" } + mapOf(
                "categories" to listOf("BodyWaterMassRecord"),
                "streams" to mapOf("BodyWaterMassRecord" to mapOf(
                    "generation" to "1", "acknowledgedSequence" to "0")))
        session.acceptPairing(session.beginExchange(), ControlJson.text(paired).toByteArray())
        return session
    }
    private fun batch(payload: String = vector("initial-raw-only")["payloadJson"] as String,
        digest: String = "sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf") =
        ControlJson.text(mapOf("version" to 1L, "kind" to "batch", "payloadJson" to payload,
            "payloadDigest" to digest)).toByteArray()
    private fun receipt() = vector("initial-raw-only")["expectedReceipt"].objectValue()
    private fun wire(value: JsonObject) = ControlJson.text(value).toByteArray()
    private class Reply(url: URL, private val status: Int, private val bytes: ByteArray,
        val delivered: ByteArrayOutputStream, private val atReply: () -> Unit) : HttpsURLConnection(url) {
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getCipherSuite() = "TLS_TEST"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getOutputStream() = delivered
        override fun getResponseCode(): Int { atReply(); return status }
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getErrorStream() = ByteArrayInputStream(bytes)
    }
    private fun transport(response: ByteArray, status: Int = 200,
        delivered: ByteArrayOutputStream = ByteArrayOutputStream(),
        origin: String = "https://health.example.test", atOpen: () -> Unit = {},
        atReply: () -> Unit = {}) = PairingTransport(ApprovedOrigin.parse(origin)) { url ->
            atOpen()
            Reply(url, status, response, delivered, atReply)
        }
    private fun expect(code: String, action: () -> Unit) =
        assertEquals(code, assertThrows(ProtocolException::class.java) { action() }.code)

    @Test fun originalProtocolAndPairingAreHealthyBaselines() {
        assertEquals("durable-receipt", protocol.decode(wire(receipt())).kind)
        assertEquals("BodyWaterMassRecord", paired().statusRequest("BodyWaterMassRecord").recordType)
        assertEquals("sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf",
            protocol.payloadDigest(vector("initial-raw-only")["payloadJson"] as String))
    }
    @Test fun exactDurableReceiptAcceptsOnlyTheOriginalUploadedBytes() {
        val sent = ByteArrayOutputStream()
        val bytes = batch()
        val result = paired().uploadBatch(transport(wire(receipt()), delivered = sent), bytes)
        assertEquals(receipt(), result.fields)
        assertArrayEquals(bytes, sent.toByteArray())
    }
    @Test fun everyForeignBindingFieldRefusesPageAcceptance() {
        for (key in listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "generation", "restoreEpoch")) {
            val foreign = binding + (key to if (key == "generation") "2" else "foreign-field")
            val session = paired()
            expect("binding-mismatch") {
                session.uploadBatch(transport(wire(receipt() + ("binding" to foreign))), batch())
            }
            expect("not-paired") { session.capabilityRequest() }
        }
    }
    @Test fun sameSequenceWithChangedImmutableDigestCannotAcceptThePage() {
        val session = paired()
        expect("digest-mismatch") {
            session.uploadBatch(transport((vector("changed-digest-same-sequence")["wire"] as String).toByteArray()), batch())
        }
        expect("not-paired") { session.capabilityRequest() }
    }
    @Test fun anotherSequenceOrBatchCannotAcknowledgeThisRequest() {
        for (wrong in listOf(receipt() + ("sequence" to "2"), receipt() + ("batchId" to "another-batch"))) {
            expect("binding-mismatch") { paired().uploadBatch(transport(wire(wrong)), batch()) }
        }
    }
    @Test fun anotherRecordTypeCannotAcknowledgeThisPage() {
        expect("scope-denied") {
            paired().uploadBatch(transport(wire(receipt() + ("recordType" to "WeightRecord"))), batch())
        }
    }
    @Test fun statusFrontierIsNotTheBatchReceipt() {
        val status = mapOf("version" to 1L, "kind" to "stream-status", "binding" to binding,
            "recordType" to "BodyWaterMassRecord", "generation" to "1", "acknowledgedSequence" to "1")
        expect("binding-mismatch") { paired().uploadBatch(transport(wire(status)), batch()) }
    }
    @Test fun failedHttpCannotTurnMatchingReceiptBytesIntoAcceptance() {
        expect("request-refused") { paired().uploadBatch(transport(wire(receipt()), 503), batch()) }
    }
    @Test fun nativeCredentialRevocationKeepsItsExactRefusal() {
        val session = paired()
        val revoked = """{"version":1,"kind":"error","code":"revoked","retryable":false}""".toByteArray()
        expect("revoked") { session.uploadBatch(transport(revoked, 401), batch()) }
        expect("not-paired") { session.capabilityRequest() }
    }
    @Test fun malformedReplyCannotAcknowledgeAndRetainPairing() {
        val session = paired()
        expect("invalid-message") { session.uploadBatch(transport("{\"version\":".toByteArray()), batch()) }
        expect("not-paired") { session.capabilityRequest() }
    }
    @Test fun stopDuringReplyPreventsLateDurableAcceptance() {
        val session = paired()
        expect("cancelled") {
            session.uploadBatch(transport(wire(receipt()), atReply = { session.clear() }), batch())
        }
    }
    @Test fun stopBeforeConnectionWriteKeepsHealthPayloadUndelivered() {
        val session = paired()
        val sent = ByteArrayOutputStream()
        expect("cancelled") {
            session.uploadBatch(transport(wire(receipt()), delivered = sent, atOpen = { session.clear() }), batch())
        }
        assertArrayEquals(byteArrayOf(), sent.toByteArray())
    }
    @Test fun anotherOriginCannotReceiveApprovedPayloadOrCredential() {
        val sent = ByteArrayOutputStream()
        expect("invalid-destination") {
            paired().uploadBatch(transport(wire(receipt()), delivered = sent,
                origin = "https://other.example.test", atOpen = { throw AssertionError("foreign origin opened") }), batch())
        }
        assertArrayEquals(byteArrayOf(), sent.toByteArray())
    }
    @Test fun foreignOutgoingBindingRefusesBeforeTransmissionWithoutLosingLegitimatePairing() {
        val payload = StrictJson.parse((vector("initial-raw-only")["payloadJson"] as String).toByteArray()).objectValue()
        val foreignPayload = ControlJson.text(payload + ("binding" to (binding + ("installationId" to "foreign-install"))))
        val session = paired()
        expect("binding-mismatch") {
            session.uploadBatch(transport(wire(receipt()), atOpen = { throw AssertionError("invalid batch sent") }),
                batch(foreignPayload, protocol.payloadDigest(foreignPayload)))
        }
        assertEquals("BodyWaterMassRecord", session.statusRequest("BodyWaterMassRecord").recordType)
    }
    @Test fun lostTransportReplyDoesNotInventAckOrRollback() {
        val session = paired()
        expect("timeout") {
            session.uploadBatch(PairingTransport(ApprovedOrigin.parse("https://health.example.test")) {
                throw ProtocolException("timeout")
            }, batch())
        }
        expect("not-paired") { session.capabilityRequest() }
    }
    @Test fun mutableCallerBytesCannotChangeTheValidatedUploadSnapshot() {
        val original = batch()
        val expected = original.copyOf()
        val sent = ByteArrayOutputStream()
        val result = paired().uploadBatch(transport(wire(receipt()), delivered = sent,
            atOpen = { original.fill(0) }), original)
        assertEquals(receipt(), result.fields)
        assertArrayEquals(expected, sent.toByteArray())
    }

    private fun installPinnedReplacementPairing(session: InMemoryPairingSession) {
        val grant = StrictJson.parse(originalWire("approved-grant").toByteArray()).objectValue() +
            binding.filterKeys {
                it in setOf("tenantId", "instanceId", "sourceStoreId", "restoreEpoch")
            } + ("categories" to listOf("BodyWaterMassRecord"))
        session.prepareGrant(ControlJson.text(grant).toByteArray())
        val response = StrictJson.parse(originalWire("paired").toByteArray()).objectValue() +
            binding.filterKeys { it != "generation" } + mapOf(
                "categories" to listOf("BodyWaterMassRecord"),
                "streams" to mapOf("BodyWaterMassRecord" to mapOf(
                    "generation" to "1", "acknowledgedSequence" to "0")))
        session.acceptPairing(session.beginExchange(), ControlJson.text(response).toByteArray())
    }

    @Test fun cancelledOldUploadCannotClearReplacementPairing() {
        val session = paired()
        expect("cancelled") {
            session.uploadBatch(transport(wire(receipt()), atOpen = {
                session.approveDestination("https://health.example.test")
                installPinnedReplacementPairing(session)
            }), batch())
        }
        assertEquals("BodyWaterMassRecord",
            session.statusRequest("BodyWaterMassRecord").recordType)
    }
}
