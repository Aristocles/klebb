// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.records.EncodedRecord
import java.time.Instant
import java.util.Collections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** A point-record query. It does not declare readable-history or absence coverage. */
class WeightReadScope(val start: Instant, val end: Instant, val pageSize: Int = 100) {
    internal fun supported(): Boolean = start.isBefore(end) && pageSize in 1..500 &&
        start.nano % 1_000_000 == 0 && end.nano % 1_000_000 == 0
    override fun toString() = "WeightReadScope"
}

class OrdinaryRecordPage(records: List<EncodedRecord>, val nextPageToken: String?) {
    val records: List<EncodedRecord> = Collections.unmodifiableList(ArrayList(records))
    override fun toString() = "OrdinaryRecordPage(${records.size} records)"
}

interface OrdinaryRecordReader {
    suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage
}

enum class ReadGate { OPEN, PERMISSION_DENIED, STALE_BINDING }
enum class ScanStop {
    INVALID_QUERY, PERMISSION_DENIED, PERMISSION_UNKNOWN, STALE_BINDING,
    READER_UNAVAILABLE, WRONG_RECORD_TYPE, STORAGE_UNAVAILABLE, PAGE_CYCLE, PAGE_LIMIT
}

sealed class PageScanResult(val pages: Int, val recordCount: Long) {
    class Finished(pages: Int, recordCount: Long) : PageScanResult(pages, recordCount)
    class Incomplete(val reason: ScanStop, pages: Int, recordCount: Long,
        val storageFailure: Blocked? = null) : PageScanResult(pages, recordCount)
}

/** Pagination only. Finished does not mean complete native coverage or Cloud acknowledgement. */
class OrdinaryRecordPager(private val reader: OrdinaryRecordReader) {
    suspend fun scan(scope: WeightReadScope, maximumPages: Int,
        gate: suspend () -> ReadGate,
        acceptPage: suspend (OrdinaryRecordPage) -> QueueResult<Unit>): PageScanResult {
        require(maximumPages > 0)
        if (!scope.supported()) return PageScanResult.Incomplete(ScanStop.INVALID_QUERY, 0, 0)
        var pages = 0
        var records = 0L
        var token: String? = null
        val requested = mutableSetOf<String>()
        while (pages < maximumPages) {
            checkpoint(gate)?.let { return PageScanResult.Incomplete(it, pages, records) }
            if (token != null && !requested.add(token)) {
                return PageScanResult.Incomplete(ScanStop.PAGE_CYCLE, pages, records)
            }
            val page = try {
                reader.readPage(scope, token)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return PageScanResult.Incomplete(ScanStop.READER_UNAVAILABLE, pages, records)
            }
            checkpoint(gate)?.let { return PageScanResult.Incomplete(it, pages, records) }
            if (page.records.any { it.recordType != "WeightRecord" }) {
                return PageScanResult.Incomplete(ScanStop.WRONG_RECORD_TYPE, pages, records)
            }
            if (page.nextPageToken != null && page.nextPageToken in requested) {
                return PageScanResult.Incomplete(ScanStop.PAGE_CYCLE, pages, records)
            }
            // The receiver must check the captured fence at its atomic page/checkpoint commit.
            val saved = try {
                acceptPage(page)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return PageScanResult.Incomplete(ScanStop.STORAGE_UNAVAILABLE, pages, records)
            }
            if (saved is Blocked) {
                return PageScanResult.Incomplete(ScanStop.STORAGE_UNAVAILABLE, pages, records, saved)
            }
            check(saved is Ok<*>)
            pages++
            records += page.records.size
            checkpoint(gate)?.let { return PageScanResult.Incomplete(it, pages, records) }
            val next = page.nextPageToken ?: return PageScanResult.Finished(pages, records)
            token = next
        }
        return PageScanResult.Incomplete(ScanStop.PAGE_LIMIT, pages, records)
    }

    private suspend fun checkpoint(gate: suspend () -> ReadGate): ScanStop? = try {
        currentCoroutineContext().ensureActive()
        when (gate()) {
            ReadGate.OPEN -> null
            ReadGate.PERMISSION_DENIED -> ScanStop.PERMISSION_DENIED
            ReadGate.STALE_BINDING -> ScanStop.STALE_BINDING
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ScanStop.PERMISSION_UNKNOWN
    }
}
