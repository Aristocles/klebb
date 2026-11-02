// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.HealthFrame
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.JsonObject
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import app.klebb.companion.protocol.SharedWire
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.protocol.objectValue
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueResult
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.MessageDigest
import java.security.cert.Certificate
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Upload admission and immutable wire custody. Prepared-page commits use the native Room fixture. */
class ImmutableBatchCoordinatorTest {
    private val protocol = SharedWire.protocol()
    private val vectors = SharedWire.read("durable-receipt-v1.json")
    private val binding = vectors["binding"].objectValue().mapValues { it.value as String }
    private val initial = "initial-raw-only"
    private val second = "second-delete-and-correction"
    private val spaced = "original-payload-trailing-space"
    private val digests = mapOf(
        initial to "sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf",
        second to "sha256:1353180f3457f77b2987d0a62ee7e7d66ba3faa756966ca16b87ffa3236d8d57",
        spaced to "sha256:a3216f4882a9d6ac61966caa5251a338cfcbac57d2c09115335eb958d983375b")
    private val wireHashes = mapOf(
        initial to "dfff664db43e256364c1ddf1ac99106f3978fcc99ddf82a3f3cf710154b84671",
        second to "11abea9894de7efb8ce02e2141fe325b6d4c95d868d2bc2995914175bf150275",
        spaced to "144242e246cfdd606303498968dd15db9adabd29fb8f2272f301f6a1345c90d9")

