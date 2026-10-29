// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object GcmEnvelope {
    fun seal(initializedCipher: Cipher, aad: ByteArray, plaintext: ByteArray): QueueEnvelope {
        val nonce = initializedCipher.iv?.copyOf() ?: throw MalformedEnvelope()
        if (nonce.size != 12) throw MalformedEnvelope()
        initializedCipher.updateAAD(aad.copyOf())
        val encrypted = initializedCipher.doFinal(plaintext.copyOf())
        if (encrypted.size < 16) throw MalformedEnvelope()
        return QueueEnvelope(1, nonce, encrypted)
    }

    fun open(key: SecretKey, aad: ByteArray, envelope: QueueEnvelope): ByteArray {
        if (envelope.version != 1) throw UnsupportedEnvelope()
        if (envelope.nonce.size != 12 || envelope.ciphertextAndTag.size < 16) {
            throw MalformedEnvelope()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, envelope.nonce.copyOf()))
        cipher.updateAAD(aad.copyOf())
        return cipher.doFinal(envelope.ciphertextAndTag.copyOf())
    }
}
