// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.units.Mass
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.sync.HealthConnectRecordReader
import app.klebb.companion.sync.WeightReadScope
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class HealthConnectRecordReaderTest {
    @Test fun ADAPTER01_weightRequestAndExposedPayload() = runBlocking<Unit> {
        var captured: ReadRecordsRequest<WeightRecord>? = null
        val record = WeightRecord(Instant.parse("2001-02-03T04:05:06.123456789Z"),
            ZoneOffset.of("+05:45"), Mass.kilograms(75.25), NativeMetadataFixture.full())
        val reader = HealthConnectRecordReader { request ->
            captured = request
            ReadRecordsResponse(listOf(record), "opaque-next")
        }
        val scope = WeightReadScope(Instant.parse("2001-02-03T00:00:00Z"),
            Instant.parse("2001-02-04T00:00:00Z"), 2)
        val page = reader.readPage(scope, "opaque-before")
        val request = checkNotNull(captured)
        assertEquals(WeightRecord::class, request.recordType)
        assertEquals(scope.start, request.timeRangeFilter.startTime)
        assertEquals(scope.end, request.timeRangeFilter.endTime)
        assertNull(request.timeRangeFilter.localStartTime)
        assertNull(request.timeRangeFilter.localEndTime)
        assertTrue(request.dataOriginFilter.isEmpty())
        assertTrue(request.ascendingOrder)
        assertEquals(2, request.pageSize)
        assertEquals("opaque-before", request.pageToken)
        assertEquals("opaque-next", page.nextPageToken)
        assertEquals("synthetic-provider-id", page.records.single().nativeRecordId)
        assertEquals("WeightRecord", page.records.single().recordType)
        val expected = checkNotNull(javaClass.classLoader!!.getResourceAsStream("record-codecs-v1.json"))
            .use { StrictJson.parse(it.readBytes()) as Map<*, *> }["weightFull"]
        assertEquals(expected, StrictJson.parse(page.records.single().recordJson.toByteArray()))
    }
}
