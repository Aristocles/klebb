// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.ExperimentalDeduplicationApi
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.queue.Ok
import app.klebb.companion.setup.*
import app.klebb.companion.sync.*
import java.time.Instant
import java.time.ZoneOffset
import kotlin.reflect.KClass
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Literals are fixed from the pinned SDK declarations, not from factory output. */
class OrdinaryNativeReaderContractTest {
    private data class NativeCase(val type: KClass<out Record>, val permission: String,
        val requiredFeature: Int?)
    private val cases = listOf(
        NativeCase(ActiveCaloriesBurnedRecord::class, "android.permission.health.READ_ACTIVE_CALORIES_BURNED", null),
        NativeCase(ActivityIntensityRecord::class, "android.permission.health.READ_ACTIVITY_INTENSITY", 7),
        NativeCase(BasalBodyTemperatureRecord::class, "android.permission.health.READ_BASAL_BODY_TEMPERATURE", null),
        NativeCase(BasalMetabolicRateRecord::class, "android.permission.health.READ_BASAL_METABOLIC_RATE", null),
        NativeCase(BloodGlucoseRecord::class, "android.permission.health.READ_BLOOD_GLUCOSE", null),
        NativeCase(BloodPressureRecord::class, "android.permission.health.READ_BLOOD_PRESSURE", null),
        NativeCase(BodyFatRecord::class, "android.permission.health.READ_BODY_FAT", null),
        NativeCase(BodyTemperatureRecord::class, "android.permission.health.READ_BODY_TEMPERATURE", null),
        NativeCase(BodyWaterMassRecord::class, "android.permission.health.READ_BODY_WATER_MASS", null),
        NativeCase(BoneMassRecord::class, "android.permission.health.READ_BONE_MASS", null),
        NativeCase(CervicalMucusRecord::class, "android.permission.health.READ_CERVICAL_MUCUS", null),
        NativeCase(CyclingPedalingCadenceRecord::class, "android.permission.health.READ_EXERCISE", null),
        NativeCase(DistanceRecord::class, "android.permission.health.READ_DISTANCE", null),
        NativeCase(ElevationGainedRecord::class, "android.permission.health.READ_ELEVATION_GAINED", null),
        NativeCase(ExerciseSessionRecord::class, "android.permission.health.READ_EXERCISE", null),
        NativeCase(FloorsClimbedRecord::class, "android.permission.health.READ_FLOORS_CLIMBED", null),
        NativeCase(HeartRateRecord::class, "android.permission.health.READ_HEART_RATE", null),
        NativeCase(HeartRateVariabilityRmssdRecord::class, "android.permission.health.READ_HEART_RATE_VARIABILITY", null),
        NativeCase(HeightRecord::class, "android.permission.health.READ_HEIGHT", null),
        NativeCase(HydrationRecord::class, "android.permission.health.READ_HYDRATION", null),
        NativeCase(IntermenstrualBleedingRecord::class, "android.permission.health.READ_INTERMENSTRUAL_BLEEDING", null),
        NativeCase(LeanBodyMassRecord::class, "android.permission.health.READ_LEAN_BODY_MASS", null),
        NativeCase(MenstruationFlowRecord::class, "android.permission.health.READ_MENSTRUATION", null),
        NativeCase(MenstruationPeriodRecord::class, "android.permission.health.READ_MENSTRUATION", null),
        NativeCase(MindfulnessSessionRecord::class, "android.permission.health.READ_MINDFULNESS", 5),
        NativeCase(NutritionRecord::class, "android.permission.health.READ_NUTRITION", null),
        NativeCase(OvulationTestRecord::class, "android.permission.health.READ_OVULATION_TEST", null),
        NativeCase(OxygenSaturationRecord::class, "android.permission.health.READ_OXYGEN_SATURATION", null),
        NativeCase(PlannedExerciseSessionRecord::class, "android.permission.health.READ_PLANNED_EXERCISE", 3),
        NativeCase(PowerRecord::class, "android.permission.health.READ_POWER", null),
        NativeCase(RespiratoryRateRecord::class, "android.permission.health.READ_RESPIRATORY_RATE", null),
        NativeCase(RestingHeartRateRecord::class, "android.permission.health.READ_RESTING_HEART_RATE", null),
        NativeCase(SexualActivityRecord::class, "android.permission.health.READ_SEXUAL_ACTIVITY", null),
        NativeCase(SkinTemperatureRecord::class, "android.permission.health.READ_SKIN_TEMPERATURE", 2),
        NativeCase(SleepSessionRecord::class, "android.permission.health.READ_SLEEP", null),
        NativeCase(SpeedRecord::class, "android.permission.health.READ_SPEED", null),
        NativeCase(StepsCadenceRecord::class, "android.permission.health.READ_STEPS", null),
        NativeCase(StepsRecord::class, "android.permission.health.READ_STEPS", null),
        NativeCase(TotalCaloriesBurnedRecord::class, "android.permission.health.READ_TOTAL_CALORIES_BURNED", null),
        NativeCase(Vo2MaxRecord::class, "android.permission.health.READ_VO2_MAX", null),
        NativeCase(WeightRecord::class, "android.permission.health.READ_WEIGHT", null),
        NativeCase(WheelchairPushesRecord::class, "android.permission.health.READ_WHEELCHAIR_PUSHES", null),
    )
    private fun state(row: NativeCase): CategoryState = CategorySetup.states(
        setOf(row.type.simpleName!!), setOf(row.permission),
        mapOf(row.type.simpleName!! to CategoryEvidence(available = CategoryAvailability.AVAILABLE))
    ).getValue(row.type.simpleName!!)
    private fun scope() = WeightReadScope(Instant.parse("2001-02-03T00:00:00Z"),
        Instant.parse("2001-02-04T00:00:00Z"), 2)
    private fun ready(choice: OrdinaryReaderChoice): OrdinaryRecordReader {
        assertTrue(choice is OrdinaryReaderChoice.Ready)
        return (choice as OrdinaryReaderChoice.Ready).reader
    }
    @Suppress("UNCHECKED_CAST")
    private fun nativeReader(type: KClass<out Record>,
        read: suspend (ReadRecordsRequest<Record>) -> ReadRecordsResponse<Record>): OrdinaryRecordReader =
        TypedHealthConnectRecordReader(type as KClass<Record>, read)
    @OptIn(ExperimentalDeduplicationApi::class)
    private fun request(query: ReadRecordsRequest<*>, type: KClass<out Record>,
        expectedScope: WeightReadScope, token: String?) {
        assertEquals(type, query.recordType)
        assertEquals(expectedScope.start, query.timeRangeFilter.startTime)
        assertEquals(expectedScope.end, query.timeRangeFilter.endTime)
        assertNull(query.timeRangeFilter.localStartTime)
        assertNull(query.timeRangeFilter.localEndTime)
        assertTrue(query.dataOriginFilter.isEmpty())
        assertTrue(query.ascendingOrder)
        assertEquals(2, query.pageSize)
        assertEquals(token, query.pageToken)
        assertEquals(0, query.deduplicateStrategy)
    }
    private fun golden(name: String): Any? = checkNotNull(javaClass.classLoader!!
        .getResourceAsStream("record-codecs-v1.json")).use {
            checkNotNull((StrictJson.parse(it.readBytes()) as Map<*, *>)[name])
        }

