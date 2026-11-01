// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.GeneralSecurityException

/** Fixed opaque storage controls; no provider page, pointer, permission or ACK claim. */
@RunWith(AndroidJUnit4::class)
class QueueAtomicPairInstrumentedTest {
    @Test fun PAIR01_exactBoundSuccessAndReopen() = QueueStorageNativeFixture().use { f ->
        f.seedAll()
        val before = f.snapshot()
        val store = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias))
        val result = stage(store, "opaque-new-a", "opaque-new-b", "stream-a",
            f.bytes("steps"), f.bytes("cursor"), 592L)
        assertTrue(result is Ok)
        assertEquals(6, f.db.blobs().all().size)
        assertEquals(before, f.snapshot().filter { it.id in setOf("opaque-a", "opaque-b", "opaque-c", "opaque-d") })
        assertEquals(537, f.db.blobs().find("opaque-new-a").encryptedBytes)
        assertEquals(55, f.db.blobs().find("opaque-new-b").encryptedBytes)
        assertArrayEquals(f.bytes("steps"), f.independentOpen(f.db.blobs().find("opaque-new-a")))
        assertArrayEquals(f.bytes("cursor"), f.independentOpen(f.db.blobs().find("opaque-new-b")))
        f.reopen()
        assertEquals(6, f.db.blobs().all().size)
        val reopened = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias))
        assertArrayEquals(f.bytes("steps"), ok(reopened.read("opaque-new-a")))
        assertArrayEquals(f.bytes("cursor"), ok(reopened.read("opaque-new-b")))
        assertEquals(before, f.snapshot().filter { it.id in setOf("opaque-a", "opaque-b", "opaque-c", "opaque-d") })
    }

    @Test fun PAIR02_secondSealFailureLeavesOriginalFour() = QueueStorageNativeFixture().use { f ->
        f.seedAll()
        val before = f.snapshot()
        val real = KeystoreQueueCipher(f.alias)
        var calls = 0
        val secondSealFailure = object : QueueCipher {
            override fun seal(plaintext: ByteArray, aad: ByteArray): QueueEnvelope {
                calls++
                if (calls == 2) throw GeneralSecurityException("synthetic second-seal failure")
                return real.seal(plaintext, aad)
            }
            override fun open(envelope: QueueEnvelope, aad: ByteArray): ByteArray = real.open(envelope, aad)
        }
        val result = stage(EncryptedBlobStore(f.db, secondSealFailure), "opaque-new-a", "opaque-new-b",
            "stream-a", f.bytes("steps"), f.bytes("cursor"), 592L)
        assertEquals(2, calls)
        blocked(result, "queue-unavailable", "encryption-failed")
        assertEquals(before, f.snapshot())
        assertEquals(4, f.db.blobs().all().size)
        assertNull(f.db.blobs().find("opaque-new-a"))
        assertNull(f.db.blobs().find("opaque-new-b"))
    }

    @Test fun PAIR03_duplicateSecondInsertRollsBackFirst() = QueueStorageNativeFixture().use { f ->
        f.seedAll()
        val before = f.snapshot()
        val sqlStart = f.sql.size
        val result = stage(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)), "opaque-new-a", "opaque-c",
            "stream-a", f.bytes("steps"), f.bytes("cursor"), 592L)
        assertEquals(2, f.sql.drop(sqlStart).count { it.trimStart().startsWith("INSERT", ignoreCase = true) })
        blocked(result, "queue-unavailable", "storage-failed")
        assertEquals(before, f.snapshot())
        assertEquals(4, f.db.blobs().all().size)
        assertNull(f.db.blobs().find("opaque-new-a"))
        assertArrayEquals(f.bytes("cursor"), f.independentOpen(f.db.blobs().find("opaque-c")))
    }

    @Test fun PAIR04_boundMinusOneRefusesWithoutInsert() = QueueStorageNativeFixture().use { f ->
        f.seedAll()
        val before = f.snapshot()
        val sqlStart = f.sql.size
        val result = stage(EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)), "opaque-new-a", "opaque-new-b",
            "stream-a", f.bytes("steps"), f.bytes("cursor"), 591L)
        blocked(result, "queue-unavailable", "stage-bound-exceeded")
        assertFalse(f.sql.drop(sqlStart).any { it.trimStart().startsWith("INSERT", ignoreCase = true) })
        assertEquals(before, f.snapshot())
        assertEquals(4, f.db.blobs().all().size)
    }

    @Test fun PAIR05_existingSinglePutStillAbortsDuplicates() = QueueStorageNativeFixture().use { f ->
        f.seedAll()
        val before = f.snapshot()
        val result = EncryptedBlobStore(f.db, KeystoreQueueCipher(f.alias)).put(
            "opaque-c", "stream-a", BlobKind.CURSOR, f.bytes("cursor"))
        blocked(result, "queue-unavailable", "storage-failed")
        assertEquals(before, f.snapshot())
        assertEquals(4, f.db.blobs().all().size)
    }

    private fun blocked(result: QueueResult<Unit>, state: String, cause: String) {
        assertTrue("Expected a closed storage refusal", result is Blocked)
        val refused = result as Blocked
        assertEquals(state, refused.state)
        assertEquals(cause, refused.cause)
    }

    private fun ok(result: QueueResult<ByteArray?>): ByteArray? {
        assertTrue(result is Ok)
        return (result as Ok<ByteArray?>).value
    }

    private fun stage(
        store: EncryptedBlobStore, payloadRowId: String, cursorRowId: String, localStreamId: String,
        payload: ByteArray, cursor: ByteArray, maxEncryptedBytes: Long
    ): QueueResult<Unit> = store.putPayloadAndCursor(
        payloadRowId, cursorRowId, localStreamId, payload, cursor, maxEncryptedBytes)
}
