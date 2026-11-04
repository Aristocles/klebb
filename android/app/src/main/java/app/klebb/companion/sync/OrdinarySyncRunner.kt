// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.app.job.JobService
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.room.Room
import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.DurablePairingStore
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
import app.klebb.companion.records.RecordCodecs
import app.klebb.companion.setup.CategoryAvailability
import app.klebb.companion.setup.CategoryEvidence
import app.klebb.companion.setup.CategorySetup
import app.klebb.companion.setup.PreferenceSetupDates
import app.klebb.companion.setup.SetupDateRead
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** One real opportunity. Scheduling supplies opportunities, never a cadence or coverage claim. */
internal class OrdinarySyncRunner(context: Context) {
    private val app = context.applicationContext
    private val background = context is JobService
    private val settings = OrdinarySyncSettings(app)

    suspend fun run(isActive: () -> Boolean): List<String> = withContext(Dispatchers.IO) {
        ManualFirstPageCapture.underCaptureLock { runLocked(isActive) }
    }

    private suspend fun runLocked(isActive: () -> Boolean): List<String> {
        currentCoroutineContext().ensureActive()
        val choices = settings.read()
        if (!isActive()) throw CancellationException("Sync stopped")
        if (choices.selected.any { it !in TYPES }) return listOf("Unsupported selected category; sync retained.")
        val protocol = DurablePairingStore.protocol(app)
        val session = try { DurablePairingStore(app).open(protocol) }
            catch (_: Exception) { return listOf("Saved pairing could not be opened; queued data retained.") }
        val destination = session.destination
            ?: return listOf("Pair this phone before syncing; queued data retained.")
        val messages = mutableListOf<String>()
        val stopOperation = CategorySharingStop(app, protocol, session)
        // Reconcile a saved deselection even if the process ended between the two saves.
        for (type in TYPES.filter { it in session.categories && it !in choices.selected }) {
            ManualFirstPageCapture.underCommitFence { session.stopCategory(type) }
        }
        for (type in session.stoppedCategories()) {
            currentCoroutineContext().ensureActive()
            val stop = session.localCategoryStop(type) ?: continue
            val transport = PairingTransport(ApprovedOrigin.parse(destination))
            try {
                stopOperation.purgeLocalLocked(stop)
                if (networkAllowed()) stopOperation.confirmLocked(stop, transport)
                if (session.confirmedCategoryStop(stop) == null) {
                    messages.add("$type: phone copies removed; server stop awaits confirmation.")
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                messages.add("$type: sharing stop remains pending; collection and upload stay disabled.")
            } finally { session.cancelTransportRequests(transport) }
        }
        if (choices.selected.isEmpty()) return messages + "No saved Weight or Steps selection."
        if (background && !choices.backgroundEnabled) return messages + "Background sync is disabled."
        if (HealthConnectClient.getSdkStatus(app) != HealthConnectClient.SDK_AVAILABLE) {
            return messages + "Health Connect is unavailable; no collection started."
        }
        val native = HealthConnectClient.getOrCreate(app)
        val initialGrants = native.permissionController.getGrantedPermissions().toSet()
        if (background && (!hasBackgroundGrant(initialGrants) ||
                native.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) !=
                    HealthConnectFeatures.FEATURE_STATUS_AVAILABLE)) {
            return messages + "Background read permission is unavailable or denied; no collection started."
        }
        try {
            for (type in TYPES.filter { it in choices.selected }) {
                currentCoroutineContext().ensureActive()
                if (!isActive()) throw CancellationException("Sync stopped")
                if (!active(type, isActive)) continue
                val grants = native.permissionController.getGrantedPermissions().toSet()
                if (CategorySetup.registry.getValue(type).readPermission !in grants) {
                    try {
                        stopDeniedCategory(type, session, stopOperation)
                        messages.add("$type: read permission denied; sharing fenced and pending phone copies removed.")
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        messages.add("$type: permission stop is unconfirmed; existing phone copies are retained.")
                    }
                    continue
                }
                // A failed category owns its failed socket; the selected sibling starts fresh.
                val transport = PairingTransport(ApprovedOrigin.parse(destination))
                try {
                    syncType(type, native, protocol, session, transport, grants, isActive, messages)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    messages.add(if (session.localCategoryStop(type) != null) {
                        "$type: sharing is stopped; fresh admission is required before syncing."
                    } else "$type: sync could not be confirmed; existing queue and token retained.")
                } finally { session.cancelTransportRequests(transport) }
            }
            return messages
        } finally {
            // Per-category owned transports have already been closed; no shared-owner cancellation.
        }
    }