    @Test fun RSDK01_registryUsesExactNativeClassAndReadPermission() {
        assertEquals(cases.map { it.type.simpleName }.toSet(), CategorySetup.registry.keys)
        for (row in cases) {
            val actual = CategorySetup.registry.getValue(row.type.simpleName!!)
            assertEquals(row.type, actual.recordType)
            assertEquals(row.permission, actual.readPermission)
        }
        assertEquals(setOf("android.permission.health.READ_EXERCISE", "android.permission.health.READ_STEPS"),
            CategorySetup.requestedReadPermissions(setOf("ExerciseSessionRecord",
                "CyclingPedalingCadenceRecord", "StepsRecord", "StepsCadenceRecord")))
    }

    @Test fun RSDK02_eachNativeDispatchPreservesSelectedQuery() = runBlocking<Unit> {
        for (row in cases) {
            val features = mutableListOf<Int>()
            val captured = mutableListOf<ReadRecordsRequest<*>>()
            val choice = OrdinaryRecordReaderFactory.create(state(row), { id -> features.add(id); 2 }) {
                assertEquals(row.type, it.recordType)
                assertEquals(row.permission, it.readPermission)
                nativeReader(it.recordType) { query ->
                    captured.add(query); ReadRecordsResponse(emptyList<Record>(), "synthetic-opaque-next-token")
                }
            }
            val reader = ready(choice)
            assertEquals(row.type.simpleName, reader.recordType)
            val query = scope()
            val page = reader.readPage(query, "synthetic-opaque-before-token")
            assertEquals(listOfNotNull(row.requiredFeature), features)
            assertEquals(1, captured.size)
            request(captured.single(), row.type, query, "synthetic-opaque-before-token")
            assertEquals("synthetic-opaque-next-token", page.nextPageToken)
            assertTrue(page.records.isEmpty())
        }
    }