    private fun vector(id: String): JsonObject = (vectors["cases"] as List<*>)
        .map { it.objectValue() }.single { it["id"] == id }
    private fun originalAuthority(id: String): String =
        (SharedWire.read("authority-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.single { it["id"] == id }["wire"] as String
    private fun receipt(id: String): ByteArray =
        (vector(id)["wire"] as String).toByteArray(Charsets.UTF_8)
    private fun expectedReceipt(id: String): JsonObject = vector(id)["expectedReceipt"].objectValue()
    private fun batchWire(id: String): ByteArray {
        val text = vector(id)["payloadJson"] as String
        assertEquals(digests.getValue(id), protocol.payloadDigest(text))
        val bytes = ControlJson.text(linkedMapOf("version" to 1L, "kind" to "batch",
            "payloadJson" to text, "payloadDigest" to digests.getValue(id))).toByteArray(Charsets.UTF_8)
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        assertEquals(wireHashes.getValue(id), hash)
        return bytes
    }
    private fun owner(changes: Map<String, String> = emptyMap()) =
        BatchOwner("synthetic-ordinary-stream", "BodyWaterMassRecord", binding + changes, 7L)

    private fun paired(): InMemoryPairingSession {
        val session = InMemoryPairingSession(protocol,
            { Instant.parse("2026-10-28T03:55:00Z") }, { binding.getValue("installationId") })
        session.approveDestination("https://health.example.test")
        val grant = StrictJson.parse(originalAuthority("approved-grant").toByteArray(Charsets.UTF_8))
            .objectValue() + binding.filterKeys {
                it in setOf("tenantId", "instanceId", "sourceStoreId", "restoreEpoch")
            } + ("categories" to listOf("BodyWaterMassRecord"))
        session.prepareGrant(ControlJson.text(grant).toByteArray(Charsets.UTF_8))
        val response = StrictJson.parse(originalAuthority("paired").toByteArray(Charsets.UTF_8))
            .objectValue() + binding.filterKeys { it != "generation" } + mapOf(
                "categories" to listOf("BodyWaterMassRecord"),
                "streams" to mapOf("BodyWaterMassRecord" to mapOf(
                    "generation" to "1", "acknowledgedSequence" to "0")))
        session.acceptPairing(session.beginExchange(),
            ControlJson.text(response).toByteArray(Charsets.UTF_8))
        assertEquals("BodyWaterMassRecord", session.statusRequest("BodyWaterMassRecord").recordType)
        val scope = session.batchScope("BodyWaterMassRecord")
        assertTrue("Healthy paired scope must be current", session.isCurrentBatchScope(scope))
        return session
    }

    private data class StageCall(val owner: BatchOwner, val checkpoint: PreparedOrdinaryPage,
        val hasRecords: Boolean)
    private data class AckCall(val owner: BatchOwner, val batch: QueuedBatch, val receipt: HealthFrame)

    /** Predeclared answers and observations; no allocation, row deletion, frontier or purge logic. */
    private class ScriptedQueue(var pending: QueuedBatch?) : DurableBatchQueue {
        val stages = mutableListOf<StageCall>()
        val reads = mutableListOf<BatchOwner>()
        val acknowledgements = mutableListOf<AckCall>()
        override fun stagePage(owner: BatchOwner, checkpoint: PreparedOrdinaryPage, hasRecords: Boolean,
            currentGate: () -> ReadGate,
            makeBatch: (sequence: String, batchId: String) -> ByteArray): QueueResult<StageReceipt> {
            stages.add(StageCall(owner, checkpoint, hasRecords))
            throw AssertionError("Prepared-wire upload must not stage a page")
        }
        override fun nextPending(owner: BatchOwner,
            currentGate: () -> ReadGate): QueueResult<QueuedBatch?> {
            reads.add(owner)
            return Ok(pending)
        }
        override fun acknowledge(owner: BatchOwner, batch: QueuedBatch, receipt: HealthFrame,
            currentGate: () -> ReadGate): QueueResult<Unit> {
            acknowledgements.add(AckCall(owner, batch, receipt))
            return Ok(Unit)
        }
    }

    private class ReplyProbe(answer: ByteArray, lostReply: Boolean = false,
        atReply: () -> Unit = {}) {
        val sent = ByteArrayOutputStream()
        var opens = 0
        val transport = PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            opens++
            object : HttpsURLConnection(url) {
                override fun connect() {}
                override fun disconnect() {}
                override fun usingProxy() = false
                override fun getCipherSuite() = "TLS_TEST"
                override fun getLocalCertificates(): Array<Certificate>? = null
                override fun getServerCertificates(): Array<Certificate> = emptyArray()
                override fun getOutputStream() = sent
                override fun getResponseCode(): Int { atReply(); return 200 }
                override fun getInputStream(): ByteArrayInputStream {
                    if (lostReply) throw ProtocolException("timeout")
                    return ByteArrayInputStream(answer)
                }
                override fun getErrorStream() = ByteArrayInputStream(answer)
            }
        }
    }

    private fun accepted(result: QueueResult<Boolean>) {
        assertTrue("Healthy coordinator admission failed", result is Ok<*>)
        assertEquals(true, (result as Ok<*>).value)
    }
    private fun refused(result: QueueResult<*>) {
        assertTrue("Coordinator must refuse this operation", result is Blocked)
    }

    /** Each case calls this first: method ordering is not a prerequisite for a negative result. */
    private fun healthyControl() {
        assertEquals(expectedReceipt(initial), protocol.decode(receipt(initial)).fields)
        val bytes = batchWire(initial)
        val prepared = QueuedBatch(bytes)
        val queue = ScriptedQueue(prepared)
        val selected = owner()
        val session = paired()
        val coordinator = ImmutableBatchCoordinator(queue, protocol, session) { ReadGate.OPEN }
        assertEquals(0, queue.acknowledgements.size)
        val reply = ReplyProbe(receipt(initial))
        accepted(coordinator.uploadNext(selected, reply.transport))
        assertArrayEquals(bytes, reply.sent.toByteArray())
        assertEquals(1, reply.opens)
        assertEquals(1, queue.acknowledgements.size)
        val acknowledgedOwner = queue.acknowledgements.single().owner
        assertEquals(selected.localStreamId, acknowledgedOwner.localStreamId)
        assertEquals(selected.recordType, acknowledgedOwner.recordType)
        assertEquals(selected.binding, acknowledgedOwner.binding)
        assertEquals(selected.localFenceEpoch, acknowledgedOwner.localFenceEpoch)
        assertEquals(0, queue.stages.size)
        assertArrayEquals(bytes, queue.acknowledgements.single().batch.copyWire())
        assertEquals(expectedReceipt(initial), queue.acknowledgements.single().receipt.fields)
    }

    @Test fun preparedCompleteWireIsImmutableAcrossCallerAndReturnedCopies() {
        healthyControl()
        for (id in listOf(initial, second, spaced)) {
            val caller = batchWire(id)
            val original = caller.copyOf()
            val prepared = QueuedBatch(caller)
            caller.fill(0)
            prepared.copyWire().fill(0)
            assertArrayEquals(original, prepared.copyWire())
            val queue = ScriptedQueue(prepared)
            val reply = ReplyProbe(receipt(id))
            accepted(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner(), reply.transport))
            assertArrayEquals(original, reply.sent.toByteArray())
            assertArrayEquals(original, queue.acknowledgements.single().batch.copyWire())
            assertEquals(digests.getValue(id), queue.acknowledgements.single().receipt.fields["payloadDigest"])
        }
    }

