// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import android.os.Bundle
import android.os.Build
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext

class PairingProofActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val operations = ForegroundOperations(scope)
    private lateinit var session: InMemoryPairingSession
    private lateinit var originInput: EditText
    private lateinit var grantInput: EditText
    private lateinit var approved: TextView
    private lateinit var result: TextView
    private lateinit var streamButtons: LinearLayout
    private val buttons = mutableListOf<Button>()
    private var transport: PairingTransport? = null
    private var inForeground = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = InMemoryPairingSession(HealthProtocol(
            assets.open("protocol-v1.schema.json").use { it.readBytes() }
        ))
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
        label("Klebb pairing proof", 24f)
        label("Client ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}), protocol 1")
        label("Approve the same HTTPS instance shown in your authenticated browser. " +
            "This screen verifies a temporary connection. Keep it open while checking. " +
            "Leaving clears the connection; health records stay on the phone.")
        originInput = EditText(this).apply {
            hint = "Approved instance URL"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            protectInput()
            layout.addView(this)
        }
        approved = label("Approve an instance before entering a grant.")
        fun action(text: String, block: () -> Unit) = Button(this).apply {
            this.text = text
            setOnClickListener { if (inForeground && !operations.active) block() }
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
                        result.text = "Connected to ${session.destination}. Check capabilities or an approved category."
                        renderStreams()
                    } finally { response.body.fill(0) }
                } finally { attempt.body.fill(0) }
            }
        }
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
    }

    private fun EditText.protectInput() {
        isSaveEnabled = false
        setSaveFromParentEnabled(false)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        imeOptions = imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    }
    private fun renderStreams() {
        streamButtons.removeAllViews()
        session.categories.forEach { recordType ->
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
            val client = transport ?: throw ProtocolException("not-paired")
            val response = withContext(Dispatchers.IO) { client.request("GET", request.path, headers = request.headers) }
            try {
                currentCoroutineContext().ensureActive()
                session.acceptResult(request, response.body, response.status)
                result.text = if (recordType == null) "Connector capabilities verified." else
                    "The approved category remains authorised."
            } finally { response.body.fill(0) }
        }
    }
    private fun run(block: suspend () -> Unit) {
        if (!operations.start {
            try { block() }
            catch (cancelled: CancellationException) { clear(); throw cancelled }
            catch (failure: ProtocolException) { refused(failure.code) }
            catch (_: Exception) { refused("request-refused") }
            finally { buttons.forEach { it.isEnabled = inForeground } }
        }) return
        buttons.forEach { it.isEnabled = false }
    }
    private fun refused(code: String) {
        clear()
        result.text = when (code) {
            "expired-grant" -> "The grant expired. Create a fresh grant in the approved browser."
            "revoked", "unauthorised" -> "The browser refused this connection. Pairing cleared."
            "invalid-destination", "redirect-refused" -> "The destination was refused. Verify the approved instance."
            else -> "The request was refused. Pairing cleared."
        }
    }
    private fun clear() {
        transport?.cancel()
        transport = null
        session.clear()
        if (::grantInput.isInitialized) grantInput.text.clear()
        if (::streamButtons.isInitialized) streamButtons.removeAllViews()
        if (::approved.isInitialized) approved.text = "Approve an instance to begin."
    }
    override fun onResume() {
        super.onResume()
        inForeground = true
        operations.resume()
        buttons.forEach { it.isEnabled = !operations.active }
    }
    override fun onPause() {
        inForeground = false
        clear()
        operations.pause()
        if (::result.isInitialized) result.text = "Pairing cleared when this screen closed."
        super.onPause()
    }
    override fun onDestroy() {
        clear()
        scope.cancel()
        super.onDestroy()
    }
}
