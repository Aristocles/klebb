// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import org.junit.Assert.*
import org.junit.Test

class SetupDateStoreTest {
    private val original = """{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-01"}"""

    @Test fun DATE01_literalLeapDayPairIsOneCompleteWriteAndCanBeReopened() {
        var value: String? = null
        val writes = mutableListOf<String>()
        val store = SetupDateStore({ value }) { raw -> writes.add(raw); value = raw; true }
        assertSame(SetupDateRead.Unset, store.read())
        assertEquals(SetupDateSave.SAVED, store.save("2040-02-29", "2040-03-01"))
        assertEquals(listOf(original), writes)
        val reopened = SetupDateStore({ value }) { error("Read must not write") }
        assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-01")), reopened.read())
    }

    @Test fun DATE02_editingDisplayKeepsImportLiteralIndependent() {
        var value: String? = original
        val store = SetupDateStore({ value }) { value = it; true }
        assertEquals(SetupDateSave.SAVED, store.save("2040-02-29", "2040-03-04"))
        assertEquals("""{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-04"}""", value)
        assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-04")), store.read())
    }

    @Test fun DATE03_intentionalGapOrOverlapNeverReordersTheTwoDates() {
        for ((history, display, expected) in listOf(
            Triple("2040-03-10", "2040-03-01", """{"version":1,"historyImportDate":"2040-03-10","displaySwitchDate":"2040-03-01"}"""),
            Triple("2040-02-29", "2040-03-10", """{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-10"}""")
        )) {
            var written: String? = null
            val store = SetupDateStore({ null }) { written = it; true }
            assertEquals(SetupDateSave.SAVED, store.save(history, display))
            assertEquals(expected, written)
        }
    }

    @Test fun DATE04_readingChoicesAndTentativeEditsHaveNoPersistenceOperation() {
        var writes = 0
        val store = SetupDateStore({ original }) { writes++; true }
        assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-01")), store.read())
        // Actual screen Cancel/leave is a separate instrumentation observation.
        assertEquals(0, writes)
        assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-01")), store.read())
    }

    @Test fun DATE05_invalidOrIncompleteDatesNeverReachTheWriter() {
        var writes = 0
        val store = SetupDateStore({ original }) { writes++; true }
        for (invalid in listOf("2041-02-29", "2040-02-30", "2040-13-01", "2040-2-3", "", null,
            " 2040-02-29", "2040-02-29 ", "2040-02-29T00:00:00Z")) {
            assertEquals(SetupDateSave.INVALID, store.save(invalid, "2040-03-01"))
            assertEquals(SetupDateSave.INVALID, store.save("2040-02-29", invalid))
        }
        assertEquals(0, writes)
        assertEquals(SetupDateRead.Stored(SetupDates("2040-02-29", "2040-03-01")), store.read())
    }

    @Test fun DATE06_falseOrThrowingCommitNeverClaimsDurableSuccessOrRollback() {
        var memory: String? = original
        val falseCommit = SetupDateStore({ memory }) { memory = it; false }
        assertEquals(SetupDateSave.UNCONFIRMED, falseCommit.save("2040-03-11", "2040-03-12"))
        // A real SharedPreferences false commit can already have updated its memory map.
        assertEquals(SetupDateRead.Stored(SetupDates("2040-03-11", "2040-03-12")), falseCommit.read())
        val throwing = SetupDateStore({ original }) { throw IllegalStateException("invented write failure") }
        assertEquals(SetupDateSave.UNCONFIRMED, throwing.save("2040-02-29", "2040-03-01"))
        val unreadable = SetupDateStore({ throw IllegalStateException("invented read failure") }) { true }
        assertSame(SetupDateRead.Unavailable, unreadable.read())
    }

    @Test fun DATE07_unknownMalformedDuplicateOrPartialStorageNeverYieldsAUsablePair() {
        for (raw in listOf(
            "", "{", "{}",
            """{"version":2,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-01"}""",
            """{"version":1,"historyImportDate":"2040-02-29"}""",
            """{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":null}""",
            """{"version":1,"historyImportDate":"2041-02-29","displaySwitchDate":"2040-03-01"}""",
            """{"version":1,"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-01"}""",
            """{"version":1,"historyImportDate":"2040-02-29","displaySwitchDate":"2040-03-01","extra":true}""",
            "x".repeat(257)
        )) {
            val store = SetupDateStore({ raw }) { error("Invalid stored values must not write") }
            assertSame(SetupDateRead.Invalid, store.read())
        }
    }
}
