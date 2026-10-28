// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class SharedObjectProtocolTest(private val vector: JsonObject) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}")
        fun vectors(): List<Array<Any>> =
            (SharedWire.read("object-protocol-v1.json")["cases"] as List<*>).map {
                arrayOf<Any>(it.objectValue())
            }
    }

    @Test
    fun independentReceiptOrAssembledOutcome() {
        val construction = vector["construction"] as? Map<*, *>
        val text = if (construction == null) vector["wire"] as? String else
            construction["prefix"] as String + "P".repeat((construction["paddingCount"] as Long).toInt()) +
                construction["suffix"] as String
        val bytes = (vector["wireHex"] as? String)?.chunked(2)?.map { it.toInt(16).toByte() }
            ?.toByteArray() ?: checkNotNull(text).toByteArray()
        assertEquals(vector["expectedUtf8Bytes"], bytes.size.toLong())
        val protocol = SharedWire.protocol()
        val context = SharedWire.context(vector["context"])
        fun action() {
            when (vector["mode"]) {
                "receipt" -> protocol.decode(bytes, context)
                "assembled" -> protocol.decodeAssembledPayload(bytes, vector["declaration"].objectValue(), context)
                else -> protocol.decode(ControlJson.text(mapOf("version" to 1L, "kind" to "batch",
                    "payloadJson" to text, "payloadDigest" to protocol.payloadDigest(checkNotNull(text)))).toByteArray(), context)
            }
        }
        val expected = vector["expected"].objectValue()
        if (expected["accepted"] == true) action() else {
            assertEquals(vector["id"].toString(), expected["code"],
                assertThrows(ProtocolException::class.java) { action() }.code)
        }
    }
}
