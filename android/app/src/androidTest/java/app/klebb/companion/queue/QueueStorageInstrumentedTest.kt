// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.GeneralSecurityException
import java.security.InvalidAlgorithmParameterException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.SecretKeyFactory
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

@RunWith(AndroidJUnit4::class)
class QueueStorageInstrumentedTest {
    @Test fun F21_exactBytesSurviveRoomCloseAndReopen() {
        QueueStorageNativeFixture().use { f ->
            f.seedAll()
            assertArrayEquals(f.bytes("steps"), f.independentOpen(f.db.blobs().find("opaque-a")))
            assertArrayEquals(f.bytes("weight"), f.independentOpen(f.db.blobs().find("opaque-b")))
            assertTrue(f.context.getDatabasePath(f.db.openHelper.databaseName!!).isFile)
            val store = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias))
            ok(store.put("opaque-new-a", "stream-a", BlobKind.PAYLOAD, f.bytes("steps")))
            ok(store.put("opaque-new-b", "stream-a", BlobKind.PAYLOAD, f.bytes("weight")))
            assertArrayEquals(f.bytes("steps"), ok(store.read("opaque-new-a")))
            assertArrayEquals(f.bytes("weight"), ok(store.read("opaque-new-b")))
            assertNull(ok(store.read("opaque-absent")))
            f.reopen()
            val reopened = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias))
            assertArrayEquals(f.bytes("steps"), ok(reopened.read("opaque-new-a")))
            assertArrayEquals(f.bytes("weight"), ok(reopened.read("opaque-new-b")))
            assertEquals(6, f.db.blobs().all().size)
        }
    }

    @Test fun F22_ciphertextAndTagControlsRefuseWithoutChangingAnyRow() {
        QueueStorageNativeFixture().use { f ->
            f.seedAll()
            val original = f.db.blobs().find("opaque-a").ciphertextAndTag.copyOf()
            for (index in listOf(0, original.lastIndex)) {
                f.replaceEncrypted("opaque-a", original.copyOf().apply { this[index] = (this[index].toInt() xor 1).toByte() })
                val before = f.snapshot()
                blocked(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)).read("opaque-a"),
                    "corrupt-queue", "authentication-failed")
                assertEquals(before, f.snapshot())
                f.replaceEncrypted("opaque-a", original)
            }
        }
    }

    @Test fun F23_rowAndStreamRelocationRefuseWithoutChangingAnyRow() {
        QueueStorageNativeFixture().use { f ->
            f.seedAll()
            val original = f.db.blobs().find("opaque-a")
            f.db.blobs().insert(QueueBlob("opaque-relocated", original.localStreamId, original.kind,
                original.version, original.nonce, original.ciphertextAndTag, original.encryptedBytes))
            var before = f.snapshot()
            blocked(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)).read("opaque-relocated"),
                "corrupt-queue", "authentication-failed")
            assertEquals(before, f.snapshot())
            f.moveStream("opaque-a", "stream-relocated")
            before = f.snapshot()
            blocked(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)).read("opaque-a"),
                "corrupt-queue", "authentication-failed")
            assertEquals(before, f.snapshot())
        }
    }

    @Test fun F24_missingRealAliasNeverCreatesReplacementOrChangesRows() {
        QueueStorageNativeFixture().use { f ->
            f.seedAll()
            f.deleteOwnedAlias()
            assertFalse(f.aliasPresent())
            val before = f.snapshot()
            blocked(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)).read("opaque-a"),
                "key-unavailable", "key-unavailable")
            assertEquals(before, f.snapshot())
            blocked(KeystoreQueueKey.initializeEmpty(f.db, f.alias), "key-unavailable", "key-unavailable")
            assertFalse(f.aliasPresent())
            assertEquals(before, f.snapshot())
        }
    }

    @Test fun F25_activatedEncryptionFailurePreservesEncryptedCursorAndAllRows() {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            f.seed("opaque-c", "stream-a", BlobKind.CURSOR, "cursor")
            f.seed("opaque-d", "stream-a", BlobKind.STATE, "operational")
            val before = f.snapshot()
            assertTrue(f.db.blobs().all().none { it.kind == BlobKind.PAYLOAD.stored })
            assertArrayEquals(f.bytes("cursor"), f.independentOpen(f.db.blobs().find("opaque-c")))
            var sealCalls = 0
            val fault = object : QueueCipher {
                override fun seal(plaintext: ByteArray, aad: ByteArray): QueueEnvelope {
                    sealCalls++
                    throw GeneralSecurityException()
                }
                override fun open(envelope: QueueEnvelope, aad: ByteArray): ByteArray =
                    KeystoreQueueCipher(f.alias).open(envelope, aad)
            }
            f.sql.clear()
            val result = EncryptedBlobStore(f.db, fault).put("opaque-new-a", "stream-a", BlobKind.PAYLOAD, f.bytes("steps"))
            assertEquals("The actual injected seal must be reached before this is classified as a fault result", 1, sealCalls)
            blocked(result, "queue-unavailable", "encryption-failed")
            val statements = synchronized(f.sql) { f.sql.toList() }
            assertFalse(statements.any { it.trimStart().startsWith("BEGIN", ignoreCase = true) })
            assertFalse(statements.any { it.trimStart().startsWith("INSERT", ignoreCase = true) })
            assertEquals(before, f.snapshot())
            assertTrue(f.db.blobs().all().none { it.kind == BlobKind.PAYLOAD.stored })
            assertArrayEquals(f.bytes("cursor"), f.independentOpen(f.db.blobs().find("opaque-c")))
            assertTrue(f.aliasPresent())
            f.assertNoPlaintextArtifacts()
        }
    }

    @Test fun F26_nativeKeyPolicyRandomIVsAndExistingKeyRetention() {
        QueueStorageNativeFixture().use { f ->
            ok(KeystoreQueueKey.initializeEmpty(f.db, f.alias))
            assertTrue(f.aliasPresent())
            val key = f.key()
            assertNull(key.encoded)
            val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
            assertEquals(256, info.keySize)
            assertTrue(KeyProperties.BLOCK_MODE_GCM in info.blockModes)
            assertTrue(KeyProperties.ENCRYPTION_PADDING_NONE in info.encryptionPaddings)
            // KeyInfo exposes no randomized-encryption getter; observe the native policy itself.
            try {
                Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, ByteArray(12)))
                fail("Native randomized encryption must refuse a caller-provided IV")
            } catch (_: InvalidAlgorithmParameterException) { /* Actual native policy refusal. */ }
            val aad = f.aad("opaque-a", "stream-a", BlobKind.PAYLOAD.stored)
            val cipher = KeystoreQueueCipher(f.alias)
            val first = cipher.seal(f.bytes("steps"), aad)
            val second = cipher.seal(f.bytes("steps"), aad)
            assertEquals(1, first.version)
            assertEquals(12, first.nonce.size)
            assertEquals(12, second.nonce.size)
            assertEquals(f.bytes("steps").size + 16, first.ciphertextAndTag.size)
            assertFalse(first.nonce.contentEquals(second.nonce))
            assertFalse(first.ciphertextAndTag.contentEquals(second.ciphertextAndTag))
            assertArrayEquals(f.bytes("steps"), cipher.open(first, aad))
            assertArrayEquals(f.bytes("steps"), cipher.open(second, aad))
            val executor = Executors.newFixedThreadPool(2)
            try {
                val calls = (1..2).map { executor.submit<QueueResult<Unit>> { KeystoreQueueKey.initializeEmpty(f.db, f.alias) } }
                calls.forEach { ok(it.get(10, TimeUnit.SECONDS)) }
            } finally { executor.shutdownNow() }
            // Existing usable alias must survive concurrent explicit initialization, not silently rotate.
            assertArrayEquals(f.bytes("steps"), KeystoreQueueCipher(f.alias).open(first, aad))
        }
    }

    @Test fun F27_populatedNativeArtifactsAndDiagnosticsContainNoPlaintextFields() {
        QueueStorageNativeFixture().use { f ->
            f.createIndependentKey()
            val controlAad = f.aad("opaque-a", "stream-a", BlobKind.PAYLOAD.stored)
            val nativeSeal = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, f.key())
                updateAAD(controlAad)
            }
            val controlEncrypted = nativeSeal.doFinal(f.bytes("steps"))
            val nativeOpen = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, f.key(), GCMParameterSpec(128, nativeSeal.iv))
                updateAAD(controlAad)
            }
            assertArrayEquals(f.bytes("steps"), nativeOpen.doFinal(controlEncrypted))
            val store = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias))
            for ((rowId, kind, input) in listOf(
                Triple("opaque-a", BlobKind.PAYLOAD, "steps"),
                Triple("opaque-b", BlobKind.PAYLOAD, "weight"),
                Triple("opaque-c", BlobKind.CURSOR, "cursor"),
                Triple("opaque-d", BlobKind.STATE, "operational")
            )) {
                ok(store.put(rowId, "stream-a", kind, f.bytes(input)))
                assertArrayEquals(f.bytes(input), ok(store.read(rowId)))
                assertArrayEquals(f.bytes(input), f.independentOpen(f.db.blobs().find(rowId)))
            }
            assertEquals(4, f.snapshot().size)
            val columns = f.db.openHelper.readableDatabase.query("PRAGMA table_info(queue_blobs)").use { cursor ->
                buildList { while (cursor.moveToNext()) add(cursor.getString(cursor.getColumnIndexOrThrow("name"))) }
            }
            assertEquals(listOf("row_id", "local_stream_id", "kind", "version", "nonce", "ciphertext_and_tag", "encrypted_bytes"), columns)
            f.assertNoPlaintextArtifacts()
        }
    }

    private fun <T> ok(result: QueueResult<T>): T {
        assertTrue("Expected typed success, got $result", result is Ok<*>)
        @Suppress("UNCHECKED_CAST") return (result as Ok<T>).value
    }

    private fun blocked(result: QueueResult<*>, state: String, cause: String) {
        assertTrue("Expected typed refusal, got $result", result is Blocked)
        assertEquals(state, (result as Blocked).state)
        assertEquals(cause, result.cause)
    }
}
