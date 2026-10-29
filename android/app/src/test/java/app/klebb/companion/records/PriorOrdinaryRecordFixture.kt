// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.*
import androidx.health.connect.client.units.*
import app.klebb.companion.protocol.StrictJson
import java.time.Instant
import java.time.ZoneOffset

/** Actual SDK constructor inputs reused from the unchanged prior golden checks. */
internal object PriorOrdinaryRecordFixture {
    fun records(): List<Record> {
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
        return records + constructPriorNutrition(meal) + SkinTemperatureRecord(
            start, startOffset, end, endOffset, metadata, listOf(
                SkinTemperatureRecord.Delta(early, TemperatureDelta.celsius(-0.25)),
                SkinTemperatureRecord.Delta(Instant.parse("2001-10-28T01:00:00.123456789Z"), TemperatureDelta.celsius(0.0)),
                SkinTemperatureRecord.Delta(late, TemperatureDelta.celsius(0.125))),
            Temperature.celsius(33.125), 3)
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
