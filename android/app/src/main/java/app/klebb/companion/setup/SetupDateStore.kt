// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.StrictJson
import java.time.LocalDate

internal data class SetupDates(val historyImportDate: String, val displaySwitchDate: String)

internal sealed class SetupDateRead {
    object Unset : SetupDateRead()
    object Invalid : SetupDateRead()
    object Unavailable : SetupDateRead()
    data class Stored(val dates: SetupDates) : SetupDateRead()
}

internal enum class SetupDateSave { SAVED, INVALID, UNCONFIRMED }

/** One complete nonsecret setup value; never collection or server policy authority. */
internal class SetupDateStore(
    private val readValue: () -> String?,
    private val commitValue: (String) -> Boolean
) {
    fun read(): SetupDateRead {
        val raw = try { readValue() } catch (_: Exception) { return SetupDateRead.Unavailable }
            ?: return SetupDateRead.Unset
        if (raw.length > 256) return SetupDateRead.Invalid
        return try {
            val fields = StrictJson.parse(raw.toByteArray(Charsets.UTF_8),
                StrictJson.Limits(bytes = 256, depth = 2, nodes = 16)) as? Map<*, *>
                ?: return SetupDateRead.Invalid
            if (fields.keys != setOf("version", "historyImportDate", "displaySwitchDate") ||
                fields["version"] != 1L) return SetupDateRead.Invalid
            val history = fields["historyImportDate"] as? String
            val display = fields["displaySwitchDate"] as? String
            if (!canonicalDate(history) || !canonicalDate(display)) return SetupDateRead.Invalid
            SetupDateRead.Stored(SetupDates(checkNotNull(history), checkNotNull(display)))
        } catch (_: Exception) { SetupDateRead.Invalid }
    }

    fun save(historyImportDate: String?, displaySwitchDate: String?): SetupDateSave {
        if (!canonicalDate(historyImportDate) || !canonicalDate(displaySwitchDate)) {
            return SetupDateSave.INVALID
        }
        // There is intentionally no ordering constraint between these independent choices.
        val value = ControlJson.text(linkedMapOf(
            "version" to 1L,
            "historyImportDate" to historyImportDate,
            "displaySwitchDate" to displaySwitchDate
        ))
        return try {
            if (commitValue(value)) SetupDateSave.SAVED else SetupDateSave.UNCONFIRMED
        } catch (_: Exception) { SetupDateSave.UNCONFIRMED }
    }

    private fun canonicalDate(value: String?): Boolean {
        if (value == null || !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(value)) return false
        return try { LocalDate.parse(value).toString() == value } catch (_: Exception) { false }
    }
}
