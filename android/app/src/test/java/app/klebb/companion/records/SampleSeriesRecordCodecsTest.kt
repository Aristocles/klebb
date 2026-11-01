// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.*
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.*
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.time.Instant
import java.time.ZoneOffset

class SampleSeriesRecordCodecsTest {
    private val start = Instant.parse("2001-10-28T00:30:00.123456789Z")
    private val end = Instant.parse("2001-10-28T02:30:00.987654321Z")
    private val startOffset = ZoneOffset.of("+02:00")
    private val endOffset = ZoneOffset.of("+01:00")
    private val early = Instant.parse("2001-10-28T00:35:00.000000001Z")
    private val late = Instant.parse("2001-10-28T02:00:00.999999999Z")
    private val metadata = NativeMetadataFixture.full()
    private fun fixtures(): Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("sample-series-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>

    private fun checkCase(key: String, record: Record): EncodedRecord {
        val fixed = (fixtures()["cases"] as Map<*, *>)[key] as Map<*, *>
        val result = RecordCodecs.encode(record)
        assertEquals(key, fixed["record"], StrictJson.parse(result.recordJson.toByteArray()))
        assertEquals(fixed["nativeRecordId"], result.nativeRecordId)
        assertEquals(fixed["recordType"], result.recordType)
        assertEquals(fixed["serializerId"], result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
        return result
    }

    private fun heart(samples: List<HeartRateRecord.Sample>, source: Metadata = metadata) =
        HeartRateRecord(start, startOffset, end, endOffset, samples, source)

    @Test fun s01ThreeHeartRateSamplesKeepEqualTimeOrderAndExactLongs() {
        checkCase("S01", heart(listOf(HeartRateRecord.Sample(early, 72L),
            HeartRateRecord.Sample(early, 75L), HeartRateRecord.Sample(late, 88L))))
    }

    @Test fun s02SpeedKeepsEverySampleAndThreeVelocityObservations() {
        checkCase("S02", SpeedRecord(start, startOffset, end, endOffset, listOf(
            SpeedRecord.Sample(early, Velocity.metersPerSecond(1.125)),
            SpeedRecord.Sample(late, Velocity.metersPerSecond(2.25))), metadata))
    }

    @Test fun s03PowerKeepsEverySampleAndBothRateObservations() {
        checkCase("S03", PowerRecord(start, startOffset, end, endOffset, listOf(
            PowerRecord.Sample(early, Power.watts(110.125)),
            PowerRecord.Sample(late, Power.watts(220.25))), metadata))
    }

    @Test fun s04StepsCadenceKeepsDistinctFiniteDoubleField() {
        checkCase("S04", StepsCadenceRecord(start, startOffset, end, endOffset, listOf(
            StepsCadenceRecord.Sample(early, 100.125),
            StepsCadenceRecord.Sample(late, 120.25)), metadata))
    }

    @Test fun s05CyclingCadenceKeepsRevolutionsPerMinuteAndOrder() {
        checkCase("S05", CyclingPedalingCadenceRecord(start, startOffset, end, endOffset, listOf(
            CyclingPedalingCadenceRecord.Sample(early, 83.125),
            CyclingPedalingCadenceRecord.Sample(late, 92.25)), metadata))
    }

    @Test fun s06EmptySeriesKeepsRecordNullFieldsAndOneNanosecondInterval() {
        checkCase("S06", HeartRateRecord(Instant.parse("2001-10-28T00:30:00.000000001Z"),
            null, Instant.parse("2001-10-28T00:30:00.000000002Z"), null,
            emptyList(), NativeMetadataFixture.nullable()))
    }

    @Test fun s07KilometresFactoryKeepsExactNativeVelocityResidual() {
        checkCase("S07", SpeedRecord(start, startOffset, end, endOffset, listOf(
            SpeedRecord.Sample(early, Velocity.kilometersPerHour(4.5))),
            NativeMetadataFixture.nullableDeviceFields()))
    }

    @Test fun s08AlternativePowerFactoryKeepsResidualAndNullableDevice() {
        checkCase("S08", PowerRecord(start, startOffset, end, endOffset, listOf(
            PowerRecord.Sample(early, Power.kilocaloriesPerDay(2000.25))),
            NativeMetadataFixture.nullableDeviceFields()))
    }

    @Test fun s09SdkLongBoundsRemainStringsAndRejectedZeroIsSeparate() {
        assertThrows(IllegalArgumentException::class.java) {
            HeartRateRecord.Sample(early, 0L)
        }
        checkCase("S09", heart(listOf(HeartRateRecord.Sample(early, 1L),
            HeartRateRecord.Sample(late, 300L))))
    }

    @Test fun s10CallerOrderRepeatsAndAlreadyReturnedJsonSurviveMutation() {
        val samples = mutableListOf(HeartRateRecord.Sample(late, 88L),
            HeartRateRecord.Sample(early, 75L), HeartRateRecord.Sample(early, 72L),
            HeartRateRecord.Sample(early, 72L))
        val result = checkCase("S10", heart(samples))
        val originalText = result.recordJson
        samples.clear()
        samples.add(HeartRateRecord.Sample(early, 1L))
        assertEquals(originalText, result.recordJson)
        val fixed = (fixtures()["cases"] as Map<*, *>)["S10"] as Map<*, *>
        assertEquals(fixed["record"], StrictJson.parse(result.recordJson.toByteArray()))
    }

    @Test fun s11BothPinnedGetterMapsAndExactGenericSamplesMatchImmutableRegistry() {
        val fixed = fixtures()
        val expected = fixed["expectedPublicGetters"] as Map<*, *>
        fun count(prefix: String, nested: Boolean) = expected.filterKeys {
            (it as String).startsWith(prefix) && it.contains('$') == nested
        }.values.sumOf { (it as Map<*, *>).size }
        assertEquals(30, count("androidx.health.connect.client.records.", false))
        assertEquals(10, count("androidx.health.connect.client.records.", true))
        assertEquals(5, count("androidx.health.connect.client.units.", false))
        for (version in listOf("1.1.0", "1.2.0-alpha06")) {
            val inventory = StrictJson.parse(
                File("../docs/sdk-inventory/$version-inventory.json").readBytes()) as Map<*, *>
            assertEquals(version, inventory["version"])
            val fields = inventory["exposedGetters"] as List<*>
            for ((name, getters) in expected) {
                val pinned = fields.map { it as Map<*, *> }.filter { it["class"] == name }
                    .associate { it["method"] as String to it["type"] as String }
                assertEquals("$version $name", getters, pinned)
            }
        }
        for ((name, getters) in expected) {
            // Tests verify exact generic nested identity; production uses explicit getters.
            val methods = Class.forName(name as String).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 &&
                    it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }
            assertEquals(name, getters, methods.associate { it.name to it.genericReturnType.typeName })
            if (methods.any { it.name == "getSamples" }) {
                assertEquals("java.util.List", methods.single { it.name == "getSamples" }.returnType.name)
            }
        }
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf(
            "ActiveCaloriesBurnedRecord", "TotalCaloriesBurnedRecord", "DistanceRecord",
            "ElevationGainedRecord", "FloorsClimbedRecord", "HydrationRecord",
            "WheelchairPushesRecord", "MenstruationPeriodRecord",
            "MindfulnessSessionRecord", "ActivityIntensityRecord",
            "CervicalMucusRecord", "IntermenstrualBleedingRecord", "MenstruationFlowRecord",
            "OvulationTestRecord", "SexualActivityRecord", "NutritionRecord", "SkinTemperatureRecord", "SleepSessionRecord", "ExerciseSessionRecord", "PlannedExerciseSessionRecord")
        assertEquals(42, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }

    @Test fun s12AllSeventeenPriorGoldenJsonByteStringsStayExact() {
        val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
        val offset = ZoneOffset.of("+05:45")
        val records = listOf(
            StepsRecord(start, startOffset, end, endOffset, 1234L, metadata),
            WeightRecord(time, offset, Mass.kilograms(75.25), metadata),
            BodyFatRecord(time, offset, Percentage(17.125), metadata),
            BodyWaterMassRecord(time, offset, Mass.grams(40125.0), metadata),
            BoneMassRecord(time, offset, Mass.grams(3125.0), metadata),
            LeanBodyMassRecord(time, offset, Mass.grams(60125.0), metadata),
            HeightRecord(time, offset, Length.meters(1.75), metadata),
            HeartRateVariabilityRmssdRecord(time, offset, 42.125, metadata),
            RespiratoryRateRecord(time, offset, 12.125, metadata),
            RestingHeartRateRecord(time, offset, 61L, metadata),
            BasalMetabolicRateRecord(time, offset, Power.watts(80.125), metadata),
            BasalBodyTemperatureRecord(time, offset, metadata, Temperature.celsius(36.625), 0),
            BodyTemperatureRecord(time, offset, metadata, Temperature.celsius(37.125), 0),
            BloodGlucoseRecord(time, offset, metadata, BloodGlucose.millimolesPerLiter(5.125), 2, 1, 2),
            BloodPressureRecord(time, offset, metadata, Pressure.millimetersOfMercury(120.125),
                Pressure.millimetersOfMercury(80.25), 2, 3),
            OxygenSaturationRecord(time, offset, Percentage(97.125), metadata),
            Vo2MaxRecord(time, offset, metadata, 42.125, 1))
        val golden = fixtures()["originalRecordJson"] as Map<*, *>
        assertEquals(17, golden.size)
        for (record in records) {
            val result = RecordCodecs.encode(record)
            assertEquals(record.javaClass.simpleName, golden[result.recordType], result.recordJson)
        }
    }
}
