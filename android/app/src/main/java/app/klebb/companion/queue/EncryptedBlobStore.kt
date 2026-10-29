// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

/** Compiled feature baseline. Storage remains unavailable until its native behavior red is observed. */
class EncryptedBlobStore(private val db: QueueDatabase, private val cipher: QueueCipher) {
    fun put(
        rowId: String, localStreamId: String, kind: BlobKind, plaintext: ByteArray
    ): QueueResult<Unit> = Blocked("queue-unavailable", "feature-unavailable")

    fun read(rowId: String): QueueResult<ByteArray?> =
        Blocked("queue-unavailable", "feature-unavailable")
}
