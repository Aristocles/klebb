// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import java.util.Collections

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
        Collections.unmodifiableSet(linkedSetOf("StepsRecord", "WeightRecord"))

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
                "weight" to linkedMapOf(
                    "unit" to "kg",
                    "value" to LosslessValues.float64(record.weight.inKilograms),
                    "sdkUnitValues" to linkedMapOf(
                        "g" to LosslessValues.float64(record.weight.inGrams),
                        "kg" to LosslessValues.float64(record.weight.inKilograms),
                        "mg" to LosslessValues.float64(record.weight.inMilligrams),
                        "ug" to LosslessValues.float64(record.weight.inMicrograms),
                        "oz" to LosslessValues.float64(record.weight.inOunces),
                        "lb" to LosslessValues.float64(record.weight.inPounds))))
            else -> throw RecordCodecException("unsupported-record")
        }
        return EncodedRecord(type, record.metadata.id, RecordJson.text(fields))
    }

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
