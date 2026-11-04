// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal enum class OrdinarySyncScheduleResult { SCHEDULED, CANCELLED, UNAVAILABLE }

/** Platform-delayed periodic work; scheduling is neither permission nor sync evidence. */
class OrdinarySyncJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val invocationLock = Any()
    private var current: Invocation? = null

    private class Invocation(val parameters: JobParameters) {
        var stopped = false
        lateinit var operation: Job
    }

    override fun onStartJob(params: JobParameters): Boolean {
        if (params.jobId != JOB_ID) return false
        val invocation = synchronized(invocationLock) {
            // Keep even a stopping invocation owned until its finally has completed.
            if (current != null) return false
            Invocation(params).also { next ->
                next.operation = scope.launch(start = CoroutineStart.LAZY) { execute(next) }
                current = next
            }
        }
        if (!invocation.operation.start()) {
            synchronized(invocationLock) {
                if (current === invocation) current = null
            }
            return false
        }
        return true
    }

    private fun isCurrent(invocation: Invocation): Boolean = synchronized(invocationLock) {
        current === invocation && !invocation.stopped
    }

    private suspend fun execute(invocation: Invocation) {
        val coroutine = currentCoroutineContext()
        try {
            val settings = OrdinarySyncSettings(this)
            val choices = settings.read()
            if (!choices.backgroundEnabled || choices.selected.isEmpty() ||
                !isCurrent(invocation) || !coroutine.isActive) return
            // Preserve the concrete service context: the runner must require genuine
            // background feature/grant evidence and recheck its own final commit fences.
            OrdinarySyncRunner(this@OrdinarySyncJobService).run {
                coroutine.isActive && isCurrent(invocation) && settings.read() == choices
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // No result is promoted to native, upload or permission success.
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                val finish = synchronized(invocationLock) {
                    if (current !== invocation) false else {
                        current = null
                        !invocation.stopped
                    }
                }
                if (finish) jobFinished(invocation.parameters, false)
            }
        }
    }

    override fun onStopJob(params: JobParameters): Boolean {
        if (params.jobId != JOB_ID) return false
        val operation = ManualFirstPageCapture.underCommitFence {
            synchronized(invocationLock) {
                // Stop parameters can be newly parcelled; the owned job id is the match.
                current?.also { it.stopped = true }?.operation
            }
        }
        operation?.cancel()
        // The next eligible periodic run remains; do not start an immediate retry loop.
        return false
    }

    override fun onDestroy() {
        val operation = ManualFirstPageCapture.underCommitFence {
            synchronized(invocationLock) { current?.also { it.stopped = true }?.operation }
        }
        operation?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        internal const val JOB_ID = 0x4f5301
        internal const val PERIOD_MILLIS = 3_600_000L

        /** The caller supplies saved-pairing eligibility, never protocol authority. */
        internal fun reconcile(
            context: Context,
            choices: OrdinarySyncChoices,
            hasSavedPairing: Boolean
        ): OrdinarySyncScheduleResult = ManualFirstPageCapture.underCommitFence {
            val application = context.applicationContext
            val scheduler = try {
                application.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler
            } catch (_: Exception) {
                null
            } ?: return@underCommitFence OrdinarySyncScheduleResult.UNAVAILABLE
            try {
                val saved = OrdinarySyncSettings(application).read()
                if (saved != choices || choices.selected.isEmpty() ||
                    !setOf("WeightRecord", "StepsRecord").containsAll(choices.selected) ||
                    !choices.backgroundEnabled || !hasSavedPairing) {
                    scheduler.cancel(JOB_ID)
                    OrdinarySyncScheduleResult.CANCELLED
                } else {
                    val network = if (choices.wifiOnly) JobInfo.NETWORK_TYPE_UNMETERED
                        else JobInfo.NETWORK_TYPE_ANY
                    val job = JobInfo.Builder(JOB_ID, ComponentName(application,
                        OrdinarySyncJobService::class.java))
                        .setPeriodic(PERIOD_MILLIS)
                        .setPersisted(true)
                        .setRequiredNetworkType(network)
                        .build()
                    if (scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) {
                        // The platform may delay a run, including while offline or idle.
                        OrdinarySyncScheduleResult.SCHEDULED
                    } else {
                        scheduler.cancel(JOB_ID)
                        OrdinarySyncScheduleResult.UNAVAILABLE
                    }
                }
            } catch (_: Exception) {
                try { scheduler.cancel(JOB_ID) } catch (_: Exception) { }
                OrdinarySyncScheduleResult.UNAVAILABLE
            }
        }
    }
}
