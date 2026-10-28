// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.time.Instant

internal class SchemaRules(schema: JsonObject) {
    private val definitions = schema["\$defs"].objectValue()
    val kinds: Map<String, JsonObject> = definitions.values.mapNotNull { value ->
        val rule = value.objectValue()
        val kind = ((rule["properties"] as? Map<*, *>)?.get("kind") as? Map<*, *>)?.get("const")
        if (kind is String) kind to rule else null
    }.toMap()

    fun definition(name: String, value: Any?): Boolean = matches(definitions[name].objectValue(), value)

    fun objectDeclaration(value: JsonObject): Boolean {
        val rule = definitions["objectFinalise"].objectValue()
        val keys = (rule["required"] as List<*>).filter { it !in listOf("version", "kind", "parts") }
        val properties = rule["properties"].objectValue().filterKeys { it in keys }
        return matches(rule + mapOf("required" to keys, "properties" to properties), value)
    }

    fun matches(rule: JsonObject, value: Any?): Boolean {
        (rule["\$ref"] as? String)?.let { return definition(it.substringAfterLast('/'), value) }
        (rule["oneOf"] as? List<*>)?.let {
            if (it.count { candidate -> matches(candidate.objectValue(), value) } != 1) return false
        }
        if (rule.containsKey("const") && value != rule["const"]) return false
        (rule["enum"] as? List<*>)?.let { if (value !in it) return false }
        val type = when (value) {
            null -> "null"
            is String -> "string"
            is Boolean -> "boolean"
            is Long -> "integer"
            is List<*> -> "array"
            is Map<*, *> -> "object"
            else -> return false
        }
        val requested = rule["type"]
        if (requested is String && requested != type &&
            !(requested == "number" && type == "integer")) return false
        if (requested is List<*> && type !in requested) return false
        fun lower(key: String, size: Long) = (rule[key] as? Long)?.let { size < it } ?: false
        fun upper(key: String, size: Long) = (rule[key] as? Long)?.let { size > it } ?: false
        if (value is String) {
            val length = value.codePointCount(0, value.length).toLong()
            if (!StrictJson.scalar(value) || lower("minLength", length) || upper("maxLength", length)) {
                return false
            }
            (rule["pattern"] as? String)?.let {
                val regex = Regex(it)
                val matched = if (it.startsWith("^") && it.endsWith("$")) regex.matches(value)
                    else regex.containsMatchIn(value)
                if (!matched) return false
            }
            if (rule === definitions["int64"] && value.toLongOrNull() == null) return false
            if (rule === definitions["instant"] && !validInstant(value)) return false
        }
        if (value is Long && (lower("minimum", value) || upper("maximum", value))) return false
        if (value is List<*>) {
            if (lower("minItems", value.size.toLong()) || upper("maxItems", value.size.toLong())) {
                return false
            }
            if (rule["uniqueItems"] == true && value.toSet().size != value.size) return false
            (rule["items"] as? Map<*, *>)?.let {
                if (!value.all { item -> matches(it.objectValue(), item) }) return false
            }
        }
        if (value is Map<*, *>) {
            if (lower("minProperties", value.size.toLong()) || upper("maxProperties", value.size.toLong())) {
                return false
            }
            (rule["required"] as? List<*>)?.let {
                if (it.any { key -> !value.containsKey(key) }) return false
            }
            val properties = rule["properties"] as? Map<*, *>
            for ((key, child) in value) {
                (rule["propertyNames"] as? Map<*, *>)?.let {
                    if (!matches(it.objectValue(), key)) return false
                }
                if (properties?.containsKey(key) == true) {
                    if (!matches(properties[key].objectValue(), child)) return false
                } else when (val additional = rule["additionalProperties"]) {
                    false -> return false
                    is Map<*, *> -> if (!matches(additional.objectValue(), child)) return false
                }
            }
        }
        return true
    }

    companion object {
        fun validInstant(text: String): Boolean {
            if (!Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$")
                    .matches(text)) return false
            if (text.substring(11, 13).toInt() >= 24 ||
                text.substring(14, 16).toInt() >= 60 ||
                text.substring(17, 19).toInt() >= 60) return false
            return try { Instant.parse(text); true } catch (_: Exception) { false }
        }
        fun positiveWindow(window: JsonObject) {
            val start = window["start"] as? String ?: throw ProtocolException("invalid-message")
            val end = window["end"] as? String ?: throw ProtocolException("invalid-message")
            if (!validInstant(start) || !validInstant(end) || !Instant.parse(end).isAfter(Instant.parse(start))) {
                throw ProtocolException("invalid-message")
            }
        }
    }
}