    @Test fun RSDK03_unimplementedAndUnknownFactsRemainDistinct() {
        val row = cases.single { it.type == WeightRecord::class }
        val open = state(row)
        val refusals = listOf(
            open.copy(adapter = CategoryAdapter("SyntheticUnimplementedRecord", WeightRecord::class,
                "android.permission.health.READ_WEIGHT")) to OrdinaryReaderBlock.UNSUPPORTED_CATEGORY,
            open.copy(adapter = CategoryAdapter("WeightRecord", StepsRecord::class,
                "android.permission.health.READ_WEIGHT")) to OrdinaryReaderBlock.UNSUPPORTED_CATEGORY,
            open.copy(selected = false) to OrdinaryReaderBlock.NOT_SELECTED,
            open.copy(permitted = CategoryTruth.UNKNOWN) to OrdinaryReaderBlock.PERMISSION_UNKNOWN,
            open.copy(permitted = CategoryTruth.NO) to OrdinaryReaderBlock.PERMISSION_DENIED,
            open.copy(available = CategoryAvailability.UNKNOWN) to OrdinaryReaderBlock.AVAILABILITY_UNKNOWN,
            open.copy(available = CategoryAvailability.UNAVAILABLE) to OrdinaryReaderBlock.CATEGORY_UNAVAILABLE,
            state(cases.single { it.type == SkinTemperatureRecord::class }).copy(permitted = CategoryTruth.NO)
                to OrdinaryReaderBlock.PERMISSION_DENIED,
            state(cases.single { it.type == SkinTemperatureRecord::class }).copy(available = CategoryAvailability.UNKNOWN)
                to OrdinaryReaderBlock.AVAILABILITY_UNKNOWN)
        for ((input, expected) in refusals) {
            var features = 0
            var created = 0
            val result = OrdinaryRecordReaderFactory.create(input, { features++; 2 }) {
                created++; nativeReader(it.recordType) { error("refusal must not read") }
            }
            assertTrue(result is OrdinaryReaderChoice.Blocked)
            assertEquals(expected, (result as OrdinaryReaderChoice.Blocked).reason)
            assertEquals(0, features)
            assertEquals(0, created)
        }
    }

    @Test fun RSDK04_onlyDocumentedFeatureStatusCanAdmitRequiredRecords() {
        for (row in cases.filter { it.requiredFeature != null }) {
            for (status in listOf(1, 99)) {
                val queried = mutableListOf<Int>()
                var created = 0
                val result = OrdinaryRecordReaderFactory.create(state(row), { queried.add(it); status }) {
                    created++; nativeReader(it.recordType) { error("must not read") }
                }
                assertEquals(listOf(row.requiredFeature), queried)
                assertTrue(result is OrdinaryReaderChoice.Blocked)
                assertEquals(if (status == 1) OrdinaryReaderBlock.FEATURE_UNAVAILABLE
                    else OrdinaryReaderBlock.FEATURE_UNKNOWN, (result as OrdinaryReaderChoice.Blocked).reason)
                assertEquals(0, created)
            }
            val failed = OrdinaryRecordReaderFactory.create(state(row), { throw IllegalStateException("synthetic feature query") }) {
                fail("failed feature query must not construct reader"); nativeReader(it.recordType) { error("no read") }
            }
            assertTrue(failed is OrdinaryReaderChoice.Blocked)
            assertEquals(OrdinaryReaderBlock.FEATURE_UNKNOWN, (failed as OrdinaryReaderChoice.Blocked).reason)
        }
    }

    @Test fun RSDK05_optionalFeatureAndReadinessFactsAreNotWholeRecordGates() {
        val row = cases.single { it.type == ExerciseSessionRecord::class }
        val input = state(row)
        val queried = mutableListOf<Int>()
        val reader = ready(OrdinaryRecordReaderFactory.create(input, { queried.add(it); 1 }) {
            nativeReader(it.recordType) { error("factory creation does not read") }
        })
        assertEquals("ExerciseSessionRecord", reader.recordType)
        assertTrue(queried.isEmpty())
        assertEquals(CategoryTruth.UNKNOWN, input.observed)
        assertEquals(CategoryTruth.UNKNOWN, input.saved)
        assertEquals(CategoryTruth.UNKNOWN, input.displayed)
    }

