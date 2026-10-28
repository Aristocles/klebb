// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

// New control frames and identity keys only. Original payload/query text is
// retained and hashed directly, never regenerated through this encoder.
internal object ControlJson {
    fun text(value: Any?): String = when (value) {
        null -> "null"
        is String -> quote(value)
        is Boolean -> value.toString()
        is Long -> {
            if (value !in -9007199254740991L..9007199254740991L) throw ProtocolException("invalid-message")
            value.toString()
        }
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") {
            quote(it.key as String) + ":" + text(it.value)
        }
        is List<*> -> value.joinToString(",", "[", "]") { text(it) }
        else -> throw ProtocolException("invalid-message")
    }
    private fun quote(value: String): String {
        if (!StrictJson.scalar(value)) throw ProtocolException("invalid-message")
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
