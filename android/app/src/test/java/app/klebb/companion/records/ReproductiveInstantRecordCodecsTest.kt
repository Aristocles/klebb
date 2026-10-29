// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.*
import androidx.health.connect.client.units.*
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.time.Instant
import java.time.ZoneOffset

class ReproductiveInstantRecordCodecsTest {
    private val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
    private val offset = ZoneOffset.of("+05:45")
    private val supplementalTime = Instant.parse("2001-02-03T04:05:06.000000001Z")
    private val metadata = NativeMetadataFixture.full()
    private fun fixtures(): Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("reproductive-instant-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>

    private fun checkCase(key: String, record: Record) {
        val fixed = (fixtures()["cases"] as Map<*, *>)[key] as Map<*, *>
        val expected = fixed["record"] as Map<*, *>
        // Observe each real constructor and public getter before calling the codec.
        // An SDK refusal remains a separate failure from unsupported encoding.
        val observed = when (record) {
            is CervicalMucusRecord -> Triple(record.time, record.zoneOffset,
                mapOf("appearance" to record.appearance, "sensation" to record.sensation))
            is IntermenstrualBleedingRecord ->
                Triple(record.time, record.zoneOffset, emptyMap<String, Int>())
            is MenstruationFlowRecord ->
                Triple(record.time, record.zoneOffset, mapOf("flow" to record.flow))
            is OvulationTestRecord ->
                Triple(record.time, record.zoneOffset, mapOf("result" to record.result))
            is SexualActivityRecord ->
                Triple(record.time, record.zoneOffset, mapOf("protectionUsed" to record.protectionUsed))
            else -> error("Unexpected synthetic record type")
        }
        assertEquals(key, expected["time"], observed.first.toString())
        assertEquals(key, expected["zoneOffset"], observed.second?.toString())
        val expectedEnums = expected.filterKeys {
            it !in setOf("metadata", "time", "zoneOffset")
        }.entries.associate { (name, value) -> name as String to (value as Number).toInt() }
        assertEquals(key, expectedEnums, observed.third)
        val expectedMetadata = expected["metadata"] as Map<*, *>
        val native = record.metadata
        assertEquals(expectedMetadata["recordingMethod"], native.recordingMethod.toLong())
        assertEquals(expectedMetadata["id"], native.id)
        assertEquals((expectedMetadata["dataOrigin"] as Map<*, *>)["packageName"],
            native.dataOrigin.packageName)
        assertEquals(expectedMetadata["lastModifiedTime"], native.lastModifiedTime.toString())
        assertEquals(expectedMetadata["clientRecordId"], native.clientRecordId)
        assertEquals(expectedMetadata["clientRecordVersion"], native.clientRecordVersion.toString())
        val device = expectedMetadata["device"] as Map<*, *>?
        if (device == null) {
            assertNull(native.device)
        } else {
            assertNotNull(native.device)
            assertEquals(device["type"], native.device!!.type.toLong())
            assertEquals(device["manufacturer"], native.device!!.manufacturer)
            assertEquals(device["model"], native.device!!.model)
        }
        val result = RecordCodecs.encode(record)
        assertEquals(key, expected, StrictJson.parse(result.recordJson.toByteArray()))
        assertEquals(fixed["nativeRecordId"], result.nativeRecordId)
        assertEquals(fixed["recordType"], result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }

    @Test fun r01CervicalMucusPreservesBothSpecificEnums() =
        checkCase("R01", CervicalMucusRecord(time, offset, metadata, 5, 2))

    @Test fun r02IntermenstrualBleedingRemainsCompleteMetadataOnlyEvent() =
        checkCase("R02", IntermenstrualBleedingRecord(time, offset, metadata))

    @Test fun r03MenstruationFlowPreservesOpaqueFlow() =
        checkCase("R03", MenstruationFlowRecord(time, offset, metadata, 2))

    @Test fun r04OvulationResultPreservesItsDifferentConstructorOrder() =
        checkCase("R04", OvulationTestRecord(time, offset, 1, metadata))

    @Test fun r05SexualActivityPreservesProtectionObservation() =
        checkCase("R05", SexualActivityRecord(time, offset, metadata, 1))

    @Test fun r06CervicalUnknownEnumsEmptyClientAndNullDeviceFieldsStayExact() =
        checkCase("R06", CervicalMucusRecord(supplementalTime, null,
            NativeMetadataFixture.nullableDeviceFields(), 9009, 9010))

    @Test fun r07BleedingKeepsOneNanosecondNullOffsetAndNullMetadataFields() =
        checkCase("R07", IntermenstrualBleedingRecord(supplementalTime, null,
            NativeMetadataFixture.nullable()))

    @Test fun r08UnknownFlowAndNullMetadataStayDistinctFromZero() =
        checkCase("R08", MenstruationFlowRecord(supplementalTime, null,
            NativeMetadataFixture.nullable(), 9013))

    @Test fun r09UnknownOvulationResultAndNullMetadataStayExact() =
        checkCase("R09", OvulationTestRecord(supplementalTime, null, 9016,
            NativeMetadataFixture.nullable()))

    @Test fun r10UnknownProtectionAndMaximumClientVersionStayExact() =
        checkCase("R10", SexualActivityRecord(supplementalTime, null,
            NativeMetadataFixture.nullableDeviceFields(), 9017))

    @Test fun r11BothPinnedPublicGetterMapsAndImmutableRegistryStayExact() {
        val fixed = fixtures()
        val expected = fixed["expectedPublicGetters"] as Map<*, *>
        assertEquals(5, expected.size)
        assertEquals(20, expected.values.sumOf { (it as Map<*, *>).size })
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
            // Test-only reflection verifies fixed public signatures, never serializes.
            val compiled = Class.forName(name as String).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 &&
                    it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.returnType.name }
            assertEquals(name, getters, compiled)
        }
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf("NutritionRecord", "SkinTemperatureRecord", "SleepSessionRecord")
        assertEquals(40, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }

    @Test fun r12AllThirtyTwoEarlierGoldenJsonByteStringsStayExact() {
        val start = Instant.parse("2001-10-28T00:30:00.123456789Z")
        val end = Instant.parse("2001-10-28T02:30:00.987654321Z")
        val startOffset = ZoneOffset.of("+02:00")
        val endOffset = ZoneOffset.of("+01:00")
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
                CyclingPedalingCadenceRecord.Sample(late, 92.25)), metadata),
            ActiveCaloriesBurnedRecord(start, startOffset, end, endOffset,
                Energy.kilocalories(123.125), metadata),
            TotalCaloriesBurnedRecord(start, startOffset, end, endOffset,
                Energy.kilocalories(456.125), metadata),
            DistanceRecord(start, startOffset, end, endOffset, Length.meters(1234.125), metadata),
            ElevationGainedRecord(start, startOffset, end, endOffset, Length.meters(12.125), metadata),
            FloorsClimbedRecord(start, startOffset, end, endOffset, 3.125, metadata),
            HydrationRecord(start, startOffset, end, endOffset, Volume.liters(0.625), metadata),
            WheelchairPushesRecord(start, startOffset, end, endOffset, 321L, metadata),
            MenstruationPeriodRecord(start, startOffset, end, endOffset, metadata),
            MindfulnessSessionRecord(start, startOffset, end, endOffset, metadata,
                0, "Synthetic pause", "Synthetic note\n\u4fdd\u7559"),
            ActivityIntensityRecord(start, startOffset, end, endOffset, metadata, 0))
        val golden = fixtures()["originalRecordJson"] as Map<*, *>
        assertEquals(32, golden.size)
        assertEquals(golden.keys, records.map { it.javaClass.simpleName }.toSet())
        for (record in records) {
            val result = RecordCodecs.encode(record)
            assertEquals(record.javaClass.simpleName, golden[result.recordType], result.recordJson)
        }
    }
}
