// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import java.util.List;

@Dao
public interface QueueBlobDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    long insert(QueueBlob row);

    @Query("SELECT * FROM queue_blobs WHERE row_id = :rowId")
    QueueBlob find(String rowId);

    @Query("SELECT * FROM queue_blobs ORDER BY row_id")
    List<QueueBlob> all();

    @Query("SELECT EXISTS(SELECT 1 FROM queue_blobs WHERE local_stream_id = :localStreamId)")
    boolean containsStream(String localStreamId);

    @Query("DELETE FROM queue_blobs WHERE local_stream_id = :localStreamId AND row_id != :markerRowId")
    int deleteStreamExceptMarker(String localStreamId, String markerRowId);

    /** Compare the exact encrypted STATE observed inside the same Room transaction. */
    @Query("UPDATE queue_blobs SET version = :nextVersion, nonce = :nextNonce, " +
            "ciphertext_and_tag = :nextCiphertext, encrypted_bytes = :nextEncryptedBytes " +
            "WHERE row_id = :rowId AND local_stream_id = :localStreamId AND kind = 'state' " +
            "AND version = :expectedVersion AND nonce = :expectedNonce " +
            "AND ciphertext_and_tag = :expectedCiphertext " +
            "AND encrypted_bytes = :expectedEncryptedBytes")
    int replaceStateIfUnchanged(String rowId, String localStreamId,
            int expectedVersion, byte[] expectedNonce, byte[] expectedCiphertext,
            int expectedEncryptedBytes, int nextVersion, byte[] nextNonce,
            byte[] nextCiphertext, int nextEncryptedBytes);

    final class StreamUsage {
        public long rowCount;
        public long encryptedBytes;
        public long invalidRows;
    }

    @Query("SELECT COUNT(*) AS rowCount, " +
        "COALESCE(SUM(COALESCE(length(CAST(nonce AS BLOB)), 0) + COALESCE(length(CAST(ciphertext_and_tag AS BLOB)), 0)), 0) AS encryptedBytes, " +
        "COALESCE(SUM(CASE WHEN version != 1 OR kind NOT IN ('payload', 'cursor', 'state') " +
        "OR typeof(version) != 'integer' OR typeof(encrypted_bytes) != 'integer' " +
        "OR typeof(nonce) != 'blob' OR typeof(ciphertext_and_tag) != 'blob' OR length(nonce) != 12 " +
        "OR length(ciphertext_and_tag) < 16 OR encrypted_bytes != length(nonce) + length(ciphertext_and_tag) " +
        "THEN 1 ELSE 0 END), 0) AS invalidRows " +
        "FROM queue_blobs WHERE local_stream_id = :localStreamId")
    StreamUsage usageForStream(String localStreamId);

    @Query("DELETE FROM queue_blobs WHERE row_id = :rowId " +
        "AND local_stream_id = :localStreamId AND kind = :kind")
    int deleteOwnedRow(String rowId, String localStreamId, String kind);
}
