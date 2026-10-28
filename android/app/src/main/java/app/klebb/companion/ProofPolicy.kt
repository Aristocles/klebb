// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import java.time.Duration
import java.time.Instant

enum class ProofCategory(val readPermission: String) {
    STEPS("android.permission.health.READ_STEPS"),
    WEIGHT("android.permission.health.READ_WEIGHT")
}

object ProofPolicy {
    fun permissionsFor(selected: Set<ProofCategory>): Set<String> =
        selected.mapTo(linkedSetOf()) { it.readPermission }

    fun readableCategories(selected: Set<ProofCategory>, grantedPermissions: Set<String>):
        Set<ProofCategory> = selected.filterTo(linkedSetOf()) {
            it.readPermission in grantedPermissions
        }

    fun validateWindow(start: Instant, end: Instant, now: Instant) {
        require(end.isAfter(start)) { "The end must follow the start." }
        require(!end.isAfter(now)) { "The end cannot be in the future." }
        require(Duration.between(start, end) <= Duration.ofHours(2)) {
            "Controlled reads cover at most two hours."
        }
    }
}
