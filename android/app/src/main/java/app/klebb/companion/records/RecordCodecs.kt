// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.StepsCadenceRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.WheelchairPushesRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.SexualActivityRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.ExerciseCompletionGoal
import androidx.health.connect.client.records.ExercisePerformanceTarget
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Velocity
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Volume
import java.util.Collections
import java.time.Instant
import java.time.Duration
import java.time.ZoneOffset

class EncodedRecord internal constructor(
    val recordType: String,
    val nativeRecordId: String,
    val recordJson: String,
) {
    val serializerId: String = "health-connect-record"
    val serializerVersion: Int = 1
    val dataFamily: String = "ordinary"
    override fun toString(): String = "EncodedRecord(redacted)"
}

object RecordCodecs {
    val supportedRecordTypes: Set<String> =
        Collections.unmodifiableSet(linkedSetOf("StepsRecord", "WeightRecord", "BodyFatRecord",
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
            "CervicalMucusRecord", "IntermenstrualBleedingRecord",
            "MenstruationFlowRecord", "OvulationTestRecord", "SexualActivityRecord",
            "NutritionRecord", "SkinTemperatureRecord", "SleepSessionRecord", "ExerciseSessionRecord",
            "PlannedExerciseSessionRecord"))

    fun encode(record: Record): EncodedRecord =
        encode(record, ExerciseRoutePayloadAuthority.DENY)

