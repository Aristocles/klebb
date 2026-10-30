// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

/** Caller-selected route sharing bound to one record; never proof of native consent. */
sealed class ExerciseRoutePayloadAuthority {
    object DENY : ExerciseRoutePayloadAuthority()
    class ForRecord(
        val nativeRecordId: String,
        val dataOriginPackageName: String
    ) : ExerciseRoutePayloadAuthority()

    final override fun toString(): String = "ExerciseRoutePayloadAuthority(redacted)"
}

enum class ExerciseRouteRefusalReason {
    AUTHORITY_REQUIRED,
    AUTHORITY_MISMATCH,
    UNKNOWN_RESULT
}

/** Whole-record refusal; bounded reason only, with no record or location attached. */
class ExerciseRouteRefused(val reason: ExerciseRouteRefusalReason) :
    RuntimeException(reason.name) {
    override fun toString(): String = "ExerciseRouteRefused(${reason.name})"
}
