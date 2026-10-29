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

class NutritionRecordCodecsTest {
    private val fixed: Map<*, *> = StrictJson.parse(
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("nutrition-record-codecs-v1.json"))
            .use { it.readBytes() }) as Map<*, *>

    private fun case(key: String) = (fixed["cases"] as Map<*, *>)[key] as Map<*, *>

    private fun construct(key: String): NutritionRecord {
        val input = case(key)["input"] as Map<*, *>
        val nutrients = input["nutrients"] as Map<*, *>
        fun mass(field: String) = (nutrients[field] as String?)?.let { Mass.grams(it.toDouble()) }
        fun energy(field: String) =
            (nutrients[field] as String?)?.let { Energy.kilocalories(it.toDouble()) }
        return NutritionRecord(
            startTime = Instant.parse(input["startTime"] as String),
            startZoneOffset = (input["startZoneOffset"] as String?)?.let { ZoneOffset.of(it) },
            endTime = Instant.parse(input["endTime"] as String),
            endZoneOffset = (input["endZoneOffset"] as String?)?.let { ZoneOffset.of(it) },
            metadata = if (input["metadataRef"] == "full") NativeMetadataFixture.full()
                else NativeMetadataFixture.nullable(),
            biotin = mass("biotin"),
            caffeine = mass("caffeine"),
            calcium = mass("calcium"),
            energy = energy("energy"),
            energyFromFat = energy("energyFromFat"),
            chloride = mass("chloride"),
            cholesterol = mass("cholesterol"),
            chromium = mass("chromium"),
            copper = mass("copper"),
            dietaryFiber = mass("dietaryFiber"),
            folate = mass("folate"),
            folicAcid = mass("folicAcid"),
            iodine = mass("iodine"),
            iron = mass("iron"),
            magnesium = mass("magnesium"),
            manganese = mass("manganese"),
            molybdenum = mass("molybdenum"),
            monounsaturatedFat = mass("monounsaturatedFat"),
            niacin = mass("niacin"),
            pantothenicAcid = mass("pantothenicAcid"),
            phosphorus = mass("phosphorus"),
            polyunsaturatedFat = mass("polyunsaturatedFat"),
            potassium = mass("potassium"),
            protein = mass("protein"),
            riboflavin = mass("riboflavin"),
            saturatedFat = mass("saturatedFat"),
            selenium = mass("selenium"),
            sodium = mass("sodium"),
            sugar = mass("sugar"),
            thiamin = mass("thiamin"),
            totalCarbohydrate = mass("totalCarbohydrate"),
            totalFat = mass("totalFat"),
            transFat = mass("transFat"),
            unsaturatedFat = mass("unsaturatedFat"),
            vitaminA = mass("vitaminA"),
            vitaminB12 = mass("vitaminB12"),
            vitaminB6 = mass("vitaminB6"),
            vitaminC = mass("vitaminC"),
            vitaminD = mass("vitaminD"),
            vitaminE = mass("vitaminE"),
            vitaminK = mass("vitaminK"),
            zinc = mass("zinc"),
            name = input["name"] as String?,
            mealType = (input["mealType"] as Number).toInt())
    }

    private fun nutrients(record: NutritionRecord): Map<String, Any?> = linkedMapOf(
        "biotin" to record.biotin,
        "caffeine" to record.caffeine,
        "calcium" to record.calcium,
        "energy" to record.energy,
        "energyFromFat" to record.energyFromFat,
        "chloride" to record.chloride,
        "cholesterol" to record.cholesterol,
        "chromium" to record.chromium,
        "copper" to record.copper,
        "dietaryFiber" to record.dietaryFiber,
        "folate" to record.folate,
        "folicAcid" to record.folicAcid,
        "iodine" to record.iodine,
        "iron" to record.iron,
        "magnesium" to record.magnesium,
        "manganese" to record.manganese,
        "molybdenum" to record.molybdenum,
        "monounsaturatedFat" to record.monounsaturatedFat,
        "niacin" to record.niacin,
        "pantothenicAcid" to record.pantothenicAcid,
        "phosphorus" to record.phosphorus,
        "polyunsaturatedFat" to record.polyunsaturatedFat,
        "potassium" to record.potassium,
        "protein" to record.protein,
        "riboflavin" to record.riboflavin,
        "saturatedFat" to record.saturatedFat,
        "selenium" to record.selenium,
        "sodium" to record.sodium,
        "sugar" to record.sugar,
        "thiamin" to record.thiamin,
        "totalCarbohydrate" to record.totalCarbohydrate,
        "totalFat" to record.totalFat,
        "transFat" to record.transFat,
        "unsaturatedFat" to record.unsaturatedFat,
        "vitaminA" to record.vitaminA,
        "vitaminB12" to record.vitaminB12,
        "vitaminB6" to record.vitaminB6,
        "vitaminC" to record.vitaminC,
        "vitaminD" to record.vitaminD,
        "vitaminE" to record.vitaminE,
        "vitaminK" to record.vitaminK,
        "zinc" to record.zinc)

    private fun unitValues(value: Any): Map<String, Double> = when (value) {
        is Mass -> linkedMapOf("getGrams" to value.inGrams, "getKilograms" to value.inKilograms,
            "getMilligrams" to value.inMilligrams, "getMicrograms" to value.inMicrograms,
            "getOunces" to value.inOunces, "getPounds" to value.inPounds)
        is Energy -> linkedMapOf("getCalories" to value.inCalories,
            "getKilocalories" to value.inKilocalories, "getJoules" to value.inJoules,
            "getKilojoules" to value.inKilojoules)
        else -> error("Unexpected synthetic nutrient unit")
    }

    private fun observe(key: String, record: NutritionRecord): Int {
        // Constructors and every public field/unit getter precede any codec call.
        // JVM fallback acceptance is separate from native platform conversion.
        val expected = case(key)["record"] as Map<*, *>
        assertEquals(key, expected["startTime"], record.startTime.toString())
        assertEquals(key, expected["startZoneOffset"], record.startZoneOffset?.toString())
        assertEquals(key, expected["endTime"], record.endTime.toString())
        assertEquals(key, expected["endZoneOffset"], record.endZoneOffset?.toString())
        assertEquals(key, expected["name"], record.name)
        assertEquals(key, (expected["mealType"] as Number).toInt(), record.mealType)
        val metadata = expected["metadata"] as Map<*, *>
        val native = record.metadata
        assertEquals(metadata["recordingMethod"], native.recordingMethod.toLong())
        assertEquals(metadata["id"], native.id)
        assertEquals((metadata["dataOrigin"] as Map<*, *>)["packageName"],
            native.dataOrigin.packageName)
        assertEquals(metadata["lastModifiedTime"], native.lastModifiedTime.toString())
        assertEquals(metadata["clientRecordId"], native.clientRecordId)
        assertEquals(metadata["clientRecordVersion"], native.clientRecordVersion.toString())
        val device = metadata["device"] as Map<*, *>?
        if (device == null) {
            assertNull(native.device)
        } else {
            assertNotNull(native.device)
            assertEquals(device["type"], native.device!!.type.toLong())
            assertEquals(device["manufacturer"], native.device!!.manufacturer)
            assertEquals(device["model"], native.device!!.model)
        }
        val oracles = case(key)["sdkUnitObservations"] as Map<*, *>
        val observed = nutrients(record)
        assertEquals(42, observed.size)
        assertEquals(expected.keys - setOf("metadata", "startTime", "startZoneOffset",
            "endTime", "endZoneOffset", "name", "mealType"), observed.keys)
        var count = 0
        for ((field, value) in observed) {
            if (expected[field] == null) {
                assertNull("$key $field", value)
                assertFalse(oracles.containsKey(field))
            } else {
                assertNotNull("$key $field", value)
                val actual = unitValues(value!!)
                val observations = (oracles[field] as List<*>).map { it as Map<*, *> }
                assertEquals("$key $field", observations.map { it["getter"] }.toSet(), actual.keys)
                for (entry in observations) {
                    val getter = entry["getter"] as String
                    val number = actual.getValue(getter)
                    assertEquals("$key $field $getter bits", entry["binary64RawBitsHex"],
                        java.lang.Long.toUnsignedString(number.toRawBits(), 16).padStart(16, '0'))
                    assertEquals("$key $field $getter SDK decimal", entry["decimal"], number.toString())
                    count++
                }
            }
        }
        return count
    }

    private fun encode(key: String, record: NutritionRecord) {
        val expected = case(key)
        val result = RecordCodecs.encode(record)
        assertEquals(key, expected["record"], StrictJson.parse(result.recordJson.toByteArray(Charsets.UTF_8)))
        assertEquals("$key fixed field order and source strings", expected["recordJson"], result.recordJson)
        assertEquals(expected["nativeRecordId"], result.nativeRecordId)
        assertEquals("NutritionRecord", result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }

    private fun checkCase(key: String) {
        val record = construct(key)
        observe(key, record)
        encode(key, record)
    }

    private fun checkSparse(keys: List<String>) {
        val records = keys.map { it to construct(it) }
        // Observe the entire sparse group before a fail-fast unsupported refusal.
        for ((key, record) in records) assertEquals(6, observe(key, record))
        for ((key, record) in records) encode(key, record)
    }

    @Test fun n01CompleteMealPreservesAllFieldsMetadataOffsetsAndSourceName() = checkCase("N01")
    @Test fun n02NullNutrientsNameMetadataAndOffsetsRemainExplicitNull() = checkCase("N02")
    @Test fun n03EveryPresentZeroUnitRemainsDistinctFromNull() = checkCase("N03")
    @Test fun n04EmptyNameAndExposedOpaqueMealTypeRemainExact() = checkCase("N04")
    @Test fun n05SparseCaffeineMagnesiumAndTransFatNeverSwap() =
        checkSparse(listOf("N05a", "N05b", "N05c"))
    @Test fun n06SparseCholesterolAndVitaminCNeverSwap() = checkSparse(listOf("N06a", "N06b"))
    @Test fun n07SparseDietaryFiberAndUnsaturatedFatNeverSwap() = checkSparse(listOf("N07a", "N07b"))

    @Test fun n08All248PrimaryAnd42SparseSdkUnitLiteralsAreObservedBeforeMapping() {
        assertEquals(248, observe("N01", construct("N01")))
        val sparse = listOf("N05a", "N05b", "N05c", "N06a", "N06b", "N07a", "N07b")
        assertEquals(42, sparse.sumOf { observe(it, construct(it)) })
        // Both cached pins also require the separate SDK-only constructor/getter
        // observer before mapping; inventory equality alone is not runtime proof.
    }

    @Test fun n09BothPinned59GetterSignaturesAndImmutable38TypeRegistryStayExact() {
        val expected = fixed["expectedPublicGetters"] as Map<*, *>
        assertEquals(3, expected.size)
        assertEquals(59, expected.values.sumOf { (it as Map<*, *>).size })
        assertEquals(49, (expected[NutritionRecord::class.java.name] as Map<*, *>).size)
        for (version in listOf("1.1.0", "1.2.0-alpha06")) {
            val inventory = StrictJson.parse(
                File("../docs/sdk-inventory/$version-inventory.json").readBytes()) as Map<*, *>
            assertEquals(version, inventory["version"])
            val getters = inventory["exposedGetters"] as List<*>
            for ((name, signatures) in expected) {
                val pinned = getters.map { it as Map<*, *> }.filter { it["class"] == name }
                    .associate { it["method"] as String to it["type"] as String }
                assertEquals("$version $name", signatures, pinned)
            }
        }
        for ((name, signatures) in expected) {
            // Test-only ABI reflection never serializes any record.
            val compiled = Class.forName(name as String).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 &&
                    it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.returnType.name }
            assertEquals(name, signatures, compiled)
        }
        val registry = (fixed["expectedRegistry"] as List<*>).toSet()
        assertEquals(38, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }

    @Test fun n10AllThirtySevenEarlierGoldenUtf8ByteStringsStayExact() {
        val time = Instant.parse("2001-02-03T04:05:06.123456789Z")
        val offset = ZoneOffset.of("+05:45")
        val metadata = NativeMetadataFixture.full()
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
            ActivityIntensityRecord(start, startOffset, end, endOffset, metadata, 0),
            CervicalMucusRecord(time, offset, metadata, 5, 2),
            IntermenstrualBleedingRecord(time, offset, metadata),
            MenstruationFlowRecord(time, offset, metadata, 2),
            OvulationTestRecord(time, offset, 1, metadata),
            SexualActivityRecord(time, offset, metadata, 1))
        val golden = fixed["originalRecordJson"] as Map<*, *>
        assertEquals(37, golden.size)
        assertEquals(golden.keys, records.map { it.javaClass.simpleName }.toSet())
        for (record in records) {
            val result = RecordCodecs.encode(record)
            assertArrayEquals(record.javaClass.simpleName,
                (golden[result.recordType] as String).toByteArray(Charsets.UTF_8),
                result.recordJson.toByteArray(Charsets.UTF_8))
        }
    }
}
