// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.response.ChangesResponse
import app.klebb.companion.queue.Ok
import app.klebb.companion.setup.CategorySetup
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlin.coroutines.cancellation.CancellationException
import org.junit.Assert.*
import org.junit.Test

/** SDK-answer fixtures are component expectations, not on-device evidence. */
class NativeWeightScopeFactsTest {
    private val scope = WeightReadScope(
        Instant.parse("2026-10-28T03:45:00Z"), Instant.parse("2026-10-28T03:46:00Z")
    )
    private val grants = setOf(
        CategorySetup.registry.getValue("WeightRecord").readPermission,
        HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
    )
    private val reader = object : OrdinaryRecordReader {
        override suspend fun readPage(scope: WeightReadScope, pageToken: String?) =
            OrdinaryRecordPage(emptyList(), null)
    }
    private fun subject(
        permissions: suspend () -> Set<String> = { grants },
        feature: () -> Int = { HealthConnectFeatures.FEATURE_STATUS_AVAILABLE },
        token: suspend () -> String = { "owned-synthetic-token" },
        response: ChangesResponse = ChangesResponse(emptyList(), "next-synthetic-token", false, false),
        changeRead: suspend (String) -> ChangesResponse = { response }
    ) = NativeWeightScopeFacts(permissions, feature, token, changeRead, reader)

    @Test fun healthyTerminalNativeFactsStillDoNotGrantPolicyAuthority() = runBlocking {
        val facts = subject().capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals(true, facts.permissionsStable)
        assertEquals(true, facts.historyIncludesScope)
        assertNull(facts.historyStart)
        assertEquals(true, facts.pagesFinished)
        assertEquals(true, facts.tokenValid)
        assertEquals(true, facts.changesBarrierDrained)
        assertEquals(0, facts.pendingChanges)
        assertEquals(facts.permissionFingerprintStart, facts.permissionFingerprintEnd)
        assertEquals("UNKNOWN", facts.nativeCompleteness)
        assertFalse(facts.enableEligible)
        assertFalse(facts.reconciliationEligible)
        assertFalse(facts.deletionEligible)
    }

    @Test fun deniedReadAndUnknownPermissionRemainDifferent() = runBlocking {
        val denied = subject(permissions = { emptySet() },
            token = { fail("Denied scope must not call the native token API"); "" })
            .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals(false, denied.readPermissionGranted)
        assertNull(denied.tokenValid)
        val unknown = subject(permissions = { throw IllegalStateException("query failed") },
            token = { fail("Unknown permission must not call the native token API"); "" })
            .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertNull(unknown.readPermissionGranted)
        assertNull(unknown.historyIncludesScope)
        assertEquals("UNKNOWN", unknown.nativeCompleteness)
    }

    @Test fun absentExtendedHistoryDoesNotInventUnlimitedHistory() = runBlocking {
        val facts = subject(permissions = { grants - HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY },
            token = { fail("Unknown history must not start a completeness scan"); "" })
            .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals(true, facts.readPermissionGranted)
        assertNull(facts.historyIncludesScope)
        assertNull(facts.pagesFinished)
        assertFalse(facts.enableEligible)
    }

    @Test fun expiredAndNonterminalChangesRefuseBarrierCompletion() = runBlocking {
        for (response in listOf(
            ChangesResponse(emptyList(), "next", false, true),
            ChangesResponse(emptyList(), "next", true, false),
            ChangesResponse(listOf(DeletionChange("owned-synthetic-id")), "next", false, false)
        )) {
            val facts = subject(response = response)
                .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
            assertEquals(true, facts.pagesFinished)
            assertEquals(false, facts.changesBarrierDrained)
            assertFalse(facts.reconciliationEligible)
        }
    }

    @Test fun staleBindingCannotBecomeFinishedCoverage() = runBlocking {
        val facts = subject().capture("WeightRecord", scope, 1,
            { ReadGate.STALE_BINDING }, { fail("Stale binding must not stage a page"); Ok(Unit) })
        assertEquals(false, facts.pagesFinished)
        assertEquals(false, facts.changesBarrierDrained)
        assertEquals("UNKNOWN", facts.nativeCompleteness)
    }

