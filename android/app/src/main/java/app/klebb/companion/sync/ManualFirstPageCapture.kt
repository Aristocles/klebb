// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.room.Room
import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.KeystoreQueueCipher
import app.klebb.companion.queue.KeystoreQueueKey
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueDatabase
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.setup.CategoryAvailability
import app.klebb.companion.setup.CategorySetup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/**
 * Foreground manual first-page path only. The one process-wide lock and one
 * BEGIN challenge supply the same fence to the native producer and coordinator.
 * Pages stay pending locally; upload, resumed pagination and scheduling are separate.
 */
internal class ManualFirstPageCapture(
    context: Context,
    private val protocol: HealthProtocol,
    private val session: InMemoryPairingSession,
    private val transport: PairingTransport,
    private val stillSelected: (String) -> Boolean,
    private val inForeground: () -> Boolean
) {
    private val app = context.applicationContext

    suspend fun capture(selected: Set<String>, query: WeightReadScope): List<String> =
        underCaptureLock { captureLocked(selected, query) }

    /** Internal continuation seam; its caller already holds the shared capture mutex. */
    internal suspend fun captureLocked(selected: Set<String>, query: WeightReadScope): List<String> {
        require(selected.isNotEmpty() && selected.all { it in TYPES } && query.supported())
        val messages = mutableListOf<String>()
        for (type in TYPES.filter { it in selected }) {
            currentCoroutineContext().ensureActive()
            if (!inForeground()) throw CancellationException("Capture stopped")
            if (!stillSelected(type)) {
                messages.add("$type: sharing stopped; no capture started.")
                continue
            }
            check(HealthConnectClient.getSdkStatus(app) == HealthConnectClient.SDK_AVAILABLE) {
                "Health Connect is unavailable"
            }
            val native = HealthConnectClient.getOrCreate(app)
            val permission = CategorySetup.registry.getValue(type).readPermission
            if (permission !in native.permissionController.getGrantedPermissions()) {
                messages.add("$type: read permission denied; no capture started.")
                continue
            }
            try {
                val (challenge, captured) = withContext(Dispatchers.IO) {
                    currentCoroutineContext().ensureActive()
                    val db = Room.databaseBuilder(app, QueueDatabase::class.java, DATABASE).build()
                    try {
                        // A populated database with a missing key refuses before changing remote policy.
                        requireOk(KeystoreQueueKey.initializeEmpty(db, KEY_ALIAS))
                        check(inForeground() && stillSelected(type)) { "Capture stopped" }
                        currentCoroutineContext().ensureActive()
                        val challenge = session.firstPageChallenge(type)?.let { existing ->
                            check(session.isCurrentFirstPage(existing) &&
                                existing.scope.start == query.start && existing.scope.end == query.end &&
                                existing.scope.pageSize == query.pageSize) { "Fresh first page changed" }
                            existing
                        } ?: session.beginFirstPage(transport, type, query)
                        val gate = {
                            if (!inForeground() || !stillSelected(type) || !session.isCurrentFirstPage(challenge)) {
                                ReadGate.STALE_BINDING
                            } else ReadGate.OPEN
                        }
                        check(gate() == ReadGate.OPEN) { "Capture stopped" }
                        val queue = RoomDurableBatchQueue(db, KeystoreQueueCipher(KEY_ALIAS), protocol, session,
                            MAXIMUM_ROWS, MAXIMUM_ENCRYPTED_BYTES)
                        val localId = "ordinary-first-page:" + protocol.payloadDigest(
                            ControlJson.text(listOf(challenge.binding, type))).removePrefix("sha256:")
                        val owner = requireOk(queue.openStream(localId, type,
                            challenge.binding.getValue("generation").toLong(), query, gate))
                        val alreadyCommitted = requireOk(queue.committedFirstPage(owner, gate))
                        if (alreadyCommitted != null) throw ProtocolException("first-page-already-committed")
                        val coordinator = ImmutableBatchCoordinator(queue, protocol, session, gate)
                        val producer = WeightStepsFirstPageCapture(native, queue, coordinator,
                            { name -> name == type && stillSelected(name) },
                            { name ->
                                if (name == type && HealthConnectClient.getSdkStatus(app) ==
                                        HealthConnectClient.SDK_AVAILABLE) CategoryAvailability.AVAILABLE
                                else CategoryAvailability.UNKNOWN
                            }, gate)
                        val result = requireOk(producer.capture(owner))
                        underCommitFence {
                            check(gate() == ReadGate.OPEN) { "Capture stopped" }
                            val receipt = checkNotNull(result.receipt.firstPage)
                            check(requireOk(queue.acceptsFirstPageCommit(owner, receipt, gate))) {
                                "Local page commit is unconfirmed"
                            }
                        }
                        challenge to result
                    } finally {
                        withContext(NonCancellable + Dispatchers.IO) { db.close() }
                    }
                }
                currentCoroutineContext().ensureActive()
                check(inForeground() && stillSelected(type) && session.isCurrentFirstPage(challenge)) {
                    "Capture stopped"
                }
                withContext(Dispatchers.IO) {
                    val currentFingerprint = currentPermissionFingerprint(native, type)
                    check(currentFingerprint == captured.facts["permissionFingerprintStart"] &&
                        currentFingerprint == captured.facts["permissionFingerprintEnd"]) {
                        "Permission observation changed"
                    }
                    check(inForeground() && stillSelected(type) && session.isCurrentFirstPage(challenge)) {
                        "Capture stopped"
                    }
                    currentCoroutineContext().ensureActive()
                    session.completeFirstPage(transport, challenge, captured.facts)
                }
                currentCoroutineContext().ensureActive()
                check(inForeground() && stillSelected(type)) { "Capture stopped" }
                val count = checkNotNull(captured.receipt.firstPage).recordCount
                messages.add("$type: $count records saved in the encrypted queue; upload pending.")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A page may already be committed. Neither queue rows nor sibling policy are purged.
                messages.add("$type: capture or readiness could not be confirmed; queued data retained.")
            }
        }
        return messages
    }

    private suspend fun currentPermissionFingerprint(native: HealthConnectClient, type: String): String {
        check(HealthConnectClient.getSdkStatus(app) == HealthConnectClient.SDK_AVAILABLE)
        val granted = native.permissionController.getGrantedPermissions().toSet()
        check(CategorySetup.registry.getValue(type).readPermission in granted)
        val historyFeature = native.features.getFeatureStatus(
            HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)
        check(historyFeature in setOf(HealthConnectFeatures.FEATURE_STATUS_AVAILABLE,
            HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE))
        val text = granted.sorted().joinToString("") { "${it.length}:$it" } +
            ":history-feature:$historyFeature"
        return "sha256:" + MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    private fun <T> requireOk(value: QueueResult<T>): T = when (value) {
        is Ok -> value.value
        is Blocked -> throw ProtocolException(value.cause)
    }

    companion object {
        private val commitFence = Any()
        internal fun <T> underCommitFence(block: () -> T): T = synchronized(commitFence, block)
        internal suspend fun <T> underCaptureLock(block: suspend () -> T): T = captureLock.withLock { block() }
        private val TYPES = listOf("WeightRecord", "StepsRecord")
        private val captureLock = Mutex()
        const val DATABASE = "ordinary-record-queue-v1.db"
        const val KEY_ALIAS = "ordinary-record-queue-v1"
        // Reuse the bounded original Room fixture configuration; do not enlarge on refusal.
        const val MAXIMUM_ROWS = 100L
        const val MAXIMUM_ENCRYPTED_BYTES = 4_194_304L
    }
}