    @Test fun lostReplyRetriesTheSamePreparedWireWithoutStageOrAcknowledgement() {
        healthyControl()
        val original = batchWire(spaced)
        val queue = ScriptedQueue(QueuedBatch(original))
        val lost = ReplyProbe(receipt(spaced), lostReply = true)
        refused(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
            .uploadNext(owner(), lost.transport))
        assertArrayEquals(original, lost.sent.toByteArray())
        assertArrayEquals(original, queue.pending!!.copyWire())
        assertEquals(0, queue.acknowledgements.size)
        assertEquals(0, queue.stages.size)
        // A lost reply clears pairing. Retry uses a real fresh handshake with the same fixed binding.
        val retry = ReplyProbe(receipt(spaced))
        accepted(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
            .uploadNext(owner(), retry.transport))
        assertArrayEquals(original, retry.sent.toByteArray())
        assertEquals(1, queue.acknowledgements.size)
        assertEquals(expectedReceipt(spaced), queue.acknowledgements.single().receipt.fields)
        assertEquals(0, queue.stages.size)
    }

    @Test fun wrongReceiptNeverReachesQueueAcknowledgement() {
        healthyControl()
        val expected = expectedReceipt(initial)
        val foreignBinding = linkedMapOf(
            "tenantId" to "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "instanceId" to "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "sourceStoreId" to "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "installationId" to "different-synthetic-installation",
            "generation" to "2", "restoreEpoch" to "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        val answers = foreignBinding.map { (key, value) ->
            expected + ("binding" to (binding + (key to value)))
        } + listOf(expected + ("recordType" to "WeightRecord"),
            expected + ("sequence" to "2"), expected + ("batchId" to "synthetic-other-batch"),
            expected + ("payloadDigest" to ("sha256:" + "0".repeat(64))))
        val original = batchWire(initial)
        for (answer in answers) {
            val queue = ScriptedQueue(QueuedBatch(original))
            val reply = ReplyProbe(ControlJson.text(answer).toByteArray(Charsets.UTF_8))
            refused(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner(), reply.transport))
            assertArrayEquals(original, reply.sent.toByteArray())
            assertArrayEquals(original, queue.pending!!.copyWire())
            assertEquals(0, queue.acknowledgements.size)
        }
    }

    @Test fun exactReceiptsReachOnlyTheirOwnPreparedBatch() {
        healthyControl()
        val firstBytes = batchWire(initial)
        val secondBytes = batchWire(second)
        val secondPrepared = QueuedBatch(secondBytes)
        val queue = ScriptedQueue(QueuedBatch(firstBytes))
        val coordinator = ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
        val selected = owner()
        val firstReply = ReplyProbe(receipt(initial))
        accepted(coordinator.uploadNext(selected, firstReply.transport))
        assertEquals(1, queue.acknowledgements.size)
        assertEquals("1", queue.acknowledgements.single().receipt.fields["sequence"])
        assertEquals("synthetic-batch-1", queue.acknowledgements.single().receipt.fields["batchId"])
        assertArrayEquals(firstBytes, queue.acknowledgements.single().batch.copyWire())
        assertArrayEquals(secondBytes, secondPrepared.copyWire())
        // Explicit scripted next answer: this assignment is not an ACK/removal/frontier algorithm.
        queue.pending = secondPrepared
        val secondReply = ReplyProbe(receipt(second))
        accepted(coordinator.uploadNext(selected, secondReply.transport))
        assertEquals(2, queue.acknowledgements.size)
        assertEquals(expectedReceipt(second), queue.acknowledgements.last().receipt.fields)
        assertArrayEquals(secondBytes, queue.acknowledgements.last().batch.copyWire())
        assertEquals(setOf("version", "kind", "binding", "recordType", "sequence", "batchId", "payloadDigest"),
            queue.acknowledgements.last().receipt.fields.keys)
        assertEquals(0, queue.stages.size)
    }

    @Test fun staleBindingAndGateRefuseBeforeSendAndBeforeAcknowledgement() {
        healthyControl()
        val original = batchWire(initial)
        for (change in listOf(mapOf("generation" to "2"),
            mapOf("restoreEpoch" to "dddddddd-dddd-4ddd-8ddd-dddddddddddd"))) {
            val queue = ScriptedQueue(QueuedBatch(original))
            val reply = ReplyProbe(receipt(initial))
            refused(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner(change), reply.transport))
            assertEquals(0, reply.opens)
            assertEquals(0, queue.acknowledgements.size)
            assertArrayEquals(original, queue.pending!!.copyWire())
        }
        val beforeQueue = ScriptedQueue(QueuedBatch(original))
        val beforeReply = ReplyProbe(receipt(initial))
        refused(ImmutableBatchCoordinator(beforeQueue, protocol, paired()) { ReadGate.STALE_BINDING }
            .uploadNext(owner(), beforeReply.transport))
        assertEquals(0, beforeReply.opens)
        assertEquals(0, beforeQueue.acknowledgements.size)
        var gate = ReadGate.OPEN
        val duringQueue = ScriptedQueue(QueuedBatch(original))
        val duringReply = ReplyProbe(receipt(initial), atReply = { gate = ReadGate.STALE_BINDING })
        refused(ImmutableBatchCoordinator(duringQueue, protocol, paired()) { gate }
            .uploadNext(owner(), duringReply.transport))
        assertArrayEquals(original, duringReply.sent.toByteArray())
        assertEquals(0, duringQueue.acknowledgements.size)
    }

    @Test fun sharingStopBlocksSendAndLateReceiptAdmission() {
        healthyControl()
        val original = batchWire(initial)
        val beforeQueue = ScriptedQueue(QueuedBatch(original))
        val beforeReply = ReplyProbe(receipt(initial))
        val closed = ImmutableBatchCoordinator(beforeQueue, protocol, paired()) { ReadGate.PERMISSION_DENIED }
        refused(closed.uploadNext(owner(), beforeReply.transport))
        assertEquals(0, beforeQueue.stages.size)
        assertEquals(0, beforeReply.opens)
        assertEquals(0, beforeQueue.acknowledgements.size)
        var gate = ReadGate.OPEN
        val duringQueue = ScriptedQueue(QueuedBatch(original))
        val session = paired()
        val duringReply = ReplyProbe(receipt(initial), atReply = {
            gate = ReadGate.PERMISSION_DENIED
            session.clear()
        })
        refused(ImmutableBatchCoordinator(duringQueue, protocol, session) { gate }
            .uploadNext(owner(), duringReply.transport))
        assertArrayEquals(original, duringReply.sent.toByteArray())
        assertEquals(0, duringQueue.acknowledgements.size)
        // This port exposes no production purge or Cloud-history mutation operation.
    }
}
