// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.Collections

typealias JsonObject = Map<String, Any?>
data class Serializer(val id: String, val version: Long, val dataFamily: String)
data class ValidationContext(
    val limits: Map<String, Long> = emptyMap(),
    val binding: Map<String, String>? = null,
    val categories: Set<String>? = null,
    val serializers: List<Serializer>? = null,
    val rawFrontiers: Map<String, String> = emptyMap()
)
class HealthFrame internal constructor(val fields: JsonObject) {
    val kind: String get() = fields["kind"] as String
    override fun toString() = "HealthFrame($kind)"
}
@Suppress("UNCHECKED_CAST")
internal fun Any?.objectValue(): JsonObject =
    this as? Map<String, Any?> ?: throw ProtocolException("invalid-message")

class HealthProtocol(schemaBytes: ByteArray) {
    private val rules = SchemaRules(StrictJson.parse(schemaBytes).objectValue())
    private val hard = mapOf("maxBytes" to 1048576L, "maxChanges" to 500L, "maxDepth" to 16L,
        "maxNodes" to 20000L, "maxSamples" to 10000L, "maxParts" to 128L, "maxObjectBytes" to 67108864L)
    private val bindingKeys = listOf("tenantId", "instanceId", "sourceStoreId", "installationId",
        "generation", "restoreEpoch")
    private val defaultSerializers = listOf(Serializer("health-connect-record", 1, "ordinary"))

    private fun limits(context: ValidationContext): Map<String, Long> {
        val negotiated = hard.toMutableMap()
        for ((key, value) in context.limits) {
            if (hard[key] == null || value < 1 || value > hard.getValue(key)) fail("limit-exceeded")
            negotiated[key] = value
        }
        return negotiated
    }

    fun decode(bytes: ByteArray, context: ValidationContext = ValidationContext()): HealthFrame {
        val negotiated = limits(context)
        val limits = StrictJson.Limits(
            negotiated.getValue("maxBytes").toInt(), negotiated.getValue("maxDepth").toInt(),
            negotiated.getValue("maxNodes").toInt()
        )
        val budget = StrictJson.Budget()
        val frame = StrictJson.parse(bytes, limits, budget).objectValue()
        if (frame["version"] != 1L) fail("unsupported-version")
        val kind = frame["kind"] as? String ?: fail()
        val rule = rules.kinds[kind] ?: fail()
        if (!rules.matches(rule, frame)) fail()
        frame["binding"]?.let { bind(it.objectValue(), context) }
        context.binding?.let { expected ->
            if (bindingKeys.any { frame.containsKey(it) && frame[it] != expected[it] }) {
                fail("binding-mismatch")
            }
        }
        (frame["recordType"] as? String)?.let { scope(it, context) }
        (frame["categories"] as? List<*>)?.forEach { scope(it as String, context) }
        var samples = 0L
        fun arrays(value: Any?) {
            if (value is List<*>) {
                samples += value.size
                if (samples > negotiated.getValue("maxSamples")) fail("limit-exceeded")
                value.forEach { arrays(it) }
            } else if (value is Map<*, *>) value.values.forEach { arrays(it) }
        }
        if (kind == "batch") {
            val text = frame["payloadJson"] as String
            if (payloadDigest(text) != frame["payloadDigest"]) fail("digest-mismatch")
            val payload = StrictJson.parseText(text, limits, budget, 2).objectValue()
            validatePayload(payload, negotiated, context, ::arrays)
        }
        (frame["window"] as? Map<*, *>)?.let { SchemaRules.positiveWindow(it.objectValue()) }
        val query = (frame["queryJson"] as? String)?.let { text ->
            if (payloadDigest(text) != frame["filterDigest"]) fail("digest-mismatch")
            val value = StrictJson.parseText(text, limits, budget, 2).objectValue()
            if (!rules.definition("query", value)) fail()
            if (value["recordType"] != frame["recordType"] ||
                value["window"].objectValue()["start"] != frame["window"].objectValue()["start"] ||
                value["window"].objectValue()["end"] != frame["window"].objectValue()["end"]) {
                fail("binding-mismatch")
            }
            arrays(value)
            value
        }
        if (kind == "coverage" && frame["status"] == "complete") {
            if (listOf("pagesFinished", "permissionsStable", "tokenValid", "historyIncludesScope",
                "changesBarrierDrained").any { frame[it] != true } ||
                frame["permissionFingerprintStart"] != frame["permissionFingerprintEnd"] ||
                (query!!["historyStart"] != null && Instant.parse(query["historyStart"] as String)
                    .isAfter(Instant.parse(frame["window"].objectValue()["start"] as String)))) {
                fail("incomplete-coverage")
            }
            frontier(frame, "rawFrontier", context)
        }
        if (kind == "aggregate") {
            val observation = frame["observation"].objectValue()
            if ((observation["state"] == "value") != (observation["quantity"] != null) ||
                (frame["status"] == "current" && observation["state"] == "missing")) fail()
            if (frame["status"] == "current") frontier(frame, "requiredRawFrontier", context)
        }
        (frame["destination"] as? String)?.let { ApprovedOrigin.parse(it) }
        (frame["streams"] as? Map<*, *>)?.let {
            it.keys.forEach { key -> scope(key as String, context) }
            if (it.keys.toSet() != (frame["categories"] as List<*>).toSet()) fail("scope-mismatch")
        }
        if (kind == "capabilities") {
            val present = listOf("destination", "connectorId", "sourceStoreId", "installationId", "streams")
                .count { frame.containsKey(it) }
            if (present != 0 && present != 5) fail()
        }
        if (kind == "stream-status" &&
            frame["generation"] != frame["binding"].objectValue()["generation"]) fail("binding-mismatch")
        if (kind in listOf("object-part", "object-finalise", "object-part-receipt")) {
            identity(frame["identity"].objectValue(), frame["binding"].objectValue(),
                frame["recordType"] as String)
            if ((frame["partCount"] as Long) > negotiated.getValue("maxParts") ||
                (frame["totalBytes"] as Long) > negotiated.getValue("maxObjectBytes")) {
                fail("limit-exceeded")
            }
            if (kind == "object-part") {
                val text = frame["partBase64"] as String
                val part = Base64.getDecoder().decode(text)
                if ((frame["partIndex"] as Long) >= frame["partCount"] as Long ||
                    part.size > frame["totalBytes"] as Long ||
                    Base64.getEncoder().encodeToString(part) != text) fail()
                if (digest(part) != frame["partDigest"]) fail("digest-mismatch")
            } else if (kind == "object-part-receipt") {
                if ((frame["partIndex"] as Long) >= frame["partCount"] as Long ||
                    (frame["partBytes"] as Long) > frame["totalBytes"] as Long) fail()
            } else {
                val parts = frame["parts"] as List<*>
                if (parts.size.toLong() != frame["partCount"] ||
                    parts.withIndex().any { (index, part) ->
                        part.objectValue()["index"] != index.toLong()
                    } || parts.sumOf { it.objectValue()["bytes"] as Long } != frame["totalBytes"]) fail()
            }
        }
        return HealthFrame(freeze(frame).objectValue())
    }

