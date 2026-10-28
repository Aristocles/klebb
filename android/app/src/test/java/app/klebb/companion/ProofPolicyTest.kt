// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProofPolicyTest {
    private val start = Instant.parse("2026-10-28T01:00:00Z")
    private val now = Instant.parse("2026-10-28T03:00:00Z")

    @Test
    fun stepsSelectionRequestsOnlyStepsReadAccess() {
        assertEquals(
            setOf("android.permission.health.READ_STEPS"),
            ProofPolicy.permissionsFor(setOf(ProofCategory.STEPS))
        )
    }

    @Test
    fun bothSelectionsRequestOnlyTheirOrdinaryReadAccess() {
        assertEquals(
            setOf(
                "android.permission.health.READ_STEPS",
                "android.permission.health.READ_WEIGHT"
            ),
            ProofPolicy.permissionsFor(setOf(ProofCategory.STEPS, ProofCategory.WEIGHT))
        )
    }

    @Test
    fun noSelectionsRequestNoAccess() {
        assertEquals(emptySet<String>(), ProofPolicy.permissionsFor(emptySet()))
    }

    @Test
    fun partialGrantReadsOnlyTheGrantedSelectedCategory() {
        assertEquals(
            setOf(ProofCategory.WEIGHT),
            ProofPolicy.readableCategories(
                setOf(ProofCategory.STEPS, ProofCategory.WEIGHT),
                setOf("android.permission.health.READ_WEIGHT")
            )
        )
    }

    @Test
    fun previouslyGrantedUnselectedCategoryDoesNotBecomeReadable() {
        assertEquals(
            setOf(ProofCategory.STEPS),
            ProofPolicy.readableCategories(
                setOf(ProofCategory.STEPS),
                setOf(
                    "android.permission.health.READ_STEPS",
                    "android.permission.health.READ_WEIGHT",
                    "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND",
                    "android.permission.health.READ_HEALTH_DATA_HISTORY",
                    "android.permission.health.WRITE_STEPS"
                )
            )
        )
    }

    @Test
    fun noGrantReadsNothing() {
        assertEquals(
            emptySet<ProofCategory>(),
            ProofPolicy.readableCategories(
                setOf(ProofCategory.STEPS, ProofCategory.WEIGHT),
                emptySet()
            )
        )
    }

    @Test
    fun unrelatedOrWriteOnlyGrantsCannotAuthoriseARead() {
        assertEquals(
            emptySet<ProofCategory>(),
            ProofPolicy.readableCategories(
                setOf(ProofCategory.STEPS, ProofCategory.WEIGHT),
                setOf(
                    "android.permission.health.READ_HEART_RATE",
                    "android.permission.health.WRITE_STEPS",
                    "android.permission.health.WRITE_WEIGHT",
                    "android.permission.health.READ_HEALTH_DATA_HISTORY"
                )
            )
        )
    }

    @Test
    fun controlledWindowWithinTwoHoursIsAccepted() {
        ProofPolicy.validateWindow(
            Instant.parse("2026-10-28T01:30:00Z"),
            Instant.parse("2026-10-28T02:00:00Z"),
            now
        )
    }

    @Test
    fun exactTwoHourWindowEndingNowIsAccepted() {
        ProofPolicy.validateWindow(start, now, now)
    }

    @Test
    fun emptyWindowIsRefused() {
        assertThrows(IllegalArgumentException::class.java) {
            ProofPolicy.validateWindow(start, start, now)
        }
    }

    @Test
    fun reversedWindowIsRefused() {
        assertThrows(IllegalArgumentException::class.java) {
            ProofPolicy.validateWindow(now, start, now)
        }
    }

    @Test
    fun windowLongerThanTwoHoursByOneNanosecondIsRefused() {
        assertThrows(IllegalArgumentException::class.java) {
            ProofPolicy.validateWindow(
                start,
                Instant.parse("2026-10-28T03:00:00.000000001Z"),
                Instant.parse("2026-10-28T04:00:00Z")
            )
        }
    }

    @Test
    fun windowEndingInTheFutureIsRefused() {
        assertThrows(IllegalArgumentException::class.java) {
            ProofPolicy.validateWindow(
                Instant.parse("2026-10-28T02:00:00Z"),
                Instant.parse("2026-10-28T03:00:00.000000001Z"),
                now
            )
        }
    }
}
