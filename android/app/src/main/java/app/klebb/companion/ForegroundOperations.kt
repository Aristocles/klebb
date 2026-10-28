// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

// Lifecycle calls and the owning scope use the same dispatcher.
class ForegroundOperations(private val scope: CoroutineScope) {
    private var foreground = false
    private var operation: Job? = null

    val active: Boolean
        get() = operation != null

    fun resume() {
        foreground = true
    }

    fun pause() {
        foreground = false
        operation?.cancel()
    }

    fun start(block: suspend () -> Unit): Boolean {
        if (!foreground || active) return false
        val nextOperation = scope.launch(start = CoroutineStart.LAZY) { block() }
        operation = nextOperation
        nextOperation.invokeOnCompletion {
            if (operation === nextOperation) operation = null
        }
        nextOperation.start()
        return true
    }
}
