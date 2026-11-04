// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.annotation.SuppressLint
import android.content.Context
import java.util.Collections

internal data class OrdinarySyncChoices(
    val selected: Set<String>,
    val wifiOnly: Boolean,
    val backgroundEnabled: Boolean
)

/** Nonsecret explicit choices only; these never establish provider or server authority. */
internal class OrdinarySyncSettings(context: Context) {
    private val application = context.applicationContext
    private val preferences by lazy {
        application.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    }

    fun read(): OrdinarySyncChoices = synchronized(storeLock) {
        if (!writeConfirmed) return@synchronized defaults()
        try {
            // One snapshot avoids joining flags from different complete saves.
            val stored = preferences.all
            if (stored.keys.any { it !in keys } || stored.values.any { it !is Boolean }) {
                return@synchronized defaults()
            }
            val selected = supported.filterTo(linkedSetOf()) { stored[it] == true }
            OrdinarySyncChoices(
                Collections.unmodifiableSet(selected),
                stored[WIFI_ONLY] as? Boolean ?: true,
                stored[BACKGROUND_ENABLED] as? Boolean ?: false
            )
        } catch (_: Exception) {
            defaults()
        }
    }

    @SuppressLint("ApplySharedPref") // Success must reflect the actual synchronous disk write.
    fun save(choices: OrdinarySyncChoices): Boolean = ManualFirstPageCapture.underCommitFence {
        synchronized(storeLock) {
            val selected = try { choices.selected.toSet() } catch (_: Exception) {
                return@synchronized false
            }
            if (!supported.containsAll(selected)) return@synchronized false
            val confirmed = try {
                // Replace only this dedicated file, including malformed previous choice values.
                preferences.edit().clear()
                    .putBoolean("WeightRecord", "WeightRecord" in selected)
                    .putBoolean("StepsRecord", "StepsRecord" in selected)
                    .putBoolean(WIFI_ONLY, choices.wifiOnly)
                    .putBoolean(BACKGROUND_ENABLED, choices.backgroundEnabled)
                    .commit()
            } catch (_: Exception) {
                false
            }
            // A failed commit can still mutate SharedPreferences' in-memory cache.
            // Every instance refuses that cache until a complete save is confirmed.
            writeConfirmed = confirmed
            confirmed
        }
    }

    companion object {
        const val FILE = "ordinary-capture-choices"
        private const val WIFI_ONLY = "wifi-only"
        private const val BACKGROUND_ENABLED = "background-enabled"
        private val supported = setOf("WeightRecord", "StepsRecord")
        private val keys = supported + setOf(WIFI_ONLY, BACKGROUND_ENABLED)
        private val storeLock = Any()
        private var writeConfirmed = true

        private fun defaults() = OrdinarySyncChoices(emptySet(), true, false)
    }
}
