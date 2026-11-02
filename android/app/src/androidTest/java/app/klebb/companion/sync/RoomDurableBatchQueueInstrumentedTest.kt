// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.queue.BlobKind
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.KeystoreQueueCipher
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueCipher
import app.klebb.companion.queue.QueueEnvelope
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.queue.QueueStorageNativeFixture
import app.klebb.companion.records.EncodedRecord
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.IOException
import javax.net.ssl.HttpsURLConnection
import java.security.cert.Certificate
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real Room/Keystore component controls. The ordinary reader returns invented records only. */
@RunWith(AndroidJUnit4::class)
class RoomDurableBatchQueueInstrumentedTest {
    private val fixed: JSONObject get() = JSONObject(
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("room-durable-batch-inputs-v1.json")
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
    )
    private val query get() = WeightReadScope(Instant.parse("2026-10-28T00:00:00Z"),
        Instant.parse("2026-10-29T00:00:00Z"), 2)
    private val open = { ReadGate.OPEN }
    private fun vector(sequence: Int): JSONObject = fixed.getJSONArray("cases").getJSONObject(sequence - 1)
    private fun wire(sequence: Int): ByteArray {
        val row = vector(sequence)
        return row.getString("wire").toByteArray(Charsets.UTF_8).also {
            assertEquals(row.getInt("wireBytes"), it.size)
            assertEquals(row.getString("wireSha256"), hex(MessageDigest.getInstance("SHA-256").digest(it)))
        }
    }
    private fun page(sequence: Int, token: String?): OrdinaryRecordPage {
        val row = vector(sequence)
        return OrdinaryRecordPage(listOf(EncodedRecord("WeightRecord",
            row.getString("nativeRecordId"), row.getString("recordJson"))), token)
    }
    private fun protocol() = HealthProtocol(
        InstrumentationRegistry.getInstrumentation().targetContext.assets
            .open("protocol-v1.schema.json").use { it.readBytes() }
    )
    private fun paired(protocol: HealthProtocol): InMemoryPairingSession {
        val session = InMemoryPairingSession(protocol,
            { Instant.parse("2026-10-28T03:55:00Z") }, { "install-a" })
        installSyntheticPairing(session)
        return session
    }
    private fun installSyntheticPairing(session: InMemoryPairingSession) {
        session.approveDestination("https://health.example.test")
        session.prepareGrant(fixed.getString("grant").toByteArray(Charsets.UTF_8))
        session.acceptPairing(session.beginExchange(),
            fixed.getString("paired").toByteArray(Charsets.UTF_8))
        assertEquals(setOf("WeightRecord"), session.categories)
    }
    private fun reader(expectedToken: String?, answer: OrdinaryRecordPage,
        observed: MutableList<String?> = mutableListOf()) = object : OrdinaryRecordReader {
        override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
            assertEquals(query.start, scope.start)
            assertEquals(query.end, scope.end)
            assertEquals(2, scope.pageSize)
            observed.add(pageToken)
            assertEquals(expectedToken, pageToken)
            return answer
        }
    }
    private class Subject(
        val f: QueueStorageNativeFixture,
        val protocol: HealthProtocol,
        val session: InMemoryPairingSession,
        val cipher: QueueCipher,
        val ids: MutableList<String> = mutableListOf()
    ) {
        var queue = make()
            private set
        private fun make() = RoomDurableBatchQueue(f.db, cipher, protocol, session,
            100L, 4_194_304L, {
                val id = "native-batch-${ids.size + 1}"
                ids.add(id)
                id
            })
        fun reopen() { f.reopen(); queue = make() }
        fun owner(): BatchOwner = ok(queue.openStream("room-owned-stream", "WeightRecord", 17L,
            WeightReadScope(Instant.parse("2026-10-28T00:00:00Z"),
                Instant.parse("2026-10-29T00:00:00Z"), 2), { ReadGate.OPEN }))
    }
    private fun subject(f: QueueStorageNativeFixture, cipher: QueueCipher = KeystoreQueueCipher(f.alias)):
        Subject = protocol().let { Subject(f, it, paired(it), cipher) }
    private suspend fun stage(s: Subject, owner: BatchOwner, sequence: Int,
        requested: String?, next: String?): QueuedBatch {
        val prepared = ok(s.queue.prepareOrdinaryPage(owner, reader(requested, page(sequence, next)), open))
        val result = ok(s.queue.stagePage(owner, prepared, true, open) { actualSequence, id ->
            assertEquals(sequence.toString(), actualSequence)
            assertEquals("native-batch-$sequence", id)
            wire(sequence)
        })
        return checkNotNull(result.batch).also { assertArrayEquals(wire(sequence), it.copyWire()) }
    }
    private fun pending(s: Subject, owner: BatchOwner): QueuedBatch? = ok(s.queue.nextPending(owner, open))
    private fun receipt(s: Subject, sequence: Int) = s.protocol.decode(
        vector(sequence).getString("receipt").toByteArray(Charsets.UTF_8)
    )

    @Test fun ROOM01_reopenRetainsTheExactOldestWireWithoutAnotherAllocation() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            val batch = stage(s, owner, 1, null, "p1")
            val before = f.snapshot()
            assertArrayEquals(wire(1), checkNotNull(pending(s, owner)).copyWire())
            assertEquals(listOf("native-batch-1"), s.ids)
            // No receipt is delivered. This component proves retention, without a network-loss claim.
            s.reopen()
            val recovered = s.owner()
            assertArrayEquals(wire(1), checkNotNull(pending(s, recovered)).copyWire())
            assertArrayEquals(batch.copyWire(), checkNotNull(pending(s, recovered)).copyWire())
            assertEquals(before, f.snapshot())
            assertEquals(listOf("native-batch-1"), s.ids)
        }
    }

    @Test fun ROOM02_nativeCursorInsertRefusalAfterActualPayloadWriteRollsBackEverything() = runBlocking<Unit> {
        // The old cipher-seal mechanism remains immutable as setup HOLD in its original bank.
        // This controlled native INSERT refusal preserves the independent rollback expectations.
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            val prepared = ok(s.queue.prepareOrdinaryPage(owner, reader(null, page(1, "p1")), open))
            val before = f.snapshot()
            assertTrue(before.none { it.kind == BlobKind.PAYLOAD.stored })
            assertNull(pending(s, owner))
            assertTrue("SETUP HOLD: fixture callback must be healthy before fault setup",
                f.nativeObserverFailuresSnapshot().isEmpty())
            var triggerInstalled = false
            try {
                // No suspended provider operation or adapter stage is enclosed by this setup transaction.
                f.db.runInTransaction(java.lang.Runnable {
                    assertTrue("SETUP HOLD: install the TEMP trigger on the owning writer transaction",
                        f.db.inTransaction())
                    f.db.openHelper.writableDatabase.execSQL(
                        "CREATE TEMP TRIGGER observer_refuse_owned_cursor BEFORE INSERT ON queue_blobs " +
                            "WHEN NEW.kind = 'cursor' AND NEW.local_stream_id = 'room-owned-stream' " +
                            "BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM queue_blobs WHERE " +
                            "kind = 'payload' AND local_stream_id = 'room-owned-stream') = 1 " +
                            "THEN RAISE(ABORT, 'invented-cursor-insert-refusal-after-payload') " +
                            "ELSE RAISE(ABORT, 'injection-precondition-not-reached') END; END"
                    )
                    assertEquals("SETUP HOLD: actual writer must own the installed TEMP trigger", "1",
                        f.scalar("SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger' " +
                            "AND name = 'observer_refuse_owned_cursor'"))
                })
                triggerInstalled = true
                // Independent JCA/direct-DAO controls commit their payload separately. A failed
                // cursor DAO transaction cannot roll that control payload back before cleanup.
                f.seed("observer-payload-control", "room-owned-stream", BlobKind.PAYLOAD, "weight")
                val controlFailure = runCatching {
                    f.seed("observer-cursor-control", "room-owned-stream", BlobKind.CURSOR, "cursor")
                }.exceptionOrNull()
                assertTrue("SETUP HOLD: observe actual native cursor INSERT refusal after payload",
                    controlFailure is android.database.sqlite.SQLiteException)
                assertTrue("SETUP HOLD: observe the exact native trigger marker",
                    controlFailure?.message.orEmpty().contains("invented-cursor-insert-refusal-after-payload"))
                assertNull("SETUP HOLD: refused independent cursor control must not persist",
                    f.db.blobs().find("observer-cursor-control"))
                assertEquals("SETUP HOLD: remove only the independently seeded control payload", 1,
                    f.db.blobs().deleteOwnedRow("observer-payload-control", "room-owned-stream", "payload"))
                assertEquals("SETUP HOLD: clean independent native controls to the exact before snapshot",
                    before, f.snapshot())

                data class CursorAttempt(
                    val columns: List<String>, val argumentCount: Int,
                    val kind: String?, val stream: String?, val thread: Thread,
                    val inTransaction: Boolean, val payloadCount: String?, val triggerCount: String?
                )
                val attempts = java.util.Collections.synchronizedList(mutableListOf<CursorAttempt>())
                val observationFailures = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
                val stageThread = Thread.currentThread()
                f.observeNativeStatement = observer@{ statement, arguments ->
                    // Room launches this diagnostic callback in a coroutine. Never assert or
                    // throw here; failures and provenance are checked on the test thread later.
                    try {
                        val match = Regex("""(?i)INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"]?queue_blobs[`"]?\s*\(([^)]+)\)""")
                            .find(statement) ?: return@observer
                        val columns = match.groupValues[1].split(',').map { it.trim().trim('`', '"') }
                        val kindIndex = columns.indexOf("kind")
                        val streamIndex = columns.indexOf("local_stream_id")
                        if (kindIndex < 0 || streamIndex < 0 || arguments.size != columns.size) {
                            observationFailures.add(IllegalStateException("Unexpected native INSERT operands"))
                            return@observer
                        }
                        if (arguments[kindIndex] != "cursor" || arguments[streamIndex] != "room-owned-stream") {
                            return@observer
                        }
                        val callbackThread = Thread.currentThread()
                        val inTransaction = f.db.inTransaction()
                        // An off-thread/late callback is setup HOLD and must not query another
                        // pooled connection or pretend to observe uncommitted payload rows.
                        val ownsTransaction = callbackThread === stageThread && inTransaction
                        val payloadCount = if (ownsTransaction) f.scalar(
                            "SELECT COUNT(*) FROM queue_blobs WHERE kind = 'payload' " +
                                "AND local_stream_id = 'room-owned-stream'") else null
                        val triggerCount = if (ownsTransaction) f.scalar(
                            "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger' " +
                                "AND name = 'observer_refuse_owned_cursor'") else null
                        attempts.add(CursorAttempt(columns.toList(), arguments.size,
                            arguments[kindIndex] as? String, arguments[streamIndex] as? String,
                            callbackThread, inTransaction, payloadCount, triggerCount))
                    } catch (failure: Throwable) {
                        observationFailures.add(failure)
                    }
                }
                val result = try {
                    s.queue.stagePage(owner, prepared, true, open) { sequence, id ->
                        assertEquals("1", sequence); assertEquals("native-batch-1", id); wire(1)
                    }
                } finally {
                    f.observeNativeStatement = null
                }
                val observed = synchronized(attempts) { attempts.toList() }
                val failedObservations = synchronized(observationFailures) { observationFailures.toList() }
                assertTrue("SETUP HOLD: native callback failed; no rollback behavior credit",
                    failedObservations.isEmpty() && f.nativeObserverFailuresSnapshot().isEmpty())
                assertEquals("SETUP HOLD: observe exactly one actual owned cursor INSERT attempt", 1, observed.size)
                val attempt = observed.single()
                assertEquals("SETUP HOLD: observe all actual named INSERT operands",
                    attempt.columns.size, attempt.argumentCount)
                assertTrue("SETUP HOLD: actual INSERT must name kind and local stream",
                    "kind" in attempt.columns && "local_stream_id" in attempt.columns)
                assertEquals("cursor", attempt.kind)
                assertEquals("room-owned-stream", attempt.stream)
                assertSame("SETUP HOLD: callback must execute on the actual adapter writer thread",
                    stageThread, attempt.thread)
                assertTrue("SETUP HOLD: callback must observe the owning Room transaction", attempt.inTransaction)
                assertEquals("SETUP HOLD: a real payload INSERT must precede cursor refusal", "1", attempt.payloadCount)
                assertEquals("SETUP HOLD: actual cursor attempt must see its writer-local TEMP trigger", "1", attempt.triggerCount)
                assertTrue(result is Blocked)
                assertEquals("storage-failed", (result as Blocked).cause)
                assertEquals(before, f.snapshot())
                assertNull(pending(s, owner))
            } finally {
                f.observeNativeStatement = null
                if (triggerInstalled) f.db.runInTransaction(java.lang.Runnable {
                    f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER observer_refuse_owned_cursor")
                })
            }
            s.reopen()
            val recovered = s.owner()
            assertEquals(before, f.snapshot())
            assertNull(pending(s, recovered))
            val requested = mutableListOf<String?>()
            ok(s.queue.prepareOrdinaryPage(recovered, reader(null, page(1, "p1"), requested), open))
            assertEquals(listOf<String?>(null), requested)
        }
    }

    @Test fun ROOM03_nativeStateCasZeroRollsBackAllPayloadAndCursorWrites() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            val prepared = ok(s.queue.prepareOrdinaryPage(owner, reader(null, page(1, "p1")), open))
            val before = f.snapshot()
            assertEquals("1", f.scalar("SELECT COUNT(*) FROM queue_blobs WHERE kind = 'state'"))
            val directStateUpdate = "UPDATE queue_blobs SET version = version " +
                "WHERE kind = 'state' AND local_stream_id = 'room-owned-stream'"
            f.db.openHelper.writableDatabase.compileStatement(directStateUpdate).use {
                assertEquals("A real owned-state UPDATE must match one row before the native trigger", 1,
                    it.executeUpdateDelete())
            }
            assertEquals(before, f.snapshot())
            f.db.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER observer_ignore_owned_state BEFORE UPDATE ON queue_blobs " +
                    "WHEN OLD.kind = 'state' AND OLD.local_stream_id = 'room-owned-stream' " +
                    "BEGIN SELECT RAISE(IGNORE); END"
            )
            assertEquals("1", f.scalar("SELECT COUNT(*) FROM sqlite_master WHERE " +
                "type = 'trigger' AND name = 'observer_ignore_owned_state'"))
            f.db.openHelper.writableDatabase.compileStatement(directStateUpdate).use {
                assertEquals("Observe native affected-row count zero before classifying the adapter fault", 0,
                    it.executeUpdateDelete())
            }
            assertEquals(before, f.snapshot())
            f.sql.clear()
            try {
                val result = s.queue.stagePage(owner, prepared, true, open) { sequence, id ->
                    assertEquals("1", sequence); assertEquals("native-batch-1", id); wire(1)
                }
                val statements = synchronized(f.sql) { f.sql.toList() }
                assertTrue("The real guarded state UPDATE must be reached before CAS-zero is credited",
                    statements.any { it.trimStart().startsWith("UPDATE", ignoreCase = true) &&
                        it.contains("queue_blobs", ignoreCase = true) &&
                        Regex("""kind\s*=\s*'state'""", RegexOption.IGNORE_CASE).containsMatchIn(it) })
                assertTrue(result is Blocked)
                assertEquals(before, f.snapshot())
                assertNull(pending(s, owner))
            } finally {
                f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER observer_ignore_owned_state")
            }
            s.reopen()
            val recovered = s.owner()
            assertEquals(before, f.snapshot())
            assertNull(pending(s, recovered))
            val requested = mutableListOf<String?>()
            ok(s.queue.prepareOrdinaryPage(recovered, reader(null, page(1, "p1"), requested), open))
            assertEquals(listOf<String?>(null), requested)
        }
    }

    @Test fun ROOM04_exactContiguousReceiptReleasesOnlyItsOwnPendingPayload() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            val beforeFirst = f.snapshot().map { it.id }.toSet()
            val first = stage(s, owner, 1, null, "p1")
            val firstPayload = f.snapshot().filter { it.kind == BlobKind.PAYLOAD.stored && it.id !in beforeFirst }
            assertEquals(1, firstPayload.size)
            val beforeSecond = f.snapshot().map { it.id }.toSet()
            val second = stage(s, owner, 2, "p1", "p2")
            val secondPayload = f.snapshot().filter { it.kind == BlobKind.PAYLOAD.stored && it.id !in beforeSecond }
            assertEquals(1, secondPayload.size)
            assertArrayEquals(wire(1), checkNotNull(pending(s, owner)).copyWire())
            val fullBefore = f.snapshot()
            // A future receipt, foreign binding or changed digest cannot release the oldest batch.
            assertTrue(s.queue.acknowledge(owner, first, receipt(s, 2), open) is Blocked)
            assertEquals(fullBefore, f.snapshot())
            for (key in listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "generation", "restoreEpoch")) {
                val wrong = JSONObject(vector(1).getString("receipt"))
                wrong.getJSONObject("binding").put(key, if (key == "generation") "2" else "foreign-field")
                assertTrue(s.queue.acknowledge(owner, first,
                    s.protocol.decode(wrong.toString().toByteArray(Charsets.UTF_8)), open) is Blocked)
                assertEquals(fullBefore, f.snapshot())
            }
            val wrongDigest = JSONObject(vector(1).getString("receipt"))
                .put("payloadDigest", "sha256:" + "0".repeat(64))
            assertTrue(s.queue.acknowledge(owner, first,
                s.protocol.decode(wrongDigest.toString().toByteArray(Charsets.UTF_8)), open) is Blocked)
            assertEquals(fullBefore, f.snapshot())
            ok(s.queue.acknowledge(owner, first, receipt(s, 1), open))
            assertFalse(f.snapshot().any { it.id == firstPayload.single().id })
            assertTrue(f.snapshot().any { it == secondPayload.single() })
            assertTrue(f.snapshot().any { it.kind == BlobKind.STATE.stored })
            assertTrue(f.snapshot().any { it.kind == BlobKind.CURSOR.stored })
            assertArrayEquals(wire(2), checkNotNull(pending(s, owner)).copyWire())
            val afterFirst = f.snapshot()
            ok(s.queue.acknowledge(owner, first, receipt(s, 1), open))
            assertEquals(afterFirst, f.snapshot())
            s.reopen()
            val recovered = s.owner()
            assertEquals(afterFirst, f.snapshot())
            assertArrayEquals(second.copyWire(), checkNotNull(pending(s, recovered)).copyWire())
            ok(s.queue.acknowledge(recovered, second, receipt(s, 2), open))
            assertNull(pending(s, recovered))
            assertFalse(f.snapshot().any { it.id == secondPayload.single().id })
            val done = f.snapshot()
            s.reopen()
            assertNull(pending(s, s.owner()))
            assertEquals(done, f.snapshot())
        }
    }

    @Test fun ROOM05_emptyStringAndTerminalNullStayLocalWithoutAnEmptyBatch() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            stage(s, owner, 1, null, "p1")
            val prepared = ok(s.queue.prepareOrdinaryPage(owner,
                reader("p1", OrdinaryRecordPage(emptyList(), "")), open))
            val initialPayloads = f.snapshot().filter { it.kind == BlobKind.PAYLOAD.stored }
            assertEquals(1, initialPayloads.size)
            assertArrayEquals(wire(1), checkNotNull(pending(s, owner)).copyWire())
            var callbacks = 0
            val staged = ok(s.queue.stagePage(owner, prepared, false, open) { _, _ ->
                callbacks++; error("An empty local page must not construct an empty upload")
            })
            assertNull(staged.batch)
            assertEquals(0, callbacks)
            assertEquals(listOf("native-batch-1"), s.ids)
            assertEquals(initialPayloads, f.snapshot().filter { it.kind == BlobKind.PAYLOAD.stored })
            assertArrayEquals(wire(1), checkNotNull(pending(s, owner)).copyWire())
            s.reopen()
            val recovered = s.owner()
            val requested = mutableListOf<String?>()
            val terminal = ok(s.queue.prepareOrdinaryPage(recovered,
                reader("", OrdinaryRecordPage(emptyList(), null), requested), open))
            assertEquals(listOf(""), requested)
            assertNull(ok(s.queue.stagePage(recovered, terminal, false, open) { _, _ ->
                callbacks++; error("A terminal empty page must not construct an empty upload")
            }).batch)
            assertEquals(0, callbacks)
            assertEquals(listOf("native-batch-1"), s.ids)
            assertArrayEquals(wire(1), checkNotNull(pending(s, recovered)).copyWire())
            assertEquals(initialPayloads, f.snapshot().filter { it.kind == BlobKind.PAYLOAD.stored })
            val terminalRows = f.snapshot()
            s.reopen()
            val terminalOwner = s.owner()
            var readsAfterTerminal = 0
            val noRead = object : OrdinaryRecordReader {
                override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                    readsAfterTerminal++
                    error("The existing terminal scan cannot restart its provider query without a fresh scan")
                }
            }
            // Refusal or a cached terminal result is acceptable; another provider read is not.
            s.queue.prepareOrdinaryPage(terminalOwner, noRead, open)
            assertEquals(0, readsAfterTerminal)
            assertEquals(terminalRows, f.snapshot())
            assertArrayEquals(wire(1), checkNotNull(pending(s, terminalOwner)).copyWire())
            assertEquals(listOf("native-batch-1"), s.ids)
        }
    }

    @Test fun ROOM06_controlledLostReplyRetainsRealRoomBytesForFreshSameBindingRetry() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val owner = s.owner()
            stage(s, owner, 1, null, "p1")
            val before = f.snapshot()
            val sent = ByteArrayOutputStream()
            var replies = 0
            val transport = PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
                object : HttpsURLConnection(url) {
                    override fun connect() {}
                    override fun disconnect() {}
                    override fun usingProxy() = false
                    override fun getCipherSuite() = "TLS_TEST"
                    override fun getLocalCertificates(): Array<Certificate>? = null
                    override fun getServerCertificates(): Array<Certificate> = emptyArray()
                    override fun getOutputStream() = sent
                    override fun getResponseCode(): Int {
                        assertArrayEquals("A lost-reply result requires the original complete outgoing bytes", wire(1), sent.toByteArray())
                        replies++
                        throw IOException("invented-lost-reply-after-write")
                    }
                }
            }
            val result = ImmutableBatchCoordinator(s.queue, s.protocol, s.session, open)
                .uploadNext(owner, transport)
            assertEquals(1, replies)
            assertTrue(result is Blocked)
            assertEquals(before, f.snapshot())
            assertEquals(listOf("native-batch-1"), s.ids)
            // Protocol failure cleared transient pairing; a fresh same-binding fixture recaptures authority.
            installSyntheticPairing(s.session)
            s.reopen()
            val recovered = s.owner()
            assertEquals(before, f.snapshot())
            assertArrayEquals(wire(1), checkNotNull(pending(s, recovered)).copyWire())
            assertEquals(listOf("native-batch-1"), s.ids)
        }
    }

    companion object {
        private fun <T> ok(result: QueueResult<T>): T {
            assertTrue("Expected typed success, got $result", result is Ok<*>)
            @Suppress("UNCHECKED_CAST") return (result as Ok<T>).value
        }
        private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
