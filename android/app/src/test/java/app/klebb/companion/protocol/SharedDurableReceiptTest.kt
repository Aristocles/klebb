// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

private object DurableReceiptWire {
    fun fixtures(): JsonObject = SharedWire.read("durable-receipt-v1.json")
    fun bytes(vector: JsonObject): ByteArray = (vector["wireHex"] as? String)
        ?.chunked(2)?.map { it.toInt(16).toByte() }?.toByteArray()
        ?: (vector["wire"] as String).toByteArray(Charsets.UTF_8)
    fun context(vector: JsonObject): ValidationContext =
        SharedWire.context(vector["context"] ?: fixtures())
    fun digest(text: String): String = "sha256:" + MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}

class DurableReceiptBankTest {
    @Test
    fun retainsEveryFrozenBatchIdentityAndOriginalUtf8Digest() {
        val fixtures = DurableReceiptWire.fixtures()
        val bank = SharedWire.read("durable-history-independent-vectors.json")
        val sources = (bank["vectors"] as List<*>).map { it.objectValue() }
        assertEquals(8, sources.size)
        assertEquals(sources.map { it["id"] }, fixtures["sourceBankCases"])
        val examples = (fixtures["cases"] as List<*>).map { it.objectValue() }
        for (source in sources) {
            val vector = examples.single { it["id"] == source["id"] }
            assertEquals(source["id"].toString(), source["expectedReceipt"], vector["expectedReceipt"])
            assertEquals(source["payloadJson"], vector["payloadJson"])
            assertEquals(source["expectedReceipt"].objectValue()["payloadDigest"],
                DurableReceiptWire.digest(source["payloadJson"] as String))
        }
    }

    @Test
    fun digestRemainsBoundToOriginalSpacingRatherThanJsonEquivalence() {
        val examples = (DurableReceiptWire.fixtures()["cases"] as List<*>).map { it.objectValue() }
        val initial = examples.single { it["id"] == "initial-raw-only" }
        val spaced = examples.single { it["id"] == "original-payload-trailing-space" }
        assertEquals(StrictJson.parse((initial["payloadJson"] as String).toByteArray()),
            StrictJson.parse((spaced["payloadJson"] as String).toByteArray()))
        assertNotEquals(initial["payloadJson"], spaced["payloadJson"])
        assertNotEquals(initial["expectedReceipt"].objectValue()["payloadDigest"],
            spaced["expectedReceipt"].objectValue()["payloadDigest"])
        val frame = SharedWire.protocol().decode(DurableReceiptWire.bytes(spaced),
            DurableReceiptWire.context(spaced))
        assertEquals(spaced["expectedReceipt"].objectValue()["payloadDigest"],
            frame.fields["payloadDigest"])
    }
}

@RunWith(Parameterized::class)
class SharedDurableReceiptExamplesTest(private val vector: JsonObject) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}")
        fun vectors(): List<Array<Any>> =
            (DurableReceiptWire.fixtures()["cases"] as List<*>).map {
                arrayOf<Any>(it.objectValue())
            }
    }

    @Suppress("UNCHECKED_CAST")
    @Test
    fun preservesExactFixedReceiptFieldsBytesPrecisionAndImmutability() {
        val bytes = DurableReceiptWire.bytes(vector)
        val expected = vector["expectedReceipt"].objectValue()
        val text = vector["payloadJson"] as String
        val protocol = SharedWire.protocol()
        assertEquals(vector["expectedBytes"], bytes.size.toLong())
        assertEquals(expected["payloadDigest"], DurableReceiptWire.digest(text))
        assertEquals(expected["payloadDigest"], protocol.payloadDigest(text))
        val frame = protocol.decode(bytes, DurableReceiptWire.context(vector))
        assertEquals("durable-receipt", frame.kind)
        assertEquals(expected, frame.fields)
        assertTrue(frame.fields["sequence"] is String)
        assertTrue(frame.fields["binding"].objectValue()["generation"] is String)
        assertEquals(expected["sequence"], frame.fields["sequence"])
        assertEquals(expected["binding"].objectValue()["generation"],
            frame.fields["binding"].objectValue()["generation"])
        assertThrows(UnsupportedOperationException::class.java) {
            (frame.fields as MutableMap<String, Any?>)["sequence"] = "2"
        }
        assertThrows(UnsupportedOperationException::class.java) {
            (frame.fields["binding"] as MutableMap<String, Any?>)["restoreEpoch"] = "other"
        }
    }
}

@RunWith(Parameterized::class)
class SharedDurableReceiptRejectionsTest(private val vector: JsonObject) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}")
        fun vectors(): List<Array<Any>> =
            (DurableReceiptWire.fixtures()["rejectedCases"] as List<*>).map {
                arrayOf<Any>(it.objectValue())
            }
    }

    @Test
    fun refusesTheIndependentlySpecifiedWireWithTheSameStableCode() {
        val bytes = DurableReceiptWire.bytes(vector)
        assertEquals(vector["expectedBytes"], bytes.size.toLong())
        val error = assertThrows(vector["id"].toString(), ProtocolException::class.java) {
            SharedWire.protocol().decode(bytes, DurableReceiptWire.context(vector))
        }
        assertEquals(vector["id"].toString(), vector["expectedCode"], error.code)
        assertEquals(error.code, error.message)
    }
}
