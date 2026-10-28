// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundOperationsTest {
    private fun foregroundScope() = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Test
    fun initiallyStoppedCoordinatorRefusesToRead() {
        val scope = foregroundScope()
        try {
            val operations = ForegroundOperations(scope)
            var reads = 0

            assertFalse(operations.start { reads++ })
            assertEquals(0, reads)
            assertFalse(operations.active)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun resumedCoordinatorRunsOneOperationAndClearsActiveState() {
        val scope = foregroundScope()
        try {
            val operations = ForegroundOperations(scope)
            var reads = 0
            operations.resume()

            assertTrue(operations.start { reads++ })
            assertEquals(1, reads)
            assertFalse(operations.active)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun suspendedOperationExcludesConcurrentReadUntilItCompletes() = runBlocking<Unit> {
        val scope = foregroundScope()
        try {
            val operations = ForegroundOperations(scope)
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val finished = CompletableDeferred<Unit>()
            var secondOperationReads = 0
            operations.resume()

            assertTrue(operations.start {
                try {
                    entered.complete(Unit)
                    release.await()
                } finally {
                    finished.complete(Unit)
                }
            })
            entered.await()

            assertTrue(operations.active)
            assertFalse(operations.start { secondOperationReads++ })
            assertEquals(0, secondOperationReads)

            release.complete(Unit)
            finished.await()
            assertFalse(operations.active)
            assertTrue(operations.start { secondOperationReads++ })
            assertEquals(1, secondOperationReads)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun pauseCancelsDelayedFirstReadBeforeSecondReadOrPublication() = runBlocking<Unit> {
        val scope = foregroundScope()
        try {
            val operations = ForegroundOperations(scope)
            val firstReadStarted = CompletableDeferred<Unit>()
            val firstReadResponse = CompletableDeferred<Unit>()
            val finished = CompletableDeferred<Unit>()
            var secondReads = 0
            var publications = 0
            operations.resume()

            assertTrue(operations.start {
                try {
                    firstReadStarted.complete(Unit)
                    firstReadResponse.await()
                    secondReads++
                    publications++
                } finally {
                    finished.complete(Unit)
                }
            })
            firstReadStarted.await()

            operations.pause()
            firstReadResponse.complete(Unit)
            finished.await()

            assertEquals(0, secondReads)
            assertEquals(0, publications)
            assertFalse(operations.active)
            assertFalse(operations.start { secondReads++ })
            assertEquals(0, secondReads)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun resumeAfterPauseAllowsFreshReadWithoutRevivingCancelledRead() = runBlocking<Unit> {
        val scope = foregroundScope()
        try {
            val operations = ForegroundOperations(scope)
            val oldReadEntered = CompletableDeferred<Unit>()
            val oldReadResponse = CompletableDeferred<Unit>()
            val oldReadFinished = CompletableDeferred<Unit>()
            var oldReadPublications = 0
            var newReads = 0
            operations.resume()
            assertTrue(operations.start {
                try {
                    oldReadEntered.complete(Unit)
                    oldReadResponse.await()
                    oldReadPublications++
                } finally {
                    oldReadFinished.complete(Unit)
                }
            })
            oldReadEntered.await()

            operations.pause()
            oldReadResponse.complete(Unit)
            oldReadFinished.await()
            operations.resume()

            assertTrue(operations.start { newReads++ })
            assertEquals(1, newReads)
            assertEquals(0, oldReadPublications)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun pauseCancelsOnlyTheOperationAndKeepsTheOwningScopeUsable() = runBlocking<Unit> {
        val scope = foregroundScope()
        try {
            val unrelatedRelease = CompletableDeferred<Unit>()
            val unrelatedFinished = CompletableDeferred<Unit>()
            var unrelatedPublications = 0
            scope.launch {
                unrelatedRelease.await()
                unrelatedPublications++
                unrelatedFinished.complete(Unit)
            }
            val operations = ForegroundOperations(scope)
            val readEntered = CompletableDeferred<Unit>()
            val readRelease = CompletableDeferred<Unit>()
            val readFinished = CompletableDeferred<Unit>()
            var readPublications = 0
            operations.resume()
            assertTrue(operations.start {
                try {
                    readEntered.complete(Unit)
                    readRelease.await()
                    readPublications++
                } finally {
                    readFinished.complete(Unit)
                }
            })
            readEntered.await()

            operations.pause()
            readRelease.complete(Unit)
            readFinished.await()
            unrelatedRelease.complete(Unit)
            unrelatedFinished.await()

            assertEquals(0, readPublications)
            assertEquals(1, unrelatedPublications)
        } finally {
            scope.cancel()
        }
    }
}