    fun decodeAssembledPayload(bytes: ByteArray, declaration: JsonObject,
        context: ValidationContext = ValidationContext()): JsonObject {
        val negotiated = limits(context)
        if (!rules.objectDeclaration(declaration)) fail()
        if ((declaration["totalBytes"] as Long) > negotiated.getValue("maxObjectBytes") ||
            (declaration["partCount"] as Long) > negotiated.getValue("maxParts") ||
            bytes.size > negotiated.getValue("maxObjectBytes")) fail("limit-exceeded")
        bind(declaration["binding"].objectValue(), context)
        scope(declaration["recordType"] as String, context)
        identity(declaration["identity"].objectValue(), declaration["binding"].objectValue(),
            declaration["recordType"] as String)
        if (bytes.size.toLong() != declaration["totalBytes"]) fail()
        if (digest(bytes) != declaration["objectDigest"]) fail("digest-mismatch")
        val payload = StrictJson.parse(bytes, StrictJson.Limits(
            negotiated.getValue("maxObjectBytes").toInt(), negotiated.getValue("maxDepth").toInt(),
            negotiated.getValue("maxNodes").toInt()), StrictJson.Budget(), 2).objectValue()
        var samples = 0L
        fun arrays(value: Any?) {
            if (value is List<*>) {
                samples += value.size
                if (samples > negotiated.getValue("maxSamples")) fail("limit-exceeded")
                value.forEach { arrays(it) }
            } else if (value is Map<*, *>) value.values.forEach { arrays(it) }
        }
        validatePayload(payload, negotiated, context, ::arrays)
        val changes = payload["changes"] as List<*>
        if (changes.size != 1) fail()
        val change = changes[0].objectValue()
        if (change["operation"] != "upsert" || change["dataFamily"] != "ordinary") fail()
        if (payload["binding"] != declaration["binding"] ||
            payload["recordType"] != declaration["recordType"] ||
            payload["batchId"] != declaration["batchId"] ||
            payload["sequence"] != declaration["sequence"] ||
            change["identity"] != declaration["identity"]) fail("binding-mismatch")
        return freeze(payload).objectValue()
    }

