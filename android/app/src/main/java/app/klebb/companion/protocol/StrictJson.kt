// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

class ProtocolException(val code: String) : RuntimeException(code)

// Bounded scalar JSON without platform JSON stubs or numeric coercion.
object StrictJson {
    data class Limits(val bytes: Int = 1048576, val depth: Int = 16, val nodes: Int = 20000)
    class Budget(var nodes: Int = 0)
    private const val MAX_SAFE_INTEGER = 9007199254740991L

    fun scalar(text: String): Boolean {
        var index = 0
        while (index < text.length) {
            val char = text[index++]
            if (Character.isHighSurrogate(char)) {
                if (index == text.length || !Character.isLowSurrogate(text[index++])) return false
            } else if (Character.isLowSurrogate(char)) return false
        }
        return true
    }

    fun parse(bytes: ByteArray, limits: Limits = Limits(), budget: Budget = Budget()): Any? {
        if (bytes.size > limits.bytes) throw ProtocolException("limit-exceeded")
        val text = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            throw ProtocolException("invalid-message")
        }
        return parseText(text, limits, budget)
    }

    fun parseText(text: String, limits: Limits, budget: Budget, initialDepth: Int = 1): Any? {
        if (!scalar(text)) throw ProtocolException("invalid-message")
        var position = 0
        fun invalid(): Nothing = throw ProtocolException("invalid-message")
        fun node() {
            if (++budget.nodes > limits.nodes) throw ProtocolException("limit-exceeded")
        }
        fun space() {
            while (position < text.length && text[position] in " \t\r\n") position++
        }
        fun string(): String {
            if (text.getOrNull(position++) != '"') invalid()
            val result = StringBuilder()
            while (position < text.length) {
                val char = text[position++]
                if (char == '"') return result.toString().also { if (!scalar(it)) invalid() }
                if (char < ' ') invalid()
                if (char != '\\') { result.append(char); continue }
                when (val escaped = text.getOrNull(position++) ?: invalid()) {
                    '"', '\\', '/' -> result.append(escaped)
                    'b' -> result.append('\b')
                    'f' -> result.append('\u000c')
                    'n' -> result.append('\n')
                    'r' -> result.append('\r')
                    't' -> result.append('\t')
                    'u' -> {
                        if (position + 4 > text.length) invalid()
                        val digits = text.substring(position, position + 4)
                        if (digits.any { it !in "0123456789abcdefABCDEF" }) invalid()
                        val number = digits.toInt(16)
                        result.append(number.toChar())
                        position += 4
                    }
                    else -> invalid()
                }
            }
            invalid()
        }
        fun number(): Long {
            val start = position
            if (text.getOrNull(position) == '-') position++
            when (text.getOrNull(position)) {
                '0' -> position++
                in '1'..'9' -> while (text.getOrNull(position) in '0'..'9') position++
                else -> invalid()
            }
            if (text.getOrNull(position) in listOf('.', 'e', 'E')) invalid()
            val result = text.substring(start, position).toLongOrNull() ?: invalid()
            if (result !in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) invalid()
            return result
        }
        lateinit var value: (Int) -> Any?
        value = { depth ->
            if (depth > limits.depth) throw ProtocolException("limit-exceeded")
            node()
            space()
            when (text.getOrNull(position)) {
                '"' -> string()
                '{', '[' -> {
                    val objectValue = text[position++] == '{'
                    val end = if (objectValue) '}' else ']'
                    val map = linkedMapOf<String, Any?>()
                    val list = mutableListOf<Any?>()
                    space()
                    if (text.getOrNull(position) == end) position++
                    else while (true) {
                        var key: String? = null
                        if (objectValue) {
                            space()
                            node()
                            key = string()
                            if (map.containsKey(key)) invalid()
                            space()
                            if (text.getOrNull(position++) != ':') invalid()
                        }
                        val child = value(depth + 1)
                        if (objectValue) map[key!!] = child else list.add(child)
                        space()
                        if (text.getOrNull(position) == end) { position++; break }
                        if (text.getOrNull(position++) != ',') invalid()
                    }
                    if (objectValue) map else list
                }
                't' -> { if (!text.startsWith("true", position)) invalid(); position += 4; true }
                'f' -> { if (!text.startsWith("false", position)) invalid(); position += 5; false }
                'n' -> { if (!text.startsWith("null", position)) invalid(); position += 4; null }
                else -> number()
            }
        }
        val result = value(initialDepth)
        space()
        if (position != text.length) invalid()
        return result
    }
}
