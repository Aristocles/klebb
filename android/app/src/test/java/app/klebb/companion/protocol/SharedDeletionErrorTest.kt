// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

// Independent fixed shared-wire vectors; execution is reported separately.
class SharedDeletionErrorTest {
    @Test
    fun preservesIndependentlyFixedAcceptedErrorFrames() {
        val fixtures = SharedWire.read("deletion-error-v1.json")
        for (item in fixtures["cases"] as List<*>) {
            val vector = item.objectValue()
            val bytes = (vector["wire"] as String).toByteArray(Charsets.UTF_8)
            assertEquals(vector["id"].toString(), vector["expectedBytes"], bytes.size.toLong())
            val frame = SharedWire.protocol().decode(bytes)
            assertEquals(vector["id"].toString(), vector["expectedFrame"], frame.fields)
            assertEquals(false, frame.fields["retryable"])
            assertThrows(UnsupportedOperationException::class.java) {
                @Suppress("UNCHECKED_CAST")
                (frame.fields as MutableMap<String, Any?>)["code"] = "conflict"
            }
        }
    }

    @Test
    fun refusesIndependentlyFixedMalformedErrorFrames() {
        val fixtures = SharedWire.read("deletion-error-v1.json")
        for (item in fixtures["rejectedCases"] as List<*>) {
            val vector = item.objectValue()
            val bytes = (vector["wire"] as String).toByteArray(Charsets.UTF_8)
            assertEquals(vector["id"].toString(), vector["expectedBytes"], bytes.size.toLong())
            val error = assertThrows(ProtocolException::class.java) {
                SharedWire.protocol().decode(bytes)
            }
            assertEquals(vector["id"].toString(), vector["expectedCode"], error.code)
            assertEquals(error.code, error.message)
        }
    }
}
