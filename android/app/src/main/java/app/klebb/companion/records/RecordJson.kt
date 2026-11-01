// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import app.klebb.companion.protocol.StrictJson

// A newly observed record is encoded once. Existing queued/raw JSON is never
// passed here for reserialization. Source Int64/IEEE values are already strings.
internal object RecordJson {
    fun text(value: Any?): String = when (value) {
        null -> "null"
        is String -> quote(value)
        is Int -> value.toString() // Opaque native enums remain Int32.
        is Boolean -> value.toString()
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") {
            quote(it.key as String) + ":" + text(it.value)
        }
        is List<*> -> value.joinToString(",", "[", "]") { text(it) }
        else -> throw RecordCodecException("unsupported-value")
    }

    private fun quote(value: String): String {
        if (!StrictJson.scalar(value)) throw RecordCodecException("unsupported-value")
        val result = StringBuilder("\"")
        for (char in value) {
            result.append(when (char) {
                '"' -> "\\\""
                '\\' -> "\\\\"
                '\b' -> "\\b"
                '\u000c' -> "\\f"
                '\n' -> "\\n"
                '\r' -> "\\r"
                '\t' -> "\\t"
                else -> if (char < ' ') "\\u" + char.code.toString(16).padStart(4, '0') else char.toString()
            })
        }
        return result.append('"').toString()
    }
}
