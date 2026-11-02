// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.queue.*
import app.klebb.companion.records.EncodedRecord
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real Room/Keystore gates on the existing clean API35 emulator fixture; invented records only. */
@RunWith(AndroidJUnit4::class)
class RoomCompleteRecordObjectInstrumentedTest {
    private val fixed get() = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
        .open("room-complete-record-object-inputs-v1.json").bufferedReader(Charsets.UTF_8).use { it.readText() })
    private val query get() = WeightReadScope(Instant.parse("2026-10-28T00:00:00Z"),
        Instant.parse("2026-10-29T00:00:00Z"), 2)
    private val open = { ReadGate.OPEN }
    private fun finalise() = fixed.getString("finalise").toByteArray(Charsets.UTF_8).also {
        assertEquals(fixed.getInt("finaliseBytes"), it.size)
        assertEquals(fixed.getString("finaliseSha256"), digest(it))
    }
    private fun partWires(): List<ByteArray> {
        val payload = (fixed.getString("payloadPrefix") + "P".repeat(1048704) +
            fixed.getString("payloadSuffix")).toByteArray(Charsets.UTF_8)
        assertEquals(1049872, payload.size)
        assertEquals("sha256:45ee44258c3e7f0491bc4e9ebdc2effe4df5e97ba50beb8fcfdef90ba51460e5", digest(payload))
        var offset = 0
        val parts = fixed.getJSONArray("parts")
        return (0 until parts.length()).map { index ->
            val entry = parts.getJSONObject(index)
            val raw = payload.copyOfRange(offset, offset + entry.getInt("bytes"))
            offset += raw.size
            assertEquals(entry.getString("digest"), digest(raw))
            (entry.getString("wirePrefix") + Base64.getEncoder().encodeToString(raw) +
                entry.getString("wireSuffix")).toByteArray(Charsets.UTF_8).also {
                assertEquals(entry.getInt("wireBytes"), it.size)
                assertEquals(entry.getString("wireSha256"), digest(it))
                raw.fill(0)
            }
        }.also { assertEquals(1049872, offset); payload.fill(0) }
    }
    private fun page(large: Boolean = true, token: String? = "next-large-page") = OrdinaryRecordPage(
        listOf(EncodedRecord("BodyWaterMassRecord", "large-raw-only",
            if (large) fixed.getString("recordPrefix") + "P".repeat(1048704) +
                fixed.getString("recordSuffix") else fixed.getString("smallRecord"))), token)
    private fun reader(answer: OrdinaryRecordPage, observed: MutableList<String?> = mutableListOf()) =
        object : OrdinaryRecordReader {
            override val recordType = "BodyWaterMassRecord"
            override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                assertEquals(query.start, scope.start)
                assertEquals(query.end, scope.end)
                assertEquals(2, scope.pageSize)
                observed.add(pageToken)
                assertNull(pageToken)
                return answer
            }
        }
    private inner class Subject(val f: QueueStorageNativeFixture,
        val rows: Long = 32L, val bytes: Long = 8_388_608L) {
        val protocol = HealthProtocol(InstrumentationRegistry.getInstrumentation().targetContext.assets
            .open("protocol-v1.schema.json").use { it.readBytes() })
        val session = InMemoryPairingSession(protocol, { Instant.parse("2026-10-28T03:55:00Z") },
            { fixed.getJSONObject("binding").getString("installationId") })
        val cipher = KeystoreQueueCipher(f.alias)
        val ids = mutableListOf<String>()
        var queue: RoomDurableBatchQueue
            private set
        init { pair(); queue = make() }
        fun pair() {
            session.approveDestination("https://health.example.test")
            session.prepareGrant(fixed.getString("grant").toByteArray(Charsets.UTF_8))
            session.acceptPairing(session.beginExchange(), fixed.getString("paired").toByteArray(Charsets.UTF_8))
            assertEquals("0", session.batchScope("BodyWaterMassRecord").acknowledgedSequence)
        }
        private fun make() = RoomDurableBatchQueue(f.db, cipher, protocol, session, rows, bytes) {
            ids.add("synthetic-large-1")
            "synthetic-large-1"
        }
        fun reopen() { f.reopen(); queue = make() }
        fun owner() = ok(queue.openStream("object-owned-stream", "BodyWaterMassRecord", 7L, query, open))
        suspend fun stage(owner: BatchOwner, answer: OrdinaryRecordPage = page()): QueueResult<StageReceipt> {
            val prepared = ok(queue.prepareOrdinaryPage(owner, reader(answer), open))
            return ImmutableBatchCoordinator(queue, protocol, session, open).stagePage(owner, answer, prepared)
        }
        fun receipt() = protocol.decode(fixed.getString("durableReceipt").toByteArray(Charsets.UTF_8))
    }
    private suspend fun healthyOrdinaryControl() {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            val staged = ok(s.stage(owner, page(false)))
            val batch = checkNotNull(staged.batch)
            val expected = fixed.getString("smallWire").toByteArray(Charsets.UTF_8)
            assertEquals(fixed.getString("smallWireSha256"), digest(expected))
            assertArrayEquals("SETUP HOLD: actual normal Room/coordinator stage must be healthy",
                expected, batch.copyWire())
            assertArrayEquals(expected, checkNotNull(ok(s.queue.nextPending(owner, open))).copyWire())
            ok(s.queue.acknowledge(owner, batch,
                s.protocol.decode(fixed.getString("smallReceipt").toByteArray(Charsets.UTF_8)), open))
            assertNull(ok(s.queue.nextPending(owner, open)))
            assertEquals(2, f.snapshot().size)
        }
    }

    @Test fun ROOMO01_realBoundedPartRowsReopenImmutableAndOnlyFinalReceiptDeletesParts() = runBlocking<Unit> {
        healthyOrdinaryControl()
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            val batch = checkNotNull(ok(s.stage(owner)).batch)
            assertArrayEquals(finalise(), batch.copyWire())
            val staged = f.snapshot()
            assertEquals(6, staged.size)
            assertEquals(4, staged.count { it.kind == "payload" })
            val expectedIds = fixed.getJSONArray("expectedOwnedRowIds")
            assertEquals((0 until expectedIds.length()).map { expectedIds.getString(it) }.toSet(),
                staged.map { it.id }.toSet())
            val originalParts = partWires()
            val rows = f.db.blobs().all()
            for (index in originalParts.indices) {
                val row = rows.single { it.rowId.endsWith(":payload:1:part:$index") }
                assertTrue("A bounded part cannot depend on a large CursorWindow", row.encryptedBytes < 1_048_576)
                assertArrayEquals(originalParts[index], f.independentOpen(row))
            }
            assertArrayEquals(finalise(), f.independentOpen(rows.single { it.rowId.endsWith(":payload:1") }))
            assertEquals(listOf("synthetic-large-1"), s.ids)
            s.reopen()
            val recovered = s.owner()
            assertArrayEquals(finalise(), checkNotNull(ok(s.queue.nextPending(recovered, open))).copyWire())
            val recoveredParts = ok(s.queue.objectParts(recovered, batch, open))
            originalParts.forEachIndexed { index, wire -> assertArrayEquals(wire, recoveredParts[index]) }
            recoveredParts.forEach { it.fill(0) }
            assertEquals(staged, f.snapshot())
            for (index in originalParts.indices) {
                val partReceipt = s.protocol.decode(fixed.getJSONArray("parts").getJSONObject(index)
                    .getString("receipt").toByteArray(Charsets.UTF_8))
                assertTrue(s.queue.acknowledge(recovered, batch, partReceipt, open) is Blocked)
                assertEquals(staged, f.snapshot())
            }
            val wrong = JSONObject(fixed.getString("durableReceipt"))
                .put("payloadDigest", "sha256:" + "0".repeat(64))
            assertTrue(s.queue.acknowledge(recovered, batch,
                s.protocol.decode(wrong.toString().toByteArray(Charsets.UTF_8)), open) is Blocked)
            assertEquals(staged, f.snapshot())
            ok(s.queue.acknowledge(recovered, batch, s.receipt(), open))
            assertEquals(2, f.snapshot().size)
            assertFalse(f.snapshot().any { it.kind == "payload" })
            assertNull(ok(s.queue.nextPending(recovered, open)))
            val acknowledged = f.snapshot()
            ok(s.queue.acknowledge(recovered, batch, s.receipt(), open))
            assertEquals(acknowledged, f.snapshot())
            s.reopen()
            assertNull(ok(s.queue.nextPending(s.owner(), open)))
            assertEquals(acknowledged, f.snapshot())
        }
    }

    @Test fun ROOMO02_nativeCursorRefusalAfterAllFourPayloadRowsRollsBackPagePartsAndHead() = runBlocking<Unit> {
        healthyOrdinaryControl()
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            val answer = page()
            val prepared = ok(s.queue.prepareOrdinaryPage(owner, reader(answer), open))
            val before = f.snapshot()
            f.db.runInTransaction(java.lang.Runnable {
                f.db.openHelper.writableDatabase.execSQL(
                    "CREATE TEMP TRIGGER refuse_complete_object_cursor BEFORE INSERT ON queue_blobs " +
                        "WHEN NEW.kind = 'cursor' AND NEW.local_stream_id = 'object-owned-stream' " +
                        "BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM queue_blobs WHERE " +
                        "kind = 'payload' AND local_stream_id = 'object-owned-stream') = 4 " +
                        "THEN RAISE(ABORT, 'invented-object-cursor-after-four-payloads') " +
                        "ELSE RAISE(ABORT, 'object-injection-precondition-not-reached') END; END")
            })
            try {
                // Direct DAO/JCA controls independently establish the actual native fault.
                for (index in 0..3) f.seed("object-fault-control-$index", "object-owned-stream", BlobKind.PAYLOAD, "weight")
                val failure = runCatching { f.seed("object-fault-cursor", "object-owned-stream", BlobKind.CURSOR, "cursor") }.exceptionOrNull()
                assertTrue("SETUP HOLD: observe exact actual SQLite refusal", failure is android.database.sqlite.SQLiteException)
                assertTrue(failure?.message.orEmpty().contains("invented-object-cursor-after-four-payloads"))
                for (index in 0..3) assertEquals(1,
                    f.db.blobs().deleteOwnedRow("object-fault-control-$index", "object-owned-stream", "payload"))
                assertEquals(before, f.snapshot())
                val writer = Thread.currentThread()
                val observed = java.util.Collections.synchronizedList(mutableListOf<Pair<Boolean, String?>>())
                f.observeNativeStatement = { statement, arguments ->
                    val match = Regex("""(?i)INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"]?queue_blobs[`"]?\s*\(([^)]+)\)""").find(statement)
                    if (match != null) {
                        val columns = match.groupValues[1].split(',').map { it.trim().trim('`', '"') }
                        val kind = columns.indexOf("kind")
                        val stream = columns.indexOf("local_stream_id")
                        if (kind >= 0 && stream >= 0 && arguments.size == columns.size &&
                            arguments[kind] == "cursor" && arguments[stream] == "object-owned-stream") {
                            val owns = Thread.currentThread() === writer && f.db.inTransaction()
                            observed.add(owns to if (owns) f.scalar("SELECT COUNT(*) FROM queue_blobs WHERE " +
                                "kind = 'payload' AND local_stream_id = 'object-owned-stream'") else null)
                        }
                    }
                }
                val result = try {
                    ImmutableBatchCoordinator(s.queue, s.protocol, s.session, open).stagePage(owner, answer, prepared)
                } finally { f.observeNativeStatement = null }
                assertTrue("SETUP HOLD: no native callback failure", f.nativeObserverFailuresSnapshot().isEmpty())
                assertEquals("SETUP HOLD: actual adapter reaches one cursor INSERT", listOf(true to "4"),
                    synchronized(observed) { observed.toList() })
                assertTrue(result is Blocked)
                assertEquals(before, f.snapshot())
                assertNull(ok(s.queue.nextPending(owner, open)))
            } finally {
                f.observeNativeStatement = null
                f.db.runInTransaction(java.lang.Runnable {
                    f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER refuse_complete_object_cursor")
                })
            }
            s.reopen()
            val requested = mutableListOf<String?>()
            ok(s.queue.prepareOrdinaryPage(s.owner(), reader(page(), requested), open))
            assertEquals(listOf<String?>(null), requested)
            assertEquals(before, f.snapshot())
        }
    }

    @Test fun ROOMO03_totalPartRowAndCipherByteQuotasRollbackWithoutCheckpointAdvance() = runBlocking<Unit> {
        healthyOrdinaryControl()
        for ((rows, bytes) in listOf(5L to 8_388_608L, 32L to 1_048_576L)) {
            QueueStorageNativeFixture().use { f ->
                f.createIndependentKey()
                val s = Subject(f, rows, bytes)
                val owner = s.owner()
                val before = f.snapshot()
                assertTrue(s.stage(owner) is Blocked)
                assertEquals(before, f.snapshot())
                assertNull(ok(s.queue.nextPending(owner, open)))
                s.reopen()
                val requested = mutableListOf<String?>()
                ok(s.queue.prepareOrdinaryPage(s.owner(), reader(page(), requested), open))
                assertEquals(listOf<String?>(null), requested)
                assertEquals(before, f.snapshot())
            }
        }
    }

    @Test fun ROOMO04_confirmedStoppedStreamPurgesAllPartsAndRetainsUnrelatedRows() = runBlocking<Unit> {
        healthyOrdinaryControl()
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            ok(s.stage(owner))
            assertEquals(6, f.snapshot().size)
            f.seed("other-object-payload", "unrelated-stream", BlobKind.PAYLOAD, "weight")
            val sibling = f.snapshot().single { it.stream == "unrelated-stream" }
            // This fixture owns/has confirmed stop for this unacknowledged synthetic stream.
            // Fence all uploads before invoking the existing exact-stream local purger.
            s.session.clear()
            val closed = { ReadGate.PERMISSION_DENIED }
            assertTrue(s.queue.nextPending(owner, closed) is Blocked)
            ok(QueueStreamPurger(f.db, s.cipher)
                .purgeConfirmedUnacknowledgedStream("object-owned-stream", "object-reconciliation-marker"))
            val remaining = f.snapshot()
            assertEquals(2, remaining.size)
            assertEquals(sibling, remaining.single { it.stream == "unrelated-stream" })
            val owned = f.db.blobs().all().single { it.localStreamId == "object-owned-stream" }
            assertEquals("object-reconciliation-marker", owned.rowId)
            assertEquals("state", owned.kind)
            assertArrayEquals("[\"klebb-queue-reconciliation-v1\",1,\"fresh-scan-required\"]".toByteArray(Charsets.UTF_8),
                f.independentOpen(owned))
            s.pair()
            s.reopen()
            assertTrue(s.queue.openStream("object-owned-stream", "BodyWaterMassRecord", 7L, query, open) is Blocked)
            assertEquals(remaining, f.snapshot())
        }
    }

    @Test fun ROOMO05_missingOrTamperedPartBlocksReadWithoutMutation() = runBlocking<Unit> {
        healthyOrdinaryControl()
        for (missing in listOf(true, false)) QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            ok(s.stage(owner))
            val part = f.db.blobs().all().single { it.rowId.endsWith(":payload:1:part:1") }
            if (missing) assertEquals(1, f.db.blobs().deleteOwnedRow(part.rowId, "object-owned-stream", "payload"))
            else f.replaceEncrypted(part.rowId, part.ciphertextAndTag.copyOf().also {
                it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
            })
            val before = f.snapshot()
            assertTrue(s.queue.nextPending(owner, open) is Blocked)
            assertEquals(before, f.snapshot())
            s.reopen()
            assertTrue(s.queue.nextPending(s.owner(), open) is Blocked)
            assertEquals(before, f.snapshot())
        }
    }
    @Test fun ROOMO06_unpartitionedMixedPageRefusesAllRecordsAndCheckpoint() = runBlocking<Unit> {
        healthyOrdinaryControl()
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = Subject(f)
            val owner = s.owner()
            val original = page().records.single()
            val other = EncodedRecord("BodyWaterMassRecord", "second-large-raw-only",
                original.recordJson.replace("\"id\":\"large-raw-only\"", "\"id\":\"second-large-raw-only\""))
            val mixed = OrdinaryRecordPage(listOf(original, other), "mixed-page-next")
            val before = f.snapshot()
            assertTrue("Mixed-page partition is required next; refusal cannot checkpoint a subset",
                s.stage(owner, mixed) is Blocked)
            assertEquals(before, f.snapshot())
            assertNull(ok(s.queue.nextPending(owner, open)))
            s.reopen()
            val requested = mutableListOf<String?>()
            ok(s.queue.prepareOrdinaryPage(s.owner(), reader(mixed, requested), open))
            assertEquals(listOf<String?>(null), requested)
            assertEquals(before, f.snapshot())
        }
    }
    companion object {
        private fun <T> ok(result: QueueResult<T>): T {
            assertTrue("Expected typed success, got $result", result is Ok<*>)
            @Suppress("UNCHECKED_CAST") return (result as Ok<T>).value
        }
        private fun digest(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
