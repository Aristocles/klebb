// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.units.Mass
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.io.File
import java.lang.reflect.Modifier

class RecordCodecsTest {
    private fun parsed(json: String): Map<*, *> = StrictJson.parse(json.toByteArray()) as Map<*, *>
    private fun expected(key: String): Map<*, *> {
        val bytes = checkNotNull(javaClass.classLoader!!.getResourceAsStream("record-codecs-v1.json"))
            .use { it.readBytes() }
        return (StrictJson.parse(bytes) as Map<*, *>)[key] as Map<*, *>
    }
    private fun steps(metadata: Metadata = NativeMetadataFixture.full()) = StepsRecord(
        Instant.parse("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
        Instant.parse("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"), 1234, metadata)
    private fun weight(metadata: Metadata = NativeMetadataFixture.full()) = WeightRecord(
        Instant.parse("2001-02-03T04:05:06.123456789Z"), ZoneOffset.of("+05:45"),
        Mass.kilograms(75.25), metadata)

    @Test fun s01StepsPreservesEveryGetterAndMetadata() {
        val result = RecordCodecs.encode(steps())
        assertEquals(expected("stepsFull"), parsed(result.recordJson))
        assertEquals("synthetic-provider-id", result.nativeRecordId)
        assertEquals("StepsRecord", result.recordType)
    }
    @Test fun s02WeightPreservesEveryUnitObservation() {
        val result = RecordCodecs.encode(weight())
        assertEquals(expected("weightFull"), parsed(result.recordJson))
        val mass = (parsed(result.recordJson)["weight"] as Map<*, *>)["value"] as String
        assertEquals(0x4052d00000000000L, mass.toDouble().toRawBits())
    }
    @Test fun s03NullDeviceFieldsAndEmptyClientIdStayDistinct() {
        val record = WeightRecord(Instant.parse("2001-02-03T04:05:06.000000001Z"), null,
            Mass.kilograms(75.25), NativeMetadataFixture.nullableDeviceFields())
        assertEquals(expected("weightNullableFields"), parsed(RecordCodecs.encode(record).recordJson))
    }
    @Test fun s04OneNanosecondIntervalAndNullFieldsSurvive() {
        val record = StepsRecord(Instant.parse("2001-10-28T00:30:00.000000001Z"), null,
            Instant.parse("2001-10-28T00:30:00.000000002Z"), null, 1234,
            NativeMetadataFixture.nullable())
        assertEquals(expected("stepsNullableFields"), parsed(RecordCodecs.encode(record).recordJson))
    }
    @Test fun s05SeventeenthDigitFloat64IsRetained() {
        val text = LosslessValues.float64(Double.fromBits(0x3fb999999999999bL))
        assertEquals("0.10000000000000002", text)
        assertEquals(0x3fb999999999999bL, text.toDouble().toRawBits())
    }
    @Test fun s06Float32IsNotPromotedToFloat64Encoding() {
        val text = LosslessValues.float32(Float.fromBits(0x3f800001))
        assertEquals("1.0000001", text)
        assertEquals(0x3f800001, text.toFloat().toRawBits())
        assertNotEquals("1.0000001192092896", text)
    }
    @Test fun s07NegativeZeroSignSurvives() {
        val text = LosslessValues.float64(-0.0)
        assertEquals("-0.0", text)
        assertEquals(Long.MIN_VALUE, text.toDouble().toRawBits())
    }
    @Test fun s08UnknownRecordingMethodRetainedAsNumber() {
        val encoded = parsed(RecordCodecs.encode(steps(NativeMetadataFixture.fullWithRecordingMethod(9024))).recordJson)
        assertEquals(9024L, (encoded["metadata"] as Map<*, *>)["recordingMethod"])
    }
    @Test fun s09UnknownClassRefusesWithoutFallbackOrUnavailableClaim() {
        val future = object : Record { override val metadata = NativeMetadataFixture.full() }
        val error = assertThrows(RecordCodecException::class.java) { RecordCodecs.encode(future) }
        assertEquals("unsupported-record", error.code)
        assertEquals("unsupported-record", error.message)
    }
    @Test fun s10RegistryAndEnvelopeAdvertiseOnlyImplementedAdapters() {
        assertEquals(setOf("StepsRecord", "WeightRecord", "BodyFatRecord", "BodyWaterMassRecord",
            "BoneMassRecord", "LeanBodyMassRecord", "HeightRecord", "HeartRateVariabilityRmssdRecord",
            "RespiratoryRateRecord", "RestingHeartRateRecord", "BasalMetabolicRateRecord",
            "BasalBodyTemperatureRecord", "BodyTemperatureRecord", "BloodGlucoseRecord",
            "BloodPressureRecord", "OxygenSaturationRecord", "Vo2MaxRecord",
            "HeartRateRecord", "SpeedRecord", "PowerRecord",
            "StepsCadenceRecord", "CyclingPedalingCadenceRecord",
            "ActiveCaloriesBurnedRecord", "TotalCaloriesBurnedRecord", "DistanceRecord",
            "ElevationGainedRecord", "FloorsClimbedRecord", "HydrationRecord",
            "WheelchairPushesRecord", "MenstruationPeriodRecord",
            "MindfulnessSessionRecord", "ActivityIntensityRecord",
            "CervicalMucusRecord", "IntermenstrualBleedingRecord", "MenstruationFlowRecord",
            "OvulationTestRecord", "SexualActivityRecord", "NutritionRecord", "SkinTemperatureRecord"),
            RecordCodecs.supportedRecordTypes)
        for (record in listOf(steps(), weight())) {
            val result = RecordCodecs.encode(record)
            assertEquals("health-connect-record", result.serializerId)
            assertEquals(1, result.serializerVersion)
            assertEquals("ordinary", result.dataFamily)
            assertEquals("EncodedRecord(redacted)", result.toString())
        }
    }

    @Test fun primitiveBoundsRoundTripWithoutJavaScriptIntegerOrDecimalLimits() {
        assertEquals("-9223372036854775808", LosslessValues.int64(Long.MIN_VALUE))
        assertEquals("9223372036854775807", LosslessValues.int64(Long.MAX_VALUE))
        assertEquals("4.9E-324", LosslessValues.float64(Double.MIN_VALUE))
        assertEquals("1.7976931348623157E308", LosslessValues.float64(Double.MAX_VALUE))
        assertEquals("1.4E-45", LosslessValues.float32(Float.MIN_VALUE))
        assertEquals("3.4028235E38", LosslessValues.float32(Float.MAX_VALUE))
        assertEquals("-0.0", LosslessValues.float32(-0.0f))
        assertEquals("0.0", LosslessValues.float64(0.0))
        for (bits in listOf(1L, 0x7fefffffffffffffL, 0x3fb999999999999bL, Long.MIN_VALUE)) {
            assertEquals(bits, LosslessValues.float64(Double.fromBits(bits)).toDouble().toRawBits())
        }
    }

    @Test fun nonFiniteValuesVisiblyRefuseWithoutPayloads() {
        for (value in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            val error = assertThrows(RecordCodecException::class.java) { LosslessValues.float64(value) }
            assertEquals("unsupported-value", error.code)
            assertEquals(error.code, error.message)
        }
        for (value in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertEquals("unsupported-value", assertThrows(RecordCodecException::class.java) {
                LosslessValues.float32(value)
            }.code)
        }
    }

    @Test fun instantAndOffsetKeepNanosecondsAndSecondPrecision() {
        assertEquals("2001-02-03T04:05:06.000000001Z",
            LosslessValues.instant(Instant.parse("2001-02-03T04:05:06.000000001Z")))
        assertEquals("+05:45:12", LosslessValues.offset(ZoneOffset.of("+05:45:12")))
        assertEquals("Z", LosslessValues.offset(ZoneOffset.UTC))
        assertNull(LosslessValues.offset(null))
    }

    @Test fun unitFactoryRoundingIsPreservedForEveryObservedGetter() {
        val nativeMass = Mass.pounds(1.0)
        val record = WeightRecord(Instant.parse("2001-02-03T04:05:06Z"), null,
            nativeMass, NativeMetadataFixture.full())
        val mass = parsed(RecordCodecs.encode(record).recordJson)["weight"] as Map<*, *>
        val values = mass["sdkUnitValues"] as Map<*, *>
        // Independent pinned-SDK unit factors, not values generated by the codec.
        assertEquals(mapOf("g" to "453.59237", "kg" to "0.45359237", "mg" to "453592.37",
            "ug" to "453592370.00000006", "oz" to "16.000001763698293", "lb" to "1"), values)
        val getters = listOf(nativeMass.inGrams, nativeMass.inKilograms, nativeMass.inMilligrams,
            nativeMass.inMicrograms, nativeMass.inOunces, nativeMass.inPounds)
        for ((index, unit) in listOf("g", "kg", "mg", "ug", "oz", "lb").withIndex()) {
            assertEquals(unit, getters[index].toRawBits(), (values[unit] as String).toDouble().toRawBits())
        }
    }

    @Test fun unknownDeviceEnumAndEscapedSourceStringsRemainUnchanged() {
        val metadata = NativeMetadataFixture.create(9024, "synthetic-id", "2001-01-01T00:00:00Z",
            "nul:\u0000 tab:\t slash:\\ emoji:\uD83D\uDE00", 9026,
            Device(9025, "", "\u0001"))
        val result = parsed(RecordCodecs.encode(steps(metadata)).recordJson)["metadata"] as Map<*, *>
        assertEquals(9024L, result["recordingMethod"])
        assertEquals("9026", result["clientRecordVersion"])
        assertEquals("nul:\u0000 tab:\t slash:\\ emoji:\uD83D\uDE00", result["clientRecordId"])
        assertEquals(mapOf("type" to 9025L, "manufacturer" to "", "model" to "\u0001"), result["device"])
    }

    @Test fun sourceUnpairedSurrogatesAndMissingNativeIdRefuse() {
        for (clientId in listOf("\uD800", "\uDC00")) {
            val metadata = NativeMetadataFixture.create(0, "synthetic-id", "2001-01-01T00:00:00Z",
                clientId, 0, null)
            assertEquals("unsupported-value", assertThrows(RecordCodecException::class.java) {
                RecordCodecs.encode(steps(metadata))
            }.code)
        }
        val sentinel = NativeMetadataFixture.create(0, "", "2001-01-01T00:00:00Z", null, 0, null)
        assertEquals("unsupported-value", assertThrows(RecordCodecException::class.java) {
            RecordCodecs.encode(steps(sentinel))
        }.code)
    }

    @Test fun unsupportedNativeVersionAndWireInstantRangeRefuse() {
        val metadata = NativeMetadataFixture.create(0, "synthetic-id", "2001-01-01T00:00:00Z",
            null, -1, null)
        assertEquals("unsupported-value", assertThrows(RecordCodecException::class.java) {
            RecordCodecs.encode(steps(metadata))
        }.code)
        assertEquals("unsupported-value", assertThrows(RecordCodecException::class.java) {
            LosslessValues.instant(Instant.parse("+10000-01-01T00:00:00Z"))
        }.code)
    }

    @Test fun getterCoverageMatchesPinnedInventoryAndActualCompiledSdk() {
        val types = mapOf(
            StepsRecord::class.java to mapOf("getStartTime" to "java.time.Instant",
                "getStartZoneOffset" to "java.time.ZoneOffset", "getEndTime" to "java.time.Instant",
                "getEndZoneOffset" to "java.time.ZoneOffset", "getCount" to "long",
                "getMetadata" to "androidx.health.connect.client.records.metadata.Metadata"),
            WeightRecord::class.java to mapOf("getTime" to "java.time.Instant",
                "getZoneOffset" to "java.time.ZoneOffset", "getWeight" to "androidx.health.connect.client.units.Mass",
                "getMetadata" to "androidx.health.connect.client.records.metadata.Metadata"),
            Metadata::class.java to mapOf("getRecordingMethod" to "int", "getId" to "java.lang.String",
                "getDataOrigin" to "androidx.health.connect.client.records.metadata.DataOrigin",
                "getLastModifiedTime" to "java.time.Instant", "getClientRecordId" to "java.lang.String",
                "getClientRecordVersion" to "long", "getDevice" to "androidx.health.connect.client.records.metadata.Device"),
            Device::class.java to mapOf("getType" to "int", "getManufacturer" to "java.lang.String",
                "getModel" to "java.lang.String"),
            DataOrigin::class.java to mapOf("getPackageName" to "java.lang.String"),
            Mass::class.java to listOf("getGrams", "getKilograms", "getMilligrams", "getMicrograms",
                "getOunces", "getPounds").associateWith { "double" })
        // Gradle's test working directory is this app module, in local and CI builds.
        val inventory = StrictJson.parse(File("../docs/sdk-inventory/1.2.0-alpha06-inventory.json")
            .readBytes()) as Map<*, *>
        val fields = inventory["exposedGetters"] as List<*>
        assertEquals("1.2.0-alpha06", inventory["version"])
        for ((type, expectedGetters) in types) {
            val pinned = fields.map { it as Map<*, *> }.filter { it["class"] == type.name }
                .associate { it["method"] as String to it["type"] as String }
            assertEquals(type.name, expectedGetters, pinned)
            // Reflection is confined to this test; production adapters call getters explicitly.
            val compiled = type.declaredMethods.filter { Modifier.isPublic(it.modifiers) &&
                !Modifier.isStatic(it.modifiers) && it.parameterCount == 0 &&
                it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*")) }
                .associate { it.name to it.returnType.name }
            assertEquals(type.name, expectedGetters, compiled)
        }
    }
}
