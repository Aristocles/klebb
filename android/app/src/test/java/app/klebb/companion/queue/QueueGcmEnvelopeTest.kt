// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class QueueGcmEnvelopeTest {
    private val key = SecretKeySpec(ByteArray(32), "AES")
    private val nonce = ByteArray(12)
    private val plaintext = ByteArray(16)
    // Original independent AES-256-GCM vector, never a production key/nonce.
    private val ciphertext = hex("cea7403d4d606b6e074ec5d3baf39d18")
    private val tag = hex("d0d1c8a799996bf0265b98b5d48ab919")
    private val envelope get() = QueueEnvelope(1, nonce.copyOf(), ciphertext + tag)

    @Test fun SW01_original_exact_encrypt_output() {
        val initialized = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        }
        val actual = GcmEnvelope.seal(initialized, byteArrayOf(), plaintext)
        assertEquals(1, actual.version)
        assertArrayEquals(nonce, actual.nonce)
        assertArrayEquals(ciphertext + tag, actual.ciphertextAndTag)
    }

    @Test fun SW02_original_exact_decrypt_output() {
        assertArrayEquals(plaintext, GcmEnvelope.open(key, byteArrayOf(), envelope))
    }

    @Test fun SW03_all_original_five_authentication_mutations_refuse() {
        val changedCiphertext = (ciphertext + tag).apply { this[0] = (this[0].toInt() xor 1).toByte() }
        val changedTag = (ciphertext + tag).apply {
            this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte()
        }
        val differentKey = SecretKeySpec(ByteArray(32).apply { this[0] = 1 }, "AES")
        val cases = listOf(
            Triple(key, byteArrayOf(), QueueEnvelope(1, nonce.copyOf(), changedCiphertext)),
            Triple(key, byteArrayOf(), QueueEnvelope(1, nonce.copyOf(), changedTag)),
            Triple(key, byteArrayOf(1), envelope),
            Triple(differentKey, byteArrayOf(), envelope),
            Triple(key, byteArrayOf(), QueueEnvelope(1, nonce.copyOf(), (ciphertext + tag).dropLast(1).toByteArray()))
        )
        for ((actualKey, aad, actualEnvelope) in cases) {
            try {
                GcmEnvelope.open(actualKey, aad, actualEnvelope)
                fail("Authenticated open returned plaintext for an original negative fixture")
            } catch (_: AEADBadTagException) {
                // A 31-byte combined blob cannot diagnose which section was truncated.
                // Setup exceptions or a feature stub cannot pass this negative.
            }
        }
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
