// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.*
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.time.Instant
import java.time.ZoneOffset

class UnitInstantRecordCodecsTest {
    private val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
    private val offset = ZoneOffset.of("+05:45")
    private val metadata = NativeMetadataFixture.full()
    private fun fixtures(): Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("unit-instant-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>
    private fun unfamiliar() = NativeMetadataFixture.create(9024, "synthetic-provider-id",
        "2001-10-29T03:04:05.987654321Z", "synthetic-client-id/\u03b1\n\"quoted\"",
        9007199254740993L, Device(9025, "Synthetic maker", "Synthetic model \u0394"))
    private fun checkCase(key: String, record: Record) {
        val result = RecordCodecs.encode(record)
        assertEquals(key, fixtures()[key], StrictJson.parse(result.recordJson.toByteArray()))
        assertEquals(record.metadata.id, result.nativeRecordId)
        assertEquals(record.javaClass.simpleName, result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }

    @Test fun u01BasalMetabolicRateKeepsBothPowerObservations() =
        checkCase("U01", BasalMetabolicRateRecord(time, offset, Power.watts(80.125), metadata))

    @Test fun u02BasalTemperatureKeepsBothUnitsAndLocation() =
        checkCase("U02", BasalBodyTemperatureRecord(time, offset, metadata,
            Temperature.celsius(36.625), 0))

    @Test fun u03BodyTemperatureKeepsBothUnitsAndLocation() =
        checkCase("U03", BodyTemperatureRecord(time, offset, metadata,
            Temperature.celsius(37.125), 0))

    @Test fun u04GlucoseKeepsBothUnitsAndAllSpecificEnums() =
        checkCase("U04", BloodGlucoseRecord(time, offset, metadata,
            BloodGlucose.millimolesPerLiter(5.125), 2, 1, 2))

    @Test fun u05BloodPressureKeepsBothMeasurementsAndEnums() =
        checkCase("U05", BloodPressureRecord(time, offset, metadata,
            Pressure.millimetersOfMercury(120.125), Pressure.millimetersOfMercury(80.25), 2, 3))

    @Test fun u06OxygenKeepsItsPercentageObservation() =
        checkCase("U06", OxygenSaturationRecord(time, offset, Percentage(97.125), metadata))

    @Test fun u07Vo2KeepsItsFiniteDoubleAndMethod() =
        checkCase("U07", Vo2MaxRecord(time, offset, metadata, 42.125, 1))

    @Test fun u08AlternativePowerFactoryKeepsResidualAndOptionalFields() =
        checkCase("U08", BasalMetabolicRateRecord(
            Instant.parse("2001-02-03T04:05:06.000000001Z"), null,
            Power.kilocaloriesPerDay(2000.25), NativeMetadataFixture.nullableDeviceFields()))

    @Test fun u09FahrenheitResidualAndUnfamiliarSpecificEnumsRemainExact() {
        checkCase("U09", BodyTemperatureRecord(time, offset, unfamiliar(),
            Temperature.fahrenheit(98.6), 9026))
        checkCase("enum-basal-temperature", BasalBodyTemperatureRecord(time, offset,
            unfamiliar(), Temperature.celsius(36.625), 9030))
        checkCase("enum-blood-pressure", BloodPressureRecord(time, offset, unfamiliar(),
            Pressure.millimetersOfMercury(120.125), Pressure.millimetersOfMercury(80.25), 9031, 9032))
        checkCase("enum-vo2", Vo2MaxRecord(time, offset, unfamiliar(), 42.125, 9033))
    }

    @Test fun u10AlternativeGlucoseFactoryKeepsResidualAndUnknownEnums() =
        checkCase("U10", BloodGlucoseRecord(time, offset, unfamiliar(),
            BloodGlucose.milligramsPerDeciliter(101.5), 9027, 9028, 9029))

    @Test fun u11PublicGetterCoverageAndImmutableRegistryStayExact() {
        val fixed = fixtures()
        val expected = fixed["expectedPublicGetters"] as Map<*, *>
        assertEquals(37, expected.filterKeys {
            (it as String).startsWith("androidx.health.connect.client.records.")
        }.values.sumOf { (it as Map<*, *>).size })
        assertEquals(8, expected.filterKeys {
            (it as String).startsWith("androidx.health.connect.client.units.")
        }.values.sumOf { (it as Map<*, *>).size })
        val inventory = StrictJson.parse(
            File("../docs/sdk-inventory/1.2.0-alpha06-inventory.json").readBytes()) as Map<*, *>
        assertEquals("1.2.0-alpha06", inventory["version"])
        val fields = inventory["exposedGetters"] as List<*>
        for ((name, getters) in expected) {
            val pinned = fields.map { it as Map<*, *> }.filter { it["class"] == name }
                .associate { it["method"] as String to it["type"] as String }
            assertEquals(name as String, getters, pinned)
            // Reflection checks the fixed public ABI only in tests, never in the production mapper.
            val compiled = Class.forName(name).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 &&
                    it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.returnType.name }
            assertEquals(name, getters, compiled)
        }
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf(
            "HeartRateRecord", "SpeedRecord", "PowerRecord",
            "StepsCadenceRecord", "CyclingPedalingCadenceRecord",
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

    @Test fun u12AllTenExistingGoldenJsonBytesStayStable() {
        val golden = fixtures()["originalRecordJson"] as Map<*, *>
        val records = listOf(
            StepsRecord(Instant.parse("2001-10-28T00:30:00.123456789Z"),
                ZoneOffset.of("+02:00"), Instant.parse("2001-10-28T02:30:00.987654321Z"),
                ZoneOffset.of("+01:00"), 1234L, metadata),
            WeightRecord(time, offset, Mass.kilograms(75.25), metadata),
            BodyFatRecord(time, offset, Percentage(17.125), metadata),
            BodyWaterMassRecord(time, offset, Mass.grams(40125.0), metadata),
            BoneMassRecord(time, offset, Mass.grams(3125.0), metadata),
            LeanBodyMassRecord(time, offset, Mass.grams(60125.0), metadata),
            HeightRecord(time, offset, Length.meters(1.75), metadata),
            HeartRateVariabilityRmssdRecord(time, offset, 42.125, metadata),
            RespiratoryRateRecord(time, offset, 12.125, metadata),
            RestingHeartRateRecord(time, offset, 61L, metadata))
        assertEquals(10, golden.size)
        for (record in records) {
            val result = RecordCodecs.encode(record)
            assertEquals(record.javaClass.simpleName, golden[result.recordType], result.recordJson)
        }
    }
}
