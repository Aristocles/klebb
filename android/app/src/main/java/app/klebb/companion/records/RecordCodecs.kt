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
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Pressure
import java.util.Collections
import java.time.Instant
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
            "BloodGlucoseRecord", "BloodPressureRecord", "OxygenSaturationRecord", "Vo2MaxRecord"))

    fun encode(record: Record): EncodedRecord {
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
            else -> throw RecordCodecException("unsupported-record")
        }
        return EncodedRecord(type, record.metadata.id, RecordJson.text(fields))
    }

    private fun instantaneous(sourceMetadata: Metadata, time: Instant, offset: ZoneOffset?,
                              field: String, value: Any?) =
        linkedMapOf(
            "metadata" to metadata(sourceMetadata),
            "time" to LosslessValues.instant(time),
            "zoneOffset" to LosslessValues.offset(offset),
            field to value)

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
