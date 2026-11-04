// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import android.app.Instrumentation
import android.app.job.JobScheduler
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.klebb.companion.PairingProofActivity
import app.klebb.companion.protocol.ApprovedOrigin
import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.DurablePairingStore
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.JsonObject
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.queue.BlobKind
import app.klebb.companion.queue.KeystoreQueueCipher
import app.klebb.companion.queue.KeystoreQueueKey
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueDatabase
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.records.EncodedRecord
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.KeyStore
import java.security.cert.Certificate
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.time.temporal.ChronoUnit
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real owned Room/Keystore/UI control with synthetic readers and HTTPS replies, not SDK/server proof. */
@RunWith(AndroidJUnit4::class)
class CategorySelectionStopInstrumentedTest {
    private val types = listOf("WeightRecord", "StepsRecord")
    private val open = { ReadGate.OPEN }
    private val pairFile = "health-pairing-private-v1"
    private val pairingAlias = "health-pairing-private-v1"
    private val instantMillis = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

    @Test fun STOP01_actualWeightCheckboxPurgesItsTwoPendingBatchesAndKeepsSteps() = runBlocking<Unit> {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext.applicationContext
        // Dirty target storage is setup HOLD, never the intended expected-zero/actual-two RED.
        assertTrue("SETUP HOLD: clean emulator only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        assertEquals("SETUP HOLD: established native fixture target", 35, Build.VERSION.SDK_INT)
        val databaseFile = context.getDatabasePath(ManualFirstPageCapture.DATABASE)
        assertFalse("SETUP HOLD: existing production database", databaseFile.exists())
        assertFalse("SETUP HOLD: existing production WAL", java.io.File(databaseFile.path + "-wal").exists())
        assertFalse("SETUP HOLD: existing production SHM", java.io.File(databaseFile.path + "-shm").exists())
        assertTrue("SETUP HOLD: existing pairing preferences",
            context.getSharedPreferences(pairFile, Context.MODE_PRIVATE).all.isEmpty())
        assertTrue("SETUP HOLD: existing saved selections",
            context.getSharedPreferences(OrdinarySyncSettings.FILE, Context.MODE_PRIVATE).all.isEmpty())
        assertFalse("SETUP HOLD: existing pairing key", keyStore().containsAlias(pairingAlias))
        assertFalse("SETUP HOLD: existing queue key", keyStore().containsAlias(ManualFirstPageCapture.KEY_ALIAS))
        val scheduler = context.getSystemService(JobScheduler::class.java)
        assertTrue("SETUP HOLD: existing owned scheduled work", scheduler == null ||
            scheduler.allPendingJobs.none { it.id == OrdinarySyncJobService.JOB_ID })

        var database: QueueDatabase? = null
        var session: InMemoryPairingSession? = null
        var activity: PairingProofActivity? = null
        var weightControl: CheckBox? = null
        var failure: Throwable? = null
        try {
            val protocol = DurablePairingStore.protocol(context)
            val store = DurablePairingStore(context)
            val paired = store.open(protocol)
            assertNull("SETUP HOLD: existing cached owner", paired.destination)
            assertTrue("SETUP HOLD: existing cached categories", paired.categories.isEmpty())
            session = paired
            installControlledPairing(paired)
            val settings = OrdinarySyncSettings(context)
            assertTrue("SETUP HOLD: confirmed initial selections",
                settings.save(OrdinarySyncChoices(types.toSet(), true, false)))
            val db = Room.databaseBuilder(context, QueueDatabase::class.java,
                ManualFirstPageCapture.DATABASE).build()
            database = db
            ok(KeystoreQueueKey.initializeEmpty(db, ManualFirstPageCapture.KEY_ALIAS))
            val queue = RoomDurableBatchQueue(db, KeystoreQueueCipher(ManualFirstPageCapture.KEY_ALIAS),
                protocol, paired, 100L, 4_194_304L)
            val weight = stageOwnedFirstPage(protocol, paired, queue, "WeightRecord", "4", "10",
                "fixed-weight-changes-4", "fixed-weight-page-2")
            val second = ok(queue.prepareOrdinaryPage(weight,
                reader("WeightRecord", "fixed-weight-page-2", page("WeightRecord", "pending-weight-12", null)), open))
            val secondReceipt = ok(ImmutableBatchCoordinator(queue, protocol, paired, open)
                .stagePage(weight, second.page, second))
            assertEquals("12", sequence(protocol, checkNotNull(secondReceipt.batch)))
            val steps = stageOwnedFirstPage(protocol, paired, queue, "StepsRecord", "7", "3",
                "fixed-steps-changes-7", null)
            assertEquals("10", paired.batchScope("WeightRecord").acknowledgedSequence)
            assertEquals("3", paired.batchScope("StepsRecord").acknowledgedSequence)
            assertEquals("SETUP HOLD: two genuine queued Weight batches", 2, payloadCount(db, weight))
            assertEquals("SETUP HOLD: one genuine queued Steps batch", 1, payloadCount(db, steps))
            val stepsBefore = snapshot(db, steps)
            assertFalse("SETUP HOLD: healthy sibling snapshot", stepsBefore.isEmpty())
            assertNotNull("SETUP HOLD: Weight controlled completed readiness", paired.readinessCompleted("WeightRecord"))
            assertNotNull("SETUP HOLD: Steps controlled completed readiness", paired.readinessCompleted("StepsRecord"))
            assertSame("SETUP HOLD: Activity must open this exact encrypted paired owner", paired, store.open(protocol))

            val launched = instrumentation.startActivitySync(Intent(context, PairingProofActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as PairingProofActivity
            activity = launched
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val boxes = checkBoxes(launched.window.decorView)
                val weightBox = boxes.single { it.text.toString() == "Weight" }
                weightControl = weightBox
                val stepsBox = boxes.single { it.text.toString() == "Steps" }
                assertTrue("SETUP HOLD: Weight initially selected", weightBox.isChecked)
                assertTrue("SETUP HOLD: Steps initially selected", stepsBox.isChecked)
                assertTrue("SETUP HOLD: actual control is enabled", weightBox.isEnabled)
                weightBox.performClick()
                assertFalse(weightBox.isChecked)
                assertTrue(stepsBox.isChecked)
            }
            // The listener disables this control until its owned local purge commits or refuses.
            // Baseline leaves it enabled, so it still reaches the pending-two/expected-zero assertion.
            awaitLocalStopControl(instrumentation, checkNotNull(weightControl))
            assertEquals("Confirmed Weight deselection must remain saved", setOf("StepsRecord"), settings.read().selected)
            assertEquals("Healthy Steps rows must remain byte-for-byte unchanged", stepsBefore, snapshot(db, steps))
            assertEquals("Confirmed Weight stop must purge both pending phone batches", 0, payloadCount(db, weight))
        } catch (caught: Throwable) {
            failure = caught
            throw caught
        } finally {
            // Only resources proven absent above and created by this test are restored/removed.
            // Cleanup errors are suppressed on the original assertion/cancellation, never replace it.
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                val cleanupFailures = mutableListOf<Throwable>()
                suspend fun cleanup(action: suspend () -> Unit) {
                    try { action() } catch (caught: Throwable) { cleanupFailures.add(caught) }
                }
                cleanup {
                    activity?.let { owned ->
                        instrumentation.runOnMainSync { owned.finish() }
                        instrumentation.waitForIdleSync()
                    }
                }
                var localStopReleased = weightControl == null
                cleanup {
                    weightControl?.let { awaitLocalStopControl(instrumentation, it) }
                    localStopReleased = true
                }
                cleanup { database?.close() }
                if (localStopReleased) {
                    cleanup { session?.let { DurablePairingStore(context).forget(it) } }
                    cleanup { check(context.getSharedPreferences(OrdinarySyncSettings.FILE, Context.MODE_PRIVATE).edit().clear().commit()) }
                    cleanup { check(context.getSharedPreferences(pairFile, Context.MODE_PRIVATE).edit().clear().commit()) }
                    cleanup { context.deleteDatabase(ManualFirstPageCapture.DATABASE) }
                    cleanup { val keys = keyStore(); if (keys.containsAlias(ManualFirstPageCapture.KEY_ALIAS)) keys.deleteEntry(ManualFirstPageCapture.KEY_ALIAS) }
                    cleanup { val keys = keyStore(); if (keys.containsAlias(pairingAlias)) keys.deleteEntry(pairingAlias) }
                } else {
                    cleanupFailures.add(IllegalStateException(
                        "CLEANUP HOLD: local stop may still own storage; test-owned database, keys and preferences retained"))
                }
                if (failure != null) cleanupFailures.forEach { failure!!.addSuppressed(it) }
                else if (cleanupFailures.isNotEmpty()) {
                    val first = cleanupFailures.first()
                    cleanupFailures.drop(1).forEach { first.addSuppressed(it) }
                    throw first
                }
            }
        }
    }

    internal fun installControlledPairing(session: InMemoryPairingSession) {
        val original = JSONObject(asset("room-durable-batch-inputs-v1.json"))
        val grant = JSONObject(original.getString("grant")).put("categories", JSONArray(types))
            .put("expiresAt", instantMillis.format(Instant.now().truncatedTo(ChronoUnit.MILLIS).plusSeconds(300)))
        session.approveDestination("https://health.example.test")
        session.prepareGrant(grant.toString().toByteArray(Charsets.UTF_8))
        val attempt = session.beginExchange()
        val installation = JSONObject(String(attempt.body, Charsets.UTF_8)).getString("installationId")
        val paired = JSONObject(original.getString("paired")).put("installationId", installation)
            .put("categories", JSONArray(types)).put("streams", JSONObject()
                .put("WeightRecord", JSONObject().put("generation", "3").put("acknowledgedSequence", "10"))
                .put("StepsRecord", JSONObject().put("generation", "6").put("acknowledgedSequence", "3")))
        session.acceptPairing(attempt, paired.toString().toByteArray(Charsets.UTF_8))
        assertEquals(types.toSet(), session.categories)
    }

    /** Shared test-owned fixture; all authority and page commits use the existing real entrypoints. */
    internal suspend fun stageStopFixture(protocol: HealthProtocol, session: InMemoryPairingSession,
        queue: RoomDurableBatchQueue): Pair<BatchOwner, BatchOwner> {
        val weight = stageOwnedFirstPage(protocol, session, queue, "WeightRecord", "4", "10",
            "fixed-weight-changes-4", "fixed-weight-page-2")
        val second = ok(queue.prepareOrdinaryPage(weight,
            reader("WeightRecord", "fixed-weight-page-2", page("WeightRecord", "pending-weight-12", null)), open))
        val secondReceipt = ok(ImmutableBatchCoordinator(queue, protocol, session, open)
            .stagePage(weight, second.page, second))
        assertEquals("12", sequence(protocol, checkNotNull(secondReceipt.batch)))
        val steps = stageOwnedFirstPage(protocol, session, queue, "StepsRecord", "7", "3",
            "fixed-steps-changes-7", null)
        return weight to steps
    }

    private suspend fun stageOwnedFirstPage(protocol: HealthProtocol, session: InMemoryPairingSession,
        queue: RoomDurableBatchQueue, type: String, generation: String, ack: String,
        token: String, next: String?): BatchOwner {
        val start = if (type == "WeightRecord") "2001-02-03T00:00:00.000Z" else "2001-10-28T00:00:00.000Z"
        val end = if (type == "WeightRecord") "2001-02-04T00:00:00.000Z" else "2001-10-29T00:00:00.000Z"
        val scope = WeightReadScope(Instant.parse(start), Instant.parse(end), 2)
        val old = session.batchScope(type)
        val binding = old.binding + ("generation" to generation)
        val query = ControlJson.text(linkedMapOf("recordType" to type, "window" to linkedMapOf(
            "start" to start, "end" to end), "pageSize" to 2L))
        fun result(owned: Map<String, String>, revision: String, enabled: Boolean): JsonObject = linkedMapOf(
            "version" to 2L, "kind" to "readiness-result", "recordType" to type, "binding" to owned,
            "policyRevision" to revision, "sharing" to if (enabled) "enabled" else "stopped",
            "verification" to if (enabled) "authenticated-companion-report" else "unverified")
        val replies = listOf(result(old.binding, "10", false), linkedMapOf(
            "version" to 2L, "kind" to "readiness-challenge", "readinessId" to "hc_ready_" + "Q".repeat(43),
            "recordType" to type, "binding" to binding, "policyRevision" to "11", "queryJson" to query,
            "filterDigest" to protocol.payloadDigest(query), "acknowledgedSequence" to ack,
            "expiresAt" to instantMillis.format(Instant.now().truncatedTo(ChronoUnit.MILLIS).plusSeconds(300))),
            result(binding, "12", true))
        var requests = 0
        val transport = PairingTransport(ApprovedOrigin.parse("https://health.example.test")) { url ->
            assertEquals("/api/connectors/health-connect/v2/streams/$type/readiness", url.path)
            ControlledReply(url, ControlJson.text(replies[requests++]))
        }
        var failure: Throwable? = null
        try {
            val challenge = session.beginFirstPage(transport, type, scope)
            assertEquals(binding, challenge.binding)
            assertEquals(ack, challenge.acknowledgedSequence)
            val localId = "ordinary-first-page:" + protocol.payloadDigest(
                ControlJson.text(listOf(challenge.binding, type))).removePrefix("sha256:")
            val owner = ok(queue.openStream(localId, type, generation.toLong(), scope, open))
            val events = mutableListOf<String>()
            val prepared = ok(queue.prepareFirstOrdinaryPage(owner,
                reader(type, null, page(type, "pending-$type-first", next), events), {
                    events.add("token"); token
                }, open))
            assertEquals(listOf("token", "read"), events)
            val receipt = ok(ImmutableBatchCoordinator(queue, protocol, session, open)
                .stagePage(owner, prepared.page, prepared))
            val committed = checkNotNull(receipt.firstPage)
            assertTrue(ok(queue.acceptsFirstPageCommit(owner, committed, open)))
            assertEquals(if (type == "WeightRecord") "11" else "4", sequence(protocol, checkNotNull(receipt.batch)))
            // Existing Session wire-test report fixture; no actual SDK permission/token claim.
            val facts: JsonObject = linkedMapOf("localReadRevision" to "1", "recordCount" to committed.recordCount.toString(),
                "terminalPage" to committed.terminalPage, "permissionFingerprintStart" to "sha256:" + "a".repeat(64),
                "permissionFingerprintEnd" to "sha256:" + "a".repeat(64), "tokenValid" to true,
                "historyWindowLimited" to true, "interveningChangeCount" to "0", "changesHaveMore" to false)
            assertEquals("enabled", session.completeFirstPage(transport, challenge, facts)["sharing"])
            assertEquals(3, requests)
            return owner
        } catch (caught: Throwable) {
            failure = caught
            throw caught
        } finally {
            try { session.cancelTransportRequests(transport) }
            catch (cleanup: Throwable) { if (failure != null) failure!!.addSuppressed(cleanup) else throw cleanup }
        }
    }

    private fun reader(type: String, requested: String?, answer: OrdinaryRecordPage,
        events: MutableList<String> = mutableListOf()) = object : OrdinaryRecordReader {
        override val recordType = type
        override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
            assertEquals(requested, pageToken)
            events.add("read")
            return answer
        }
    }
    private fun page(type: String, id: String, next: String?): OrdinaryRecordPage {
        val key = if (type == "WeightRecord") "weightFull" else "stepsFull"
        val record = JSONObject(asset("initial-page-record-codecs-v1.json")).getJSONObject(key)
        record.getJSONObject("metadata").put("id", id)
        return OrdinaryRecordPage(listOf(EncodedRecord(type, id, record.toString())), next)
    }
    private fun sequence(protocol: HealthProtocol, batch: QueuedBatch) =
        JSONObject(protocol.decode(batch.copyWire()).fields["payloadJson"] as String).getString("sequence")
    private fun payloadCount(db: QueueDatabase, owner: BatchOwner) = db.blobs().all().count {
        it.localStreamId == owner.localStreamId && it.kind == BlobKind.PAYLOAD.stored
    }
    private data class SavedRow(val id: String, val kind: String, val version: Int,
        val nonce: String, val ciphertext: String, val bytes: Int)
    private fun snapshot(db: QueueDatabase, owner: BatchOwner) = db.blobs().all()
        .filter { it.localStreamId == owner.localStreamId }.map { row ->
            SavedRow(row.rowId, row.kind, row.version, hex(row.nonce), hex(row.ciphertextAndTag), row.encryptedBytes)
        }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun checkBoxes(view: View): List<CheckBox> = when (view) {
        is CheckBox -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { checkBoxes(view.getChildAt(it)) }
        else -> emptyList()
    }
    private suspend fun awaitLocalStopControl(instrumentation: Instrumentation, control: CheckBox) {
        val deadline = SystemClock.uptimeMillis() + 10_000L
        while (true) {
            var enabled = false
            instrumentation.runOnMainSync { enabled = control.isEnabled }
            if (enabled) return
            assertTrue("OBSERVATION HOLD: local stop has not finished within the existing request bound",
                SystemClock.uptimeMillis() < deadline)
            kotlinx.coroutines.delay(10L)
        }
    }
    private fun asset(name: String) = InstrumentationRegistry.getInstrumentation().context.assets.open(name)
        .bufferedReader(Charsets.UTF_8).use { it.readText() }
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun <T> ok(value: QueueResult<T>): T {
        assertTrue("SETUP HOLD: expected existing typed fixture success, got $value", value is Ok<*>)
        @Suppress("UNCHECKED_CAST") return (value as Ok<T>).value
    }
    private class ControlledReply(url: URL, reply: String) : HttpsURLConnection(url) {
        private val bytes = reply.toByteArray(Charsets.UTF_8)
        private val sent = ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getResponseCode() = 200
        override fun getInputStream() = ByteArrayInputStream(bytes.copyOf())
        override fun getOutputStream() = sent
        override fun getCipherSuite() = "test"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
    }
}