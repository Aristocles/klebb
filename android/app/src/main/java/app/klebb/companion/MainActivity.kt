// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.feature.ExperimentalPersonalHealthRecordApi
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

class MainActivity : ComponentActivity() {
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val foregroundOperations = ForegroundOperations(uiScope)
    private lateinit var contentLayout: LinearLayout
    private lateinit var runtime: TextView
    private lateinit var results: TextView
    private lateinit var startInput: EditText
    private lateinit var endInput: EditText
    private val categories = linkedMapOf<ProofCategory, CheckBox>()
    private val buttons = mutableListOf<Button>()
    private var busy = false
    private var permissionPending = false
    private var inForeground = false
    private var runtimeReport = "Runtime check pending."

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) {
        permissionPending = false
        operation { refreshRuntime() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        contentLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val scroll = ScrollView(this).apply { addView(contentLayout) }
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(scroll)
        label("Klebb Health Connect feasibility", 24f)
        label("Use invented records written by Google's Health Connect Toolbox. " +
            "This APK filters reads to that controlled producer and has no Cloud connection. " +
            "It reads only selected categories in the interval below, at most two hours. " +
            "Read results stay in memory. A producer must separately be allowed to write " +
            "to Health Connect. This is a platform proof, not the sync companion.")
        runtime = label("Checking runtime…")
        ProofCategory.entries.forEach { category ->
            categories[category] = CheckBox(this).apply {
                text = when (category) {
                    ProofCategory.STEPS -> "Steps"
                    ProofCategory.WEIGHT -> "Weight"
                }
                isChecked = category == ProofCategory.STEPS
                setOnCheckedChangeListener { _, _ -> results.text = "" }
                contentLayout.addView(this)
            }
        }
        action("Request selected read permissions") {
            operation {
                val selected = ProofPolicy.permissionsFor(selectedCategories())
                require(selected.isNotEmpty()) { "Select steps or weight first." }
                client()
                launchPermissionRequest(selected)
            }
        }
        val end = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        label("Controlled interval in UTC (ISO 8601, ending Z)")
        startInput = input("Start UTC", end.minusSeconds(900).toString())
        endInput = input("End UTC", end.toString())
        action("Read controlled interval") { operation { readControlledInterval() } }
        action("Refresh runtime and grants") { operation { refreshRuntime() } }
        action("Check optional history permission") {
            requestOptional(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
                HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
        }
        action("Check optional background permission") {
            requestOptional(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
                HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        }
        label("The optional buttons test separate grants only; they do not start " +
            "background reads or a historical import. Routes require foreground consent. " +
            "Routes and medical ingestion are pending separate implementation.")
        action("Copy runtime evidence (excludes readings)") {
            getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("Klebb runtime evidence", runtimeReport))
        }
        action("Read privacy rationale") {
            startActivity(Intent(this, RationaleActivity::class.java))
        }
        results = label("")
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
        foregroundOperations.resume()
        if (::results.isInitialized && !permissionPending) operation { refreshRuntime() }
    }

    override fun onStop() {
        inForeground = false
        foregroundOperations.pause()
        super.onStop()
        if (::results.isInitialized) results.text = ""
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }

    private fun label(value: String, size: Float = 16f) = TextView(this).apply {
        text = value
        textSize = size
        setPadding(0, 12, 0, 12)
        contentLayout.addView(this)
    }

    private fun input(description: String, value: String) = EditText(this).apply {
        hint = description
        contentDescription = description
        setText(value)
        isSingleLine = true
        contentLayout.addView(this)
    }

    private fun action(title: String, run: () -> Unit) {
        Button(this).apply {
            text = title
            setOnClickListener { run() }
            buttons.add(this)
            contentLayout.addView(this)
        }
    }

    private fun selectedCategories() = categories.filterValues { it.isChecked }.keys.toSet()

    private fun operation(run: suspend () -> Unit) {
        if (!inForeground || busy || permissionPending) return
        busy = true
        updateButtons()
        val started = foregroundOperations.start {
            try {
                run()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: IllegalArgumentException) {
                if (inForeground) results.text = "Check the selected categories and UTC interval. " +
                    "The start must precede the end by at most two hours; end cannot be future."
            } catch (error: Exception) {
                // Provider messages can contain payloads. Keep evidence and UI payload-free.
                if (inForeground) results.text = "Experiment failed: ${error.javaClass.simpleName}. " +
                    "Refresh grants and record this result; native access is still pending."
            } finally {
                busy = false
                updateButtons()
            }
        }
        if (!started) {
            busy = false
            updateButtons()
        }
    }

    private fun updateButtons() {
        val editable = !busy && !permissionPending
        buttons.forEach { it.isEnabled = editable }
        categories.values.forEach { it.isEnabled = editable }
        if (::startInput.isInitialized) startInput.isEnabled = editable
        if (::endInput.isInitialized) endInput.isEnabled = editable
    }

    private suspend fun requireForeground() {
        currentCoroutineContext().ensureActive()
        if (!inForeground) throw CancellationException("Foreground experiment stopped")
    }

    private fun launchPermissionRequest(permissions: Set<String>) {
        permissionPending = true
        try {
            permissionLauncher.launch(permissions)
        } catch (error: Exception) {
            permissionPending = false
            throw error
        }
    }

    private fun client(): HealthConnectClient {
        check(HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) {
            "Health Connect unavailable"
        }
        return HealthConnectClient.getOrCreate(this)
    }

    private fun requestOptional(feature: Int, permission: String) = operation {
        val native = client()
        if (native.features.getFeatureStatus(feature) !=
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE) {
            results.text = "Optional feature unavailable on the observed provider. " +
                "No permission requested."
        } else {
            launchPermissionRequest(setOf(permission))
        }
    }

    private fun installationMarker(): String {
        val preferences = getSharedPreferences("feasibility-installation", MODE_PRIVATE)
        val existing = preferences.getString("marker", null)
        if (existing != null) return existing
        val marker = UUID.randomUUID().toString()
        check(preferences.edit().putString("marker", marker).commit())
        return marker
    }

    @OptIn(ExperimentalPersonalHealthRecordApi::class)
    private suspend fun refreshRuntime() {
        val status = HealthConnectClient.getSdkStatus(this)
        val native = if (status == HealthConnectClient.SDK_AVAILABLE) client() else null
        val grants = native?.permissionController?.getGrantedPermissions().orEmpty()
        requireForeground()
        val features = linkedMapOf(
            "background" to HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
            "extended history" to HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
            "activity intensity" to HealthConnectFeatures.FEATURE_ACTIVITY_INTENSITY,
            "exercise improvements" to HealthConnectFeatures.FEATURE_EXERCISE_SESSION_IMPROVEMENTS,
            "medical" to HealthConnectFeatures.FEATURE_PERSONAL_HEALTH_RECORD
        )
        val providerPackages = listOf(
            "com.google.android.apps.healthdata",
            "com.google.android.healthconnect.controller",
            "com.android.healthconnect.controller"
        )
        runtimeReport = buildString {
            appendLine("Package: ${BuildConfig.APPLICATION_ID}")
            appendLine("Application: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            appendLine("Compiled Health Connect SDK: ${BuildConfig.HEALTH_CONNECT_SDK}")
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("Android: ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
            appendLine("Build: ${Build.DISPLAY}; patch: ${Build.VERSION.SECURITY_PATCH}")
            appendLine("Update marker: ${installationMarker()}")
            appendLine("Health Connect status: " + when (status) {
                HealthConnectClient.SDK_AVAILABLE -> "available"
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "provider update required"
                else -> "unavailable"
            })
            providerPackages.forEach { name ->
                val version = try {
                    @Suppress("DEPRECATION")
                    packageManager.getPackageInfo(name, 0).versionName ?: "unknown"
                } catch (missing: android.content.pm.PackageManager.NameNotFoundException) {
                    "not visible/installed"
                }
                appendLine("Provider $name: $version")
            }
            appendLine("Granted: ${grants.sorted().joinToString().ifEmpty { "none" }}")
            features.forEach { (name, feature) ->
                val available = native?.features?.getFeatureStatus(feature)
                appendLine("$name: " + when (available) {
                    HealthConnectFeatures.FEATURE_STATUS_AVAILABLE -> "available"
                    HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE -> "unavailable"
                    else -> "not observed"
                })
            }
            appendLine("Routes: compiled consent API; device consent/read still pending")
            appendLine("One UI and watch/provider versions: record separately on device")
        }
        runtime.text = runtimeReport
    }

    private suspend fun readControlledInterval() {
        results.text = ""
        val start = Instant.parse(startInput.text.toString().trim())
        val end = Instant.parse(endInput.text.toString().trim())
        ProofPolicy.validateWindow(start, end, Instant.now())
        val native = client()
        val selected = selectedCategories()
        val readable = ProofPolicy.readableCategories(
            selected, native.permissionController.getGrantedPermissions()
        )
        requireForeground()
        if (readable.isEmpty()) {
            results.text = "No selected category has read permission. No record API called."
            return
        }
        val observations = StringBuilder("Controlled read [$start, $end)\n")
        observations.appendLine("Denied/unselected categories are not read.")
        for (category in readable) {
            // Recheck immediately before each call, including partially granted selections.
            if (category.readPermission !in native.permissionController.getGrantedPermissions()) {
                observations.appendLine("$category: permission revoked; not read")
                continue
            }
            requireForeground()
            val filter = TimeRangeFilter.between(start, end)
            when (category) {
                ProofCategory.STEPS -> {
                    val page = native.readRecords(ReadRecordsRequest(
                        StepsRecord::class, filter,
                        dataOriginFilter = setOf(DataOrigin("androidx.health.connect.client.devtool")),
                        pageSize = 100
                    ))
                    requireForeground()
                    observations.appendLine("Steps: ${page.records.size} records")
                    page.records.forEach { record ->
                        observations.appendLine("${record.startTime} to ${record.endTime}: " +
                            "${record.count} steps; producer ${record.metadata.dataOrigin.packageName}")
                    }
                    if (page.pageToken != null) observations.appendLine(
                        "Additional pages exist: incomplete bounded proof, not a full scan."
                    )
                }
                ProofCategory.WEIGHT -> {
                    val page = native.readRecords(ReadRecordsRequest(
                        WeightRecord::class, filter,
                        dataOriginFilter = setOf(DataOrigin("androidx.health.connect.client.devtool")),
                        pageSize = 100
                    ))
                    requireForeground()
                    observations.appendLine("Weight: ${page.records.size} records")
                    page.records.forEach { record ->
                        observations.appendLine("${record.time}: ${record.weight.inKilograms} kg; " +
                            "producer ${record.metadata.dataOrigin.packageName}")
                    }
                    if (page.pageToken != null) observations.appendLine(
                        "Additional pages exist: incomplete bounded proof, not a full scan."
                    )
                }
            }
        }
        requireForeground()
        results.text = observations.toString()
        refreshRuntime()
    }
}
