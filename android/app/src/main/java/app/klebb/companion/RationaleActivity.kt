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
            text = "Klebb Health Connect privacy\n\n" +
                "You can select Weight, Steps, or both. Sync requires their Health Connect " +
                "read permissions and a paired Klebb HTTPS instance that you explicitly approve. " +
                "The initial history scan starts at your saved import date at 00:00 UTC. " +
                "Subsequent sync can read changes for the selected categories. Older history " +
                "depends on separate Health Connect history access; this does not guarantee " +
                "that all history is available.\n\n" +
                "Use Sync now for foreground capture. Background sync is off unless you enable " +
                "it, and runs only when the required permissions, platform support, connection " +
                "and saved settings remain valid. Granting permissions alone does not enable it. " +
                "Android may delay background work.\n\n" +
                "Captured pages are saved in an encrypted queue on this phone and uploaded " +
                "only to your approved Klebb instance. Offline or unconfirmed uploads leave " +
                "pending pages in the queue. A matching durable acknowledgement allows their " +
                "queued payloads to be removed.\n\n" +
                "Deselecting a category stops its local capture and upload and attempts to " +
                "remove its pending phone payloads. If the stop or removal cannot be confirmed, " +
                "sync stays stopped and copies may remain. A small non-payload record of the " +
                "stop may remain. Stopping sharing does not delete history already committed " +
                "to the approved instance.\n\n" +
                "You can revoke read access in Health Connect at any time. Klebb does not " +
                "write health records to Health Connect."
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
