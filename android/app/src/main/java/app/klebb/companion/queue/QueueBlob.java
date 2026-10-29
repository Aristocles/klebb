// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "queue_blobs", indices = {@Index("local_stream_id")})
public final class QueueBlob {
    @PrimaryKey @NonNull @ColumnInfo(name = "row_id") public final String rowId;
    @NonNull @ColumnInfo(name = "local_stream_id") public final String localStreamId;
    @NonNull public final String kind;
    public final int version;
    @NonNull public final byte[] nonce;
    @NonNull @ColumnInfo(name = "ciphertext_and_tag") public final byte[] ciphertextAndTag;
    @ColumnInfo(name = "encrypted_bytes") public final int encryptedBytes;

    public QueueBlob(@NonNull String rowId, @NonNull String localStreamId,
            @NonNull String kind, int version, @NonNull byte[] nonce,
            @NonNull byte[] ciphertextAndTag, int encryptedBytes) {
        this.rowId = rowId;
        this.localStreamId = localStreamId;
        this.kind = kind;
        this.version = version;
        this.nonce = nonce.clone();
        this.ciphertextAndTag = ciphertextAndTag.clone();
        this.encryptedBytes = encryptedBytes;
    }
}
