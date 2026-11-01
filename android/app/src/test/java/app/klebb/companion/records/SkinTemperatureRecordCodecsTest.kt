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
import java.util.Collections

class SkinTemperatureRecordCodecsTest {
    private val fixed = StrictJson.parse(checkNotNull(javaClass.classLoader!!
        .getResourceAsStream("skin-temperature-record-codecs-v1.json"))
        .use { it.readBytes() }) as Map<*, *>
    private fun case(key: String) = (fixed["cases"] as Map<*, *>)[key] as Map<*, *>
    private val observations = fixed["sourceArithmeticUnitObservations"] as List<*>
    private val unitIds = fixed["unitObservationIdsInOrder"] as List<*>
    private fun observation(id: String) = observations[unitIds.indexOf(id)] as Map<*, *>
    private fun factory(input: Map<*, *>): Any {
        val value = (input["decimal"] as String).toDouble()
        return when (input["factory"]) {
            "Temperature.celsius" -> Temperature.celsius(value)
            "Temperature.fahrenheit" -> Temperature.fahrenheit(value)
            "TemperatureDelta.celsius" -> TemperatureDelta.celsius(value)
            "TemperatureDelta.fahrenheit" -> TemperatureDelta.fahrenheit(value)
            else -> error("Unknown fixed temperature unit factory")
        }
    }
    private fun factoryFor(id: String): Any {
        val row = observation(id)
        val input = row["input"] as Map<*, *>
        return factory(mapOf("factory" to row["factory"], "decimal" to input["decimal"]))
    }
    private fun observeUnit(value: Any, row: Map<*, *>) {
        val actual = when (value) {
            is Temperature -> listOf(value.inCelsius, value.inFahrenheit)
            is TemperatureDelta -> listOf(value.inCelsius, value.inFahrenheit)
            else -> error("Unexpected exposed temperature unit")
        }
        for ((index, key) in listOf("expectedGetCelsius", "expectedGetFahrenheit").withIndex()) {
            val expected = row[key] as Map<*, *>
            assertEquals("$key raw Float64 bits", expected["rawBitsHex"],
                java.lang.Long.toUnsignedString(actual[index].toRawBits(), 16).padStart(16, '0'))
            assertEquals("$key original SDK decimal", expected["decimal"], actual[index].toString())
        }
    }
    private fun samples(input: Map<*, *>): MutableList<SkinTemperatureRecord.Delta> =
        (input["deltas"] as List<*>).map { raw ->
            val row = raw as Map<*, *>
            SkinTemperatureRecord.Delta(Instant.parse(row["time"] as String),
                factoryFor(row["unitObservationId"] as String) as TemperatureDelta)
        }.toMutableList()
    private fun construct(body: Map<*, *>, mutable: List<SkinTemperatureRecord.Delta>? = null): SkinTemperatureRecord {
        val input = body["input"] as Map<*, *>
        fun offset(key: String) = (input[key] as String?)?.let { ZoneOffset.of(it) }
        val baseline = input["baseline"] as Map<*, *>?
        return SkinTemperatureRecord(Instant.parse(input["startTime"] as String), offset("startZoneOffset"),
            Instant.parse(input["endTime"] as String), offset("endZoneOffset"),
            if (input["metadataRef"] == "full") NativeMetadataFixture.full() else NativeMetadataFixture.nullable(),
            mutable ?: samples(input), baseline?.let { factory(it) as Temperature },
            (input["measurementLocation"] as Number).toInt())
    }
    private fun observe(body: Map<*, *>, record: SkinTemperatureRecord) {
        val expected = body["record"] as Map<*, *>
        val input = body["input"] as Map<*, *>
        assertEquals(expected["startTime"], record.startTime.toString())
        assertEquals(expected["startZoneOffset"], record.startZoneOffset?.toString())
        assertEquals(expected["endTime"], record.endTime.toString())
        assertEquals(expected["endZoneOffset"], record.endZoneOffset?.toString())
        assertEquals((expected["measurementLocation"] as Number).toInt(), record.measurementLocation)
        val metadata = expected["metadata"] as Map<*, *>
        val native = record.metadata
        assertEquals(metadata["recordingMethod"], native.recordingMethod.toLong())
        assertEquals(metadata["id"], native.id)
        assertEquals((metadata["dataOrigin"] as Map<*, *>)["packageName"], native.dataOrigin.packageName)
        assertEquals(metadata["lastModifiedTime"], native.lastModifiedTime.toString())
        assertEquals(metadata["clientRecordId"], native.clientRecordId)
        assertEquals(metadata["clientRecordVersion"], native.clientRecordVersion.toString())
        val device = metadata["device"] as Map<*, *>?
        if (device == null) assertNull(native.device) else {
            assertNotNull(native.device)
            assertEquals(device["type"], native.device!!.type.toLong())
            assertEquals(device["manufacturer"], native.device!!.manufacturer)
            assertEquals(device["model"], native.device!!.model)
        }
        val baseline = input["baseline"] as Map<*, *>?
        if (baseline == null) assertNull(record.baseline) else {
            assertNotNull(record.baseline)
            val row = observations.map { it as Map<*, *> }.single {
                it["factory"] == baseline["factory"] && it["input"] == mapOf(
                    "decimal" to baseline["decimal"], "rawBitsHex" to baseline["rawBitsHex"])
            }
            observeUnit(record.baseline!!, row)
        }
        val ordered = input["deltas"] as List<*>
        assertEquals(ordered.size, record.deltas.size)
        for ((index, raw) in ordered.withIndex()) {
            val row = raw as Map<*, *>
            assertEquals(row["time"], record.deltas[index].time.toString())
            observeUnit(record.deltas[index].delta, observation(row["unitObservationId"] as String))
        }
    }
    private fun assertEncoding(body: Map<*, *>, result: EncodedRecord) {
        assertEquals(body["record"], StrictJson.parse(result.recordJson.toByteArray(Charsets.UTF_8)))
        assertArrayEquals("fixed whole UTF8 record JSON", (body["recordJson"] as String).toByteArray(Charsets.UTF_8),
            result.recordJson.toByteArray(Charsets.UTF_8))
        assertEquals(body["nativeRecordId"], result.nativeRecordId)
        assertEquals("SkinTemperatureRecord", result.recordType)
        assertEquals("health-connect-record", result.serializerId)
        assertEquals(1, result.serializerVersion)
        assertEquals("ordinary", result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }
    private fun checkCase(key: String) {
        val body = case(key)
        val record = construct(body)
        observe(body, record) // Direct preconditions precede unsupported mapper behavior.
        assertEncoding(body, RecordCodecs.encode(record))
    }
    @Test fun s01CompleteOriginalPrimaryRetainsAllExposedMetadataTimesUnitsAndDeltas() = checkCase("S01")
    @Test fun s02NullBaselineEmptyDeltasNullableMetadataAndOffsetsStayExplicit() = checkCase("S02")
    @Test fun s03PresentAbsoluteZeroBaselineStaysDistinctFromNull() = checkCase("S03")
    @Test fun s04ActualExposedOpaqueLocation9018StaysInt32() = checkCase("S04")
    @Test fun s05DifferenceUnitsNeverAcquireAbsoluteFahrenheitOffset() {
        assertEquals(14, observations.size)
        for (id in unitIds) observeUnit(factoryFor(id as String), observation(id))
        checkCase("S05")
    }
    @Test fun s06SuppliedOutOfOrderAndRepeatedSampleTimesNeverSortOrDeduplicate() = checkCase("S06")
    @Test fun s07PriorEncodedSnapshotSurvivesLaterExposedListMutation() {
        val before = case("S07")["initial"] as Map<*, *>
        val after = case("S07")["afterMutation"] as Map<*, *>
        val mutable = samples(before["input"] as Map<*, *>)
        val record = construct(before, mutable)
        assertSame("observed selected SDK retains passed list", mutable, record.deltas)
        observe(before, record)
        val first = RecordCodecs.encode(record)
        assertEncoding(before, first)
        Collections.swap(mutable, 0, 2)
        mutable.removeAt(1)
        observe(after, record)
        assertEncoding(before, first)
        assertEncoding(after, RecordCodecs.encode(record))
    }
    @Test fun s08ActualSelectedFallbackRecordBoundsAreObservedBeforeMapping() {
        assertEquals("actual JVM fallback branch", 0, android.os.Build.VERSION.SDK_INT)
        val accepted = mutableListOf<Pair<Map<*, *>, SkinTemperatureRecord>>()
        val controls = case("S08")["controls"] as List<*>
        assertEquals(10, controls.size)
        for (raw in controls) {
            val control = raw as Map<*, *>
            if (control["alphaFallbackSourceExpected"] == "REFUSE") {
                assertThrows(control["id"] as String, IllegalArgumentException::class.java) {
                    construct(mapOf("input" to control["input"]))
                }
            } else {
                val body = control["expectedWhenConstructed"] as Map<*, *>
                val record = construct(body)
                observe(body, record)
                accepted.add(body to record)
            }
        }
        assertEquals(4, accepted.size)
        for ((body, record) in accepted) assertEncoding(body, RecordCodecs.encode(record))
    }
    @Test fun s09NestedDeltaBoundsAreSeparateFromUnitFactoryAndMapperRefusal() {
        val accepted = mutableListOf<Pair<Map<*, *>, SkinTemperatureRecord>>()
        val controls = case("S09")["controls"] as List<*>
        assertEquals(4, controls.size)
        for (raw in controls) {
            val control = raw as Map<*, *>
            val input = control["input"] as Map<*, *>
            val deltaInput = input["delta"] as Map<*, *>
            val value = factory(deltaInput) as TemperatureDelta
            val row = observations.map { it as Map<*, *> }.single {
                it["factory"] == deltaInput["factory"] && it["input"] == mapOf(
                    "decimal" to deltaInput["decimal"], "rawBitsHex" to deltaInput["rawBitsHex"])
            }
            observeUnit(value, row)
            if (control["alphaNestedSourceExpected"] == "REFUSE") {
                assertThrows(control["id"] as String, IllegalArgumentException::class.java) {
                    SkinTemperatureRecord.Delta(Instant.parse(input["time"] as String), value)
                }
            } else {
                val nested = SkinTemperatureRecord.Delta(Instant.parse(input["time"] as String), value)
                assertEquals(input["time"], nested.time.toString())
                observeUnit(nested.delta, row)
                val body = control["expectedWhenConstructed"] as Map<*, *>
                val record = construct(body)
                observe(body, record)
                accepted.add(body to record)
            }
        }
        assertEquals(2, accepted.size)
        for ((body, record) in accepted) assertEncoding(body, RecordCodecs.encode(record))
    }
    @Test fun s10BothPinned14PublicGetterSignaturesKeepExactTypedDeltaList() {
        val signatures = (fixed["expectedPublicGetters"] as List<*>).map { it as Map<*, *> }
        assertEquals(14, signatures.size)
        val grouped = signatures.groupBy { it["class"] as String }
        for (version in listOf("1.1.0", "1.2.0-alpha06")) {
            val inventory = StrictJson.parse(File("../docs/sdk-inventory/$version-inventory.json").readBytes()) as Map<*, *>
            assertEquals(version, inventory["version"])
            val getters = (inventory["exposedGetters"] as List<*>).map { it as Map<*, *> }
            for ((name, rows) in grouped) assertEquals("$version $name",
                rows.associate { it["method"] to it["type"] },
                getters.filter { it["class"] == name }.associate { it["method"] to it["type"] })
        }
        for ((name, rows) in grouped) {
            val compiled = Class.forName(name).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 && it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.genericReturnType.typeName }
            assertEquals(name, rows.associate { it["method"] to it["type"] }, compiled)
        }
        assertNotNull(SkinTemperatureRecord::class.java.getConstructor(Instant::class.java,
            ZoneOffset::class.java, Instant::class.java, ZoneOffset::class.java, Metadata::class.java,
            List::class.java, Temperature::class.java, Int::class.javaPrimitiveType!!))
        assertNotNull(SkinTemperatureRecord.Delta::class.java.getConstructor(Instant::class.java,
            TemperatureDelta::class.java))
    }
    @Test fun s11Exact40ClassOrdinaryRegistryIsImmutable() {
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf("SleepSessionRecord", "ExerciseSessionRecord", "PlannedExerciseSessionRecord")
        assertEquals(42, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }

    @Test fun s12AllThirtyEightPriorGoldenUtf8RecordStringsStayByteExact() {
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
        val nutritionFixed = StrictJson.parse(checkNotNull(javaClass.classLoader!!
            .getResourceAsStream("nutrition-record-codecs-v1.json")).use { it.readBytes() }) as Map<*, *>
        val meal = ((nutritionFixed["cases"] as Map<*, *>)["N01"] as Map<*, *>)["input"] as Map<*, *>
        val all = records + constructPriorNutrition(meal)
        val golden = fixed["originalRecordJson"] as Map<*, *>
        assertEquals(38, golden.size)
        assertEquals(golden.keys, all.map { it.javaClass.simpleName }.toSet())
        for (record in all) {
            val result = RecordCodecs.encode(record)
            assertArrayEquals(record.javaClass.simpleName,
                (golden[result.recordType] as String).toByteArray(Charsets.UTF_8),
                result.recordJson.toByteArray(Charsets.UTF_8))
        }
    }
    private fun constructPriorNutrition(input: Map<*, *>): NutritionRecord {
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

}
