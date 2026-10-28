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
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Percentage
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
            "HeartRateVariabilityRmssdRecord", "RespiratoryRateRecord", "RestingHeartRateRecord"))

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
