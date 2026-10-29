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

class FlatIntervalRecordCodecsTest {
    private val start = Instant.parse("2001-10-28T00:30:00.123456789Z")
    private val end = Instant.parse("2001-10-28T02:30:00.987654321Z")
    private val startOffset = ZoneOffset.of("+02:00")
    private val endOffset = ZoneOffset.of("+01:00")
    private val metadata = NativeMetadataFixture.full()
    private fun fixtures(): Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("flat-interval-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>

    private fun checkCase(key: String, record: Record) {
        val fixed = (fixtures()["cases"] as Map<*, *>)[key] as Map<*, *>
        val result = RecordCodecs.encode(record)
        assertEquals(key, fixed["record"], StrictJson.parse(result.recordJson.toByteArray()))
        assertEquals(fixed["nativeRecordId"], result.nativeRecordId)
        assertEquals(fixed["recordType"], result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }

    @Test fun i01ActiveEnergyPreservesFourSdkObservations() =
        checkCase("I01", ActiveCaloriesBurnedRecord(start, startOffset, end, endOffset,
            Energy.kilocalories(123.125), metadata))

    @Test fun i02TotalEnergyPreservesFourSdkObservations() =
        checkCase("I02", TotalCaloriesBurnedRecord(start, startOffset, end, endOffset,
            Energy.kilocalories(456.125), metadata))

    @Test fun i03DistancePreservesFiveLengthObservations() =
        checkCase("I03", DistanceRecord(start, startOffset, end, endOffset,
            Length.meters(1234.125), metadata))

    @Test fun i04ElevationPreservesFiveLengthObservations() =
        checkCase("I04", ElevationGainedRecord(start, startOffset, end, endOffset,
            Length.meters(12.125), metadata))

    @Test fun i05FloorsPreservesFiniteDouble() =
        checkCase("I05", FloorsClimbedRecord(start, startOffset, end, endOffset, 3.125, metadata))

    @Test fun i06HydrationPreservesThreeVolumeObservations() =
        checkCase("I06", HydrationRecord(start, startOffset, end, endOffset,
            Volume.liters(0.625), metadata))

    @Test fun i07WheelchairPushesPreservesLongCount() =
        checkCase("I07", WheelchairPushesRecord(start, startOffset, end, endOffset, 321L, metadata))

    @Test fun i08PeriodPreservesCompleteMetadataOnlyInterval() =
        checkCase("I08", MenstruationPeriodRecord(start, startOffset, end, endOffset, metadata))

    @Test fun i09MindfulnessPreservesUnicodeAndEnumZero() =
        checkCase("I09", MindfulnessSessionRecord(start, startOffset, end, endOffset, metadata,
            0, "Synthetic pause", "Synthetic note\n\u4fdd\u7559"))

    @Test fun i10ActivityIntensityZeroIsDataNotMissingOrUnavailable() =
        checkCase("I10", ActivityIntensityRecord(start, startOffset, end, endOffset, metadata, 0))

    @Test fun i11NullEmptyAndConstructibleUnknownEnumsStayDistinct() {
        checkCase("I11-null", MindfulnessSessionRecord(start, startOffset, end, endOffset,
            NativeMetadataFixture.nullable(), 9014, null, null))
        checkCase("I11-empty", MindfulnessSessionRecord(start, startOffset, end, endOffset,
            NativeMetadataFixture.nullableDeviceFields(), 9014, "", ""))
        checkCase("I11-activity",
            ActivityIntensityRecord(start, startOffset, end, endOffset, metadata, 9001))
    }

    @Test fun i12SdkLongBoundariesAndIndependentOffsetsRemainExplicit() {
        assertThrows(IllegalArgumentException::class.java) {
            WheelchairPushesRecord(start, startOffset, end, endOffset, -1L, metadata)
        }
        assertThrows(IllegalArgumentException::class.java) {
            WheelchairPushesRecord(start, startOffset, end, endOffset, Long.MAX_VALUE, metadata)
        }
        checkCase("I12-zero", WheelchairPushesRecord(start, null, end, endOffset, 0L,
            NativeMetadataFixture.nullable()))
        checkCase("I12-max", WheelchairPushesRecord(start, startOffset, end, null, 1000000L,
            NativeMetadataFixture.nullableDeviceFields()))
    }

    @Test fun i13OneNanosecondPeriodKeepsNullOffsetsAndNullMetadataFields() =
        checkCase("I13-period", MenstruationPeriodRecord(
            Instant.parse("2001-10-28T00:30:00.000000001Z"), null,
            Instant.parse("2001-10-28T00:30:00.000000002Z"), null,
            NativeMetadataFixture.nullable()))

    @Test fun i14SourceDerivedUnitLiteralsMatchActualSdkBeforeMapper() {
        // These checks do not call the mapper or its decimal helper.
        val expected = fixtures()["literalExpectedGetterValues"] as Map<*, *>
        fun check(key: String, actual: Map<String, Double>) {
            val literals = expected[key] as Map<*, *>
            assertEquals(literals.keys, actual.keys)
            for ((getter, value) in actual) {
                assertEquals("$key $getter", (literals[getter] as String).toDouble().toRawBits(),
                    value.toRawBits())
            }
        }
        val active = Energy.kilocalories(123.125)
        check("activeKcal", linkedMapOf("getCalories" to active.inCalories,
            "getKilocalories" to active.inKilocalories, "getJoules" to active.inJoules,
            "getKilojoules" to active.inKilojoules))
        val total = Energy.kilocalories(456.125)
        check("totalKcal", linkedMapOf("getCalories" to total.inCalories,
            "getKilocalories" to total.inKilocalories, "getJoules" to total.inJoules,
            "getKilojoules" to total.inKilojoules))
        fun length(key: String, value: Length) = check(key, linkedMapOf(
            "getMeters" to value.inMeters, "getKilometers" to value.inKilometers,
            "getMiles" to value.inMiles, "getInches" to value.inInches, "getFeet" to value.inFeet))
        length("distanceMeters", Length.meters(1234.125))
        length("elevationMeters", Length.meters(12.125))
        val volume = Volume.liters(0.625)
        check("hydrationLiters", linkedMapOf("getLiters" to volume.inLiters,
            "getMilliliters" to volume.inMilliliters, "getFluidOuncesUs" to volume.inFluidOuncesUs))
        val alternativeLength = Length.kilometers(1.25)
        assertEquals(1250.0.toRawBits(), alternativeLength.inMeters.toRawBits())
        assertEquals(1.25.toRawBits(), alternativeLength.inKilometers.toRawBits())
        val alternativeVolume = Volume.milliliters(625.0)
        assertEquals(0.625.toRawBits(), alternativeVolume.inLiters.toRawBits())
        assertEquals(625.0.toRawBits(), alternativeVolume.inMilliliters.toRawBits())
        // Establish opaque constructor observations before unsupported adapters stop i11.
        val opaqueMindfulness = MindfulnessSessionRecord(start, startOffset, end, endOffset,
            NativeMetadataFixture.nullable(), 9014, null, null)
        assertEquals(9014, opaqueMindfulness.mindfulnessSessionType)
        assertNull(opaqueMindfulness.title)
        assertNull(opaqueMindfulness.notes)
        assertEquals(9001, ActivityIntensityRecord(
            start, startOffset, end, endOffset, metadata, 9001).activityIntensityType)
    }

    @Test fun i15BothPinsAndActualPublicAbiMatchExactImmutableRegistry() {
        val fixed = fixtures()
        val expected = fixed["expectedPublicGetters"] as Map<*, *>
        assertEquals(61, expected.filterKeys {
            (it as String).startsWith("androidx.health.connect.client.records.")
        }.values.sumOf { (it as Map<*, *>).size })
        assertEquals(12, expected.filterKeys {
            (it as String).startsWith("androidx.health.connect.client.units.")
        }.values.sumOf { (it as Map<*, *>).size })
        for (version in listOf("1.1.0", "1.2.0-alpha06")) {
            val inventory = StrictJson.parse(
                File("../docs/sdk-inventory/$version-inventory.json").readBytes()) as Map<*, *>
            assertEquals(version, inventory["version"])
            val fields = inventory["exposedGetters"] as List<*>
            for ((name, getters) in expected) {
                val pinned = fields.map { it as Map<*, *> }.filter { it["class"] == name }
                    .associate { it["method"] as String to it["type"] as String }
                if (version == "1.1.0" &&
                    name == "androidx.health.connect.client.records.ActivityIntensityRecord") {
                    assertTrue("Alpha-only class must remain absent on stable", pinned.isEmpty())
                } else {
                    assertEquals("$version $name", getters, pinned)
                }
            }
        }
        for ((name, getters) in expected) {
            // Reflection verifies fixed public SDK signatures only in tests.
            val compiled = Class.forName(name as String).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 &&
                    it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.returnType.name }
            assertEquals(name, getters, compiled)
        }
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf(
            "CervicalMucusRecord", "IntermenstrualBleedingRecord", "MenstruationFlowRecord",
            "OvulationTestRecord", "SexualActivityRecord", "NutritionRecord", "SkinTemperatureRecord")
        assertEquals(39, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }

    @Test fun i16AllTwentyTwoEarlierGoldenJsonByteStringsStayExact() {
        val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
        val offset = ZoneOffset.of("+05:45")
        val early = Instant.parse("2001-10-28T00:35:00.000000001Z")
        val late = Instant.parse("2001-10-28T02:00:00.999999999Z")
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
            Vo2MaxRecord(time, offset, metadata, 42.125, 1),
            HeartRateRecord(start, startOffset, end, endOffset, listOf(
                HeartRateRecord.Sample(early, 72L), HeartRateRecord.Sample(early, 75L),
                HeartRateRecord.Sample(late, 88L)), metadata),
            SpeedRecord(start, startOffset, end, endOffset, listOf(
                SpeedRecord.Sample(early, Velocity.metersPerSecond(1.125)),
                SpeedRecord.Sample(late, Velocity.metersPerSecond(2.25))), metadata),
            PowerRecord(start, startOffset, end, endOffset, listOf(
                PowerRecord.Sample(early, Power.watts(110.125)),
                PowerRecord.Sample(late, Power.watts(220.25))), metadata),
            StepsCadenceRecord(start, startOffset, end, endOffset, listOf(
                StepsCadenceRecord.Sample(early, 100.125),
                StepsCadenceRecord.Sample(late, 120.25)), metadata),
            CyclingPedalingCadenceRecord(start, startOffset, end, endOffset, listOf(
                CyclingPedalingCadenceRecord.Sample(early, 83.125),
                CyclingPedalingCadenceRecord.Sample(late, 92.25)), metadata))
        val golden = fixtures()["originalRecordJson"] as Map<*, *>
        assertEquals(22, golden.size)
        for (record in records) {
            val result = RecordCodecs.encode(record)
            assertEquals(record.javaClass.simpleName, golden[result.recordType], result.recordJson)
        }
    }
}