    private fun validatePayload(payload: JsonObject, negotiated: Map<String, Long>,
        context: ValidationContext, arrays: (Any?) -> Unit) {
        if (!rules.definition("batchPayload", payload)) fail()
        val binding = payload["binding"].objectValue()
        val recordType = payload["recordType"] as String
        bind(binding, context)
        scope(recordType, context)
        val changes = payload["changes"] as List<*>
        if (changes.size > negotiated.getValue("maxChanges")) fail("limit-exceeded")
        for (entry in changes) {
            val change = entry.objectValue()
            identity(change["identity"].objectValue(), binding, recordType)
            if (change["operation"] == "upsert") {
                val family = change["dataFamily"] as String
                if (!(context.serializers ?: defaultSerializers).any {
                    it.id == change["serializerId"] && it.version == change["serializerVersion"] &&
                        it.dataFamily == family
                }) fail()
                val record = change["record"].objectValue()
                if (family == "ordinary" && (record["metadata"] as? Map<*, *>)?.get("id") !=
                    change["identity"].objectValue()["nativeRecordId"]) fail("binding-mismatch")
                raw(record, family)
                arrays(record)
            }
        }
    }

    fun payloadDigest(text: String): String {
        if (!StrictJson.scalar(text)) throw ProtocolException("invalid-message")
        return digest(text.toByteArray())
    }
    fun nativeKey(identity: Map<String, String>): String {
        val keys = listOf("tenantId", "sourceStoreId", "recordType", "nativeRecordId")
        val fields = keys.associateWith { identity[it] }
        if (!rules.definition("identity", fields)) fail()
        return ControlJson.text(keys.map { fields[it] })
    }
    private fun digest(bytes: ByteArray): String =
        "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun fail(code: String = "invalid-message"): Nothing = throw ProtocolException(code)
    private fun bind(binding: JsonObject, context: ValidationContext) {
        context.binding?.let {
            if (bindingKeys.any { key -> binding[key] != it[key] }) fail("binding-mismatch")
        }
    }
    private fun scope(recordType: String, context: ValidationContext) {
        if (context.categories != null && recordType !in context.categories) fail("scope-denied")
    }
    private fun identity(identity: JsonObject, binding: JsonObject, recordType: String) {
        if (identity["tenantId"] != binding["tenantId"] ||
            identity["sourceStoreId"] != binding["sourceStoreId"] ||
            identity["recordType"] != recordType) fail("binding-mismatch")
    }
    private fun frontier(frame: JsonObject, field: String, context: ValidationContext) {
        val saved = context.rawFrontiers[frame["recordType"] as String]
        if (!rules.definition("int64", saved) || saved!!.toLong() < (frame[field] as String).toLong()) {
            fail("frontier-lag")
        }
    }
    private fun raw(record: JsonObject, family: String) {
        val metadata = record["metadata"] as? Map<*, *>
        if (family == "ordinary" && metadata?.containsKey("clientRecordVersion") == true &&
            !rules.definition("int64", metadata["clientRecordVersion"])) fail()
        fun visit(value: Any?, key: String = "") {
            when (value) {
                is List<*> -> value.forEach { visit(it) }
                is Map<*, *> -> {
                    value.forEach { (name, child) -> visit(child, name as String) }
                    if (family == "ordinary" && value["startTime"] is String && value["endTime"] is String) {
                        SchemaRules.positiveWindow(mapOf("start" to value["startTime"], "end" to value["endTime"]))
                    }
                    if (family == "ordinary" && value.containsKey("value") && value.containsKey("unit") &&
                        !rules.definition("decimal", value["value"])) fail()
                }
                else -> {
                    if (value is Long && value !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) fail()
                    if (family == "ordinary" && key in listOf("time", "startTime", "endTime", "lastModifiedTime") &&
                        !rules.definition("instant", value)) fail()
                }
            }
        }
        visit(record)
    }
    private fun freeze(value: Any?): Any? = when (value) {
        is Map<*, *> -> Collections.unmodifiableMap(value.entries.associate { it.key as String to freeze(it.value) })
        is List<*> -> Collections.unmodifiableList(value.map { freeze(it) })
        else -> value
    }
}
