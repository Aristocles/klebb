// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.time.TimeRangeFilter
import app.klebb.companion.records.RecordCodecs

/** Inert adapter: its caller supplies permission/fence checks and durable page acceptance. */
class HealthConnectRecordReader internal constructor(
    private val readNative: suspend (ReadRecordsRequest<WeightRecord>) -> ReadRecordsResponse<WeightRecord>
) : OrdinaryRecordReader {
    constructor(client: HealthConnectClient) : this({ request -> client.readRecords(request) })

    override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
        require(scope.supported())
        // This public SDK constructor disables deduplication and leaves all producers readable.
        val request = ReadRecordsRequest(
            recordType = WeightRecord::class,
            timeRangeFilter = TimeRangeFilter.between(scope.start, scope.end),
            dataOriginFilter = emptySet(),
            ascendingOrder = true,
            pageSize = scope.pageSize,
            pageToken = pageToken
        )
        val page = readNative(request)
        // Any failed serializer refuses the entire page before its checkpoint can be accepted.
        return OrdinaryRecordPage(page.records.map { RecordCodecs.encode(it) }, page.pageToken)
    }
}