    fun encode(record: Record, routeAuthority: ExerciseRoutePayloadAuthority?): EncodedRecord {
        val (type, fields) = when (record) {
            is StepsRecord -> "StepsRecord" to linkedMapOf(
                "metadata" to metadata(record.metadata),
                "startTime" to LosslessValues.instant(record.startTime),
                "startZoneOffset" to LosslessValues.offset(record.startZoneOffset),
                "endTime" to LosslessValues.instant(record.endTime),
                "endZoneOffset" to LosslessValues.offset(record.endZoneOffset),
                "count" to LosslessValues.int64(record.count))
            is WeightRecord -> "WeightRecord" to linkedMapOf(
                "metadata" to metadata(record.metadata),
                "time" to LosslessValues.instant(record.time),
                "zoneOffset" to LosslessValues.offset(record.zoneOffset),
                "weight" to mass(record.weight))
            is BodyFatRecord -> "BodyFatRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "percentage", percentage(record.percentage))
            is BodyWaterMassRecord -> "BodyWaterMassRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "mass", mass(record.mass))
            is BoneMassRecord -> "BoneMassRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "mass", mass(record.mass))
            is LeanBodyMassRecord -> "LeanBodyMassRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "mass", mass(record.mass))
            is HeightRecord -> "HeightRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "height", length(record.height))
            is HeartRateVariabilityRmssdRecord -> "HeartRateVariabilityRmssdRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "heartRateVariabilityMillis",
                LosslessValues.float64(record.heartRateVariabilityMillis))
            is RespiratoryRateRecord -> "RespiratoryRateRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "rate", LosslessValues.float64(record.rate))
            is RestingHeartRateRecord -> "RestingHeartRateRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "beatsPerMinute",
                LosslessValues.int64(record.beatsPerMinute))
            is BasalMetabolicRateRecord -> "BasalMetabolicRateRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "basalMetabolicRate",
                power(record.basalMetabolicRate))
            is BasalBodyTemperatureRecord -> "BasalBodyTemperatureRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "temperature", temperature(record.temperature)
            ).apply { put("measurementLocation", record.measurementLocation) }
            is BodyTemperatureRecord -> "BodyTemperatureRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "temperature", temperature(record.temperature)
            ).apply { put("measurementLocation", record.measurementLocation) }
            is BloodGlucoseRecord -> "BloodGlucoseRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "level", bloodGlucose(record.level)
            ).apply {
                put("specimenSource", record.specimenSource)
                put("mealType", record.mealType)
                put("relationToMeal", record.relationToMeal)
            }
            is BloodPressureRecord -> "BloodPressureRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "systolic", pressure(record.systolic)
            ).apply {
                put("diastolic", pressure(record.diastolic))
                put("bodyPosition", record.bodyPosition)
                put("measurementLocation", record.measurementLocation)
            }
            is OxygenSaturationRecord -> "OxygenSaturationRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "percentage", percentage(record.percentage))
            is Vo2MaxRecord -> "Vo2MaxRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "vo2MillilitersPerMinuteKilogram",
                LosslessValues.float64(record.vo2MillilitersPerMinuteKilogram)
            ).apply { put("measurementMethod", record.measurementMethod) }
            is HeartRateRecord -> "HeartRateRecord" to series(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset, record.samples.map {
                    linkedMapOf("time" to LosslessValues.instant(it.time),
                        "beatsPerMinute" to LosslessValues.int64(it.beatsPerMinute))
                })
            is SpeedRecord -> "SpeedRecord" to series(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset, record.samples.map {
                    linkedMapOf("time" to LosslessValues.instant(it.time), "speed" to velocity(it.speed))
                })
            is PowerRecord -> "PowerRecord" to series(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset, record.samples.map {
                    linkedMapOf("time" to LosslessValues.instant(it.time), "power" to power(it.power))
                })
            is StepsCadenceRecord -> "StepsCadenceRecord" to series(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset, record.samples.map {
                    linkedMapOf("time" to LosslessValues.instant(it.time),
                        "rate" to LosslessValues.float64(it.rate))
                })
            is CyclingPedalingCadenceRecord -> "CyclingPedalingCadenceRecord" to series(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset, record.samples.map {
                    linkedMapOf("time" to LosslessValues.instant(it.time),
                        "revolutionsPerMinute" to LosslessValues.float64(it.revolutionsPerMinute))
                })
            is ActiveCaloriesBurnedRecord -> "ActiveCaloriesBurnedRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply { put("energy", energy(record.energy)) }
            is TotalCaloriesBurnedRecord -> "TotalCaloriesBurnedRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply { put("energy", energy(record.energy)) }
            is DistanceRecord -> "DistanceRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply { put("distance", length(record.distance)) }
            is ElevationGainedRecord -> "ElevationGainedRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply { put("elevation", length(record.elevation)) }
            is FloorsClimbedRecord -> "FloorsClimbedRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset
            ).apply { put("floors", LosslessValues.float64(record.floors)) }
            is HydrationRecord -> "HydrationRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply { put("volume", volume(record.volume)) }
            is WheelchairPushesRecord -> "WheelchairPushesRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset
            ).apply { put("count", LosslessValues.int64(record.count)) }
            is MenstruationPeriodRecord -> "MenstruationPeriodRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset)
            is MindfulnessSessionRecord -> "MindfulnessSessionRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply {
                    put("mindfulnessSessionType", record.mindfulnessSessionType)
                    put("title", record.title)
                    put("notes", record.notes)
                }
            is ActivityIntensityRecord -> "ActivityIntensityRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset
            ).apply { put("activityIntensityType", record.activityIntensityType) }
            is CervicalMucusRecord -> "CervicalMucusRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "appearance", record.appearance
            ).apply { put("sensation", record.sensation) }
            is IntermenstrualBleedingRecord -> "IntermenstrualBleedingRecord" to linkedMapOf(
                "metadata" to metadata(record.metadata),
                "time" to LosslessValues.instant(record.time),
                "zoneOffset" to LosslessValues.offset(record.zoneOffset))
            is MenstruationFlowRecord -> "MenstruationFlowRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "flow", record.flow)
            is OvulationTestRecord -> "OvulationTestRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "result", record.result)
            is SexualActivityRecord -> "SexualActivityRecord" to instantaneous(
                record.metadata, record.time, record.zoneOffset, "protectionUsed", record.protectionUsed)
            is NutritionRecord -> "NutritionRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply {
                    put("biotin", record.biotin?.let { mass(it) })
                    put("caffeine", record.caffeine?.let { mass(it) })
                    put("calcium", record.calcium?.let { mass(it) })
                    put("energy", record.energy?.let { energy(it) })
                    put("energyFromFat", record.energyFromFat?.let { energy(it) })
                    put("chloride", record.chloride?.let { mass(it) })
                    put("cholesterol", record.cholesterol?.let { mass(it) })
                    put("chromium", record.chromium?.let { mass(it) })
                    put("copper", record.copper?.let { mass(it) })
                    put("dietaryFiber", record.dietaryFiber?.let { mass(it) })
                    put("folate", record.folate?.let { mass(it) })
                    put("folicAcid", record.folicAcid?.let { mass(it) })
                    put("iodine", record.iodine?.let { mass(it) })
                    put("iron", record.iron?.let { mass(it) })
                    put("magnesium", record.magnesium?.let { mass(it) })
                    put("manganese", record.manganese?.let { mass(it) })
                    put("molybdenum", record.molybdenum?.let { mass(it) })
                    put("monounsaturatedFat", record.monounsaturatedFat?.let { mass(it) })
                    put("niacin", record.niacin?.let { mass(it) })
                    put("pantothenicAcid", record.pantothenicAcid?.let { mass(it) })
                    put("phosphorus", record.phosphorus?.let { mass(it) })
                    put("polyunsaturatedFat", record.polyunsaturatedFat?.let { mass(it) })
                    put("potassium", record.potassium?.let { mass(it) })
                    put("protein", record.protein?.let { mass(it) })
                    put("riboflavin", record.riboflavin?.let { mass(it) })
                    put("saturatedFat", record.saturatedFat?.let { mass(it) })
                    put("selenium", record.selenium?.let { mass(it) })
                    put("sodium", record.sodium?.let { mass(it) })
                    put("sugar", record.sugar?.let { mass(it) })
                    put("thiamin", record.thiamin?.let { mass(it) })
                    put("totalCarbohydrate", record.totalCarbohydrate?.let { mass(it) })
                    put("totalFat", record.totalFat?.let { mass(it) })
                    put("transFat", record.transFat?.let { mass(it) })
                    put("unsaturatedFat", record.unsaturatedFat?.let { mass(it) })
                    put("vitaminA", record.vitaminA?.let { mass(it) })
                    put("vitaminB12", record.vitaminB12?.let { mass(it) })
                    put("vitaminB6", record.vitaminB6?.let { mass(it) })
                    put("vitaminC", record.vitaminC?.let { mass(it) })
                    put("vitaminD", record.vitaminD?.let { mass(it) })
                    put("vitaminE", record.vitaminE?.let { mass(it) })
                    put("vitaminK", record.vitaminK?.let { mass(it) })
                    put("zinc", record.zinc?.let { mass(it) })
                    put("name", record.name)
                    put("mealType", record.mealType)
                }
            is SkinTemperatureRecord -> "SkinTemperatureRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset
            ).apply {
                put("deltas", record.deltas.map { delta ->
                    linkedMapOf(
                        "time" to LosslessValues.instant(delta.time),
                        "delta" to temperatureDelta(delta.delta)
                    )
                })
                put("baseline", record.baseline?.let { temperature(it) })
                put("measurementLocation", record.measurementLocation)
            }
            is SleepSessionRecord -> "SleepSessionRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset
            ).apply {
                put("title", record.title)
                put("notes", record.notes)
                put("stages", record.stages.map { stage ->
                    linkedMapOf(
                        "startTime" to LosslessValues.instant(stage.startTime),
                        "endTime" to LosslessValues.instant(stage.endTime),
                        "stage" to stage.stage
                    )
                })
            }
            is ExerciseSessionRecord -> {
                val route = when (val routeResult = record.exerciseRouteResult) {
                    is ExerciseRouteResult.NoData -> linkedMapOf("variant" to "NoData")
                    is ExerciseRouteResult.ConsentRequired -> linkedMapOf("variant" to "ConsentRequired")
                    is ExerciseRouteResult.Data -> {
                        if (routeAuthority == null || routeAuthority === ExerciseRoutePayloadAuthority.DENY) {
                            throw ExerciseRouteRefused(ExerciseRouteRefusalReason.AUTHORITY_REQUIRED)
                        }
                        val binding = routeAuthority as ExerciseRoutePayloadAuthority.ForRecord
                        if (binding.nativeRecordId != record.metadata.id ||
                            binding.dataOriginPackageName != record.metadata.dataOrigin.packageName) {
                            throw ExerciseRouteRefused(ExerciseRouteRefusalReason.AUTHORITY_MISMATCH)
                        }
                        linkedMapOf(
                            "variant" to "Data",
                            "route" to routeResult.exerciseRoute.route.map { location ->
                                linkedMapOf(
                                    "time" to LosslessValues.instant(location.time),
                                    "latitude" to LosslessValues.float64(location.latitude),
                                    "longitude" to LosslessValues.float64(location.longitude),
                                    "horizontalAccuracy" to location.horizontalAccuracy?.let { length(it) },
                                    "verticalAccuracy" to location.verticalAccuracy?.let { length(it) },
                                    "altitude" to location.altitude?.let { length(it) }
                                )
                            }
                        )
                    }
                    else -> throw ExerciseRouteRefused(ExerciseRouteRefusalReason.UNKNOWN_RESULT)
                }
                "ExerciseSessionRecord" to interval(
                    record.metadata, record.startTime, record.startZoneOffset,
                    record.endTime, record.endZoneOffset
                ).apply {
                    put("exerciseType", record.exerciseType)
                    put("title", record.title)
                    put("notes", record.notes)
                    put("segments", record.segments.map { segment ->
                        linkedMapOf(
                            "startTime" to LosslessValues.instant(segment.startTime),
                            "endTime" to LosslessValues.instant(segment.endTime),
                            "segmentType" to segment.segmentType,
                            "repetitions" to segment.repetitions,
                            "weight" to segment.weight?.let { mass(it) },
                            "setIndex" to segment.setIndex,
                            "rateOfPerceivedExertion" to segment.rateOfPerceivedExertion?.let {
                                LosslessValues.float32(it)
                            }
                        )
                    })
                    put("laps", record.laps.map { lap ->
                        linkedMapOf(
                            "startTime" to LosslessValues.instant(lap.startTime),
                            "endTime" to LosslessValues.instant(lap.endTime),
                            "length" to lap.length?.let { length(it) }
                        )
                    })
                    put("exerciseRouteResult", route)
                    put("plannedExerciseSessionId", record.plannedExerciseSessionId)
                    put("rateOfPerceivedExertion", record.rateOfPerceivedExertion?.let {
                        LosslessValues.float32(it)
                    })
                }
            }
            is PlannedExerciseSessionRecord -> "PlannedExerciseSessionRecord" to interval(
                record.metadata, record.startTime, record.startZoneOffset,
                record.endTime, record.endZoneOffset).apply {
                    put("hasExplicitTime", record.hasExplicitTime)
                    put("exerciseType", record.exerciseType)
                    put("completedExerciseSessionId", record.completedExerciseSessionId)
                    put("blocks", record.blocks.map { block ->
                        linkedMapOf(
                            "repetitions" to block.repetitions,
                            "steps" to block.steps.map { step ->
                                linkedMapOf(
                                    "exerciseType" to step.exerciseType,
                                    "exercisePhase" to step.exercisePhase,
                                    "completionGoal" to completionGoal(step.completionGoal),
                                    "performanceTargets" to step.performanceTargets.map { performanceTarget(it) },
                                    "description" to step.description)
                            },
                            "description" to block.description)
                    })
                    put("title", record.title)
                    put("notes", record.notes)
                }
            else -> throw RecordCodecException("unsupported-record")
        }
        return EncodedRecord(type, record.metadata.id, RecordJson.text(fields))
    }

    private fun completionGoal(value: ExerciseCompletionGoal): Map<String, Any?> = when (value) {
        is ExerciseCompletionGoal.DistanceGoal -> linkedMapOf(
            "variant" to "DistanceGoal", "distance" to length(value.distance))
        is ExerciseCompletionGoal.DistanceAndDurationGoal -> linkedMapOf(
            "variant" to "DistanceAndDurationGoal", "distance" to length(value.distance),
            "duration" to duration(value.duration))
        is ExerciseCompletionGoal.StepsGoal -> linkedMapOf(
            "variant" to "StepsGoal", "steps" to value.steps)
        is ExerciseCompletionGoal.DurationGoal -> linkedMapOf(
            "variant" to "DurationGoal", "duration" to duration(value.duration))
        is ExerciseCompletionGoal.RepetitionsGoal -> linkedMapOf(
            "variant" to "RepetitionsGoal", "repetitions" to value.repetitions)
        is ExerciseCompletionGoal.TotalCaloriesBurnedGoal -> linkedMapOf(
            "variant" to "TotalCaloriesBurnedGoal", "totalCalories" to energy(value.totalCalories))
        is ExerciseCompletionGoal.ActiveCaloriesBurnedGoal -> linkedMapOf(
            "variant" to "ActiveCaloriesBurnedGoal", "activeCalories" to energy(value.activeCalories))
        ExerciseCompletionGoal.UnknownGoal -> linkedMapOf("variant" to "UnknownGoal")
        ExerciseCompletionGoal.ManualCompletion -> linkedMapOf("variant" to "ManualCompletion")
        else -> throw RecordCodecException("unsupported-value")
    }

    private fun performanceTarget(value: ExercisePerformanceTarget): Map<String, Any?> = when (value) {
        is ExercisePerformanceTarget.PowerTarget -> linkedMapOf(
            "variant" to "PowerTarget", "minPower" to power(value.minPower), "maxPower" to power(value.maxPower))
        is ExercisePerformanceTarget.SpeedTarget -> linkedMapOf(
            "variant" to "SpeedTarget", "minSpeed" to velocity(value.minSpeed), "maxSpeed" to velocity(value.maxSpeed))
        is ExercisePerformanceTarget.CadenceTarget -> linkedMapOf(
            "variant" to "CadenceTarget", "minCadence" to LosslessValues.float64(value.minCadence),
            "maxCadence" to LosslessValues.float64(value.maxCadence))
        is ExercisePerformanceTarget.HeartRateTarget -> linkedMapOf(
            "variant" to "HeartRateTarget", "minHeartRate" to LosslessValues.float64(value.minHeartRate),
            "maxHeartRate" to LosslessValues.float64(value.maxHeartRate))
        is ExercisePerformanceTarget.WeightTarget -> linkedMapOf(
            "variant" to "WeightTarget", "mass" to mass(value.mass))
        is ExercisePerformanceTarget.RateOfPerceivedExertionTarget -> linkedMapOf(
            "variant" to "RateOfPerceivedExertionTarget", "rpe" to value.rpe)
        ExercisePerformanceTarget.AmrapTarget -> linkedMapOf("variant" to "AmrapTarget")
        ExercisePerformanceTarget.UnknownTarget -> linkedMapOf("variant" to "UnknownTarget")
        else -> throw RecordCodecException("unsupported-value")
    }

    private fun duration(value: Duration) = linkedMapOf(
        "seconds" to LosslessValues.int64(value.seconds), "nanoAdjustment" to value.nano)

    private fun instantaneous(sourceMetadata: Metadata, time: Instant, offset: ZoneOffset?,
                              field: String, value: Any?) =
        linkedMapOf(
            "metadata" to metadata(sourceMetadata),
            "time" to LosslessValues.instant(time),
            "zoneOffset" to LosslessValues.offset(offset),
            field to value)

    private fun interval(sourceMetadata: Metadata, start: Instant, startOffset: ZoneOffset?,
                         end: Instant, endOffset: ZoneOffset?) =
        linkedMapOf(
            "metadata" to metadata(sourceMetadata),
            "startTime" to LosslessValues.instant(start),
            "startZoneOffset" to LosslessValues.offset(startOffset),
            "endTime" to LosslessValues.instant(end),
            "endZoneOffset" to LosslessValues.offset(endOffset))

    private fun series(sourceMetadata: Metadata, start: Instant, startOffset: ZoneOffset?,
                       end: Instant, endOffset: ZoneOffset?, samples: List<Map<String, Any?>>) =
        linkedMapOf(
            "metadata" to metadata(sourceMetadata),
            "startTime" to LosslessValues.instant(start),
            "startZoneOffset" to LosslessValues.offset(startOffset),
            "endTime" to LosslessValues.instant(end),
            "endZoneOffset" to LosslessValues.offset(endOffset),
            "samples" to samples)

    private fun mass(value: Mass) = linkedMapOf(
        "unit" to "kg",
        "value" to LosslessValues.float64(value.inKilograms),
        "sdkUnitValues" to linkedMapOf(
            "g" to LosslessValues.float64(value.inGrams),
            "kg" to LosslessValues.float64(value.inKilograms),
            "mg" to LosslessValues.float64(value.inMilligrams),
            "ug" to LosslessValues.float64(value.inMicrograms),
            "oz" to LosslessValues.float64(value.inOunces),
            "lb" to LosslessValues.float64(value.inPounds)))

    private fun length(value: Length) = linkedMapOf(
        "unit" to "m",
        "value" to LosslessValues.float64(value.inMeters),
        "sdkUnitValues" to linkedMapOf(
            "m" to LosslessValues.float64(value.inMeters),
            "km" to LosslessValues.float64(value.inKilometers),
            "mi" to LosslessValues.float64(value.inMiles),
            "in" to LosslessValues.float64(value.inInches),
            "ft" to LosslessValues.float64(value.inFeet)))

    private fun percentage(value: Percentage) = linkedMapOf(
        "unit" to "percent",
        "value" to LosslessValues.float64(value.value),
        "sdkUnitValues" to linkedMapOf("percent" to LosslessValues.float64(value.value)))

    private fun power(value: Power) = linkedMapOf(
        "unit" to "W",
        "value" to LosslessValues.float64(value.inWatts),
        "sdkUnitValues" to linkedMapOf(
            "W" to LosslessValues.float64(value.inWatts),
            "kcal/day" to LosslessValues.float64(value.inKilocaloriesPerDay)))

    private fun temperature(value: Temperature) = linkedMapOf(
        "unit" to "degC",
        "value" to LosslessValues.float64(value.inCelsius),
        "sdkUnitValues" to linkedMapOf(
            "degC" to LosslessValues.float64(value.inCelsius),
            "degF" to LosslessValues.float64(value.inFahrenheit)))

    private fun temperatureDelta(value: TemperatureDelta) =
        linkedMapOf(
            "unit" to "degC-difference",
            "value" to LosslessValues.float64(value.inCelsius),
            "sdkUnitValues" to linkedMapOf(
                "degC-difference" to LosslessValues.float64(value.inCelsius),
                "degF-difference" to LosslessValues.float64(value.inFahrenheit)))

    private fun bloodGlucose(value: BloodGlucose) = linkedMapOf(
        "unit" to "mmol/L",
        "value" to LosslessValues.float64(value.inMillimolesPerLiter),
        "sdkUnitValues" to linkedMapOf(
            "mmol/L" to LosslessValues.float64(value.inMillimolesPerLiter),
            "mg/dL" to LosslessValues.float64(value.inMilligramsPerDeciliter)))

    private fun pressure(value: Pressure) = linkedMapOf(
        "unit" to "mmHg",
        "value" to LosslessValues.float64(value.inMillimetersOfMercury),
        "sdkUnitValues" to linkedMapOf(
            "mmHg" to LosslessValues.float64(value.inMillimetersOfMercury)))

    private fun velocity(value: Velocity) = linkedMapOf(
        "unit" to "m/s",
        "value" to LosslessValues.float64(value.inMetersPerSecond),
        "sdkUnitValues" to linkedMapOf(
            "m/s" to LosslessValues.float64(value.inMetersPerSecond),
            "km/h" to LosslessValues.float64(value.inKilometersPerHour),
            "mi/h" to LosslessValues.float64(value.inMilesPerHour)))

    private fun energy(value: Energy) = linkedMapOf(
        "unit" to "kcal",
        "value" to LosslessValues.float64(value.inKilocalories),
        "sdkUnitValues" to linkedMapOf(
            "cal" to LosslessValues.float64(value.inCalories),
            "kcal" to LosslessValues.float64(value.inKilocalories),
            "J" to LosslessValues.float64(value.inJoules),
            "kJ" to LosslessValues.float64(value.inKilojoules)))

    private fun volume(value: Volume) = linkedMapOf(
        "unit" to "L",
        "value" to LosslessValues.float64(value.inLiters),
        "sdkUnitValues" to linkedMapOf(
            "L" to LosslessValues.float64(value.inLiters),
            "mL" to LosslessValues.float64(value.inMilliliters),
            "fl. oz (US)" to LosslessValues.float64(value.inFluidOuncesUs)))

    private fun metadata(value: Metadata): Map<String, Any?> {
        if (value.id.isEmpty() || value.id.codePointCount(0, value.id.length) > 256 ||
            value.clientRecordVersion < 0) throw RecordCodecException("unsupported-value")
        return linkedMapOf(
            "recordingMethod" to value.recordingMethod,
            "id" to value.id,
            "dataOrigin" to linkedMapOf("packageName" to value.dataOrigin.packageName),
            "lastModifiedTime" to LosslessValues.instant(value.lastModifiedTime),
            "clientRecordId" to value.clientRecordId,
            "clientRecordVersion" to LosslessValues.int64(value.clientRecordVersion),
            "device" to value.device?.let {
                linkedMapOf("type" to it.type, "manufacturer" to it.manufacturer, "model" to it.model)
            })
    }
}
