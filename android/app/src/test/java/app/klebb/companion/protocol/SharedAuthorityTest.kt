// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

class SharedAuthorityExamplesTest {
    @Test
    fun readsAllCompleteAuthorityFramesAndOriginalByteCounts() {
        val fixtures = SharedWire.read("authority-v1.json")
        val context = SharedWire.context(fixtures)
        val protocol = SharedWire.protocol()
        for (item in fixtures["cases"] as List<*>) {
            val vector = item.objectValue()
            val bytes = (vector["wire"] as String).toByteArray()
            assertEquals(vector["expectedBytes"], bytes.size.toLong())
            val parsed = protocol.decode(bytes, context)
            assertEquals(vector["expectedKind"], parsed.kind)
            assertFalse(parsed.toString().contains("klebb_hc1_"))
        }
    }
}

@RunWith(Parameterized::class)
class SharedAuthorityRejectionsTest(private val vector: JsonObject) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{index}")
        fun vectors(): List<Array<Any>> =
            (SharedWire.read("authority-v1.json")["rejectedCases"] as List<*>).map {
                arrayOf<Any>(it.objectValue())
            }
    }

    @Test
    fun agreesWithIndependentAuthorityRejection() {
        val context = SharedWire.context(SharedWire.read("authority-v1.json"))
        val error = assertThrows(vector["id"].toString(), ProtocolException::class.java) {
            SharedWire.protocol().decode((vector["wire"] as String).toByteArray(), context)
        }
        assertEquals(vector["id"].toString(), vector["expectedCode"], error.code)
        assertEquals(error.code, error.message)
    }
}

@RunWith(Parameterized::class)
class InstantBoundaryTest(private val instant: String, private val accepted: Boolean) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> = listOf(
            arrayOf("2026-10-28T24:00:00Z", false),
            arrayOf("2026-10-28T23:59:60Z", false),
            arrayOf("2026-10-28T23:59:59.999999999Z", true),
            arrayOf("2026-02-30T03:00:00Z", false)
        )
    }

    @Test
    fun calendarAndTimeFieldsAgreeWithSharedProtocolRules() {
        val vector = (SharedWire.read("authority-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.first { it["id"] == "connector-list" }
        val original = StrictJson.parse((vector["wire"] as String).toByteArray()).objectValue()
        val connector = (original["connectors"] as List<*>).single().objectValue()
        val wire = ControlJson.text(original + ("connectors" to listOf(
            connector + ("createdAt" to instant)
        ))).toByteArray()
        if (accepted) {
            assertEquals("connector-list", SharedWire.protocol().decode(wire).kind)
        } else {
            assertEquals("invalid-message", assertThrows(ProtocolException::class.java) {
                SharedWire.protocol().decode(wire)
            }.code)
        }
    }
}

@RunWith(Parameterized::class)
class CanonicalDestinationTest(private val destination: String, private val accepted: Boolean) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> = listOf(
            arrayOf("https://health.example.test:0444", false),
            arrayOf("https://health.example.test:444", true),
            arrayOf("https://health.example.test", true),
            arrayOf("https://127.1", false),
            arrayOf("https://127.000.000.001", false),
            arrayOf("https://0x7f000001", false),
            arrayOf("https://127.0.0.1", true),
            arrayOf("https://[0:0:0:0:0:0:0:1]", false),
            arrayOf("https://[::1]", true)
        )
    }

    @Test
    fun canonicalOriginSpellingAgreesWithSharedConsumer() {
        val bytes = ControlJson.text(mapOf("version" to 1L, "kind" to "connector-list",
            "destination" to destination, "connectors" to emptyList<Any>())).toByteArray()
        if (accepted) {
            assertEquals("connector-list", SharedWire.protocol().decode(bytes).kind)
        } else {
            assertEquals("invalid-destination", assertThrows(ProtocolException::class.java) {
                SharedWire.protocol().decode(bytes)
            }.code)
        }
    }
}
