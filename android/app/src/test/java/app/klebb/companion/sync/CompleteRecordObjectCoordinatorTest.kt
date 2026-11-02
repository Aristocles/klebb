// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.*
import app.klebb.companion.queue.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.cert.Certificate
import java.time.Instant
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.*
import org.junit.Test

/** Independent invented wire controls. These tests do not simulate Room or ACK-frontier storage. */
class CompleteRecordObjectCoordinatorTest {
    private val protocol = SharedWire.protocol()
    private val fixed = SharedWire.read("room-complete-record-object-inputs-v1.json")
    private val binding = fixed["binding"].objectValue().mapValues { it.value as String }
    private val expected = fixed["durableReceipt"] as String
    private val finalise get() = (fixed["finalise"] as String).toByteArray(Charsets.UTF_8)
    private val owner get() = BatchOwner("synthetic-object-stream", "BodyWaterMassRecord", binding, 7L)
    private val partInputs = (fixed["parts"] as List<*>).map { it.objectValue() }
    private fun payload() = (fixed["payloadPrefix"] as String + "P".repeat(1048704) +
        fixed["payloadSuffix"] as String).toByteArray(Charsets.UTF_8)
    private fun parts(): List<ByteArray> {
        val original = payload()
        assertEquals(1049872, original.size)
        assertEquals("sha256:45ee44258c3e7f0491bc4e9ebdc2effe4df5e97ba50beb8fcfdef90ba51460e5", digest(original))
        var offset = 0
        return partInputs.map { input ->
            val count = (input["bytes"] as Long).toInt()
            val raw = original.copyOfRange(offset, offset + count)
            offset += count
            assertEquals(input["digest"], digest(raw))
            (input["wirePrefix"] as String + Base64.getEncoder().encodeToString(raw) +
                input["wireSuffix"] as String).toByteArray(Charsets.UTF_8).also {
                assertEquals(input["wireBytes"], it.size.toLong())
                assertEquals(input["wireSha256"], digest(it))
            }
        }.also { assertEquals(1049872, offset); original.fill(0) }
    }
    private fun digest(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun paired() = InMemoryPairingSession(protocol,
        { Instant.parse("2026-10-28T03:55:00Z") }, { binding.getValue("installationId") }).also {
        it.approveDestination("https://health.example.test")
        it.prepareGrant((fixed["grant"] as String).toByteArray(Charsets.UTF_8))
        it.acceptPairing(it.beginExchange(), (fixed["paired"] as String).toByteArray(Charsets.UTF_8))
        assertEquals("0", it.batchScope("BodyWaterMassRecord").acknowledgedSequence)
    }
    /** Only predeclared pending answers and ACK observations. No persistence/frontier algorithm. */
    private class ScriptedQueue(wire: ByteArray, val partAnswers: List<ByteArray>) : DurableBatchQueue {
        val pending = QueuedBatch(wire)
        val acknowledgements = mutableListOf<HealthFrame>()
        var partReads = 0
        override fun stagePage(owner: BatchOwner, checkpoint: PreparedOrdinaryPage, hasRecords: Boolean,
            currentGate: () -> ReadGate, makeBatch: (String, String) -> ByteArray): QueueResult<StageReceipt> =
            throw AssertionError("An immutable upload must not stage or rebuild a page")
        override fun nextPending(owner: BatchOwner, currentGate: () -> ReadGate): QueueResult<QueuedBatch?> = Ok(pending)
        override fun objectParts(owner: BatchOwner, batch: QueuedBatch,
            currentGate: () -> ReadGate): QueueResult<List<ByteArray>> {
            partReads++
            return Ok(partAnswers.map { it.copyOf() })
        }
        override fun acknowledge(owner: BatchOwner, batch: QueuedBatch, receipt: HealthFrame,
            currentGate: () -> ReadGate): QueueResult<Unit> {
            assertArrayEquals(pending.copyWire(), batch.copyWire())
            acknowledgements.add(receipt)
            return Ok(Unit)
        }
    }
    private data class Sent(val path: String, val bytes: ByteArray)
    private class ReplySequence(val answers: List<ByteArray>,
        val afterReply: (Int) -> Unit = {}, val lostReplyIndex: Int? = null) {
        val sent = mutableListOf<Sent>()
        val transport = PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            val index = sent.size
            val output = ByteArrayOutputStream()
            object : HttpsURLConnection(url) {
                override fun connect() {}
                override fun disconnect() {}
                override fun usingProxy() = false
                override fun getCipherSuite() = "TLS_TEST"
                override fun getLocalCertificates(): Array<Certificate>? = null
                override fun getServerCertificates(): Array<Certificate> = emptyArray()
                override fun getOutputStream() = output
                override fun getResponseCode(): Int {
                    assertEquals("POST", requestMethod)
                    sent.add(Sent(url.path, output.toByteArray()))
                    afterReply(index)
                    return 200
                }
                override fun getInputStream(): ByteArrayInputStream {
                    if (index == lostReplyIndex) throw ProtocolException("timeout")
                    return ByteArrayInputStream(answers[index])
                }
                override fun getErrorStream() = ByteArrayInputStream(answers[index])
            }
        }
    }
    private fun answers() = partInputs.map {
        (it["receipt"] as String).toByteArray(Charsets.UTF_8)
    } + expected.toByteArray(Charsets.UTF_8)
    private fun healthyOrdinaryControl() {
        val initial = (SharedWire.read("durable-receipt-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.single { it["id"] == "initial-raw-only" }
        val wire = ControlJson.text(linkedMapOf("version" to 1L, "kind" to "batch",
            "payloadJson" to initial["payloadJson"],
            "payloadDigest" to "sha256:99ef27c681971cbe8a725d9454d14362c11307143b850f3a84531995133c0bcf")).toByteArray(Charsets.UTF_8)
        val queue = ScriptedQueue(wire, emptyList())
        val replies = ReplySequence(listOf((initial["wire"] as String).toByteArray(Charsets.UTF_8)))
        val result = ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }.uploadNext(owner, replies.transport)
        assertTrue("SETUP HOLD: ordinary coordinator/HTTP control must pass", result is Ok<*>)
        assertEquals(true, (result as Ok<*>).value)
        assertEquals(1, queue.acknowledgements.size)
        assertEquals(0, queue.partReads)
        assertArrayEquals(wire, replies.sent.single().bytes)
    }
    private fun healthyObjectControl() {
        healthyOrdinaryControl()
        val originalParts = parts()
        val queue = ScriptedQueue(finalise, originalParts)
        val session = paired()
        val replies = ReplySequence(answers(), afterReply = { _ ->
            assertEquals("Part responses cannot authorize queue ACK", 0, queue.acknowledgements.size)
            assertEquals("0", session.batchScope("BodyWaterMassRecord").acknowledgedSequence)
        })
        val result = ImmutableBatchCoordinator(queue, protocol, session) { ReadGate.OPEN }.uploadNext(owner, replies.transport)
        assertTrue("Complete original object must drain after the healthy ordinary control", result is Ok<*>)
        assertEquals(true, (result as Ok<*>).value)
        assertEquals(4, replies.sent.size)
        originalParts.forEachIndexed { index, wire ->
            assertEquals("/api/connectors/health-connect/v1/object-parts", replies.sent[index].path)
            assertArrayEquals(wire, replies.sent[index].bytes)
        }
        assertEquals("/api/connectors/health-connect/v1/object-finalise", replies.sent.last().path)
        assertArrayEquals(finalise, replies.sent.last().bytes)
        assertEquals(1, queue.acknowledgements.size)
        assertEquals(protocol.decode(expected.toByteArray(Charsets.UTF_8)).fields,
            queue.acknowledgements.single().fields)
    }
    @Test fun partsNeverAcknowledgeAndOnlyFinalDurableReceiptReachesQueue() = healthyObjectControl()
    @Test fun missingReorderedCorruptOrForeignPartsRefuseBeforeFirstHttp() {
        healthyObjectControl()
        val original = parts()
        val foreign = protocol.decode(original[0]).fields + ("binding" to (binding + ("generation" to "2")))
        val corrupt = original[0].copyOf().also { it[it.size - 2] = 'f'.code.toByte() }
        for (bad in listOf(original.dropLast(1), original.reversed(),
            listOf(corrupt) + original.drop(1),
            listOf(ControlJson.text(foreign).toByteArray(Charsets.UTF_8)) + original.drop(1))) {
            val queue = ScriptedQueue(finalise, bad)
            val replies = ReplySequence(answers())
            assertTrue(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner, replies.transport) is Blocked)
            assertEquals(0, replies.sent.size)
            assertEquals(0, queue.acknowledgements.size)
            assertArrayEquals(finalise, queue.pending.copyWire())
        }
    }
    @Test fun lostPartOrFinalReplyRetainsExactBytesForFreshPairingRetry() {
        healthyObjectControl()
        for (lostIndex in listOf(0, 3)) {
            val original = parts()
            val queue = ScriptedQueue(finalise, original)
            val lost = ReplySequence(answers(), lostReplyIndex = lostIndex)
            assertTrue(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner, lost.transport) is Blocked)
            assertEquals(0, queue.acknowledgements.size)
            assertArrayEquals(finalise, queue.pending.copyWire())
            val retry = ReplySequence(answers())
            assertEquals(true, (ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
                .uploadNext(owner, retry.transport) as Ok<*>).value)
            assertEquals(4, retry.sent.size)
            original.forEachIndexed { index, wire -> assertArrayEquals(wire, retry.sent[index].bytes) }
            assertArrayEquals(finalise, retry.sent.last().bytes)
            assertEquals(1, queue.acknowledgements.size)
        }
    }
    @Test fun wrongFinalReceiptAndStopAfterPartCannotReachQueueAck() {
        healthyObjectControl()
        val wrong = protocol.decode(expected.toByteArray(Charsets.UTF_8)).fields + ("sequence" to "2")
        val queue = ScriptedQueue(finalise, parts())
        val replies = ReplySequence(answers().dropLast(1) +
            ControlJson.text(wrong).toByteArray(Charsets.UTF_8))
        assertTrue(ImmutableBatchCoordinator(queue, protocol, paired()) { ReadGate.OPEN }
            .uploadNext(owner, replies.transport) is Blocked)
        assertEquals(0, queue.acknowledgements.size)
        for (stopIndex in listOf(0, 3)) {
            var gate = ReadGate.OPEN
            val stopped = ScriptedQueue(finalise, parts())
            val session = paired()
            val stop = ReplySequence(answers(), afterReply = { index ->
                if (index == stopIndex) { gate = ReadGate.PERMISSION_DENIED; session.clear() }
            })
            assertTrue(ImmutableBatchCoordinator(stopped, protocol, session) { gate }
                .uploadNext(owner, stop.transport) is Blocked)
            assertEquals(stopIndex + 1, stop.sent.size)
            assertEquals(0, stopped.acknowledgements.size)
            assertArrayEquals(finalise, stopped.pending.copyWire())
        }
    }
}