    @Test fun RSDK06_stepsNativePagesAndEmptyTokenKeepLosslessContent() = runBlocking<Unit> {
        val full = StepsRecord(Instant.parse("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
            Instant.parse("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"), 1234,
            NativeMetadataFixture.full())
        val nullable = StepsRecord(Instant.parse("2001-10-28T00:30:00.000000001Z"), null,
            Instant.parse("2001-10-28T00:30:00.000000002Z"), null, 1234, NativeMetadataFixture.nullable())
        val queries = mutableListOf<ReadRecordsRequest<StepsRecord>>()
        val accepted = mutableListOf<EncodedRecord>()
        val reader = TypedHealthConnectRecordReader(StepsRecord::class) { query ->
            queries.add(query)
            when (queries.size) {
                1 -> ReadRecordsResponse(listOf(full), "")
                2 -> ReadRecordsResponse(listOf(nullable), null)
                else -> error("unexpected read ahead")
            }
        }
        val query = WeightReadScope(Instant.parse("2001-10-28T00:00:00Z"),
            Instant.parse("2001-10-29T00:00:00Z"), 2)
        val result = OrdinaryRecordPager(reader).scan(query, 3, { ReadGate.OPEN }) {
            accepted.addAll(it.records); Ok(Unit)
        }
        assertEquals(2, queries.size)
        request(queries[0], StepsRecord::class, query, null)
        request(queries[1], StepsRecord::class, query, "")
        assertEquals(listOf("synthetic-provider-id", "synthetic-provider-id-nullable"), accepted.map { it.nativeRecordId })
        assertEquals(listOf("StepsRecord", "StepsRecord"), accepted.map { it.recordType })
        assertEquals(listOf(golden("stepsFull"), golden("stepsNullableFields")),
            accepted.map { StrictJson.parse(it.recordJson.toByteArray(Charsets.UTF_8)) })
        assertTrue(result is PageScanResult.Finished)
        assertEquals(2, result.pages)
        assertEquals(2L, result.recordCount)
    }

    @Test fun RSDK07_freshStepsGateAndFeatureCancellationRemainFenced() = runBlocking<Unit> {
        var gate = ReadGate.OPEN
        var accepted = 0
        val entered = CompletableDeferred<ReadRecordsRequest<StepsRecord>>()
        val reply = CompletableDeferred<ReadRecordsResponse<StepsRecord>>()
        val reader = TypedHealthConnectRecordReader(StepsRecord::class) { query ->
            entered.complete(query); reply.await()
        }
        val query = scope()
        val scan = async {
            OrdinaryRecordPager(reader).scan(query, 3, { gate }) { accepted++; Ok(Unit) }
        }
        request(entered.await(), StepsRecord::class, query, null)
        gate = ReadGate.PERMISSION_DENIED
        reply.complete(ReadRecordsResponse(emptyList(), null))
        val result = scan.await()
        assertTrue(result is PageScanResult.Incomplete)
        assertEquals(ScanStop.PERMISSION_DENIED, (result as PageScanResult.Incomplete).reason)
        assertEquals(0, result.pages)
        assertEquals(0L, result.recordCount)
        assertEquals(0, accepted)
        val skin = cases.single { it.type == SkinTemperatureRecord::class }
        try {
            OrdinaryRecordReaderFactory.create(state(skin), { throw CancellationException("synthetic feature cancellation") }) {
                fail("cancelled feature query must not construct reader"); nativeReader(it.recordType) { error("no read") }
            }
            fail("feature cancellation must propagate")
        } catch (_: CancellationException) { }
    }
    @Test fun RSDK08_foreignNativeClassCannotBecomeACompleteSelectedPage() = runBlocking<Unit> {
        val steps = StepsRecord(Instant.parse("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
            Instant.parse("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"), 1234,
            NativeMetadataFixture.full())
        val weight = WeightRecord(Instant.parse("2001-02-03T04:05:06.123456789Z"),
            ZoneOffset.of("+05:45"), androidx.health.connect.client.units.Mass.kilograms(75.25),
            NativeMetadataFixture.full())
        val queries = mutableListOf<ReadRecordsRequest<*>>()
        val reader = nativeReader(StepsRecord::class) { query ->
            queries.add(query)
            ReadRecordsResponse<Record>(listOf(steps, weight), "synthetic-opaque-next-token")
        }
        var accepted = 0
        val query = scope()
        val result = OrdinaryRecordPager(reader).scan(query, 3, { ReadGate.OPEN }) {
            accepted++; Ok(Unit)
        }
        assertEquals(1, queries.size)
        request(queries.single(), StepsRecord::class, query, null)
        assertTrue(result is PageScanResult.Incomplete)
        assertEquals(ScanStop.WRONG_RECORD_TYPE, (result as PageScanResult.Incomplete).reason)
        assertEquals(0, result.pages)
        assertEquals(0L, result.recordCount)
        assertEquals(0, accepted)
    }

}
