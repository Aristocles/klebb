// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PlannedExerciseStep
import java.util.TimeZone
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proposed tests for an actual merged and verified Exercise41 foundation.
 * SDK constructor/getter controls must succeed before a missing codec can earn RED.
 * Literal resources are independently fixed source-contract expectations; actual
 * Retained SDK agreement is host SDK_INT0 only; current JUnit and wire PASS await execution.
 */
class PlannedExerciseCodecTest {
    @Test
    fun primaryPreservesEverySessionNestedAndUnitGetter() = withUtc {
        assertEncodedFixture("O1")
    }

    @Test
    fun dateOnlyRetainsFalseUtcNoonNanosecondsAndNullableMetadata() = withUtc {
        assertEncodedFixture("O2")
    }

    @Test
    fun physicalNullOffsetsRetainOneNanosecondAndNullableDeviceFields() = withUtc {
        assertEncodedFixture("O3")
    }

    @Test
    fun blockStepAndTargetOrderRetainsDuplicatesAndRepetitionValues() = withUtc {
        assertEncodedFixture("N4")
    }

    @Test
    fun exposedOpaqueIntegerValuesArePreservedWithoutEnumNormalization() = withUtc {
        // Constructor refusal is an SDK precondition result, never a codec failure.
        assertEncodedFixture("O5")
    }

    @Test
    fun zeroBlockGoalAndTargetValuesRemainZero() = withUtc {
        assertEncodedFixture("O6")
    }

    @Test
    fun plannedIsExactlyTheConditionalFortySecondOrdinaryEntry() = withUtc {
        verifiedFixture("O1")
        requireExerciseFoundation()
        frozenWireBytes("O1")
        val expected = setOf(
            "ActiveCaloriesBurnedRecord",
            "ActivityIntensityRecord",
            "BasalBodyTemperatureRecord",
            "BasalMetabolicRateRecord",
            "BloodGlucoseRecord",
            "BloodPressureRecord",
            "BodyFatRecord",
            "BodyTemperatureRecord",
            "BodyWaterMassRecord",
            "BoneMassRecord",
            "CervicalMucusRecord",
            "CyclingPedalingCadenceRecord",
            "DistanceRecord",
            "ElevationGainedRecord",
            "ExerciseSessionRecord",
            "FloorsClimbedRecord",
            "HeartRateRecord",
            "HeartRateVariabilityRmssdRecord",
            "HeightRecord",
            "HydrationRecord",
            "IntermenstrualBleedingRecord",
            "LeanBodyMassRecord",
            "MenstruationFlowRecord",
            "MenstruationPeriodRecord",
            "MindfulnessSessionRecord",
            "NutritionRecord",
            "OvulationTestRecord",
            "OxygenSaturationRecord",
            "PlannedExerciseSessionRecord",
            "PowerRecord",
            "RespiratoryRateRecord",
            "RestingHeartRateRecord",
            "SexualActivityRecord",
            "SkinTemperatureRecord",
            "SleepSessionRecord",
            "SpeedRecord",
            "StepsCadenceRecord",
            "StepsRecord",
            "TotalCaloriesBurnedRecord",
            "Vo2MaxRecord",
            "WeightRecord",
            "WheelchairPushesRecord"
        )
        assertEquals("REGISTRY_CONTRACT: exact independent ordinary42", expected,
            RecordCodecs.supportedRecordTypes)
        org.junit.Assert.assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
        assertEquals("REGISTRY_CONTRACT: refusal preserves exact42", expected,
            RecordCodecs.supportedRecordTypes)
    }

    @Test
    fun futureGoalRefusesTheWholeRecordWithoutKnownUnknownCoercion() = withUtc {
        // ADVERSARIAL_PUBLIC_LIST_AFTER_VALID_CONSTRUCTOR; direct S12 remains separate.
        val fixture = verifiedOwnedPrimary("S12")
        sdkConstruction("S12/adversarial-public-list-step") {
            fixture.suppliedSteps[0] = PlannedExerciseStep(0, 1,
                PlannedSdkObserver.SyntheticFutureGoal(9), fixture.suppliedTargets,
                "Synthetic distance goal.")
        }
        verifyAdversarialFutureSetup("S12", fixture.record)
        assertWholeRecordUnsupportedValue(fixture.record)
    }

