// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.ExperimentalDeduplicationApi
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.units.Mass
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.queue.Ok
import app.klebb.companion.sync.*
import java.io.IOException
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Genuine SDK values at the existing inert reader seam; no provider is opened. */
class WeightSdkReaderBoundaryTest {
    private fun scope() = WeightReadScope(Instant.parse("2001-02-03T00:00:00Z"),
        Instant.parse("2001-02-04T00:00:00Z"), 2)
    private fun full() = WeightRecord(Instant.parse("2001-02-03T04:05:06.123456789Z"),
        ZoneOffset.of("+05:45"), Mass.kilograms(75.25), NativeMetadataFixture.full())
    private fun nullable() = WeightRecord(Instant.parse("2001-02-03T04:05:06.000000001Z"),
        null, Mass.kilograms(75.25), NativeMetadataFixture.nullableDeviceFields())
    private fun golden(name: String): Any? = checkNotNull(javaClass.classLoader!!
        .getResourceAsStream("record-codecs-v1.json")).use {
            checkNotNull((StrictJson.parse(it.readBytes()) as Map<*, *>)[name])
        }
    private fun stopped(result: PageScanResult, reason: ScanStop) {
        assertTrue(result is PageScanResult.Incomplete)
        assertEquals(reason, (result as PageScanResult.Incomplete).reason)
        assertEquals(0, result.pages)
        assertEquals(0L, result.recordCount)
    }
    @OptIn(ExperimentalDeduplicationApi::class)
    private fun request(actual: ReadRecordsRequest<WeightRecord>, token: String?) {
        assertEquals(WeightRecord::class, actual.recordType)
        assertEquals(Instant.parse("2001-02-03T00:00:00Z"), actual.timeRangeFilter.startTime)
        assertEquals(Instant.parse("2001-02-04T00:00:00Z"), actual.timeRangeFilter.endTime)
        assertNull(actual.timeRangeFilter.localStartTime)
        assertNull(actual.timeRangeFilter.localEndTime)
        assertTrue(actual.dataOriginFilter.isEmpty())
        assertTrue(actual.ascendingOrder)
        assertEquals(2, actual.pageSize)
        assertEquals(token, actual.pageToken)
        assertEquals(0, actual.deduplicateStrategy)
    }

    @Test fun WSDK01_twoNativePagesPreserveWholeIndependentGoldens() = runBlocking<Unit> {
        val requests = mutableListOf<ReadRecordsRequest<WeightRecord>>()
        val accepted = mutableListOf<EncodedRecord>()
        val reader = HealthConnectRecordReader { query ->
            requests.add(query)
            when (requests.size) {
                1 -> ReadRecordsResponse(listOf(full()), "synthetic-opaque-next-token")
                2 -> ReadRecordsResponse(listOf(nullable()), null)
                else -> error("unexpected read ahead")
            }
        }
        val result = OrdinaryRecordPager(reader).scan(scope(), 3, { ReadGate.OPEN }) {
            accepted.addAll(it.records); Ok(Unit)
        }
        assertEquals(2, requests.size)
        request(requests[0], null)
        request(requests[1], "synthetic-opaque-next-token")
        assertEquals(listOf("synthetic-provider-id", "synthetic-provider-id-device-null-fields"),
            accepted.map { it.nativeRecordId })
        assertEquals(listOf("WeightRecord", "WeightRecord"), accepted.map { it.recordType })
        assertEquals(listOf(golden("weightFull"), golden("weightNullableFields")),
            accepted.map { StrictJson.parse(it.recordJson.toByteArray(Charsets.UTF_8)) })
        assertTrue(result is PageScanResult.Finished)
        assertEquals(2, result.pages)
        assertEquals(2L, result.recordCount)
    }

    @Test fun WSDK02_freshGateAfterSdkAwaitRefusesNativeReply() = runBlocking<Unit> {
        for ((closed, expected) in listOf(ReadGate.PERMISSION_DENIED to ScanStop.PERMISSION_DENIED,
            ReadGate.STALE_BINDING to ScanStop.STALE_BINDING)) {
            var gate = ReadGate.OPEN
            var accepted = 0
            val entered = CompletableDeferred<ReadRecordsRequest<WeightRecord>>()
            val reply = CompletableDeferred<ReadRecordsResponse<WeightRecord>>()
            val reader = HealthConnectRecordReader { query -> entered.complete(query); reply.await() }
            val scan = async {
                OrdinaryRecordPager(reader).scan(scope(), 3, { gate }) { accepted++; Ok(Unit) }
            }
            request(entered.await(), null)
            gate = closed
            reply.complete(ReadRecordsResponse(listOf(full()), null))
            stopped(scan.await(), expected)
            assertEquals(0, accepted)
        }
    }

    @Test fun WSDK03_freshDeniedGateNeverEntersSdkRead() = runBlocking<Unit> {
        var reads = 0
        var accepted = 0
        val reader = HealthConnectRecordReader { reads++; ReadRecordsResponse(listOf(full()), null) }
        val result = OrdinaryRecordPager(reader).scan(scope(), 3, { ReadGate.PERMISSION_DENIED }) {
            accepted++; Ok(Unit)
        }
        stopped(result, ScanStop.PERMISSION_DENIED)
        assertEquals(0, reads)
        assertEquals(0, accepted)
    }

    @Test fun WSDK04_cancellationAndTransientReadFaultAreNotPermissionLoss() = runBlocking<Unit> {
        val entered = CompletableDeferred<Unit>()
        val reply = CompletableDeferred<ReadRecordsResponse<WeightRecord>>()
        var accepted = 0
        val scan = async {
            OrdinaryRecordPager(HealthConnectRecordReader { entered.complete(Unit); reply.await() })
                .scan(scope(), 3, { ReadGate.OPEN }) { accepted++; Ok(Unit) }
        }
        entered.await()
        scan.cancel()
        try { scan.await(); fail("SDK await cancellation must propagate") }
        catch (_: CancellationException) { }
        assertEquals(0, accepted)
        var gate = ReadGate.OPEN
        val result = OrdinaryRecordPager(HealthConnectRecordReader {
            throw IOException("synthetic SDK read failure")
        }).scan(scope(), 3, { gate }) { accepted++; Ok(Unit) }
        stopped(result, ScanStop.READER_UNAVAILABLE)
        assertEquals(ReadGate.OPEN, gate)
        assertEquals(0, accepted)
    }


}
