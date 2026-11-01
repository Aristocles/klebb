// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import app.klebb.companion.records.RecordCodecs
import app.klebb.companion.sync.HealthConnectRecordReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CategorySetupTest {
    private val steps = "StepsRecord"
    private val weight = "WeightRecord"
    private val readSteps = "android.permission.health.READ_STEPS"
    private val readWeight = "android.permission.health.READ_WEIGHT"
    private val available = CategoryEvidence(available = CategoryAvailability.AVAILABLE)

    @Test
    fun SETUP01_selectedTypesRequestOnlySdkReadPermissions() {
        // A healthy real adapter precedes the independent request assertion.
        assertEquals(StepsRecord::class, CategorySetup.registry.getValue(steps).recordType)
        assertEquals(readSteps, HealthPermission.getReadPermission(StepsRecord::class))
        assertEquals(setOf(readSteps), CategorySetup.requestedReadPermissions(setOf(steps)))
        assertEquals(
            setOf(readSteps, readWeight),
            CategorySetup.requestedReadPermissions(setOf(steps, weight))
        )
        assertEquals(emptySet<String>(), CategorySetup.requestedReadPermissions(emptySet()))
    }

    @Test
    fun SETUP02_partialGrantKeepsEachStateSeparate() {
        val states = CategorySetup.states(
            setOf(steps, weight), setOf(readWeight),
            mapOf(steps to available, weight to available)
        )
        val denied = states.getValue(steps)
        val permitted = states.getValue(weight)
        assertTrue(denied.selected)
        assertEquals(CategoryTruth.NO, denied.permitted)
        assertFalse(denied.canCollect)
        assertEquals(CategoryTruth.YES, permitted.permitted)
        assertTrue(permitted.canCollect)
        for (state in listOf(denied, permitted)) {
            assertEquals(CategoryTruth.UNKNOWN, state.observed)
            assertEquals(CategoryTruth.UNKNOWN, state.saved)
            assertEquals(CategoryTruth.UNKNOWN, state.displayed)
        }
    }

    @Test
    fun SETUP03_permissionDoesNotSelectOrRequestAnUnselectedType() {
        val state = CategorySetup.states(
            setOf(steps), setOf(readSteps, readWeight), mapOf(weight to available)
        ).getValue(weight)
        assertFalse(state.selected)
        assertEquals(CategoryTruth.YES, state.permitted)
        assertFalse(state.canCollect)
        assertEquals(setOf(readSteps), CategorySetup.requestedReadPermissions(setOf(steps)))
    }

    @Test
    fun SETUP04_unknownPermissionIsDifferentFromConfirmedMissingGrant() {
        val unknown = CategorySetup.states(setOf(steps), null).getValue(steps)
        val denied = CategorySetup.states(setOf(steps), emptySet()).getValue(steps)
        assertEquals(CategoryTruth.UNKNOWN, unknown.permitted)
        assertEquals(CategoryTruth.NO, denied.permitted)
        assertFalse(unknown.canCollect)
        assertFalse(denied.canCollect)
    }

    @Test
    fun SETUP05_unknownAndUnavailableDoNotAuthoriseCollection() {
        val unknown = CategorySetup.states(setOf(steps), setOf(readSteps)).getValue(steps)
        val unavailable = CategorySetup.states(
            setOf(steps), setOf(readSteps),
            mapOf(steps to CategoryEvidence(available = CategoryAvailability.UNAVAILABLE))
        ).getValue(steps)
        assertEquals(CategoryAvailability.UNKNOWN, unknown.available)
        assertEquals(CategoryAvailability.UNAVAILABLE, unavailable.available)
        assertEquals(CategoryTruth.YES, unavailable.permitted)
        assertFalse(unknown.canCollect)
        assertFalse(unavailable.canCollect)
    }

    @Test
    fun SETUP06_observedDoesNotImplySavedOrDisplayed() {
        val state = CategorySetup.states(
            setOf(steps), setOf(readSteps),
            mapOf(steps to available.copy(
                observed = CategoryTruth.YES,
                displayed = CategoryTruth.NO
            ))
        ).getValue(steps)
        assertEquals(CategoryTruth.YES, state.observed)
        assertEquals(CategoryTruth.UNKNOWN, state.saved)
        assertEquals(CategoryTruth.NO, state.displayed)
        val savedOnly = CategorySetup.states(
            setOf(steps), setOf(readSteps),
            mapOf(steps to available.copy(
                observed = CategoryTruth.NO,
                saved = CategoryTruth.YES,
                displayed = CategoryTruth.NO
            ))
        ).getValue(steps)
        assertEquals(CategoryTruth.NO, savedOnly.observed)
        assertEquals(CategoryTruth.YES, savedOnly.saved)
        assertEquals(CategoryTruth.NO, savedOnly.displayed)
        val displayedOnly = CategorySetup.states(
            setOf(steps), setOf(readSteps),
            mapOf(steps to available.copy(
                saved = CategoryTruth.NO,
                displayed = CategoryTruth.YES
            ))
        ).getValue(steps)
        assertEquals(CategoryTruth.UNKNOWN, displayedOnly.observed)
        assertEquals(CategoryTruth.NO, displayedOnly.saved)
        assertEquals(CategoryTruth.YES, displayedOnly.displayed)
    }

    @Test
    fun SETUP07_deselectionStopsEligibilityWithoutDeletingSavedHistory() {
        val evidence = mapOf(weight to available.copy(
            observed = CategoryTruth.YES,
            saved = CategoryTruth.YES,
            displayed = CategoryTruth.YES
        ))
        val before = CategorySetup.states(setOf(weight), setOf(readWeight), evidence)
            .getValue(weight)
        val after = CategorySetup.states(emptySet(), setOf(readWeight), evidence)
            .getValue(weight)
        assertTrue(before.canCollect)
        assertFalse(after.selected)
        assertFalse(after.canCollect)
        assertEquals(CategoryTruth.YES, after.permitted)
        assertEquals(before.observed, after.observed)
        assertEquals(before.saved, after.saved)
        assertEquals(before.displayed, after.displayed)
        assertEquals(emptySet<String>(), CategorySetup.requestedReadPermissions(emptySet()))
    }

    @Test
    fun SETUP08_sharedPermissionDoesNotMergeCategorySelection() {
        val cadence = "StepsCadenceRecord"
        assertEquals(
            setOf(readSteps), CategorySetup.requestedReadPermissions(setOf(steps, cadence))
        )
        val states = CategorySetup.states(setOf(steps), setOf(readSteps))
        assertTrue(states.getValue(steps).selected)
        assertFalse(states.getValue(cadence).selected)
        assertEquals(CategoryTruth.YES, states.getValue(cadence).permitted)
        assertFalse(states.getValue(cadence).canCollect)
    }

    @Test
    fun SETUP09_registryUsesActualMapperClassesWithoutNativeCoverageClaims() {
        assertEquals(42, CategorySetup.registry.size)
        assertEquals(RecordCodecs.supportedRecordTypes, CategorySetup.registry.keys)
        assertEquals(WeightRecord::class, CategorySetup.registry.getValue(weight).recordType)
        for ((name, adapter) in CategorySetup.registry) {
            assertEquals(name, adapter.recordType.simpleName)
            assertEquals(HealthPermission.getReadPermission(adapter.recordType), adapter.readPermission)
        }
        assertTrue(CategorySetup.registry.containsKey("PlannedExerciseSessionRecord"))
        val skin = CategorySetup.states(emptySet(), null).getValue("SkinTemperatureRecord")
        assertEquals(CategoryAvailability.UNKNOWN, skin.available)
        assertEquals(CategoryTruth.UNKNOWN, skin.observed)
    }

    @Test
    fun SETUP10_unsupportedSelectionsAreExplicitlyRefused() {
        for (unsupported in listOf(
            "ExerciseRoute", "MedicalResource", "NotARecord"
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                CategorySetup.requestedReadPermissions(setOf(unsupported))
            }
            assertThrows(IllegalArgumentException::class.java) {
                CategorySetup.states(setOf(unsupported), emptySet())
            }
        }
    }

    @Test
    fun SETUP11_returnedStateIsIndependentOfMutableInputs() {
        val selected = mutableSetOf(steps)
        val grants = mutableSetOf(readSteps)
        val evidence = mutableMapOf(steps to available)
        val state = CategorySetup.states(selected, grants, evidence).getValue(steps)
        selected.clear()
        grants.clear()
        evidence.clear()
        assertTrue(state.selected)
        assertEquals(CategoryTruth.YES, state.permitted)
        assertEquals(CategoryAvailability.AVAILABLE, state.available)
        assertThrows(UnsupportedOperationException::class.java) {
            (CategorySetup.registry as MutableMap<String, CategoryAdapter>).clear()
        }
    }

    @Test
    fun SETUP12_actualWeightReaderFactoryRequiresAllThreeCollectionFacts() {
        var created = 0
        val reader = HealthConnectRecordReader { error("No native read in setup fixture") }
        val factory = { created++; reader }
        val healthy = CategorySetup.states(
            setOf(weight), setOf(readWeight), mapOf(weight to available)
        ).getValue(weight)
        assertSame(reader, CategorySetup.weightReaderIfEligible(healthy, factory))
        assertEquals(1, created)
        val ineligible = listOf(
            CategorySetup.states(setOf(weight), null, mapOf(weight to available)).getValue(weight),
            CategorySetup.states(setOf(weight), emptySet(), mapOf(weight to available)).getValue(weight),
            CategorySetup.states(emptySet(), setOf(readWeight), mapOf(weight to available)).getValue(weight),
            CategorySetup.states(setOf(weight), setOf(readWeight)).getValue(weight),
            CategorySetup.states(setOf(steps), setOf(readSteps), mapOf(steps to available)).getValue(steps)
        )
        for (state in ineligible) {
            assertEquals(null, CategorySetup.weightReaderIfEligible(state, factory))
        }
        assertEquals(1, created)
    }
}
