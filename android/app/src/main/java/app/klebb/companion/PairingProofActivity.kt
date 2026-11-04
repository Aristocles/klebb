// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import app.klebb.companion.setup.CategorySetup
import app.klebb.companion.setup.PreferenceSetupDates
import app.klebb.companion.setup.SetupDateRead
import app.klebb.companion.sync.ManualFirstPageCapture
import app.klebb.companion.sync.CategorySharingStop
import app.klebb.companion.sync.OrdinarySyncChoices
import app.klebb.companion.sync.OrdinarySyncJobService
import app.klebb.companion.sync.OrdinarySyncRunner
import app.klebb.companion.sync.OrdinarySyncSettings
import app.klebb.companion.protocol.DurablePairingStore
import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.AuthorisedRequest
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.LocalCategoryStopReceipt
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

class PairingProofActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val operations = ForegroundOperations(scope)
    private lateinit var session: InMemoryPairingSession
    private lateinit var protocol: HealthProtocol
    private lateinit var pairingStore: DurablePairingStore
    private lateinit var syncSettings: OrdinarySyncSettings
    private lateinit var wifiOnly: CheckBox
    private lateinit var backgroundSync: CheckBox
    private val captureSelections = mutableMapOf<String, CheckBox>()
    private val purgingCategories = mutableSetOf<String>()
    private val stopJobs = mutableMapOf<String, Job>()
    private val stopTransports = mutableMapOf<String, PairingTransport>()
    private var permissionPending = false
    @Volatile private var selectionSaveConfirmed = true
    private lateinit var originInput: EditText
    private lateinit var grantInput: EditText
    private lateinit var approved: TextView
    private lateinit var result: TextView
    private lateinit var streamButtons: LinearLayout
    private val buttons = mutableListOf<Button>()
    private var transport: PairingTransport? = null
    private var activeRequest: AuthorisedRequest? = null
    @Volatile private var inForeground = false
    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) {
        permissionPending = false
        if (::result.isInitialized) result.text = "Read permission response received. Sync will check the actual grants."
        buttons.forEach { it.isEnabled = inForeground && !operations.active }
        updateCaptureControls()
        if (::wifiOnly.isInitialized) wifiOnly.isEnabled = inForeground && !operations.active
        if (::backgroundSync.isInitialized) backgroundSync.isEnabled = inForeground && !operations.active
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            protocol = DurablePairingStore.protocol(this)
            pairingStore = DurablePairingStore(this)
            session = pairingStore.open(protocol)
            syncSettings = OrdinarySyncSettings(this)
        } catch (_: Exception) {
            setContentView(TextView(this).apply {
                text = "Saved connection could not be opened. No capture or upload started."
            })
            return
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val scroll = ScrollView(this).apply {
            addView(layout)
            if (Build.VERSION.SDK_INT >= 30) {
                setOnApplyWindowInsetsListener { view, insets ->
                    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                    insets
                }
            }
        }
        setContentView(scroll)
        fun label(text: String, size: Float = 16f) = TextView(this).apply {
            this.text = text
            textSize = size
            layout.addView(this)
        }
        label("Health Connect setup", 24f)
        label("Client ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        label("Approve the same HTTPS instance shown in your authenticated browser. " +
            "Choose Weight and Steps, set dates and grant read permissions before connecting. " +
            "The approved connection and queued pages are encrypted on this phone. " +
            "Choose Wi-Fi and optional background sync below.")
        originInput = EditText(this).apply {
            hint = "Approved instance URL"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            protectInput()
            layout.addView(this)
        }
        originInput.setText(session.destination ?: "")
        approved = label(session.destination?.let { "Connected destination: $it" }
            ?: "Approve an instance before entering a grant.")
        transport = session.destination?.let { PairingTransport(ApprovedOrigin.parse(it)) }
        fun action(text: String, block: () -> Unit) = Button(this).apply {
            this.text = text
            setOnClickListener { if (inForeground && !operations.active && !permissionPending) block() }
            layout.addView(this)
            buttons.add(this)
        }
        action("Approve this instance") {
            try {
                clear()
                session.approveDestination(originInput.text.toString())
                approved.text = "Approved destination: ${session.destination}"
                result.text = "Paste the single-use grant from this instance's browser."
            } catch (_: Exception) { refused("invalid-destination") }
        }
        grantInput = EditText(this).apply {
            hint = "Single-use browser grant JSON"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            protectInput()
            layout.addView(this)
        }
        action("Exchange approved grant") {
            run {
                val raw = grantInput.text.toString().toByteArray()
                try { session.prepareGrant(raw) } finally {
                    raw.fill(0)
                    grantInput.text.clear()
                }
                val attempt = session.beginExchange()
                val client = PairingTransport(ApprovedOrigin.parse(checkNotNull(session.destination)))
                transport = client
                try {
                    val response = withContext(Dispatchers.IO) {
                        client.request("POST", InMemoryPairingSession.EXCHANGE, attempt.body)
                    }
                    try {
                        currentCoroutineContext().ensureActive()
                        session.acceptPairing(attempt, response.body, response.status)
                        result.text = "Connected to ${session.destination}. Sync Weight or Steps when ready."
                        renderStreams()
                        reconcileBackground()
                    } finally { response.body.fill(0) }
                } finally { attempt.body.fill(0) }
            }
        }
        label("Select Weight and/or Steps.")
        val savedChoices = syncSettings.read()
        for ((type, caption) in listOf("WeightRecord" to "Weight", "StepsRecord" to "Steps")) {
            captureSelections[type] = CheckBox(this).apply {
                text = caption
                isChecked = type in savedChoices.selected
                layout.addView(this)
            }
        }
        wifiOnly = CheckBox(this).apply {
            text = "Upload over unmetered Wi-Fi only"
            isChecked = savedChoices.wifiOnly
            layout.addView(this)
        }
        backgroundSync = CheckBox(this).apply {
            text = "Allow background sync (roughly hourly when eligible)"
            isChecked = savedChoices.backgroundEnabled
            layout.addView(this)
        }
        val saveChoices = { _: android.widget.CompoundButton, _: Boolean -> saveSyncChoices() }
        captureSelections.values.forEach { it.setOnCheckedChangeListener(saveChoices) }
        wifiOnly.setOnCheckedChangeListener(saveChoices)
        backgroundSync.setOnCheckedChangeListener(saveChoices)
        action("Request selected read permissions") {
            val selected = savedCaptureSelection()
            if (selected.isEmpty()) {
                result.text = "Select Weight or Steps first."
            } else if (HealthConnectClient.getSdkStatus(this) != HealthConnectClient.SDK_AVAILABLE) {
                result.text = "Health Connect is unavailable. No permission or record request started."
            } else {
                cancelForeground()
                permissionPending = true
                val permissions = CategorySetup.requestedReadPermissions(selected) +
                    if (syncSettings.read().backgroundEnabled)
                        setOf("android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND") else emptySet()
                try { permissionLauncher.launch(permissions) }
                catch (_: Exception) { permissionPending = false; result.text = "Permission request could not start." }
            }
        }
        action("Set capture dates") {
            startActivity(Intent(this, app.klebb.companion.setup.SetupDatesActivity::class.java))
        }
        action("Sync now") {
            run {
                val selected = savedCaptureSelection()
                if (selected.isEmpty()) throw ProtocolException("scope-denied")
                val messages = OrdinarySyncRunner(this@PairingProofActivity).run { inForeground }
                currentCoroutineContext().ensureActive()
                result.text = messages.joinToString("\n")
            }
        }
        label("Sync starts at the saved import date at 00:00 UTC. " +
            "Queued pages remain encrypted offline and are removed after a confirmed upload or when you deselect that category. " +
            "Background opportunities may be delayed; an empty or partial page does not prove complete history.")
        action("Check connector capabilities") { check(null) }
        action("Clear pairing") {
            clear()
            result.text = "Pairing cleared. Approve an instance to begin again."
        }
        streamButtons = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layout.addView(this)
        }
        result = label("")
        renderStreams()
        reconcileBackground()
    }

    private fun savedCaptureSelection(): Set<String> {
        check(selectionSaveConfirmed) { "Selected categories are unconfirmed" }
        return syncSettings.read().selected
    }

    private fun saveSyncChoices() = ManualFirstPageCapture.underCommitFence {
        val previous = syncSettings.read().selected
        val selected = captureSelections.filterValues { it.isChecked }.keys.toSet()
        selectionSaveConfirmed = syncSettings.save(OrdinarySyncChoices(
            selected, wifiOnly.isChecked, backgroundSync.isChecked))
        if (!selectionSaveConfirmed) {
            cancelForeground()
            if (::result.isInitialized) result.text = "Settings were not saved. Sync is stopped until a confirmed save."
        } else {
            for (type in previous - selected) {
                if (type !in session.categories) continue
                try {
                    // Durable local fencing precedes waiting for the owned capture operation.
                    launchStop(session.stopCategory(type))
                } catch (_: Exception) {
                    selectionSaveConfirmed = false
                    if (::result.isInitialized) result.text =
                        "Sharing stop could not be saved. Sync is disabled; phone copies are retained."
                }
            }
            if ((selected - previous).any { session.localCategoryStop(it) != null } &&
                ::result.isInitialized) {
                result.text = "Sync now must confirm the stop and start a fresh scan before sharing again."
            }
        }
        reconcileBackground()
    }

    private fun launchStop(stop: LocalCategoryStopReceipt) {
        val type = stop.recordType
        if (stopJobs[type]?.isCompleted == false) return
        purgingCategories.add(type)
        captureSelections[type]?.isEnabled = false
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var purged = false
            var client: PairingTransport? = null
            try {
                val stopOperation = CategorySharingStop(this@PairingProofActivity, protocol, session)
                stopOperation.purgeLocal(stop)
                purged = true
                withContext(Dispatchers.Main) {
                    if (inForeground && ::result.isInitialized) result.text =
                        "$type: pending phone copies removed. Server history is retained."
                }
                if (session.isCurrentLocalStop(stop) && session.confirmedCategoryStop(stop) == null) {
                    client = PairingTransport(ApprovedOrigin.parse(
                        session.destination ?: throw ProtocolException("not-paired")))
                    val ownedClient = checkNotNull(client)
                    ManualFirstPageCapture.underCommitFence { stopTransports[type] = ownedClient }
                    withContext(Dispatchers.IO) {
                        ManualFirstPageCapture.underCaptureLock {
                            if (session.isCurrentLocalStop(stop)) {
                                stopOperation.confirmLocked(stop, ownedClient)
                            }
                        }
                    }
                    if (inForeground && ::result.isInitialized) result.text =
                        "$type: sharing stopped. Existing server history is retained."
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (inForeground && ::result.isInitialized) result.text = if (purged) {
                    "$type: pending phone copies removed; server stop is still unconfirmed."
                } else {
                    "$type: local stop is pending. Sync stays disabled and phone copies are retained."
                }
            } finally {
                client?.let { session.cancelTransportRequests(it) }
                withContext(NonCancellable + Dispatchers.Main) {
                    purgingCategories.remove(type)
                    stopTransports.remove(type)
                    stopJobs.remove(type)
                    // Also observable during teardown, after the owned local DB has closed.
                    captureSelections[type]?.isEnabled = !permissionPending
                    reconcileBackground()
                }
            }
        }
        stopJobs[type] = job
        job.start()
    }

    private fun resumeStops() {
        if (!::session.isInitialized || !::syncSettings.isInitialized) return
        val selected = syncSettings.read().selected
        for (type in session.categories.filter { it in captureSelections && it !in selected }) {
            try { launchStop(session.localCategoryStop(type) ?: session.stopCategory(type)) }
            catch (_: Exception) { selectionSaveConfirmed = false }
        }
        for (type in session.stoppedCategories()) {
            session.localCategoryStop(type)?.let { stop ->
                if (session.confirmedCategoryStop(stop) == null) launchStop(stop)
            }
        }
    }

    private fun updateCaptureControls() {
        captureSelections.forEach { (type, checkbox) ->
            checkbox.isEnabled = inForeground && !permissionPending && type !in purgingCategories
        }
    }

    private fun reconcileBackground() = ManualFirstPageCapture.underCommitFence {
        if (!::syncSettings.isInitialized || !::session.isInitialized) return@underCommitFence
        OrdinarySyncJobService.reconcile(this, syncSettings.read(),
            selectionSaveConfirmed && session.destination != null && session.categories.isNotEmpty())
    }

    private fun EditText.protectInput() {
        isSaveEnabled = false
        setSaveFromParentEnabled(false)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        imeOptions = imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    }
    private fun renderStreams() {
        streamButtons.removeAllViews()
        session.categories.filter { it in setOf("WeightRecord", "StepsRecord") }.forEach { recordType ->
            val name = recordType.removeSuffix("Record").replace(Regex("([a-z])([A-Z])"), "$1 $2")
            streamButtons.addView(Button(this).apply {
                text = "Check $name connection"
                setOnClickListener { if (inForeground && !operations.active) check(recordType) }
            })
        }
    }
    private fun check(recordType: String?) {
        run {
            val request = if (recordType == null) session.capabilityRequest() else session.statusRequest(recordType)
            activeRequest = request
            try {
                val client = PairingTransport(ApprovedOrigin.parse(
                    session.destination ?: throw ProtocolException("not-paired"))).also { transport = it }
                val response = withContext(Dispatchers.IO) {
                    client.request("GET", request.path, headers = request.headers)
                }
                try {
                    currentCoroutineContext().ensureActive()
                    session.acceptResult(request, response.body, response.status)
                    result.text = if (recordType == null) "Connector capabilities verified." else
                        "The approved category remains authorised."
                } finally { response.body.fill(0) }
            } finally {
                ManualFirstPageCapture.underCommitFence {
                    session.cancelOwnedRequest(request)
                    if (activeRequest === request) activeRequest = null
                }
            }
        }
    }
    private fun run(block: suspend () -> Unit) {
        if (!operations.start {
            try { block() }
            catch (cancelled: CancellationException) { cancelForeground(); throw cancelled }
            catch (failure: ProtocolException) { refused(failure.code) }
            catch (_: Exception) { refused("request-refused") }
            finally {
                buttons.forEach { it.isEnabled = inForeground && !permissionPending }
                updateCaptureControls()
                wifiOnly.isEnabled = inForeground && !permissionPending
                backgroundSync.isEnabled = inForeground && !permissionPending
            }
        }) return
        buttons.forEach { it.isEnabled = false }
        // Category deselection must remain available while a page or upload is in flight.
        updateCaptureControls()
        wifiOnly.isEnabled = false
        backgroundSync.isEnabled = false
    }
    private fun refused(code: String) {
        if (code in setOf("revoked", "unauthorised")) clear() else cancelForeground()
        result.text = when (code) {
            "expired-grant" -> "The grant expired. Create a fresh grant in the approved browser."
            "revoked", "unauthorised" -> "The browser refused this connection. Pairing cleared."
            "invalid-destination", "redirect-refused" -> "The destination was refused. Verify the approved instance."
            else -> "The request could not be confirmed. Queued pages and the saved connection are retained."
        }
    }
    private fun cancelForeground() = ManualFirstPageCapture.underCommitFence {
        transport?.cancel()
        if (::session.isInitialized) activeRequest?.let { session.cancelOwnedRequest(it) }
        activeRequest = null
        if (::grantInput.isInitialized) grantInput.text.clear()
    }

    private fun clear() = ManualFirstPageCapture.underCommitFence {
        stopTransports.values.toList().forEach { it.cancel() }
        stopJobs.values.toList().forEach { it.cancel() }
        cancelForeground()
        transport = null
        if (::session.isInitialized) pairingStore.forget(session)
        reconcileBackground()
        if (::streamButtons.isInitialized) streamButtons.removeAllViews()
        if (::approved.isInitialized) approved.text = "Approve an instance to begin."
    }
    override fun onResume() {
        super.onResume()
        ManualFirstPageCapture.underCommitFence {
            inForeground = true
            if (::session.isInitialized) {
                transport?.cancel()
                transport = session.destination?.let { PairingTransport(ApprovedOrigin.parse(it)) }
            }
        }
        operations.resume()
        buttons.forEach { it.isEnabled = !operations.active && !permissionPending }
        updateCaptureControls()
        if (::wifiOnly.isInitialized) wifiOnly.isEnabled = !operations.active && !permissionPending
        if (::backgroundSync.isInitialized) backgroundSync.isEnabled = !operations.active && !permissionPending
        ManualFirstPageCapture.underCommitFence { resumeStops() }
    }
    override fun onPause() {
        ManualFirstPageCapture.underCommitFence {
            inForeground = false
            cancelForeground()
        }
        operations.pause()
        if (::result.isInitialized) result.text = "Foreground sync paused; saved connection and queued pages retained."
        super.onPause()
    }
    override fun onDestroy() {
        cancelForeground()
        ManualFirstPageCapture.underCommitFence {
            stopTransports.values.toList().forEach { it.cancel() }
        }
        scope.cancel()
        super.onDestroy()
    }
}
