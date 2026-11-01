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
}
