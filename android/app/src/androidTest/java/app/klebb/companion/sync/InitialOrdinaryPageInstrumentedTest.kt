// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.queue.BlobKind
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.EncryptedBlobStore
import app.klebb.companion.queue.KeystoreQueueCipher
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.queue.QueueStorageNativeFixture
import app.klebb.companion.records.EncodedRecord
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Existing Room/Keystore fixture with independently fixed invented page/token inputs. */
@RunWith(AndroidJUnit4::class)
class InitialOrdinaryPageInstrumentedTest {
    private val open = { ReadGate.OPEN }
    private val types = listOf("WeightRecord", "StepsRecord")
    private fun asset(name: String): String =
        InstrumentationRegistry.getInstrumentation().context.assets.open(name)
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
    private fun query(type: String): WeightReadScope = if (type == "WeightRecord") {
        WeightReadScope(Instant.parse("2001-02-03T00:00:00Z"), Instant.parse("2001-02-04T00:00:00Z"), 2)
    } else {
        WeightReadScope(Instant.parse("2001-10-28T00:00:00Z"), Instant.parse("2001-10-29T00:00:00Z"), 2)
    }
    private fun token(type: String) = if (type == "WeightRecord") {
        "fixed-initial-changes-weight-01"
    } else {
        "fixed-initial-changes-steps-01"
    }
    private fun page(type: String, next: String?): OrdinaryRecordPage {
        val key = if (type == "WeightRecord") "weightFull" else "stepsFull"
        val record = JSONObject(asset("initial-page-record-codecs-v1.json")).getJSONObject(key)
        return OrdinaryRecordPage(listOf(EncodedRecord(type,
            record.getJSONObject("metadata").getString("id"), record.toString())), next)
    }
    private class Subject(
        val fixture: QueueStorageNativeFixture,
        val protocol: HealthProtocol,
        val session: InMemoryPairingSession,
        val queue: RoomDurableBatchQueue
    )
    private fun subject(f: QueueStorageNativeFixture, rows: Long = 100L): Subject {
        val protocol = HealthProtocol(InstrumentationRegistry.getInstrumentation().targetContext.assets
            .open("protocol-v1.schema.json").use { it.readBytes() })
        val source = JSONObject(asset("room-durable-batch-inputs-v1.json"))
        val session = InMemoryPairingSession(protocol, { Instant.parse("2026-10-28T03:55:00Z") }, { "install-a" })
        val grant = JSONObject(source.getString("grant"))
        grant.put("categories", org.json.JSONArray(types))
        val paired = JSONObject(source.getString("paired"))
        paired.put("categories", org.json.JSONArray(types))
        paired.put("streams", JSONObject()
            .put("WeightRecord", JSONObject().put("generation", "1").put("acknowledgedSequence", "0"))
            .put("StepsRecord", JSONObject().put("generation", "1").put("acknowledgedSequence", "0")))
        session.approveDestination("https://health.example.test")
        session.prepareGrant(grant.toString().toByteArray(Charsets.UTF_8))
        session.acceptPairing(session.beginExchange(), paired.toString().toByteArray(Charsets.UTF_8))
        assertEquals(types.toSet(), session.categories)
        val queue = RoomDurableBatchQueue(f.db, KeystoreQueueCipher(f.alias), protocol, session,
            rows, 4_194_304L, { "fixed-first-page-batch" })
        return Subject(f, protocol, session, queue)
    }
    private fun owner(s: Subject, type: String): BatchOwner =
        ok(s.queue.openStream("fixed-first-page-$type", type, 17L, query(type), open))
    private fun reader(type: String, answer: OrdinaryRecordPage, events: MutableList<String>) =
        object : OrdinaryRecordReader {
            override val recordType = type
            override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                events.add("read")
                assertEquals(query(type).start, scope.start)
                assertEquals(query(type).end, scope.end)
                assertEquals(2, scope.pageSize)
                assertNull(pageToken)
                return answer
            }
        }
    private suspend fun prepare(s: Subject, o: BatchOwner, page: OrdinaryRecordPage,
        events: MutableList<String>): PreparedOrdinaryPage =
        ok(s.queue.prepareFirstOrdinaryPage(o, reader(o.recordType, page, events), {
            events.add("token")
            token(o.recordType)
        }, open))
    private fun ack(s: Subject, o: BatchOwner): String {
        val row = s.fixture.snapshot().single { it.kind == BlobKind.STATE.stored &&
            s.fixture.db.blobs().find(it.id)?.localStreamId == o.localStreamId }
        val bytes = checkNotNull(ok(EncryptedBlobStore(s.fixture.db,
            KeystoreQueueCipher(s.fixture.alias)).read(row.id)))
        return JSONObject(String(bytes, Charsets.UTF_8)).getString("acknowledged")
    }
    private fun stage(s: Subject, o: BatchOwner, prepared: PreparedOrdinaryPage): StageReceipt =
        ok(ImmutableBatchCoordinator(s.queue, s.protocol, s.session, open)
            .stagePage(o, prepared.page, prepared))

    @Test fun FIRST01_fixedTokenAndCompletePageSurviveRealReopenForBothTypes() = runBlocking<Unit> {
        for (type in types) QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val o = owner(s, type)
            val next = if (type == "WeightRecord") "opaque-next" else ""
            val answer = page(type, next)
            val events = mutableListOf<String>()
            assertEquals("0", ack(s, o))
            val prepared = prepare(s, o, answer, events)
            assertEquals(listOf("token", "read"), events)
            assertNull(ok(s.queue.committedFirstPage(o, open)))
            val result = stage(s, o, prepared)
            assertEquals("0", ack(s, o))
            val commit = checkNotNull(result.firstPage)
            assertEquals(token(type), commit.initialChangesToken)
            assertEquals(1L, commit.recordCount)
            assertEquals(next, commit.nextPageToken)
            assertFalse(commit.terminalPage)
            assertTrue(ok(s.queue.acceptsFirstPageCommit(o, commit, open)))
            val bytes = checkNotNull(result.batch).copyWire()
            val payload = JSONObject(s.protocol.decode(bytes).fields["payloadJson"] as String)
            assertEquals(answer.records.single().recordJson,
                payload.getJSONArray("changes").getJSONObject(0).getJSONObject("record").toString())
            assertEquals("1", payload.getString("sequence"))
            val before = f.snapshot()
            f.reopen()
            val recovered = subject(f)
            val recoveredOwner = owner(recovered, type)
            val stored = checkNotNull(ok(recovered.queue.committedFirstPage(recoveredOwner, open)))
            assertEquals(token(type), stored.initialChangesToken)
            assertEquals(1L, stored.recordCount)
            assertEquals(next, stored.nextPageToken)
            assertTrue(ok(recovered.queue.acceptsFirstPageCommit(recoveredOwner, stored, open)))
            assertTrue(recovered.queue.acceptsFirstPageCommit(recoveredOwner, commit, open) is Blocked)
            assertArrayEquals(bytes, checkNotNull(ok(recovered.queue.nextPending(recoveredOwner, open))).copyWire())
            assertEquals(before, f.snapshot())
            assertEquals("0", ack(recovered, recoveredOwner))
        }
    }

    @Test fun FIRST02_realEmptyPageStillCommitsTokenAndCheckpointWithoutBatch() = runBlocking<Unit> {
        for (type in types) QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val o = owner(s, type)
            val events = mutableListOf<String>()
            val result = stage(s, o, prepare(s, o, OrdinaryRecordPage(emptyList(), null), events))
            assertEquals(listOf("token", "read"), events)
            assertNull(result.batch)
            assertNull(ok(s.queue.nextPending(o, open)))
            val stored = checkNotNull(ok(s.queue.committedFirstPage(o, open)))
            assertEquals(0L, stored.recordCount)
            assertEquals(token(type), stored.initialChangesToken)
            assertTrue(stored.terminalPage)
            assertEquals(3, f.snapshot().size)
            assertEquals("0", ack(s, o))
            assertTrue(ok(s.queue.acceptsFirstPageCommit(o, stored, open)))
            val before = f.snapshot()
            f.reopen()
            val recovered = subject(f)
            val recoveredOwner = owner(recovered, type)
            val reopened = checkNotNull(ok(recovered.queue.committedFirstPage(recoveredOwner, open)))
            assertEquals(token(type), reopened.initialChangesToken)
            assertEquals(0L, reopened.recordCount)
            assertTrue(reopened.terminalPage)
            assertTrue(ok(recovered.queue.acceptsFirstPageCommit(recoveredOwner, reopened, open)))
            assertNull(ok(recovered.queue.nextPending(recoveredOwner, open)))
            assertEquals("0", ack(recovered, recoveredOwner))
            assertEquals(before, f.snapshot())
        }
    }

    @Test fun FIRST03_deniedGateCallsNeitherTokenNorReaderAndDoesNotChangeSibling() = runBlocking<Unit> {
        for (type in types) QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val target = owner(s, type)
            val siblingType = types.single { it != type }
            val sibling = owner(s, siblingType)
            val siblingReceipt = stage(s, sibling,
                prepare(s, sibling, page(siblingType, "opaque-next"), mutableListOf()))
            val siblingBytes = checkNotNull(siblingReceipt.batch).copyWire()
            val before = f.snapshot()
            val events = mutableListOf<String>()
            val result = s.queue.prepareFirstOrdinaryPage(target,
                reader(type, page(type, null), events), {
                    events.add("token")
                    token(type)
                }, { ReadGate.PERMISSION_DENIED })
            assertTrue(result is Blocked)
            assertEquals("permission-denied", (result as Blocked).cause)
            assertTrue(events.isEmpty())
            assertNull(ok(s.queue.committedFirstPage(target, open)))
            assertTrue(ok(s.queue.acceptsFirstPageCommit(sibling,
                checkNotNull(siblingReceipt.firstPage), open)))
            assertArrayEquals(siblingBytes, checkNotNull(ok(s.queue.nextPending(sibling, open))).copyWire())
            assertEquals("0", ack(s, target))
            assertEquals("0", ack(s, sibling))
            assertEquals(before, f.snapshot())
        }
    }

    @Test fun FIRST04_uncommittedForgedAndForeignReceiptsCannotBeAdmitted() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f)
            val weight = owner(s, "WeightRecord")
            val steps = owner(s, "StepsRecord")
            val prepared = prepare(s, weight, page("WeightRecord", null), mutableListOf())
            val before = f.snapshot()
            assertNull(ok(s.queue.committedFirstPage(weight, open)))
            val forged = FirstPageCommit.issue(Any(), weight, query("WeightRecord"),
                token("WeightRecord"), 1L, null)
            assertTrue(s.queue.acceptsFirstPageCommit(weight, forged, open) is Blocked)
            assertEquals(before, f.snapshot())
            val commit = checkNotNull(stage(s, weight, prepared).firstPage)
            val afterWeight = f.snapshot()
            assertTrue(s.queue.acceptsFirstPageCommit(steps, commit, open) is Blocked)
            assertNull(ok(s.queue.committedFirstPage(steps, open)))
            assertEquals(afterWeight, f.snapshot())
        }
    }

    @Test fun FIRST05_initialMetadataConsumesExistingCapAndWholeStageRollsBack() = runBlocking<Unit> {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val s = subject(f, rows = 3L)
            val o = owner(s, "WeightRecord")
            val prepared = prepare(s, o, page("WeightRecord", null), mutableListOf())
            val before = f.snapshot()
            val refused = ImmutableBatchCoordinator(s.queue, s.protocol, s.session, open)
                .stagePage(o, prepared.page, prepared)
            assertTrue(refused is Blocked)
            assertEquals(before, f.snapshot())
            assertNull(ok(s.queue.committedFirstPage(o, open)))
            assertNull(ok(s.queue.nextPending(o, open)))
        }
    }

    companion object {
        private fun <T> ok(value: QueueResult<T>): T {
            assertTrue("Expected original healthy fixture, got $value", value is Ok<*>)
            @Suppress("UNCHECKED_CAST") return (value as Ok<T>).value
        }
    }
}
