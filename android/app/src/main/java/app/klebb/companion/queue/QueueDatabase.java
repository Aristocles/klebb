// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue;

import androidx.room.Database;
import androidx.room.RoomDatabase;

@Database(entities = {QueueBlob.class}, version = 1, exportSchema = true)
public abstract class QueueDatabase extends RoomDatabase {
    public abstract QueueBlobDao blobs();
}
