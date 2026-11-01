// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.time.TimeRangeFilter
import app.klebb.companion.records.RecordCodecs
import app.klebb.companion.setup.CategoryAdapter
import app.klebb.companion.setup.CategoryAvailability
import app.klebb.companion.setup.CategorySetup
import app.klebb.companion.setup.CategoryState
import app.klebb.companion.setup.CategoryTruth
import kotlin.coroutines.cancellation.CancellationException
import kotlin.reflect.KClass

enum class OrdinaryReaderBlock {
    UNSUPPORTED_CATEGORY, NOT_SELECTED, PERMISSION_UNKNOWN, PERMISSION_DENIED,
    AVAILABILITY_UNKNOWN, CATEGORY_UNAVAILABLE, FEATURE_UNKNOWN, FEATURE_UNAVAILABLE
}

sealed class OrdinaryReaderChoice {
    class Ready(val reader: OrdinaryRecordReader) : OrdinaryReaderChoice()
    class Blocked(val reason: OrdinaryReaderBlock) : OrdinaryReaderChoice()
}

/** A setup precondition only; native permission/fence checks and page acceptance stay with callers. */
object OrdinaryRecordReaderFactory {
    fun create(client: HealthConnectClient, state: CategoryState): OrdinaryReaderChoice =
        create(state, { feature -> client.features.getFeatureStatus(feature) }) { adapter ->
            nativeReader(client, adapter.recordType)
        }

    internal fun create(
        state: CategoryState,
        featureStatus: (Int) -> Int,
        createReader: (CategoryAdapter) -> OrdinaryRecordReader
    ): OrdinaryReaderChoice {
        val adapter = CategorySetup.registry[state.adapter.name]
        if (adapter == null || adapter != state.adapter) {
            return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.UNSUPPORTED_CATEGORY)
        }
        if (!state.selected) return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.NOT_SELECTED)
        when (state.permitted) {
            CategoryTruth.UNKNOWN -> return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.PERMISSION_UNKNOWN)
            CategoryTruth.NO -> return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.PERMISSION_DENIED)
            CategoryTruth.YES -> Unit
        }
        when (state.available) {
            CategoryAvailability.UNKNOWN -> return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.AVAILABILITY_UNKNOWN)
            CategoryAvailability.UNAVAILABLE -> return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.CATEGORY_UNAVAILABLE)
            CategoryAvailability.AVAILABLE -> Unit
        }
        val feature = requiredFeature(adapter.recordType)
        if (feature != null) {
            val status = try {
                featureStatus(feature)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.FEATURE_UNKNOWN)
            }
            when (status) {
                HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE ->
                    return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.FEATURE_UNAVAILABLE)
                HealthConnectFeatures.FEATURE_STATUS_AVAILABLE -> Unit
                else -> return OrdinaryReaderChoice.Blocked(OrdinaryReaderBlock.FEATURE_UNKNOWN)
            }
        }
        val reader = createReader(adapter)
        check(reader.recordType == adapter.name) { "Reader type must match the selected category" }
        return OrdinaryReaderChoice.Ready(reader)
    }

    private fun requiredFeature(recordType: KClass<out Record>): Int? = when (recordType) {
        SkinTemperatureRecord::class -> HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE
        PlannedExerciseSessionRecord::class -> HealthConnectFeatures.FEATURE_PLANNED_EXERCISE
        MindfulnessSessionRecord::class -> HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION
        ActivityIntensityRecord::class -> HealthConnectFeatures.FEATURE_ACTIVITY_INTENSITY
        else -> null
    }

    private fun <T : Record> nativeReader(
        client: HealthConnectClient,
        recordType: KClass<T>
    ): OrdinaryRecordReader = TypedHealthConnectRecordReader(recordType) { request ->
        client.readRecords(request)
    }
}

/** Inert typed SDK adapter; no aggregates, field rewriting or additional route authority. */
internal class TypedHealthConnectRecordReader<T : Record>(
    private val nativeRecordType: KClass<T>,
    private val readNative: suspend (ReadRecordsRequest<T>) -> ReadRecordsResponse<T>
) : OrdinaryRecordReader {
    override val recordType: String = requireNotNull(nativeRecordType.simpleName)

    init {
        require(recordType in RecordCodecs.supportedRecordTypes &&
            CategorySetup.registry[recordType]?.recordType == nativeRecordType) {
            "Unsupported ordinary record type"
        }
    }

    override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
        require(scope.supported())
        // The public constructor preserves all producers and disables SDK deduplication.
        val request = ReadRecordsRequest(
            recordType = nativeRecordType,
            timeRangeFilter = TimeRangeFilter.between(scope.start, scope.end),
            dataOriginFilter = emptySet(),
            ascendingOrder = true,
            pageSize = scope.pageSize,
            pageToken = pageToken
        )
        val page = readNative(request)
        val encoded = page.records.map { record ->
            if (!nativeRecordType.java.isInstance(record)) throw WrongRecordTypeException()
            RecordCodecs.encode(record).also {
                if (it.recordType != recordType) throw WrongRecordTypeException()
            }
        }
        // A failed encoder refuses the entire page before a checkpoint can be accepted.
        return OrdinaryRecordPage(encoded, page.pageToken)
    }
}