    @Test fun registeredUnimplementedNativeAdapterIsNotPlatformUnavailable() = runBlocking {
        val facts = subject(token = { fail("No adapter is implemented for this type"); "" })
            .capture("StepsRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals("adapter-unimplemented", facts.reason)
        assertNull(facts.readPermissionGranted)
        assertEquals("UNKNOWN", facts.nativeCompleteness)
    }

    @Test fun featureUnavailableCannotSupplyUnlimitedHistory() = runBlocking {
        val facts = subject(feature = { HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE },
            token = { fail("Unavailable history feature must not start a completeness scan"); "" })
            .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertNull(facts.historyIncludesScope)
        assertNull(facts.pagesFinished)
        assertFalse(facts.enableEligible)
    }

    @Test fun permissionChurnStopsScopeBeforeCompletion() = runBlocking {
        var first = true
        val facts = subject(permissions = {
            if (first) { first = false; grants } else grants - HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
        }).capture("WeightRecord", scope, 1, { ReadGate.OPEN },
            { fail("Lost permission must not stage a page"); Ok(Unit) })
        assertEquals(false, facts.permissionsStable)
        assertEquals(false, facts.pagesFinished)
        assertEquals(false, facts.changesBarrierDrained)
        assertNull(facts.historyIncludesScope)
    }

    @Test fun restoredEndFingerprintDoesNotHideObservedPermissionLoss() = runBlocking {
        var observations = 0
        val facts = subject(permissions = {
            observations++
            if (observations == 2) grants - HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
            else grants
        }).capture("WeightRecord", scope, 1, { ReadGate.OPEN },
            { fail("Observed permission loss must prevent page acceptance"); Ok(Unit) })
        assertEquals(facts.permissionFingerprintStart, facts.permissionFingerprintEnd)
        assertEquals(false, facts.permissionsStable)
        assertEquals(false, facts.pagesFinished)
        assertEquals(false, facts.changesBarrierDrained)
    }

    @Test fun bindingChangeDuringSdkBarrierCannotSealCurrentScope() = runBlocking {
        var current = true
        val facts = subject(changeRead = {
            current = false
            ChangesResponse(emptyList(), "next", false, false)
        }).capture("WeightRecord", scope, 1,
            { if (current) ReadGate.OPEN else ReadGate.STALE_BINDING }, { Ok(Unit) })
        assertNull(facts.tokenValid)
        assertNull(facts.changesBarrierDrained)
        assertEquals("UNKNOWN", facts.nativeCompleteness)
        assertFalse(facts.enableEligible)
    }

    @Test fun featureChurnCannotSealReadableHistory() = runBlocking {
        var first = true
        val facts = subject(feature = {
            if (first) { first = false; HealthConnectFeatures.FEATURE_STATUS_AVAILABLE }
            else HealthConnectFeatures.FEATURE_STATUS_UNAVAILABLE
        }).capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals(false, facts.permissionsStable)
        assertNull(facts.historyIncludesScope)
        assertEquals(false, facts.changesBarrierDrained)
    }

    @Test fun tokenFailureAndEmptyTokenDoNotBecomeCompleteEvidence() = runBlocking {
        for (token in listOf<suspend () -> String>(
            { throw IllegalStateException("native token unavailable") }, { "" }
        )) {
            val facts = subject(token = token)
                .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
            assertNull(facts.tokenValid)
            assertNull(facts.pagesFinished)
            assertEquals("UNKNOWN", facts.nativeCompleteness)
        }
        val readFailure = subject(changeRead = { throw IllegalStateException("SDK barrier failed") })
            .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
        assertEquals(true, readFailure.pagesFinished)
        assertNull(readFailure.tokenValid)
        assertNull(readFailure.changesBarrierDrained)
        assertEquals("UNKNOWN", readFailure.nativeCompleteness)
    }

    @Test fun coroutineCancellationIsNotSwallowedAsUnknownSuccess() = runBlocking {
        try {
            subject(token = { throw CancellationException("owned cancellation") })
                .capture("WeightRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
            fail("Cancellation must propagate")
        } catch (_: CancellationException) {
            // The caller retains cancellation and cleanup ownership.
        }
    }

    @Test fun foreignTypeRefusesBeforeCallingNativeApis() = runBlocking {
        try {
            subject(token = { fail("Foreign type must not call the SDK"); "" })
                .capture("ForeignSyntheticRecord", scope, 1, { ReadGate.OPEN }, { Ok(Unit) })
            fail("An unregistered category must refuse")
        } catch (_: IllegalArgumentException) {
            // Refusal is distinct from a registered but unimplemented adapter.
        }
    }

    @Test fun bindingChangedDuringFinalPermissionObservationCannotSealBarrier() = runBlocking {
        var current = true
        var barrierReturned = false
        val facts = subject(permissions = {
            if (barrierReturned) current = false
            grants
        }, changeRead = {
            barrierReturned = true
            ChangesResponse(emptyList(), "next", false, false)
        }).capture("WeightRecord", scope, 1,
            { if (current) ReadGate.OPEN else ReadGate.STALE_BINDING }, { Ok(Unit) })
        assertTrue("A final awaited observation cannot seal stale custody",
            facts.changesBarrierDrained != true)
        assertEquals("UNKNOWN", facts.nativeCompleteness)
        assertFalse(facts.enableEligible)
        assertFalse(facts.reconciliationEligible)
        assertFalse(facts.deletionEligible)
    }
}