    @Test
    fun futureTargetRefusesTheWholeRecordWithoutDroppingOrPartialJson() = withUtc {
        // ADVERSARIAL_PUBLIC_LIST_AFTER_VALID_CONSTRUCTOR; direct S13 remains separate.
        val fixture = verifiedOwnedPrimary("S13")
        fixture.suppliedTargets[0] = PlannedSdkObserver.SyntheticFutureTarget(9)
        verifyAdversarialFutureSetup("S13", fixture.record)
        assertWholeRecordUnsupportedValue(fixture.record)
    }

    @Test
    fun returnedJsonRemainsFixedAfterEachOwnedCallerListClear() = withUtc {
        requireExerciseFoundation()
        for (id in listOf("O1", "N4")) {
            for (listName in listOf("blocks", "steps", "targets")) {
                // Fresh constructor-supplied lists for each clear; three per case.
                val fixture = sdkConstruction("$id/$listName") {
                    PlannedSdkObserver.ownedFixture(id)
                }
                verifySnapshot(id, fixture.record)
                val expectedWire = frozenWireBytes(id)
                val encoded = encodeAfterValidSetup(fixture.record)
                assertIdentity(id, encoded)
                assertWire(id, encoded, expectedWire)
                val returned = encoded.recordJson
                when (listName) {
                    "blocks" -> fixture.suppliedBlocks.clear()
                    "steps" -> fixture.suppliedSteps.clear()
                    "targets" -> fixture.suppliedTargets.clear()
                }
                assertEquals("RETURNED_SNAPSHOT: $id/$listName", returned, encoded.recordJson)
                assertWire(id, encoded, expectedWire)
                // No second encode: its expectation awaits real SDK ownership observations.
            }
        }
    }

    private fun verifiedOwnedPrimary(caseId: String): PlannedSdkObserver.OwnedFixture {
        val fixture = sdkConstruction("$caseId/O1-owned") { PlannedSdkObserver.ownedFixture("O1") }
        verifySnapshot("O1", fixture.record)
        requireExerciseFoundation()
        val expectedWire = frozenWireBytes("O1")
        val encoded = encodeAfterValidSetup(fixture.record)
        assertIdentity("O1", encoded)
        assertWire("O1", encoded, expectedWire)
        assertSame("SDK_PRECONDITION_ALIAS: $caseId/blocks",
            fixture.suppliedBlocks, fixture.record.blocks)
        assertSame("SDK_PRECONDITION_ALIAS: $caseId/steps",
            fixture.suppliedSteps, fixture.record.blocks[0].steps)
        assertSame("SDK_PRECONDITION_ALIAS: $caseId/targets",
            fixture.suppliedTargets, fixture.record.blocks[0].steps[0].performanceTargets)
        return fixture
    }

    private fun verifyAdversarialFutureSetup(caseId: String,
                                           record: PlannedExerciseSessionRecord) {
        val expected = PlannedExerciseExpectedGetters.adversarialPublicListSnapshots.getValue(caseId)
        assertEquals("SDK_PRECONDITION_ADVERSARIAL_LITERAL_COUNT: $caseId", 133, expected.size)
        val actual = sdkConstruction("$caseId/adversarial-getters") { PlannedSdkObserver.snapshot(record) }
        assertEquals("SDK_PRECONDITION_ADVERSARIAL_GETTER_KEYS: $caseId", expected.keys, actual.keys)
        assertEquals("SDK_PRECONDITION_ADVERSARIAL_GETTER_VALUES: $caseId", expected, actual)
    }

    private fun assertEncodedFixture(id: String) {
        val record = verifiedFixture(id)
        requireExerciseFoundation()
        val expectedWire = frozenWireBytes(id)
        val encoded = encodeAfterValidSetup(record)
        assertIdentity(id, encoded)
        assertWire(id, encoded, expectedWire)
    }

    private fun verifiedFixture(id: String): PlannedExerciseSessionRecord {
        val record = sdkConstruction(id) { PlannedSdkObserver.fixture(id) }
        verifySnapshot(id, record)
        return record
    }

    private fun verifySnapshot(id: String, record: PlannedExerciseSessionRecord) {
        val expected = frozenGetterSnapshot(id)
        val actual = sdkConstruction("$id/getters") { PlannedSdkObserver.snapshot(record) }
        // Whole key-set equality witnesses all paths, including null versus absent.
        assertEquals("SDK_PRECONDITION_GETTER_KEYS: $id", expected.keys, actual.keys)
        assertEquals("SDK_PRECONDITION_GETTER_VALUES: $id", expected, actual)
    }

