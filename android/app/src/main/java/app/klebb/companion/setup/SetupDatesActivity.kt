// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import android.os.Build
import android.os.Bundle
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

/** Date choices only. No permission, pairing credential, provider or upload operations. */
class SetupDatesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = PreferenceSetupDates.open(this)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val scroll = ScrollView(this).apply {
            addView(layout)
            if (Build.VERSION.SDK_INT >= 30) {
                setOnApplyWindowInsetsListener { view, insets ->
                    val bars = insets.getInsets(WindowInsets.Type.systemBars() or
                        WindowInsets.Type.displayCutout())
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                    insets
                }
            }
        }
        setContentView(scroll)
        fun label(text: String) = TextView(this).apply {
            this.text = text
            textSize = 16f
            layout.addView(this)
        }
        label("Capture dates").textSize = 24f
        label("Choose each date separately in YYYY-MM-DD format. The import date controls " +
            "how far back to collect. The display switch chooses when Health Connect " +
            "takes over from iPhone history. Saving these choices does not start an import " +
            "or change your dashboard yet.")
        fun field(caption: String, name: String): EditText {
            val heading = label(caption)
            return EditText(this).apply {
                id = View.generateViewId()
                heading.labelFor = id
                tag = name
                hint = "YYYY-MM-DD"
                inputType = InputType.TYPE_CLASS_TEXT
                isSingleLine = true
                isSaveEnabled = false
                setSaveFromParentEnabled(false)
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                imeOptions = imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                layout.addView(this)
            }
        }
        val history = field("Historical import start date", "historyImportDate")
        val display = field("iPhone / Health Connect display switch date", "displaySwitchDate")
        val status = label("").apply { tag = "dateStatus" }
        when (val stored = store.read()) {
            is SetupDateRead.Stored -> {
                history.setText(stored.dates.historyImportDate)
                display.setText(stored.dates.displaySwitchDate)
                status.text = "Date choices loaded."
            }
            SetupDateRead.Unset -> status.text = "Choose both dates."
            SetupDateRead.Invalid -> status.text = "The stored choices could not be used. Choose both dates again."
            SetupDateRead.Unavailable -> status.text = "Could not load date choices. Try again later."
        }
        layout.addView(Button(this).apply {
            text = "Save dates"
            tag = "saveDates"
            setOnClickListener {
                status.text = when (store.save(history.text.toString(), display.text.toString())) {
                    SetupDateSave.SAVED -> "Date choices saved on this phone."
                    SetupDateSave.INVALID -> "Enter two valid dates in YYYY-MM-DD format."
                    SetupDateSave.UNCONFIRMED -> "The save could not be confirmed. Retry before continuing."
                }
            }
        })
        layout.addView(Button(this).apply {
            text = "Cancel"
            tag = "cancelDates"
            setOnClickListener { finish() }
        })
    }
}
