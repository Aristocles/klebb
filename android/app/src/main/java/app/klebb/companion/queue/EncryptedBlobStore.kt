// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import org.json.JSONArray
import java.util.concurrent.Callable

/** Immutable byte storage; callers perform synchronous Room work off the main thread. */
class EncryptedBlobStore(private val db: QueueDatabase, private val cipher: QueueCipher) {
    fun put(
        rowId: String, localStreamId: String, kind: BlobKind, plaintext: ByteArray
    ): QueueResult<Unit> {
        val row = try {
            val envelope = cipher.seal(plaintext.copyOf(), aad(kind.stored, rowId, localStreamId))
            val nonce = envelope.nonce.copyOf()
            val encrypted = envelope.ciphertextAndTag.copyOf()
            val size = nonce.size.toLong() + encrypted.size.toLong()
            if (envelope.version != 1 || nonce.size != 12 || encrypted.size < 16 || size > Int.MAX_VALUE) {
                return Blocked("queue-unavailable", "encryption-failed")
            }
            QueueBlob(rowId, localStreamId, kind.stored, 1, nonce, encrypted, size.toInt())
        } catch (_: QueueKeyUnavailable) {
            return Blocked("key-unavailable", "key-unavailable")
        } catch (_: Exception) {
            return Blocked("queue-unavailable", "encryption-failed")
        }
        return try {
            db.runInTransaction(Callable<QueueResult<Unit>> {
                db.blobs().insert(row)
                Ok(Unit)
            })
        } catch (_: Exception) {
            Blocked("queue-unavailable", "storage-failed")
        }
    }

    /** Atomic opaque pair; the bound is supplied by the caller, not a global queue quota. */
    fun putPayloadAndCursor(
        payloadRowId: String, cursorRowId: String, localStreamId: String,
        payload: ByteArray, cursor: ByteArray, maxEncryptedBytes: Long
    ): QueueResult<Unit> {
        if (maxEncryptedBytes <= 0L) return Blocked("queue-unavailable", "stage-bound-exceeded")
        val rows = try {
            listOf(
                Triple(payloadRowId, BlobKind.PAYLOAD, payload.copyOf()),
                Triple(cursorRowId, BlobKind.CURSOR, cursor.copyOf())
            ).map { (rowId, kind, plaintext) ->
                val envelope = cipher.seal(plaintext, aad(kind.stored, rowId, localStreamId))
                val nonce = envelope.nonce.copyOf()
                val encrypted = envelope.ciphertextAndTag.copyOf()
                val size = nonce.size.toLong() + encrypted.size.toLong()
                if (envelope.version != 1 || nonce.size != 12 || encrypted.size < 16 || size > Int.MAX_VALUE) {
                    throw MalformedEnvelope()
                }
                QueueBlob(rowId, localStreamId, kind.stored, 1, nonce, encrypted, size.toInt())
            }
        } catch (_: QueueKeyUnavailable) {
            return Blocked("key-unavailable", "key-unavailable")
        } catch (_: Exception) {
            return Blocked("queue-unavailable", "encryption-failed")
        }
        if (rows.sumOf { it.encryptedBytes.toLong() } > maxEncryptedBytes) {
            return Blocked("queue-unavailable", "stage-bound-exceeded")
        }
        return try {
            db.runInTransaction(Callable<QueueResult<Unit>> {
                rows.forEach { db.blobs().insert(it) }
                Ok(Unit)
            })
        } catch (_: Exception) {
            Blocked("queue-unavailable", "storage-failed")
        }
    }

    fun read(rowId: String): QueueResult<ByteArray?> {
        val row = try {
            db.blobs().find(rowId)
        } catch (_: Exception) {
            return Blocked("queue-unavailable", "storage-failed")
        } ?: return Ok(null)
        if (row.version != 1) return Blocked("corrupt-queue", "unsupported-envelope")
        if (BlobKind.entries.none { it.stored == row.kind } || row.nonce.size != 12 ||
            row.ciphertextAndTag.size < 16 || row.encryptedBytes.toLong() !=
            row.nonce.size.toLong() + row.ciphertextAndTag.size.toLong()) {
            return Blocked("corrupt-queue", "malformed-envelope")
        }
        val envelope = QueueEnvelope(row.version, row.nonce.copyOf(), row.ciphertextAndTag.copyOf())
        return try {
            Ok(cipher.open(envelope, aad(row.kind, row.rowId, row.localStreamId)).copyOf())
        } catch (_: QueueKeyUnavailable) {
            Blocked("key-unavailable", "key-unavailable")
        } catch (_: UnsupportedEnvelope) {
            Blocked("corrupt-queue", "unsupported-envelope")
        } catch (_: MalformedEnvelope) {
            Blocked("corrupt-queue", "malformed-envelope")
        } catch (_: Exception) {
            Blocked("corrupt-queue", "authentication-failed")
        }
    }

    private fun aad(kind: String, rowId: String, localStreamId: String): ByteArray =
        JSONArray(listOf("klebb-health-queue-v1", 1, kind, rowId, localStreamId))
            .toString().toByteArray(Charsets.UTF_8)
}
