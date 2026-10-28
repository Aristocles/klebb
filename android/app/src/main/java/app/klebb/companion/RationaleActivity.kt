// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.widget.ScrollView
import android.widget.TextView

class RationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val rationale = TextView(this).apply {
            text = "Klebb feasibility privacy\n\n" +
                "This test APK reads only selected steps and weight written by Google's " +
                "Health Connect Toolbox, in an explicit interval " +
                "of at most two hours. Use invented controlled records. Results stay on this " +
                "screen in memory and are cleared when the app closes. No health records " +
                "are uploaded or saved by this APK. It has no network or health write permission.\n\n" +
                "History and background grants are separate optional capability checks. " +
                "They do not start background collection. Revoke access in Health Connect " +
                "at any time. Other categories, routes and medical capture are not implemented " +
                "in this feasibility package."
            setPadding(32, 48, 32, 32)
            textSize = 18f
        }
        val scroll = ScrollView(this).apply { addView(rationale) }
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
    }
}
