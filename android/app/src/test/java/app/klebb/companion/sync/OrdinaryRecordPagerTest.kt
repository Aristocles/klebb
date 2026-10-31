// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.Ok
import app.klebb.companion.records.EncodedRecord
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class OrdinaryRecordPagerTest {
    private fun scope() = WeightReadScope(Instant.parse("2030-01-01T00:00:00Z"),
        Instant.parse("2030-01-02T00:00:00Z"), 2)
    private fun record(id: String, type: String = "WeightRecord") =
        EncodedRecord(type, id, "{\"metadata\":{\"id\":\"$id\"},\"value\":\"75.25\"}")
    private fun page(ids: List<String>, next: String?) = OrdinaryRecordPage(ids.map { record(it) }, next)
    private fun reader(read: suspend (WeightReadScope, String?) -> OrdinaryRecordPage) =
        object : OrdinaryRecordReader {
            override suspend fun readPage(scope: WeightReadScope, pageToken: String?) = read(scope, pageToken)
        }
    private fun incomplete(result: PageScanResult, reason: ScanStop): PageScanResult.Incomplete {
        assertTrue("must remain incomplete", result is PageScanResult.Incomplete)
        return (result as PageScanResult.Incomplete).also { assertEquals(reason, it.reason) }
    }

    @Test fun PAGE01_completeTwoPages() = runBlocking<Unit> {
        val query = scope()
        val tokens = mutableListOf<String?>()
        val accepted = mutableListOf<String>()
        val texts = mutableListOf<String>()
        val pager = OrdinaryRecordPager(reader { actual, token ->
            assertSame(query, actual)
            tokens.add(token)
            if (token == null) page(listOf("a", "b"), "p1")
            else { assertEquals("p1", token); page(listOf("c"), null) }
        })
        val result = pager.scan(query, 3, { ReadGate.OPEN }) { records ->
            accepted.addAll(records.records.map { it.nativeRecordId })
            texts.addAll(records.records.map { it.recordJson })
            Ok(Unit)
        }
        // The healthy one-page baseline reaches this ordinary assertion with [a,b].
        assertEquals(listOf("a", "b", "c"), accepted)
        assertEquals(listOf(null, "p1"), tokens)
        assertEquals(listOf(
            "{\"metadata\":{\"id\":\"a\"},\"value\":\"75.25\"}",
            "{\"metadata\":{\"id\":\"b\"},\"value\":\"75.25\"}",
            "{\"metadata\":{\"id\":\"c\"},\"value\":\"75.25\"}"), texts)
        assertTrue(result is PageScanResult.Finished)
        assertEquals(2, result.pages)
        assertEquals(3L, result.recordCount)
    }

    @Test fun PAGE02_permissionDeniedMakesNoRead() = runBlocking<Unit> {
        var reads = 0
        var accepts = 0
        val result = OrdinaryRecordPager(reader { _, _ -> reads++; page(emptyList(), null) })
            .scan(scope(), 3, { ReadGate.PERMISSION_DENIED }) { accepts++; Ok(Unit) }
        incomplete(result, ScanStop.PERMISSION_DENIED)
        assertEquals(0, reads)
        assertEquals(0, accepts)
    }

    @Test fun PAGE03_revocationBeforeNextPageStops() = runBlocking<Unit> {
        var permission = ReadGate.OPEN
        var reads = 0
        val accepted = mutableListOf<String>()
        val result = OrdinaryRecordPager(reader { _, _ -> reads++; page(listOf("a", "b"), "p1") })
            .scan(scope(), 3, { permission }) {
                accepted.addAll(it.records.map { record -> record.nativeRecordId })
                permission = ReadGate.PERMISSION_DENIED
                Ok(Unit)
            }
        incomplete(result, ScanStop.PERMISSION_DENIED)
        assertEquals(1, reads)
        assertEquals(listOf("a", "b"), accepted)
        assertEquals(1, result.pages)
    }

    @Test fun PAGE04_repeatedTokenIsIncomplete() = runBlocking<Unit> {
        val tokens = mutableListOf<String?>()
        val accepted = mutableListOf<String>()
        val result = OrdinaryRecordPager(reader { _, token ->
            tokens.add(token)
            if (token == null) page(listOf("a", "b"), "p1") else page(listOf("c"), "p1")
        }).scan(scope(), 3, { ReadGate.OPEN }) {
            accepted.addAll(it.records.map { record -> record.nativeRecordId }); Ok(Unit)
        }
        incomplete(result, ScanStop.PAGE_CYCLE)
        assertEquals(listOf(null, "p1"), tokens)
        assertEquals(listOf("a", "b"), accepted)
        assertEquals(1, result.pages)
    }

    @Test fun PAGE05_acceptanceFailureDoesNotReadAhead() = runBlocking<Unit> {
        var reads = 0
        var accepts = 0
        val tokens = mutableListOf<String?>()
        val result = OrdinaryRecordPager(reader { _, token ->
            tokens.add(token); reads++; page(listOf("a", "b"), "p1")
        })
            .scan(scope(), 3, { ReadGate.OPEN }) {
                accepts++; Blocked("queue-unavailable", "storage-failed")
            }
        val stopped = incomplete(result, ScanStop.STORAGE_UNAVAILABLE)
        assertEquals(Blocked("queue-unavailable", "storage-failed"), stopped.storageFailure)
        assertEquals(1, reads)
        assertEquals(1, accepts)
        assertEquals(0, result.pages)
        assertEquals(listOf<String?>(null), tokens)
    }

    @Test fun PAGE06_changedFenceAfterReadDoesNotPublish() = runBlocking<Unit> {
        var fence = ReadGate.OPEN
        var accepts = 0
        val result = OrdinaryRecordPager(reader { _, _ ->
            fence = ReadGate.STALE_BINDING; page(listOf("a"), null)
        }).scan(scope(), 3, { fence }) { accepts++; Ok(Unit) }
        incomplete(result, ScanStop.STALE_BINDING)
        assertEquals(0, accepts)
        assertEquals(0, result.pages)
    }

    @Test fun PAGE07_cancellationDuringReadIsPropagated() = runBlocking<Unit> {
        val entered = CompletableDeferred<Unit>()
        val response = CompletableDeferred<OrdinaryRecordPage>()
        var accepts = 0
        val scan = async {
            OrdinaryRecordPager(reader { _, _ -> entered.complete(Unit); response.await() })
                .scan(scope(), 3, { ReadGate.OPEN }) { accepts++; Ok(Unit) }
        }
        entered.await()
        scan.cancel()
        response.complete(page(listOf("a"), null))
        try { scan.await(); fail("cancellation must propagate") } catch (_: CancellationException) { }
        assertEquals(0, accepts)
    }

    @Test fun PAGE08_nonAlignedScopeMakesNoRead() = runBlocking<Unit> {
        var reads = 0
        val unsupported = WeightReadScope(Instant.parse("2030-01-01T00:00:00.000000001Z"),
            Instant.parse("2030-01-02T00:00:00Z"))
        val result = OrdinaryRecordPager(reader { _, _ -> reads++; page(emptyList(), null) })
            .scan(unsupported, 3, { ReadGate.OPEN }) { fail("unsupported query must not stage"); Ok(Unit) }
        incomplete(result, ScanStop.INVALID_QUERY)
        assertEquals(0, reads)
    }

    @Test fun PAGE09_boundExhaustionStaysIncomplete() = runBlocking<Unit> {
        var reads = 0
        val result = OrdinaryRecordPager(reader { _, _ -> reads++; page(listOf("a", "b"), "p1") })
            .scan(scope(), 1, { ReadGate.OPEN }) { Ok(Unit) }
        incomplete(result, ScanStop.PAGE_LIMIT)
        assertEquals(1, reads)
        assertEquals(1, result.pages)
        assertEquals(2L, result.recordCount)
    }

    @Test fun PAGE10_wrongRecordTypeRefusesWholePage() = runBlocking<Unit> {
        var accepts = 0
        val result = OrdinaryRecordPager(reader { _, _ ->
            OrdinaryRecordPage(listOf(record("a"), record("wrong", "StepsRecord")), null)
        }).scan(scope(), 3, { ReadGate.OPEN }) { accepts++; Ok(Unit) }
        incomplete(result, ScanStop.WRONG_RECORD_TYPE)
        assertEquals(0, accepts)
        assertEquals(0, result.pages)
    }
}
