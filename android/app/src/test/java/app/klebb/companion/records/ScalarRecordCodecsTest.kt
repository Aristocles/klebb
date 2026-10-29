// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.*
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.time.Instant
import java.time.ZoneOffset

class ScalarRecordCodecsTest {
    private val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
    private val offset = ZoneOffset.of("+05:45")
    private val metadata = NativeMetadataFixture.full()
    private fun fixtures(): Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("scalar-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>
    private fun checkCase(key: String, record: Record) {
        val result = RecordCodecs.encode(record)
        assertEquals(fixtures()[key], StrictJson.parse(result.recordJson.toByteArray()))
        assertEquals(record.metadata.id, result.nativeRecordId)
        assertEquals(record.javaClass.simpleName, result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }

    @Test fun f01BodyFatPreservesPercentageAndCommonFields() =
        checkCase("F01", BodyFatRecord(time, offset, Percentage(17.125), metadata))

    @Test fun f02BodyWaterMassPreservesAllSixUnits() =
        checkCase("F02", BodyWaterMassRecord(time, offset, Mass.grams(40125.0), metadata))

    @Test fun f03BoneMassPreservesAllSixUnits() =
        checkCase("F03", BoneMassRecord(time, offset, Mass.grams(3125.0), metadata))

    @Test fun f04LeanBodyMassPreservesAllSixUnits() =
        checkCase("F04", LeanBodyMassRecord(time, offset, Mass.grams(60125.0), metadata))

    @Test fun f05HeightPreservesAllFiveUnits() =
        checkCase("F05", HeightRecord(time, offset, Length.meters(1.75), metadata))

    @Test fun f06HrvPreservesFiniteDouble() =
        checkCase("F06", HeartRateVariabilityRmssdRecord(time, offset, 42.125, metadata))

    @Test fun f07RespiratoryRatePreservesFiniteDouble() =
        checkCase("F07", RespiratoryRateRecord(time, offset, 12.125, metadata))

    @Test fun f08RestingHeartRatePreservesInt64() =
        checkCase("F08", RestingHeartRateRecord(time, offset, 61L, metadata))

    @Test fun f09InchesFactoryResidualAndNullMetadataStayExact() =
        checkCase("F09", HeightRecord(Instant.parse("2001-02-03T04:05:06.000000001Z"),
            null, Length.inches(69.0), NativeMetadataFixture.nullableDeviceFields()))

    @Test fun f10UnfamiliarCommonEnumsRemainNumbers() {
        val unfamiliar = NativeMetadataFixture.create(9024, "synthetic-provider-id",
            "2001-10-29T03:04:05.987654321Z", "synthetic-client-id/\u03b1\n\"quoted\"",
            9007199254740993L, Device(9025, "Synthetic maker", "Synthetic model \u0394"))
        checkCase("F10", BodyFatRecord(time, offset, Percentage(17.125), unfamiliar))
    }

    @Test fun f11RegistryAndPinnedPublicGetterCoverageStayExact() {
        assertEquals(setOf("StepsRecord", "WeightRecord", "BodyFatRecord",
            "BodyWaterMassRecord", "BoneMassRecord", "LeanBodyMassRecord", "HeightRecord",
            "HeartRateVariabilityRmssdRecord", "RespiratoryRateRecord", "RestingHeartRateRecord",
            "BasalMetabolicRateRecord", "BasalBodyTemperatureRecord", "BodyTemperatureRecord",
            "BloodGlucoseRecord", "BloodPressureRecord", "OxygenSaturationRecord", "Vo2MaxRecord",
            "HeartRateRecord", "SpeedRecord", "PowerRecord",
            "StepsCadenceRecord", "CyclingPedalingCadenceRecord",
            "ActiveCaloriesBurnedRecord", "TotalCaloriesBurnedRecord", "DistanceRecord",
            "ElevationGainedRecord", "FloorsClimbedRecord", "HydrationRecord",
            "WheelchairPushesRecord", "MenstruationPeriodRecord",
            "MindfulnessSessionRecord", "ActivityIntensityRecord",
            "CervicalMucusRecord", "IntermenstrualBleedingRecord", "MenstruationFlowRecord",
            "OvulationTestRecord", "SexualActivityRecord", "NutritionRecord", "SkinTemperatureRecord"),
            RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
        val common = mapOf("getTime" to "java.time.Instant",
            "getZoneOffset" to "java.time.ZoneOffset",
            "getMetadata" to "androidx.health.connect.client.records.metadata.Metadata")
        val expected = mapOf(
            BodyFatRecord::class.java to (common + ("getPercentage" to Percentage::class.java.name)),
            BodyWaterMassRecord::class.java to (common + ("getMass" to Mass::class.java.name)),
            BoneMassRecord::class.java to (common + ("getMass" to Mass::class.java.name)),
            LeanBodyMassRecord::class.java to (common + ("getMass" to Mass::class.java.name)),
            HeightRecord::class.java to (common + ("getHeight" to Length::class.java.name)),
            HeartRateVariabilityRmssdRecord::class.java to
                (common + ("getHeartRateVariabilityMillis" to "double")),
            RespiratoryRateRecord::class.java to (common + ("getRate" to "double")),
            RestingHeartRateRecord::class.java to (common + ("getBeatsPerMinute" to "long")),
            Length::class.java to listOf("getMeters", "getKilometers", "getMiles",
                "getInches", "getFeet").associateWith { "double" },
            Percentage::class.java to mapOf("getValue" to "double"))
        val inventory = StrictJson.parse(
            File("../docs/sdk-inventory/1.2.0-alpha06-inventory.json").readBytes()) as Map<*, *>
        val fields = inventory["exposedGetters"] as List<*>
        assertEquals("1.2.0-alpha06", inventory["version"])
        for ((type, getters) in expected) {
            val pinned = fields.map { it as Map<*, *> }.filter { it["class"] == type.name }
                .associate { it["method"] as String to it["type"] as String }
            assertEquals(type.name, getters, pinned)
            // Reflection is test-only; production dispatch and unit access stay explicit.
            val compiled = type.declaredMethods.filter { Modifier.isPublic(it.modifiers) &&
                !Modifier.isStatic(it.modifiers) && it.parameterCount == 0 &&
                it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*")) }
                .associate { it.name to it.returnType.name }
            assertEquals(type.name, getters, compiled)
        }
    }

    @Test fun f12OriginalStepsAndWeightJsonBytesStayStable() {
        val golden = fixtures()["originalRecordJson"] as Map<*, *>
        val steps = StepsRecord(Instant.parse("2001-10-28T00:30:00.123456789Z"),
            ZoneOffset.of("+02:00"), Instant.parse("2001-10-28T02:30:00.987654321Z"),
            ZoneOffset.of("+01:00"), 1234L, metadata)
        val weight = WeightRecord(time, offset, Mass.kilograms(75.25), metadata)
        assertEquals(golden["StepsRecord"], RecordCodecs.encode(steps).recordJson)
        assertEquals(golden["WeightRecord"], RecordCodecs.encode(weight).recordJson)
    }
}
