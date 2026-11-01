// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import java.util.concurrent.Callable

/**
 * Exact local queue routing only; this class does not establish sharing-stop authority.
 * The caller must own the opaque stream, confirm stop, establish every matching row
 * as unacknowledged, and fence all matching writes/uploads before invoking it.
 * Logical deletion does not establish erasure of SQLite/WAL or temporary copies.
 */
internal class QueueStreamPurger(private val db: QueueDatabase, private val cipher: QueueCipher) {
    fun purgeConfirmedUnacknowledgedStream(localStreamId: String, markerRowId: String): QueueResult<Unit> {
        if (localStreamId.isBlank() || markerRowId.isBlank()) {
            return Blocked("queue-unavailable", "invalid-identity")
        }
        return try {
            db.runInTransaction(Callable<QueueResult<Unit>> {
                val dao = db.blobs()
                if (!dao.containsStream(localStreamId)) {
                    throw PurgeRefused(Blocked("queue-unavailable", "unknown-stream"))
                }
                val marker = "[\"klebb-queue-reconciliation-v1\",1,\"fresh-scan-required\"]"
                    .toByteArray(Charsets.UTF_8)
                val inserted = EncryptedBlobStore(db, cipher).put(
                    markerRowId, localStreamId, BlobKind.STATE, marker
                )
                if (inserted is Blocked) throw PurgeRefused(inserted)
                dao.deleteStreamExceptMarker(localStreamId, markerRowId)
                Ok(Unit)
            })
        } catch (refusal: PurgeRefused) {
            refusal.result
        } catch (_: Exception) {
            Blocked("queue-unavailable", "storage-failed")
        }
    }

    private class PurgeRefused(val result: Blocked) : RuntimeException()
}
