// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.concurrent.Callable
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

object KeystoreQueueKey {
    private val initializationLock = Any()
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun initializeEmpty(db: QueueDatabase, alias: String): QueueResult<Unit> =
        synchronized(initializationLock) {
            try {
                db.runInTransaction(Callable<QueueResult<Unit>> {
                    val populated = db.blobs().all().isNotEmpty()
                    try {
                        if (store().containsAlias(alias)) {
                            open(alias)
                        } else {
                            if (populated) return@Callable Blocked("key-unavailable", "key-unavailable")
                            val spec = KeyGenParameterSpec.Builder(
                                alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                            ).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                                .setRandomizedEncryptionRequired(true).build()
                            KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
                                init(spec)
                                generateKey()
                            }
                        }
                        Ok(Unit)
                    } catch (_: Exception) { Blocked("key-unavailable", "key-unavailable") }
                })
            } catch (_: Exception) {
                Blocked("queue-unavailable", "storage-failed")
            }
        }

    fun open(alias: String): SecretKey = try {
        store().getKey(alias, null) as? SecretKey ?: throw QueueKeyUnavailable()
    } catch (_: Exception) { throw QueueKeyUnavailable() }
}

class KeystoreQueueCipher(private val alias: String) : QueueCipher {
    override fun seal(plaintext: ByteArray, aad: ByteArray): QueueEnvelope {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, KeystoreQueueKey.open(alias))
        return GcmEnvelope.seal(cipher, aad, plaintext)
    }

    override fun open(envelope: QueueEnvelope, aad: ByteArray): ByteArray =
        GcmEnvelope.open(KeystoreQueueKey.open(alias), aad, envelope)
}
