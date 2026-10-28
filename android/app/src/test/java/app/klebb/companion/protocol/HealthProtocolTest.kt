// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

internal object SharedWire {
    fun resource(name: String): ByteArray =
        checkNotNull(javaClass.classLoader?.getResourceAsStream(name)).use { it.readBytes() }
    fun read(name: String): JsonObject = StrictJson.parse(resource(name)).objectValue()
    fun context(value: Any?): ValidationContext {
        if (value == null) return ValidationContext()
        val fields = value.objectValue()
        fun strings(value: Any?) = (value as? Map<*, *>)?.entries?.associate {
            it.key as String to it.value as String
        }
        val serializers = (fields["serializers"] as? List<*>)?.map {
            val item = it.objectValue()
            Serializer(item["id"] as String, item["version"] as Long, item["dataFamily"] as String)
        }
        return ValidationContext(
            limits = (fields["limits"] as? Map<*, *>)?.entries?.associate {
                it.key as String to it.value as Long
            } ?: emptyMap(),
            binding = strings(fields["binding"]),
            categories = (fields["categories"] as? List<*>)?.map { it as String }?.toSet(),
            serializers = serializers,
            rawFrontiers = strings(fields["rawFrontiers"]) ?: emptyMap()
        )
    }
    fun protocol() = HealthProtocol(resource("protocol-v1.schema.json"))
}

class HealthProtocolTest {
    @Test
    fun sharedCompleteExamplesAndOriginalByteCounts() {
        val fixtures = SharedWire.read("protocol-v1.json")
        val context = SharedWire.context(fixtures)
        for (value in fixtures["cases"] as List<*>) {
            val vector = value.objectValue()
            val bytes = (vector["wire"] as String).toByteArray()
            assertEquals(vector["id"].toString(), vector["expectedBytes"], bytes.size.toLong())
            assertEquals(vector["expectedKind"], SharedWire.protocol().decode(bytes, context).kind)
        }
    }

    @Test
    fun sharedFixedDigestVectorsUseOriginalUtf8Text() {
        val protocol = SharedWire.protocol()
        for (value in SharedWire.read("protocol-v1.json")["digestVectors"] as List<*>) {
            val vector = value.objectValue()
            val text = vector["text"] as String
            assertEquals(vector["bytes"], text.toByteArray().size.toLong())
            assertEquals(vector["digest"], protocol.payloadDigest(text))
        }
    }

    @Test
    fun nonJsonUnicodeEscapeSignsAndLoneSurrogatesAreRefused() {
        for (input in listOf("""{"x":"\u+001"}""", """{"x":"\u-001"}""", """{"x":"\ud800"}""")) {
            assertEquals("invalid-message", assertThrows(ProtocolException::class.java) {
                StrictJson.parse(input.toByteArray())
            }.code)
        }
    }

    @Test
    fun nativeKeysHaveFourExactComponentsWithoutTransportOrDelimiterCollisions() {
        val protocol = SharedWire.protocol()
        val identity = mapOf("tenantId" to "a|b", "sourceStoreId" to "c",
            "recordType" to "StepsRecord", "nativeRecordId" to "d")
        assertEquals("""["a|b","c","StepsRecord","d"]""", protocol.nativeKey(identity))
        org.junit.Assert.assertNotEquals(protocol.nativeKey(identity),
            protocol.nativeKey(identity + mapOf("tenantId" to "a", "sourceStoreId" to "b|c")))
        assertEquals(protocol.nativeKey(identity), protocol.nativeKey(identity + mapOf(
            "installationId" to "other", "digest" to "other", "generation" to "8", "restoreEpoch" to "other")))
        assertEquals("""["a\"b","c\\d","StepsRecord","line\nend"]""", protocol.nativeKey(mapOf(
            "tenantId" to "a\"b", "sourceStoreId" to "c\\d", "recordType" to "StepsRecord",
            "nativeRecordId" to "line\nend")))
    }
}

@RunWith(Parameterized::class)
class SharedAdversarialTest(private val vector: JsonObject) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}")
        fun vectors(): List<Array<Any>> =
            (SharedWire.read("adversarial-v1.json")["cases"] as List<*>).map {
                arrayOf<Any>(it.objectValue())
            }
    }

    @Test
    fun agreesWithIndependentlyExpectedWireOutcome() {
        val expected = vector["expected"].objectValue()
        val bytes = (vector["wireHex"] as? String)?.chunked(2)?.map { it.toInt(16).toByte() }
            ?.toByteArray() ?: (vector["wire"] as String).toByteArray()
        assertEquals(vector["expectedUtf8Bytes"], bytes.size.toLong())
        val protocol = SharedWire.protocol()
        val context = SharedWire.context(vector["context"])
        if (expected["accepted"] == true) protocol.decode(bytes, context)
        else {
            val error = assertThrows(vector["id"].toString(), ProtocolException::class.java) {
                protocol.decode(bytes, context)
            }
            assertEquals(vector["id"].toString(), expected["code"], error.code)
            assertEquals(error.code, error.message)
        }
    }
}
