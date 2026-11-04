// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.protocol.JsonObject
import app.klebb.companion.setup.CategoryAvailability
import app.klebb.companion.setup.CategoryEvidence
import app.klebb.companion.setup.CategorySetup
import java.security.MessageDigest
import java.util.Collections
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** SDK observations accompanying a committed local page, not a server acknowledgement. */
internal class CapturedFirstPage internal constructor(val receipt: StageReceipt, facts: JsonObject) {
    val facts: JsonObject = Collections.unmodifiableMap(LinkedHashMap(facts))
    override fun toString() = "CapturedFirstPage"
}

/**
 * One selected ordinary page into the existing encrypted queue, under the caller's
 * shared coordinator lock and current capture fence. Pairing is not this fence.
 * The caller must obtain its actual stopped-BEGIN binding before opening the stream.
 * This entrypoint does not activate readiness, upload, schedule, or prove coverage.
 */
internal class WeightStepsFirstPageCapture(
    private val client: HealthConnectClient,
    private val queue: RoomDurableBatchQueue,
    private val coordinator: ImmutableBatchCoordinator,
    private val selected: (String) -> Boolean,
    private val availability: (String) -> CategoryAvailability,
    private val currentCaptureGate: () -> ReadGate
) {
    suspend fun capture(owner: BatchOwner): QueueResult<CapturedFirstPage> {
        val recordClass = when (owner.recordType) {
            "WeightRecord" -> WeightRecord::class
            "StepsRecord" -> StepsRecord::class
            else -> return Blocked("scope-mismatch", "unsupported-first-page-category")
        }
        try {
            if (!selected(owner.recordType)) return Blocked("permission-denied", "not-selected")
            if (currentCaptureGate() != ReadGate.OPEN) {
                return Blocked("stale-binding", "capture-fence-not-current")
            }
            val before = client.permissionController.getGrantedPermissions().toSet()
            val historyFeature = client.features.getFeatureStatus(
                HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)
            if (historyFeature !in setOf(HealthConnectFeatures.FEATURE_STATUS_AVAILABLE,
                    HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE)) {
                return Blocked("permission-unknown", "history-feature-unknown")
            }
            val permission = CategorySetup.registry.getValue(owner.recordType).readPermission
            if (permission !in before) return Blocked("permission-denied", "permission-denied")
            val states = CategorySetup.states(setOf(owner.recordType), before,
                mapOf(owner.recordType to CategoryEvidence(available = availability(owner.recordType))))
            val state = states.getValue(owner.recordType)
            val choice = OrdinaryRecordReaderFactory.create(client, state)
            if (choice !is OrdinaryReaderChoice.Ready) {
                return Blocked("reader-unavailable", "selected-category-unavailable")
            }
            fun gate(): ReadGate {
                if (!selected(owner.recordType)) return ReadGate.PERMISSION_DENIED
                return currentCaptureGate()
            }
            suspend fun permissionsStillMatch() {
                check(client.permissionController.getGrantedPermissions().toSet() == before) {
                    "Permission observation changed"
                }
                check(client.features.getFeatureStatus(
                    HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) == historyFeature) {
                    "History feature observation changed"
                }
                check(gate() == ReadGate.OPEN) { "Capture fence changed" }
            }
            val observedReader = object : OrdinaryRecordReader {
                override val recordType = owner.recordType
                override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                    permissionsStillMatch()
                    return choice.reader.readPage(scope, pageToken).also { permissionsStillMatch() }
                }
            }
            val prepared = when (val result = queue.prepareFirstOrdinaryPage(owner, observedReader, {
                permissionsStillMatch()
                client.getChangesToken(ChangesTokenRequest(recordTypes = setOf(recordClass)))
            }, ::gate)) {
                is Blocked -> return result
                is Ok -> result.value
            }
            permissionsStillMatch()
            val token = checkNotNull(prepared.initialChangesToken)
            val changes = client.getChanges(token)
            if (changes.changesTokenExpired) return Blocked("token-unconfirmed", "initial-token-expired")
            permissionsStillMatch()
            currentCoroutineContext().ensureActive()
            val staged = ManualFirstPageCapture.underCommitFence {
                check(gate() == ReadGate.OPEN) { "Capture fence changed" }
                coordinator.stagePage(owner, prepared.page, prepared)
            }
            val receipt = when (staged) {
                is Blocked -> return staged
                is Ok -> staged.value
            }
            val commit = checkNotNull(receipt.firstPage)
            ManualFirstPageCapture.underCommitFence {
                check(gate() == ReadGate.OPEN) { "Capture fence changed" }
                check(when (val admitted = queue.acceptsFirstPageCommit(owner, commit, ::gate)) {
                    is Blocked -> false
                    is Ok -> admitted.value
                }) { "Committed page receipt was not admitted" }
            }
            val fingerprintText = before.sorted().joinToString("") { "${it.length}:$it" } +
                ":history-feature:$historyFeature"
            val fingerprint = "sha256:" + MessageDigest.getInstance("SHA-256")
                .digest(fingerprintText.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 255) }
            return Ok(CapturedFirstPage(receipt, linkedMapOf(
                "localReadRevision" to "1",
                "recordCount" to commit.recordCount.toString(),
                "terminalPage" to commit.terminalPage,
                "permissionFingerprintStart" to fingerprint,
                "permissionFingerprintEnd" to fingerprint,
                "tokenValid" to true,
                "historyWindowLimited" to !(historyFeature == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE &&
                    HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in before),
                "interveningChangeCount" to changes.changes.size.toString(),
                "changesHaveMore" to changes.hasMore
            )))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return Blocked("first-page-unconfirmed", "permission-token-reader-or-fence-unconfirmed")
        }
    }
}