    private fun verifyFutureSetup(record: PlannedExerciseSessionRecord,
                                  changedPrefix: String, variant: String) {
        // Compose only the already-frozen O1 plus S12/S13 literal controls.
        // No expected value is read from the actual observer or encoder.
        val expected = frozenGetterSnapshot("O1").filterKeys {
            !it.startsWith(changedPrefix)
        }.toMutableMap()
        expected[changedPrefix + "variant"] = variant
        expected[changedPrefix + "syntheticValue"] = "9"
        val actual = sdkConstruction("$variant/getters") { PlannedSdkObserver.snapshot(record) }
        assertEquals("SDK_PRECONDITION_FUTURE_KEYS: $variant", expected.keys, actual.keys)
        assertEquals("SDK_PRECONDITION_FUTURE_VALUES: $variant", expected, actual)
    }

    private fun requireExerciseFoundation() {
        // The actual reviewed merge remains an external prerequisite. These source
        // assertions guard the registered surface and do not prove PR831 was merged.
        assertTrue("FOUNDATION_PRECONDITION: verified Exercise41 required",
            "ExerciseSessionRecord" in RecordCodecs.supportedRecordTypes)
        assertTrue("FOUNDATION_PRECONDITION: expected Exercise41 or Planned42 surface",
            RecordCodecs.supportedRecordTypes.size in 41..42)
    }

    private fun encodeAfterValidSetup(record: PlannedExerciseSessionRecord): EncodedRecord =
        try {
            RecordCodecs.encode(record)
        } catch (failure: RecordCodecException) {
            if (failure.code == "unsupported-record") {
                throw AssertionError("CODEC_MISSING: Planned unsupported-record after valid SDK setup",
                    failure)
            }
            throw failure
        }

    private fun assertWholeRecordUnsupportedValue(record: PlannedExerciseSessionRecord) {
        try {
            RecordCodecs.encode(record)
        } catch (failure: RecordCodecException) {
            assertEquals("FUTURE_VARIANT: bounded whole-record refusal", "unsupported-value",
                failure.code)
            return
        }
        throw AssertionError("FUTURE_VARIANT: whole record unexpectedly returned EncodedRecord")
    }

    private fun assertIdentity(id: String, encoded: EncodedRecord) {
        assertEquals("PlannedExerciseSessionRecord", encoded.recordType)
        assertEquals(frozenGetterSnapshot(id)["metadata.id"], encoded.nativeRecordId)
        assertEquals("health-connect-record", encoded.serializerId)
        assertEquals(1, encoded.serializerVersion)
        assertEquals("ordinary", encoded.dataFamily)
    }

    private fun assertWire(id: String, encoded: EncodedRecord, expectedWire: ByteArray) {
        assertArrayEquals("WIRE_LITERAL: complete UTF8 payload for $id",
            expectedWire,
            encoded.recordJson.toByteArray(Charsets.UTF_8))
    }

    private fun frozenWireBytes(id: String): ByteArray = try {
        resourceBytes("$id-proposed-recordJson.utf8").also { bytes ->
            if (bytes.isEmpty()) {
                throw AssertionError("SDK_PRECONDITION_RESOURCE: fixed wire literal empty")
            }
        }
    } catch (failure: Exception) {
        throw AssertionError("SDK_PRECONDITION_RESOURCE: fixed wire literal unavailable", failure)
    }

    private fun frozenGetterSnapshot(id: String): Map<String, String?> =
        PlannedExerciseExpectedGetters.snapshots[id]
            ?: throw AssertionError("SDK_PRECONDITION_RESOURCE: fixed getter literal missing")

    private fun resourceBytes(name: String): ByteArray =
        javaClass.getResourceAsStream("/planned/$name")?.use { it.readBytes() }
            ?: throw AssertionError("SDK_PRECONDITION_RESOURCE: required literal missing")

    private inline fun <T> sdkConstruction(caseId: String, build: () -> T): T = try {
        build()
    } catch (failure: RuntimeException) {
        throw AssertionError("SDK_PRECONDITION_SETUP: $caseId", failure)
    } catch (failure: LinkageError) {
        throw AssertionError("SDK_PRECONDITION_LINKAGE: $caseId", failure)
    }

    private inline fun withUtc(body: () -> Unit) {
        val previous = TimeZone.getDefault()
        try {
            // Applies only inside the later separately approved isolated test JVM.
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
            assertEquals("SDK_PRECONDITION_ZONE", "UTC", TimeZone.getDefault().id)
            body()
        } finally {
            TimeZone.setDefault(previous)
        }
    }
}
