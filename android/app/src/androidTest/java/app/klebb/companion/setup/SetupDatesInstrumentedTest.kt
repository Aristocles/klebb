// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import android.content.Context
import android.content.Intent
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Invented date choices only. This is not a provider, phone-support or process-death proof. */
@RunWith(AndroidJUnit4::class)
class SetupDatesInstrumentedTest {
    @Test fun DATES_NATIVE01_actualPrivatePreferenceCommitAndPhysicalFile() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "invented-date-test-${UUID.randomUUID()}"
        val xml = File(context.applicationInfo.dataDir, "shared_prefs/$name.xml")
        assertFalse(xml.exists())
        try {
            val preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
            assertTrue(preferences.all.isEmpty())
            val store = PreferenceSetupDates.from(preferences)
            assertSame(SetupDateRead.Unset, store.read())
            assertEquals(SetupDateSave.SAVED, store.save("2040-02-29", "2040-03-01"))
            assertEquals(setOf("complete-value"), preferences.all.keys)
            assertEquals("""{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-01"}""",
                preferences.getString("complete-value", null))
            assertTrue(xml.isFile)
            val physical = xml.readText(Charsets.UTF_8)
            assertTrue(physical.contains("2040-02-29"))
            assertTrue(physical.contains("2040-03-01"))
            assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-01")),
                PreferenceSetupDates.from(context.getSharedPreferences(name, Context.MODE_PRIVATE)).read())
        } finally {
            assertTrue(context.deleteSharedPreferences(name))
        }
    }

    @Test fun DATES_NATIVE02_realScreenSaveReopenAndCancelPreserveConfirmedDates() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val xml = File(context.applicationInfo.dataDir, "shared_prefs/capture-date-choices.xml")
        // Refuse an existing user's choices. Root must use a fresh controlled test instance.
        assertFalse("A fresh controlled app-data directory is required", xml.exists())
        assertTrue(context.getSharedPreferences(PreferenceSetupDates.FILE, Context.MODE_PRIVATE).all.isEmpty())
        var activity: SetupDatesActivity? = null
        fun open(): SetupDatesActivity = instrumentation.startActivitySync(
            Intent(context, SetupDatesActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as SetupDatesActivity
        fun close() {
            activity?.let { target -> instrumentation.runOnMainSync { target.finish() } }
            instrumentation.waitForIdleSync()
            activity = null
        }
        try {
            activity = open()
            instrumentation.runOnMainSync {
                val target = checkNotNull(activity)
                val history = target.findViewById<android.view.View>(android.R.id.content)
                    .findViewWithTag<EditText>("historyImportDate")
                val display = target.findViewById<android.view.View>(android.R.id.content)
                    .findViewWithTag<EditText>("displaySwitchDate")
                assertEquals("", history.text.toString())
                assertEquals("", display.text.toString())
                // Preserve an overlong paste so Save, rather than truncation, decides validity.
                history.setText("2040-02-29T00:00:00Z")
                display.setText("2040-03-01")
                assertEquals("2040-02-29T00:00:00Z", history.text.toString())
                target.findViewById<android.view.View>(android.R.id.content)
                    .findViewWithTag<Button>("saveDates").performClick()
                assertEquals("Enter two valid dates in YYYY-MM-DD format.",
                    target.findViewById<android.view.View>(android.R.id.content)
                        .findViewWithTag<TextView>("dateStatus").text.toString())
                assertFalse(xml.exists())
                history.setText("2040-02-29")
                display.setText("2040-03-01")
                target.findViewById<android.view.View>(android.R.id.content)
                    .findViewWithTag<Button>("saveDates").performClick()
                assertEquals("Date choices saved on this phone.", target.findViewById<android.view.View>(android.R.id.content)
                    .findViewWithTag<TextView>("dateStatus").text.toString())
            }
            close()
            assertTrue(xml.isFile)
            activity = open()
            instrumentation.runOnMainSync {
                val root = checkNotNull(activity).findViewById<android.view.View>(android.R.id.content)
                assertEquals("2040-02-29", root.findViewWithTag<EditText>("historyImportDate").text.toString())
                assertEquals("2040-03-01", root.findViewWithTag<EditText>("displaySwitchDate").text.toString())
                root.findViewWithTag<EditText>("historyImportDate").setText("2040-03-11")
                root.findViewWithTag<EditText>("displaySwitchDate").setText("2040-03-12")
                root.findViewWithTag<Button>("cancelDates").performClick()
            }
            close()
            activity = open()
            instrumentation.runOnMainSync {
                val root = checkNotNull(activity).findViewById<android.view.View>(android.R.id.content)
                assertEquals("2040-02-29", root.findViewWithTag<EditText>("historyImportDate").text.toString())
                assertEquals("2040-03-01", root.findViewWithTag<EditText>("displaySwitchDate").text.toString())
            }
        } finally {
            close()
            assertTrue(context.deleteSharedPreferences(PreferenceSetupDates.FILE))
        }
    }
}
