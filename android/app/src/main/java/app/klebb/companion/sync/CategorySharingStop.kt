// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.content.Context
import androidx.room.Room
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.LocalCategoryStopReceipt
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.KeystoreQueueCipher
import app.klebb.companion.queue.KeystoreQueueKey
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueDatabase
import app.klebb.companion.queue.QueueResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** One selected category's durable stop. All callers share the existing capture mutex. */
internal class CategorySharingStop(
    context: Context,
    private val protocol: HealthProtocol,
    private val session: InMemoryPairingSession
) {
    private val app = context.applicationContext

    suspend fun purgeLocal(stop: LocalCategoryStopReceipt) = withContext(Dispatchers.IO) {
        ManualFirstPageCapture.underCaptureLock { purgeLocalLocked(stop) }
    }

    /** Called even offline; no provider request or server history deletion is involved. */
    internal suspend fun purgeLocalLocked(stop: LocalCategoryStopReceipt) {
        withQueue { queue ->
            val receipt = requireOk(queue.purgeStoppedCategory(stop))
            check(requireOk(queue.acceptsCategoryPurge(stop, receipt))) { "Local purge changed" }
        }
    }

    /** A lost or refused response leaves the durable stop pending for the next opportunity. */
    internal suspend fun confirmLocked(stop: LocalCategoryStopReceipt, transport: PairingTransport) {
        purgeLocalLocked(stop)
        if (session.confirmedCategoryStop(stop) == null) {
            session.confirmCategoryStop(transport, stop)
        }
    }

    /** The private Room receipt is freshly reconstructed, never a saved admission boolean. */
    internal suspend fun reenableLocked(stop: LocalCategoryStopReceipt,
        transport: PairingTransport, query: WeightReadScope) {
        withQueue { queue ->
            val receipt = requireOk(queue.purgeStoppedCategory(stop))
            if (session.confirmedCategoryStop(stop) == null) {
                session.confirmCategoryStop(transport, stop)
            }
            session.reenableFirstPage(transport, stop, receipt, queue, query)
        }
    }

    private suspend fun <T> withQueue(operation: suspend (RoomDurableBatchQueue) -> T): T {
        val db = Room.databaseBuilder(app, QueueDatabase::class.java,
            ManualFirstPageCapture.DATABASE).build()
        try {
            requireOk(KeystoreQueueKey.initializeEmpty(db, ManualFirstPageCapture.KEY_ALIAS))
            val queue = RoomDurableBatchQueue(db,
                KeystoreQueueCipher(ManualFirstPageCapture.KEY_ALIAS), protocol, session,
                ManualFirstPageCapture.MAXIMUM_ROWS, ManualFirstPageCapture.MAXIMUM_ENCRYPTED_BYTES)
            return operation(queue)
        } finally {
            withContext(NonCancellable + Dispatchers.IO) { db.close() }
        }
    }

    private fun <T> requireOk(value: QueueResult<T>): T = when (value) {
        is Ok -> value.value
        is Blocked -> throw ProtocolException(value.cause)
    }
}