    private suspend fun syncType(type: String, native: HealthConnectClient, protocol: HealthProtocol,
        session: InMemoryPairingSession, transport: PairingTransport, grants: Set<String>,
        isActive: () -> Boolean, messages: MutableList<String>) {
        suspend fun permissionCheckpoint() {
            currentCoroutineContext().ensureActive()
            check(active(type, isActive)) { "Sync stopped" }
            check(HealthConnectClient.getSdkStatus(app) == HealthConnectClient.SDK_AVAILABLE)
            val now = native.permissionController.getGrantedPermissions().toSet()
            if (CategorySetup.registry.getValue(type).readPermission !in now) {
                stopDeniedCategory(type, session, CategorySharingStop(app, protocol, session))
                throw ProtocolException("permission-denied")
            }
            check(now == grants) {
                "Permission observation changed"
            }
            if (background) {
                check(hasBackgroundGrant(now) &&
                    native.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
                        HealthConnectFeatures.FEATURE_STATUS_AVAILABLE) { "Background read denied" }
            }
        }
        permissionCheckpoint()
        session.localCategoryStop(type)?.let { stop ->
            check(networkAllowed()) { "Fresh server admission is unavailable" }
            CategorySharingStop(app, protocol, session).reenableLocked(stop, transport, newQuery())
        }
        if (session.readinessCompleted(type) == null) {
            val query = session.firstPageChallenge(type)?.scope ?: newQuery()
            messages.addAll(ManualFirstPageCapture(app, protocol, session, transport,
                { selected -> selected == type && active(type, isActive) },
                { active(type, isActive) }).captureLocked(setOf(type), query))
        }
        val challenge = session.firstPageChallenge(type)
            ?: throw ProtocolException("readiness-unverified")
        // Completed challenge expiry is recovery data, never fresh BEGIN authority.
        val completed = session.readinessCompleted(type)
            ?: throw ProtocolException("readiness-unverified")
        check(completed["binding"] == challenge.binding && completed["recordType"] == type &&
            completed["sharing"] == "enabled" && completed["verification"] == "authenticated-companion-report") {
            "Completed readiness does not own this queue"
        }
        val paired = session.batchScope(type)
        check(paired.binding == challenge.binding) { "Changed generation" }
        val gate = {
            if (!active(type, isActive) || !session.isCurrentBatchScope(paired) ||
                session.readinessCompleted(type)?.get("binding") != challenge.binding) ReadGate.STALE_BINDING
            else ReadGate.OPEN
        }
        permissionCheckpoint()
        val db = Room.databaseBuilder(app, QueueDatabase::class.java, ManualFirstPageCapture.DATABASE).build()
        try {
            requireOk(KeystoreQueueKey.initializeEmpty(db, ManualFirstPageCapture.KEY_ALIAS))
            val queue = RoomDurableBatchQueue(db, KeystoreQueueCipher(ManualFirstPageCapture.KEY_ALIAS),
                protocol, session, ManualFirstPageCapture.MAXIMUM_ROWS,
                ManualFirstPageCapture.MAXIMUM_ENCRYPTED_BYTES)
            val localId = "ordinary-first-page:" + protocol.payloadDigest(
                ControlJson.text(listOf(challenge.binding, type))).removePrefix("sha256:")
            val owner = requireOk(queue.resumeStream(localId, type,
                challenge.binding.getValue("generation").toLong(), challenge.scope, gate))
            val first = checkNotNull(requireOk(queue.committedFirstPage(owner, gate)))
            check(first.query.start == challenge.scope.start && first.query.end == challenge.scope.end &&
                first.query.pageSize == challenge.scope.pageSize) { "Saved query changed" }
            val coordinator = ImmutableBatchCoordinator(queue, protocol, session, gate)
            var uploadNetworkConfirmed = false
            var uploadUnconfirmed = false
            var uploadWifiPolicy = settings.read().wifiOnly
            val uploadCoordinator = ImmutableBatchCoordinator(queue, protocol, session) {
                if (gate() != ReadGate.OPEN || !uploadNetworkConfirmed ||
                    settings.read().wifiOnly != uploadWifiPolicy) ReadGate.STALE_BINDING else ReadGate.OPEN
            }
            val state = CategorySetup.states(setOf(type), grants,
                mapOf(type to CategoryEvidence(available = CategoryAvailability.AVAILABLE))).getValue(type)
            val choice = OrdinaryRecordReaderFactory.create(native, state)
            check(choice is OrdinaryReaderChoice.Ready) { "Selected reader unavailable" }
            val reader = object : OrdinaryRecordReader {
                override val recordType = type
                override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                    permissionCheckpoint()
                    return choice.reader.readPage(scope, pageToken).also { permissionCheckpoint() }
                }
            }
            suspend fun drain(): Boolean {
                if (uploadUnconfirmed) return false
                while (true) {
                    permissionCheckpoint()
                    uploadWifiPolicy = settings.read().wifiOnly
                    uploadNetworkConfirmed = networkAllowed()
                    if (!uploadNetworkConfirmed) return false
                    when (val uploaded = uploadCoordinator.uploadNext(owner, transport)) {
                        is Blocked -> {
                            uploadUnconfirmed = true
                            messages.add("$type: upload unconfirmed; the same encrypted batch remains pending.")
                            return false
                        }
                        is Ok -> if (!uploaded.value) return true
                    }
                }
            }
            drain()
            var collectedPages = 0L
            while (!requireOk(queue.ordinaryPageProgress(owner, gate)).terminal) {
                if (collectedPages >= ManualFirstPageCapture.MAXIMUM_ROWS) {
                    messages.add("$type: saved page limit reached for this opportunity; continuation retained.")
                    return
                }
                permissionCheckpoint()
                val prepared = requireOk(queue.prepareOrdinaryPage(owner, reader, gate))
                permissionCheckpoint()
                requireOk(ManualFirstPageCapture.underCommitFence {
                    check(gate() == ReadGate.OPEN) { "Sync stopped" }
                    coordinator.stagePage(owner, prepared.page, prepared)
                })
                collectedPages++
                drain()
            }
            do {
                if (collectedPages >= ManualFirstPageCapture.MAXIMUM_ROWS) {
                    messages.add("$type: saved page limit reached for this opportunity; changes token retained.")
                    return
                }
                permissionCheckpoint()
                val prepared = requireOk(queue.prepareNativeChanges(owner, { token ->
                    permissionCheckpoint()
                    val response = native.getChanges(token)
                    check(!response.changesTokenExpired) { "Changes token expired; no reset performed" }
                    val changes = response.changes.map { change ->
                        when (change) {
                            is UpsertionChange -> NativeRecordChange.Upsert(RecordCodecs.encode(change.record).also {
                                check(it.recordType == type) { "Unexpected changed record type" }
                            })
                            is DeletionChange -> NativeRecordChange.Delete(change.recordId)
                            else -> throw ProtocolException("unsupported-native-change")
                        }
                    }
                    permissionCheckpoint()
                    NativeChangesPage(changes, response.nextChangesToken, response.hasMore)
                }, gate))
                permissionCheckpoint()
                requireOk(ManualFirstPageCapture.underCommitFence {
                    check(gate() == ReadGate.OPEN) { "Sync stopped" }
                    coordinator.stageNativeChanges(owner, prepared)
                })
                collectedPages++
                drain()
            } while (requireOk(queue.nativeChangesProgress(owner, gate)).hasMore)
            val pending = requireOk(queue.nextPending(owner, gate)) != null
            messages.add(if (pending) "$type: complete observed pages saved; encrypted upload remains pending."
                else "$type: observed pages uploaded with confirmed receipts. This is not a complete-history claim.")
        } finally {
            withContext(NonCancellable + Dispatchers.IO) { db.close() }
        }
    }

    private fun active(type: String, isActive: () -> Boolean): Boolean {
        if (!isActive()) return false
        val current = settings.read()
        return type in current.selected && (!background || current.backgroundEnabled)
    }

    /** Only an actual granted-permissions response establishes definite category denial. */
    private suspend fun stopDeniedCategory(type: String, session: InMemoryPairingSession,
        stopOperation: CategorySharingStop) {
        val stop = ManualFirstPageCapture.underCommitFence {
            val current = settings.read()
            check(settings.save(current.copy(selected = current.selected - type))) {
                "Permission stop could not be saved"
            }
            session.stopCategory(type)
        }
        stopOperation.purgeLocalLocked(stop)
    }

    private fun networkAllowed(): Boolean = try {
        val manager = app.getSystemService(ConnectivityManager::class.java)
        val network = manager?.activeNetwork
        val capabilities = if (network == null) null else manager?.getNetworkCapabilities(network)
        capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
            (!settings.read().wifiOnly || (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)))
    } catch (_: Exception) { false }

    private fun newQuery(): WeightReadScope {
        val dates = PreferenceSetupDates.open(app).read()
        if (dates !is SetupDateRead.Stored) throw ProtocolException("capture-dates-required")
        val start = LocalDate.parse(dates.dates.historyImportDate).atStartOfDay().toInstant(ZoneOffset.UTC)
        return WeightReadScope(start, Instant.now().truncatedTo(ChronoUnit.MILLIS), 100).also {
            require(it.supported()) { "Saved import date must precede now" }
        }
    }

    private fun hasBackgroundGrant(grants: Set<String>) =
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in grants

    private fun <T> requireOk(result: QueueResult<T>): T = when (result) {
        is Ok -> result.value
        is Blocked -> throw ProtocolException(result.cause)
    }

    private companion object {
        val TYPES = listOf("WeightRecord", "StepsRecord")
    }
}
