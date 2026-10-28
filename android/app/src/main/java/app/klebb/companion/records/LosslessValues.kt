// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import java.time.Instant
import java.time.ZoneOffset
import java.math.BigDecimal

class RecordCodecException(val code: String) : RuntimeException(code)

object LosslessValues {
    fun int64(value: Long): String = value.toString()

    fun float64(value: Double): String {
        if (!value.isFinite()) throw RecordCodecException("unsupported-value")
        return decimal(value.toString())
    }

    fun float32(value: Float): String {
        if (!value.isFinite()) throw RecordCodecException("unsupported-value")
        return decimal(value.toString())
    }

    private fun decimal(shortest: String): String {
        // Zero's sign is observable; Float.toString must precede any promotion.
        if (shortest == "-0.0" || shortest == "0.0") return shortest
        val decimal = BigDecimal(shortest).stripTrailingZeros()
        val exponent = decimal.precision() - decimal.scale() - 1
        // Ordinary magnitudes use plain decimal, removing only redundant .0.
        // Tiny/large magnitudes retain the native shortest exponent spelling.
        return if (exponent in -6..20) decimal.toPlainString() else shortest
    }

    fun instant(value: Instant): String {
        val text = value.toString()
        if (!text.matches(Regex("[0-9]{4}-.*"))) throw RecordCodecException("unsupported-value")
        return text
    }

    fun offset(value: ZoneOffset?): String? = value?.id
}
