// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.GeneralSecurityException
import java.security.MessageDigest

/** Invented owned-stream storage cases; no category, acknowledgement or consent authority inferred. */
@RunWith(AndroidJUnit4::class)
class QueueStreamPurgeInstrumentedTest {
    @Test fun A601_exactStreamPurgeKeepsOnlyEncryptedMinimalMarkerAndForeignRow() {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            f.reopen()
            assertOriginalReadable(f)
            val foreign = f.snapshot().single { it.id == "opaque-other" }
            val result = QueueStreamPurger(f.db, KeystoreQueueCipher(f.alias))
                .purgeConfirmedUnacknowledgedStream("stream-a", "opaque-reconcile")
            assertTrue("Expected successful exact-stream transaction; received ${result.javaClass.simpleName}", result is Ok<*>)
            assertEquals(2, f.snapshot().size)
            assertEquals(foreign, f.snapshot().single { it.id == "opaque-other" })
            listOf("opaque-a", "opaque-b", "opaque-c", "opaque-d").forEach { assertNull(f.db.blobs().find(it)) }
            assertMarker(f)
            val committed = f.snapshot()
            f.reopen()
            assertEquals(committed, f.snapshot())
            assertMarker(f)
            assertArrayEquals(f.bytes("steps"), f.independentOpen(f.db.blobs().find("opaque-other")))
            assertTrue(f.aliasPresent())
        }
    }

    @Test fun A602_sameStreamMarkerIdentityCollisionPreservesEveryRow() = collision("opaque-a")
    @Test fun A603_foreignMarkerIdentityCollisionPreservesEveryRow() = collision("opaque-other")

    @Test fun A604_activatedDeleteFailureRollsBackInsertedMarkerAndEveryRemoval() {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            val before = f.snapshot()
            f.db.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER purge_fail BEFORE DELETE ON queue_blobs " +
                    "WHEN OLD.local_stream_id = 'stream-a' AND EXISTS " +
                    "(SELECT 1 FROM queue_blobs WHERE row_id = 'opaque-reconcile') " +
                    "BEGIN SELECT RAISE(ABORT, 'synthetic-delete-failure'); END"
            )
            try {
                f.sql.clear()
                val result = QueueStreamPurger(f.db, KeystoreQueueCipher(f.alias))
                    .purgeConfirmedUnacknowledgedStream("stream-a", "opaque-reconcile")
                blocked(result, "storage-failed")
                val statements = synchronized(f.sql) { f.sql.toList() }
                val insertion = statements.indexOfFirst { it.trimStart().startsWith("INSERT", true) }
                val deletion = statements.indexOfFirst { it.trimStart().startsWith("DELETE", true) }
                assertTrue("The marker INSERT must precede the activated DELETE fault", insertion >= 0 && deletion > insertion)
                assertEquals(before, f.snapshot())
                assertNull(f.db.blobs().find("opaque-reconcile"))
                assertOriginalReadable(f)
                f.reopen()
                assertEquals(before, f.snapshot())
                assertNull(f.db.blobs().find("opaque-reconcile"))
            } finally {
                f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER IF EXISTS purge_fail")
            }
        }
    }

    @Test fun A605_activatedSealFailureNeverInsertsOrDeletesAnyRow() {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            val before = f.snapshot()
            var seals = 0
            val fault = object : QueueCipher {
                override fun seal(plaintext: ByteArray, aad: ByteArray): QueueEnvelope {
                    seals++
                    throw GeneralSecurityException()
                }
                override fun open(envelope: QueueEnvelope, aad: ByteArray): ByteArray =
                    KeystoreQueueCipher(f.alias).open(envelope, aad)
            }
            f.sql.clear()
            val result = QueueStreamPurger(f.db, fault)
                .purgeConfirmedUnacknowledgedStream("stream-a", "opaque-reconcile")
            assertEquals(1, seals)
            blocked(result, "encryption-failed")
            val statements = synchronized(f.sql) { f.sql.toList() }
            assertFalse(statements.any { it.trimStart().startsWith("INSERT", true) || it.trimStart().startsWith("DELETE", true) })
            assertEquals(before, f.snapshot())
            assertNull(f.db.blobs().find("opaque-reconcile"))
            assertOriginalReadable(f)
            assertTrue(f.aliasPresent())
        }
    }

    @Test fun A606_absentExactStreamRefusesWithoutInventingAStream() {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            val before = f.snapshot()
            f.sql.clear()
            blocked(QueueStreamPurger(f.db, KeystoreQueueCipher(f.alias))
                .purgeConfirmedUnacknowledgedStream("unknown-owned-stream", "opaque-reconcile"), "unknown-stream")
            val statements = synchronized(f.sql) { f.sql.toList() }
            assertFalse(statements.any { it.trimStart().startsWith("INSERT", true) || it.trimStart().startsWith("DELETE", true) })
            assertEquals(before, f.snapshot())
            assertNull(f.db.blobs().find("opaque-reconcile"))
        }
    }

    @Test fun A607_prefixSimilarStreamIsNotTheSelectedStream() {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            f.seed("opaque-prefix", "stream-a-extra", BlobKind.PAYLOAD, "weight")
            val foreign = f.snapshot().filter { it.stream != "stream-a" }
            assertTrue(QueueStreamPurger(f.db, KeystoreQueueCipher(f.alias))
                .purgeConfirmedUnacknowledgedStream("stream-a", "opaque-reconcile") is Ok<*>)
            assertEquals(3, f.snapshot().size)
            assertEquals(foreign, f.snapshot().filter { it.stream != "stream-a" })
            assertArrayEquals(f.bytes("weight"), f.independentOpen(f.db.blobs().find("opaque-prefix")))
            assertMarker(f)
        }
    }

    private fun seed(f: QueueStorageNativeFixture) {
        f.seedAll()
        f.seed("opaque-other", "stream-b", BlobKind.PAYLOAD, "steps")
        assertEquals(5, f.snapshot().size)
        assertOriginalReadable(f)
    }

    private fun collision(markerId: String) {
        QueueStorageNativeFixture().use { f ->
            seed(f)
            val before = f.snapshot()
            f.sql.clear()
            blocked(QueueStreamPurger(f.db, KeystoreQueueCipher(f.alias))
                .purgeConfirmedUnacknowledgedStream("stream-a", markerId), "storage-failed")
            val statements = synchronized(f.sql) { f.sql.toList() }
            assertTrue("INSERT collision must actually be reached", statements.any { it.trimStart().startsWith("INSERT", true) })
            assertFalse(statements.any { it.trimStart().startsWith("DELETE", true) })
            assertEquals(before, f.snapshot())
            assertOriginalReadable(f)
            f.reopen()
            assertEquals(before, f.snapshot())
            assertTrue(f.aliasPresent())
        }
    }

    private fun assertOriginalReadable(f: QueueStorageNativeFixture) {
        mapOf("opaque-a" to "steps", "opaque-b" to "weight", "opaque-c" to "cursor",
            "opaque-d" to "operational", "opaque-other" to "steps").forEach { (id, input) ->
            assertArrayEquals(f.bytes(input), f.independentOpen(f.db.blobs().find(id)))
        }
    }

    private fun assertMarker(f: QueueStorageNativeFixture) {
        val expected = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("queue-stream-purge-inputs-v1.json").bufferedReader(Charsets.UTF_8).use { it.readText() })
            .getJSONObject("marker")
        val bytes = QueueStorageNativeFixture.unhex(expected.getString("utf8Hex"))
        assertEquals(57, bytes.size)
        assertEquals("697be27c4277813293cf1e164e0adc1e50c952d2ea6114f5cb02345d8253588f",
            QueueStorageNativeFixture.hex(MessageDigest.getInstance("SHA-256").digest(bytes)))
        val row = f.db.blobs().find("opaque-reconcile")
        assertNotNull(row)
        assertEquals("stream-a", row.localStreamId)
        assertEquals("state", row.kind)
        assertEquals(1, row.version)
        assertEquals(12, row.nonce.size)
        assertEquals(73, row.ciphertextAndTag.size)
        assertEquals(85, row.encryptedBytes)
        assertEquals(1, f.db.blobs().all().count { it.localStreamId == "stream-a" })
        assertArrayEquals(bytes, f.independentOpen(row))
    }

    private fun blocked(result: QueueResult<*>, cause: String) {
        assertTrue("Expected typed storage refusal", result is Blocked)
        assertEquals("queue-unavailable", (result as Blocked).state)
        assertEquals(cause, result.cause)
    }
}
