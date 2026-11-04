// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One encrypted private snapshot; it stores authenticated facts, not policy booleans. */
class DurablePairingStore(context: Context) {
    private val app = context.applicationContext
    private val identity = identity(app)
    private val preferences = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    /** The default Session constructor remains RAM-only; only this path attaches the vault. */
    fun open(protocol: HealthProtocol): InMemoryPairingSession {
        val session = synchronized(vaultLock) {
            cachedSessions[identity]?.let {
                if (it.protocol !== protocol) throw ProtocolException("pairing-protocol-mismatch")
                return@synchronized it.session
            }
            val encoded = readBlob()
            val restored = InMemoryPairingSession(protocol)
            if (encoded != null) {
                val plaintext = decrypt(encoded)
                try { restored.restoreDurableState(plaintext) }
                catch (_: Exception) { throw ProtocolException("pairing-storage-unavailable") }
                finally { plaintext.fill(0) }
            }
            restored.attachPersistence(Binding(encoded))
            cachedSessions[identity] = Entry(protocol, restored)
            restored
        }
        // Keep the lock order Session -> vault; never acquire a shared Session under vaultLock.
        session.checkStoredPairingCurrent()
        return session
    }

    /** Only a deliberate clear/revocation may remove the encrypted paired owner. */
    fun forget(session: InMemoryPairingSession) {
        val owned = synchronized(vaultLock) { cachedSessions[identity]?.session === session }
        if (!owned) throw ProtocolException("pairing-owner-mismatch")
        session.clear()
    }

    private inner class Binding(private var expected: String?) : PairingSessionPersistence {
        override val owner: Any get() = identity
        override fun checkCurrent() = synchronized(vaultLock) {
            if (readBlob() != expected) throw ProtocolException("pairing-storage-unavailable")
        }
        override fun save(state: ByteArray?) = synchronized(vaultLock) {
            checkCurrent()
            val next = state?.let { encrypt(it, expected != null) }
            val editor = preferences.edit()
            if (next == null) editor.remove(BLOB) else editor.putString(BLOB, next)
            if (!editor.commit()) {
                // SharedPreferences may already have changed its memory map on failed commit.
                // Restore the old ciphertext. Failure remains a refusal even if rollback also fails.
                val rollback = preferences.edit()
                if (expected == null) rollback.remove(BLOB) else rollback.putString(BLOB, expected)
                rollback.commit()
                throw ProtocolException("pairing-storage-unavailable")
            }
            expected = next
        }
        override fun forget() = synchronized(vaultLock) {
            // A deliberate clear can recover a faulted Session; ordinary saves cannot.
            val previous = readBlob()
            if (!preferences.edit().remove(BLOB).commit()) {
                val rollback = preferences.edit()
                if (previous == null) rollback.remove(BLOB) else rollback.putString(BLOB, previous)
                rollback.commit()
                throw ProtocolException("pairing-storage-unavailable")
            }
            expected = null
        }
    }

    private fun readBlob(): String? = try {
        if (!preferences.contains(BLOB)) null else {
            val text = preferences.getString(BLOB, null)
                ?: throw ProtocolException("pairing-storage-unavailable")
            if (text.isEmpty() || text.length > MAX_ENCODED) {
                throw ProtocolException("pairing-storage-unavailable")
            }
            text
        }
    } catch (_: Exception) { throw ProtocolException("pairing-storage-unavailable") }

    private fun key(populated: Boolean): SecretKey = try {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) {
            if (populated) throw ProtocolException("pairing-storage-unavailable")
            val spec = KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build()
            KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
                init(spec)
                generateKey()
            }
        }
        store.getKey(ALIAS, null) as? SecretKey
            ?: throw ProtocolException("pairing-storage-unavailable")
    } catch (_: Exception) { throw ProtocolException("pairing-storage-unavailable") }

    private fun encrypt(plaintext: ByteArray, populated: Boolean): String = try {
        if (plaintext.isEmpty() || plaintext.size > MAX_PLAINTEXT) {
            throw ProtocolException("pairing-storage-unavailable")
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(populated))
        cipher.updateAAD(AAD)
        val iv = cipher.iv
        if (iv.size != 12) throw ProtocolException("pairing-storage-unavailable")
        val ciphertext = cipher.doFinal(plaintext)
        Base64.getEncoder().encodeToString(byteArrayOf(1) + iv + ciphertext)
    } catch (_: Exception) { throw ProtocolException("pairing-storage-unavailable") }

    private fun decrypt(encoded: String): ByteArray = try {
        val envelope = Base64.getDecoder().decode(encoded)
        if (Base64.getEncoder().encodeToString(envelope) != encoded ||
            envelope.size !in 30..(MAX_PLAINTEXT + 29) || envelope[0] != 1.toByte()) {
            throw ProtocolException("pairing-storage-unavailable")
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(true), GCMParameterSpec(128, envelope.copyOfRange(1, 13)))
        cipher.updateAAD(AAD)
        cipher.doFinal(envelope.copyOfRange(13, envelope.size))
    } catch (_: Exception) { throw ProtocolException("pairing-storage-unavailable") }

    private class Entry(val protocol: HealthProtocol, val session: InMemoryPairingSession)

    companion object {
        private const val PREFERENCES = "health-pairing-private-v1"
        private const val BLOB = "encrypted-paired-owner"
        private const val ALIAS = "health-pairing-private-v1"
        private const val MAX_PLAINTEXT = 1048576
        private const val MAX_ENCODED = 1398144
        private val AAD = "health-pairing-private-v1".toByteArray(Charsets.UTF_8)
        private val vaultLock = Any()
        private val cachedSessions = mutableMapOf<String, Entry>()
        private val cachedProtocols = mutableMapOf<String, HealthProtocol>()
        private fun identity(context: Context) = context.applicationContext.filesDir.absolutePath +
            "/" + PREFERENCES

        /** Activity and job use one exact schema object and one exact paired owner in this process. */
        fun protocol(context: Context): HealthProtocol = synchronized(vaultLock) {
            val app = context.applicationContext
            cachedProtocols.getOrPut(identity(app)) {
                val bytes = app.assets.open("protocol-v1.schema.json").use { it.readBytes() }
                try { HealthProtocol(bytes) } finally { bytes.fill(0) }
            }
        }
    }
}
