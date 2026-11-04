// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.HealthFrame
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.JsonObject
import app.klebb.companion.protocol.LocalCategoryStopReceipt
import app.klebb.companion.protocol.PairedBatchScope
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.protocol.ValidationContext
import app.klebb.companion.protocol.objectValue
import app.klebb.companion.queue.BlobKind
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.EncryptedBlobStore
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueBlob
import app.klebb.companion.queue.QueueCipher
import app.klebb.companion.queue.QueueDatabase
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.queue.QueueStreamPurger
import app.klebb.companion.records.EncodedRecord
import java.time.Instant
import java.util.UUID
import java.util.Collections
import java.util.concurrent.Callable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray

/** Issued after an actual reader call, not from caller-supplied checkpoint bytes. */
internal class PreparedOrdinaryPage private constructor(
    private val issuer: Any,
    internal val owner: BatchOwner,
    internal val query: WeightReadScope,
    internal val requestedToken: String?,
    internal val revision: Long,
    val page: OrdinaryRecordPage,
    internal val initialChangesToken: String? = null
) {
    internal fun issuedBy(candidate: Any): Boolean = issuer === candidate
    internal companion object {
        fun issue(issuer: Any, owner: BatchOwner, query: WeightReadScope,
            requestedToken: String?, revision: Long, page: OrdinaryRecordPage,
            initialChangesToken: String? = null) =
            PreparedOrdinaryPage(issuer, owner, query, requestedToken, revision, page, initialChangesToken)
    }
    override fun toString() = "PreparedOrdinaryPage"
}

/** Local commit facts, admitted only by the private issuer of the actual Room queue. */
internal class FirstPageCommit private constructor(
    private val issuer: Any,
    internal val owner: BatchOwner,
    val query: WeightReadScope,
    val initialChangesToken: String,
    val recordCount: Long,
    val nextPageToken: String?
) {
    val terminalPage: Boolean get() = nextPageToken == null
    internal fun issuedBy(candidate: Any): Boolean = issuer === candidate
    internal fun sameFacts(other: FirstPageCommit): Boolean =
        owner.localStreamId == other.owner.localStreamId && owner.recordType == other.owner.recordType &&
            owner.binding == other.owner.binding && owner.localFenceEpoch == other.owner.localFenceEpoch &&
            query.start == other.query.start && query.end == other.query.end && query.pageSize == other.query.pageSize &&
            initialChangesToken == other.initialChangesToken && recordCount == other.recordCount &&
            nextPageToken == other.nextPageToken
    internal companion object {
        fun issue(issuer: Any, owner: BatchOwner, query: WeightReadScope, token: String,
            count: Long, next: String?) = FirstPageCommit(issuer, owner, query, token, count, next)
    }
    override fun toString() = "FirstPageCommit"
}

internal class OrdinaryPageProgress(val query: WeightReadScope, val terminal: Boolean)

/** Issued only after this queue observes the stopped category's committed local purge. */
internal class CategoryPurgeReceipt private constructor(
    private val issuer: Any,
    internal val stop: LocalCategoryStopReceipt,
    internal val localStreamId: String,
    internal val markerRowId: String?,
    internal val markerNonce: ByteArray?,
    internal val markerCiphertext: ByteArray?
) {
    internal fun issuedBy(candidate: Any): Boolean = issuer === candidate
    internal companion object {
        fun issue(issuer: Any, stop: LocalCategoryStopReceipt, localStreamId: String,
            marker: QueueBlob?) = CategoryPurgeReceipt(issuer, stop, localStreamId,
            marker?.rowId, marker?.nonce?.copyOf(), marker?.ciphertextAndTag?.copyOf())
    }
    override fun toString() = "CategoryPurgeReceipt"
}

/** A complete native changes response; never an already queued retry body. */
internal sealed class NativeRecordChange {
    class Upsert(val record: EncodedRecord) : NativeRecordChange()
    class Delete(val nativeRecordId: String) : NativeRecordChange()
}

internal class NativeChangesPage(changes: List<NativeRecordChange>,
    val nextChangesToken: String, val hasMore: Boolean) {
    val changes: List<NativeRecordChange> = Collections.unmodifiableList(ArrayList(changes))
    init { require(nextChangesToken.isNotEmpty()) }
}

internal class NativeChangesProgress(val query: WeightReadScope, val token: String,
    internal val revision: Long, val hasMore: Boolean)

/** Only this actual queue can issue and later admit the observed complete page. */
internal class PreparedNativeChangesPage private constructor(
    private val issuer: Any, internal val owner: BatchOwner,
    internal val progress: NativeChangesProgress, val page: NativeChangesPage
) {
    internal fun issuedBy(candidate: Any): Boolean = issuer === candidate
    internal companion object {
        fun issue(issuer: Any, owner: BatchOwner, progress: NativeChangesProgress,
            page: NativeChangesPage) = PreparedNativeChangesPage(issuer, owner, progress, page)
    }
}

/**
 * Off-main-thread Room operations under the caller's existing shared coordinator lock/fence.
 * STATE and cursors are private local metadata, never wire coverage or policy authority.
 * A missing or purged head cannot resume. No counters or pending order are held in RAM.
 */
internal class RoomDurableBatchQueue(
    private val db: QueueDatabase,
    private val cipher: QueueCipher,
    private val protocol: HealthProtocol,
    private val session: InMemoryPairingSession,
    private val maximumRows: Long,
    private val maximumEncryptedBytes: Long,
    private val nextBatchId: () -> String = { UUID.randomUUID().toString() }
) : DurableBatchQueue {
    private val store = EncryptedBlobStore(db, cipher)
    private val pageIssuer = Any()
    private val purgeIssuer = Any()
    private data class Ack(val sequence: Long, val batchId: String, val digest: String)
    private data class Head(val query: WeightReadScope, val allocated: Long, val ack: Long,
        val revision: Long, val nextToken: String?, val terminal: Boolean,
        val cursor: String?, val lastAck: Ack?)
    private data class Loaded(val row: QueueBlob, val head: Head)
    private data class Wire(val bytes: ByteArray, val frame: HealthFrame, val payload: JsonObject,
        val sequence: Long, val batchId: String, val digest: String)
    private class Refused(val result: Blocked) : RuntimeException()

    /**
     * Stop is Session-issued and durable before this transaction. Only the exact old
     * category namespace is inspected; its remaining payloads must be locally pending.
     * Server records and sibling streams are outside this deletion.
     */
    fun purgeStoppedCategory(stop: LocalCategoryStopReceipt): QueueResult<CategoryPurgeReceipt> = tx {
        if (!session.isCurrentLocalStop(stop)) reject("stale-sharing-stop")
        val owner = stoppedOwner(stop)
        val markerId = prefix(owner) + ":sharing-stop"
        val rows = db.blobs().forStream(owner.localStreamId)
        val marker = if (rows.isEmpty()) {
            null
        } else if (rows.size == 1 && rows.single().rowId == markerId) {
            requirePurgeMarker(owner, rows.single())
            rows.single()
        } else {
            if (rows.size.toLong() > maximumRows || rows.any { it.rowId == markerId }) {
                reject("corrupt-stopped-stream")
            }
            checkBounds(owner)
            val head = load(owner, stop.pairedScope).head
            if (head.allocated - head.ack > maximumRows) reject("corrupt-stopped-stream")
            val expectedPayloads = linkedSetOf<String>()
            var sequence = head.ack
            while (sequence < head.allocated) {
                sequence = increment(sequence)
                val wire = wire(owner, stop.pairedScope,
                    readOwned(owner, payloadId(owner, sequence), BlobKind.PAYLOAD))
                val cursor = checkedCursor(owner, cursorId(owner, sequence))
                if (wire.sequence != sequence || cursor["query"] != queryObject(head.query) ||
                    decimal(cursor["revision"] as String) > head.revision ||
                    cursor["sequence"] != sequence.toString() || cursor["batchId"] != wire.batchId ||
                    cursor["payloadDigest"] != wire.digest || cursor["uploadEligible"] != true) {
                    reject("corrupt-stopped-stream")
                }
                expectedPayloads.add(payloadId(owner, sequence))
                if (wire.frame.kind == "object-finalise") {
                    val parts = readParts(owner, wire)
                    try {
                        CompleteRecordObject.validateParts(protocol, context(owner, stop.pairedScope),
                            wire.frame, parts)
                        for (index in parts.indices) expectedPayloads.add(partId(owner, sequence, index))
                    } finally { parts.forEach { it.fill(0) } }
                }
            }
            if (rows.filter { it.kind == BlobKind.PAYLOAD.stored }.map { it.rowId }.toSet() !=
                expectedPayloads) reject("corrupt-stopped-stream")
            for (row in rows) {
                when {
                    row.rowId == headId(owner) && row.kind == BlobKind.STATE.stored -> Unit
                    row.rowId in expectedPayloads && row.kind == BlobKind.PAYLOAD.stored -> Unit
                    row.kind == BlobKind.CURSOR.stored && row.rowId == firstTokenId(owner) -> {
                        val value = StrictJson.parse(readOwned(owner, row.rowId, BlobKind.CURSOR)).objectValue()
                        if (value.keys != FIRST_TOKEN_KEYS || value["format"] != "initial-ordinary-token-v1" ||
                            value["binding"] != owner.binding || value["localStreamId"] != owner.localStreamId ||
                            value["recordType"] != owner.recordType ||
                            value["localFenceEpoch"] != owner.localFenceEpoch.toString() ||
                            value["query"] != queryObject(head.query) || value["revision"] != "1" ||
                            (value["initialChangesToken"] as? String).isNullOrEmpty() ||
                            value["terminalPage"] != (nullableString(value["nextPageToken"]) == null)) {
                            reject("corrupt-stopped-stream")
                        }
                        decimal(value["recordCount"] as String)
                    }
                    row.kind == BlobKind.CURSOR.stored && row.rowId == changesTokenId(owner) -> {
                        val value = StrictJson.parse(readOwned(owner, row.rowId, BlobKind.CURSOR)).objectValue()
                        if (value.keys != CHANGES_TOKEN_KEYS || value["format"] != "native-changes-token-v1" ||
                            value["binding"] != owner.binding || value["localStreamId"] != owner.localStreamId ||
                            value["recordType"] != owner.recordType ||
                            value["localFenceEpoch"] != owner.localFenceEpoch.toString() ||
                            value["query"] != queryObject(head.query) ||
                            value["revision"] != head.revision.toString() ||
                            (value["changesToken"] as? String).isNullOrEmpty() ||
                            value["hasMore"] !is Boolean) reject("corrupt-stopped-stream")
                    }
                    row.kind == BlobKind.CURSOR.stored -> {
                        val value = checkedCursor(owner, row.rowId)
                        if (value["query"] != queryObject(head.query) ||
                            decimal(value["revision"] as String) > head.revision ||
                            (row.rowId != head.cursor && (value["uploadEligible"] != true ||
                                payloadId(owner, decimal(value["sequence"] as String)) !in expectedPayloads))) {
                            reject("corrupt-stopped-stream")
                        }
                    }
                    else -> reject("foreign-stopped-row")
                }
            }
            if (!session.isCurrentLocalStop(stop)) reject("stale-sharing-stop")
            requireOk(QueueStreamPurger(db, cipher)
                .purgeConfirmedUnacknowledgedStream(owner.localStreamId, markerId))
            val remaining = db.blobs().forStream(owner.localStreamId)
            if (remaining.size != 1 || remaining.single().rowId != markerId) reject("purge-unconfirmed")
            requirePurgeMarker(owner, remaining.single())
            remaining.single()
        }
        if (!session.isCurrentLocalStop(stop)) reject("stale-sharing-stop")
        CategoryPurgeReceipt.issue(purgeIssuer, stop, owner.localStreamId, marker)
    }

    /** Fresh admission requires the same private issuer and the actual still-purged rows. */
    fun acceptsCategoryPurge(stop: LocalCategoryStopReceipt,
        receipt: CategoryPurgeReceipt): QueueResult<Boolean> = tx {
        if (!receipt.issuedBy(purgeIssuer) || receipt.stop !== stop ||
            !session.isCurrentLocalStop(stop)) return@tx false
        val owner = stoppedOwner(stop)
        if (receipt.localStreamId != owner.localStreamId) return@tx false
        val rows = db.blobs().forStream(owner.localStreamId)
        if (receipt.markerRowId == null) return@tx rows.isEmpty()
        if (rows.size != 1) return@tx false
        val row = rows.single()
        if (row.rowId != receipt.markerRowId ||
            !row.nonce.contentEquals(receipt.markerNonce) ||
            !row.ciphertextAndTag.contentEquals(receipt.markerCiphertext)) return@tx false
        requirePurgeMarker(owner, row)
        session.isCurrentLocalStop(stop)
    }

    private fun stoppedOwner(stop: LocalCategoryStopReceipt): BatchOwner {
        if (stop.pairedScope.recordType != stop.recordType ||
            stop.pairedScope.binding != stop.binding) reject("stale-sharing-stop")
        val localId = "ordinary-first-page:" + protocol.payloadDigest(
            ControlJson.text(listOf(stop.binding, stop.recordType))).removePrefix("sha256:")
        return BatchOwner(localId, stop.recordType, binding(stop.binding),
            decimal(stop.binding.getValue("generation")))
    }

    private fun requirePurgeMarker(owner: BatchOwner, row: QueueBlob) {
        if (row.rowId != prefix(owner) + ":sharing-stop" || row.kind != BlobKind.STATE.stored ||
            !readOwned(owner, row.rowId, BlobKind.STATE).contentEquals(PURGE_MARKER)) {
            reject("purge-unconfirmed")
        }
    }

    /** Only an entirely absent stream may be seeded from its actual paired ACK frontier. */
    fun openStream(localStreamId: String, recordType: String, localFenceEpoch: Long,
        scope: WeightReadScope, currentGate: () -> ReadGate): QueueResult<BatchOwner> = tx {
        if (localStreamId.isEmpty() || localFenceEpoch < 0L || !scope.supported()) reject("invalid-query")
        gate(currentGate)
        val paired = session.batchScope(recordType)
        val owner = BatchOwner(localStreamId, recordType, binding(paired.binding), localFenceEpoch)
        val row = db.blobs().find(headId(owner))
        if (row == null) {
            // A purge marker or any unknown existing rows require a separate fresh handshake path.
            if (db.blobs().containsStream(localStreamId)) reject("fresh-scan-required")
            val ack = decimal(paired.acknowledgedSequence)
            val head = Head(scope, ack, ack, 0L, null, false, null, null)
            ensureCurrent(owner, paired, currentGate)
            requireOk(store.put(headId(owner), localStreamId, BlobKind.STATE, headBytes(owner, head)))
            checkBounds(owner)
            ensureCurrent(owner, paired, currentGate)
        } else {
            val existing = load(owner).head
            if (!sameQuery(existing.query, scope)) reject("query-mismatch")
            ensureCurrent(owner, paired, currentGate)
        }
        owner
    }

    /** Recovery never seeds a replacement stream or changes its saved query/generation. */
    fun resumeStream(localStreamId: String, recordType: String, localFenceEpoch: Long,
        scope: WeightReadScope, currentGate: () -> ReadGate): QueueResult<BatchOwner> = tx {
        val paired = session.batchScope(recordType)
        val owner = BatchOwner(localStreamId, recordType, binding(paired.binding), localFenceEpoch)
        val h = load(owner).head
        if (!sameQuery(h.query, scope)) reject("query-mismatch")
        if (requireOk(committedFirstPage(owner, currentGate)) == null) reject("first-page-unconfirmed")
        ensureCurrent(owner, paired, currentGate)
        owner
    }

    fun ordinaryPageProgress(owner: BatchOwner,
        currentGate: () -> ReadGate): QueueResult<OrdinaryPageProgress> = tx {
        val paired = current(owner, currentGate)
        val h = load(owner).head
        ensureCurrent(owner, paired, currentGate)
        OrdinaryPageProgress(h.query, h.terminal)
    }

    /** No Room transaction is held across a suspend point or provider call. */
    suspend fun prepareOrdinaryPage(owner: BatchOwner, reader: OrdinaryRecordReader,
        currentGate: () -> ReadGate): QueueResult<PreparedOrdinaryPage> {
        currentCoroutineContext().ensureActive()
        val before = tx {
            val paired = current(owner, currentGate)
            val loaded = load(owner)
            if (loaded.head.terminal) reject("local-page-terminal")
            if (reader.recordType != owner.recordType) reject("wrong-record-type")
            ensureCurrent(owner, paired, currentGate)
            loaded.head
        }
        val head = when (before) { is Blocked -> return before; is Ok -> before.value }
        val page = try {
            reader.readPage(head.query, head.nextToken)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { return Blocked("reader-unavailable", "read-unconfirmed") }
        currentCoroutineContext().ensureActive()
        return tx {
            val paired = current(owner, currentGate)
            val after = load(owner).head
            if (after.revision != head.revision || after.nextToken != head.nextToken ||
                !sameQuery(after.query, head.query)) reject("stale-page")
            if (page.records.any { it.recordType != owner.recordType }) reject("wrong-record-type")
            if (page.nextPageToken != null && page.nextPageToken == head.nextToken) reject("page-cycle")
            ensureCurrent(owner, paired, currentGate)
            PreparedOrdinaryPage.issue(pageIssuer, owner, head.query, head.nextToken, head.revision, page)
        }
    }

    /** Opt-in first page only. The production caller supplies its actual SDK token operation. */
    suspend fun prepareFirstOrdinaryPage(owner: BatchOwner, reader: OrdinaryRecordReader,
        initialChangesToken: suspend () -> String, currentGate: () -> ReadGate): QueueResult<PreparedOrdinaryPage> {
        val first = tx {
            val paired = current(owner, currentGate)
            val h = load(owner).head
            if (h.revision != 0L || h.nextToken != null || h.cursor != null || h.allocated != h.ack ||
                db.blobs().find(firstTokenId(owner)) != null) reject("first-page-already-prepared")
            if (reader.recordType != owner.recordType) reject("wrong-record-type")
            ensureCurrent(owner, paired, currentGate)
            h.query
        }
        val query = when (first) { is Blocked -> return first; is Ok -> first.value }
        val token = try { initialChangesToken().also { require(it.isNotEmpty()) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { return Blocked("token-unconfirmed", "initial-token-unavailable") }
        val guarded = object : OrdinaryRecordReader {
            override val recordType = reader.recordType
            override suspend fun readPage(scope: WeightReadScope, pageToken: String?): OrdinaryRecordPage {
                check(pageToken == null && sameQuery(scope, query)) { "First page changed" }
                return reader.readPage(scope, pageToken)
            }
        }
        val prepared = when (val result = prepareOrdinaryPage(owner, guarded, currentGate)) {
            is Blocked -> return result
            is Ok -> result.value
        }
        if (prepared.revision != 0L || prepared.requestedToken != null ||
            !sameQuery(prepared.query, query)) return Blocked("queue-unavailable", "stale-first-page")
        return Ok(PreparedOrdinaryPage.issue(pageIssuer, owner, query, null, 0L, prepared.page, token))
    }

    /** Reconstruct only verified local storage facts; this is not an SDK/BEGIN attestation. */
    fun committedFirstPage(owner: BatchOwner, currentGate: () -> ReadGate): QueueResult<FirstPageCommit?> = tx {
        val paired = current(owner, currentGate)
        val head = load(owner).head
        val row = db.blobs().find(firstTokenId(owner)) ?: return@tx null
        val value = StrictJson.parse(readOwned(owner, row.rowId, BlobKind.CURSOR)).objectValue()
        if (head.revision < 1L || value.keys != FIRST_TOKEN_KEYS || value["format"] != "initial-ordinary-token-v1" ||
            value["binding"] != owner.binding || value["localStreamId"] != owner.localStreamId ||
            value["recordType"] != owner.recordType || value["localFenceEpoch"] != owner.localFenceEpoch.toString() ||
            value["query"] != queryObject(head.query) || value["revision"] != "1") reject("corrupt-first-token")
        val token = value["initialChangesToken"] as? String ?: reject("corrupt-first-token")
        if (token.isEmpty()) reject("corrupt-first-token")
        val count = decimal(value["recordCount"] as String)
        val next = nullableString(value["nextPageToken"])
        val terminal = value["terminalPage"] as? Boolean ?: reject("corrupt-first-token")
        if (terminal != (next == null)) reject("corrupt-first-token")
        ensureCurrent(owner, paired, currentGate)
        FirstPageCommit.issue(pageIssuer, owner, head.query, token, count, next)
    }

    fun acceptsFirstPageCommit(owner: BatchOwner, receipt: FirstPageCommit,
        currentGate: () -> ReadGate): QueueResult<Boolean> {
        if (!receipt.issuedBy(pageIssuer) || !sameOwner(receipt.owner, owner)) {
            return Blocked("queue-unavailable", "foreign-first-page-receipt")
        }
        return when (val saved = committedFirstPage(owner, currentGate)) {
            is Blocked -> saved
            is Ok -> Ok(saved.value?.sameFacts(receipt) == true)
        }
    }

    fun nativeChangesProgress(owner: BatchOwner,
        currentGate: () -> ReadGate): QueueResult<NativeChangesProgress> = tx {
        val paired = current(owner, currentGate)
        val h = load(owner).head
        if (!h.terminal) reject("ordinary-pages-incomplete")
        val first = requireOk(committedFirstPage(owner, currentGate))
            ?: reject("first-page-unconfirmed")
        val progress = changesProgress(owner, h, first.initialChangesToken)
        ensureCurrent(owner, paired, currentGate)
        progress
    }

    suspend fun prepareNativeChanges(owner: BatchOwner,
        readNative: suspend (String) -> NativeChangesPage,
        currentGate: () -> ReadGate): QueueResult<PreparedNativeChangesPage> {
        currentCoroutineContext().ensureActive()
        val progress = when (val result = nativeChangesProgress(owner, currentGate)) {
            is Blocked -> return result
            is Ok -> result.value
        }
        val page = try { readNative(progress.token) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { return Blocked("changes-unconfirmed", "native-changes-unconfirmed") }
        currentCoroutineContext().ensureActive()
        if (page.nextChangesToken == progress.token && (page.hasMore || page.changes.isNotEmpty())) {
            return Blocked("changes-unconfirmed", "changes-token-cycle")
        }
        if (page.changes.any {
                when (it) {
                    is NativeRecordChange.Upsert -> it.record.recordType != owner.recordType
                    is NativeRecordChange.Delete -> it.nativeRecordId.isEmpty()
                }
            }) return Blocked("changes-unconfirmed", "wrong-native-change")
        return tx {
            val paired = current(owner, currentGate)
            val current = requireOk(nativeChangesProgress(owner, currentGate))
            if (current.revision != progress.revision || current.token != progress.token ||
                !sameQuery(current.query, progress.query)) reject("stale-changes")
            ensureCurrent(owner, paired, currentGate)
            PreparedNativeChangesPage.issue(pageIssuer, owner, progress, page)
        }
    }

    /** One transaction commits every native upsert/delete and the returned progress token. */
    fun stageNativeChanges(owner: BatchOwner, checkpoint: PreparedNativeChangesPage,
        currentGate: () -> ReadGate,
        makeBatch: (sequence: String, batchId: String) -> ByteArray): QueueResult<StageReceipt> = tx {
        val paired = current(owner, currentGate)
        val loaded = load(owner)
        val h = loaded.head
        val progress = requireOk(nativeChangesProgress(owner, currentGate))
        if (!checkpoint.issuedBy(pageIssuer) || !sameOwner(checkpoint.owner, owner) ||
            checkpoint.progress.revision != h.revision || checkpoint.progress.token != progress.token ||
            !sameQuery(checkpoint.progress.query, h.query) || !h.terminal) reject("stale-changes")
        val page = checkpoint.page
        if (page.nextChangesToken == progress.token && (page.hasMore || page.changes.isNotEmpty())) {
            reject("changes-token-cycle")
        }
        val revision = increment(h.revision)
        val wire = if (page.changes.isNotEmpty()) {
            val sequence = increment(h.allocated)
            val batchId = nextBatchId()
            val parsed = wire(owner, paired, makeBatch(sequence.toString(), batchId).copyOf())
            if (parsed.sequence != sequence || parsed.batchId != batchId ||
                parsed.payload != StrictJson.parse(nativeChangesPayload(owner, page.changes,
                    sequence.toString(), batchId).toByteArray(Charsets.UTF_8)).objectValue()) {
                reject("incomplete-changes")
            }
            parsed
        } else null
        val cursorId = if (wire == null) prefix(owner) + ":empty:" + revision else cursorId(owner, wire.sequence)
        val next = h.copy(allocated = wire?.sequence ?: h.allocated, revision = revision, cursor = cursorId)
        val cursor = nativeChangesCursorBytes(owner, next, wire)
        ensureCurrent(owner, paired, currentGate)
        if (wire == null) requireOk(store.put(cursorId, owner.localStreamId, BlobKind.CURSOR, cursor))
        else requireOk(store.putPayloadAndCursor(payloadId(owner, wire.sequence), cursorId,
            owner.localStreamId, wire.bytes, cursor, maximumEncryptedBytes))
        if (db.blobs().find(changesTokenId(owner)) != null) {
            delete(owner, changesTokenId(owner), BlobKind.CURSOR)
        }
        requireOk(store.put(changesTokenId(owner), owner.localStreamId, BlobKind.CURSOR,
            changesTokenBytes(owner, next, page)))
        replaceHead(owner, loaded.row, next)
        discardUnneededCursor(owner, h, cursorId)
        checkBounds(owner)
        ensureCurrent(owner, paired, currentGate)
        StageReceipt(wire?.let { QueuedBatch(it.bytes) })
    }

    override fun stagePage(owner: BatchOwner, checkpoint: PreparedOrdinaryPage,
        hasRecords: Boolean, currentGate: () -> ReadGate,
        makeBatch: (sequence: String, batchId: String) -> ByteArray): QueueResult<StageReceipt> = tx {
        val paired = current(owner, currentGate)
        val loaded = load(owner)
        val h = loaded.head
        if (!checkpoint.issuedBy(pageIssuer) || !sameOwner(checkpoint.owner, owner) ||
            checkpoint.revision != h.revision || checkpoint.requestedToken != h.nextToken ||
            !sameQuery(checkpoint.query, h.query) || h.terminal ||
            hasRecords != checkpoint.page.records.isNotEmpty()) reject("stale-page")
        val page = checkpoint.page
        val initialToken = checkpoint.initialChangesToken
        if (initialToken != null && (initialToken.isEmpty() || h.revision != 0L || h.nextToken != null ||
                db.blobs().find(firstTokenId(owner)) != null)) reject("stale-first-page")
        if (page.records.any { it.recordType != owner.recordType }) reject("wrong-record-type")
        val revision = increment(h.revision)
        val wire = if (hasRecords) {
            val sequence = increment(h.allocated)
            val batchId = nextBatchId()
            val bytes = makeBatch(sequence.toString(), batchId).copyOf()
            val parsed = wire(owner, paired, bytes)
            if (parsed.sequence != sequence || parsed.batchId != batchId) reject("batch-mismatch")
            if (parsed.frame.kind == "object-finalise") {
                if (page.records.size != 1) reject("incomplete-page")
                val original = CompleteRecordObject.payload(owner, page.records.single(),
                    sequence.toString(), batchId)
                try {
                    // Actual reader-issued record and declared original must match before writes.
                    protocol.decodeAssembledPayload(original,
                        CompleteRecordObject.declaration(parsed.frame), context(owner, paired))
                } finally { original.fill(0) }
            } else if (parsed.payload != StrictJson.parse(
                    expectedPayloadText(owner, page, sequence, batchId).toByteArray(Charsets.UTF_8)
                ).objectValue()) {
                reject("incomplete-page")
            }
            parsed
        } else null
        val cursorId = if (wire == null) prefix(owner) + ":empty:" + revision
            else cursorId(owner, wire.sequence)
        val next = h.copy(allocated = wire?.sequence ?: h.allocated, revision = revision,
            nextToken = page.nextPageToken, terminal = page.nextPageToken == null, cursor = cursorId)
        val cursor = cursorBytes(owner, next, checkpoint.requestedToken, wire)
        ensureCurrent(owner, paired, currentGate)
        if (wire == null) {
            requireOk(store.put(cursorId, owner.localStreamId, BlobKind.CURSOR, cursor))
        } else {
            if (wire.frame.kind == "object-finalise") {
                val original = CompleteRecordObject.payload(owner, page.records.single(),
                    wire.sequence.toString(), wire.batchId)
                try {
                    CompleteRecordObject.partWires(protocol, context(owner, paired), wire.frame, original)
                        .forEachIndexed { index, part ->
                            try {
                                requireOk(store.put(partId(owner, wire.sequence, index),
                                    owner.localStreamId, BlobKind.PAYLOAD, part))
                            } finally { part.fill(0) }
                        }
                } finally { original.fill(0) }
            }
            // Every part, finalise, cursor and head shares THIS outer transaction and quota.
            // EncryptedBlobStore catches its inner error. Throw its Blocked through THIS transaction.
            requireOk(store.putPayloadAndCursor(payloadId(owner, wire.sequence), cursorId,
                owner.localStreamId, wire.bytes, cursor, maximumEncryptedBytes))
        }
        if (initialToken != null) {
            requireOk(store.put(firstTokenId(owner), owner.localStreamId, BlobKind.CURSOR,
                firstTokenBytes(owner, h.query, initialToken, page)))
        }
        replaceHead(owner, loaded.row, next)
        discardUnneededCursor(owner, h, cursorId)
        checkBounds(owner)
        ensureCurrent(owner, paired, currentGate)
        StageReceipt(wire?.let { QueuedBatch(it.bytes) }, initialToken?.let {
            FirstPageCommit.issue(pageIssuer, owner, h.query, it, page.records.size.toLong(), page.nextPageToken)
        })
    }

    override fun nextPending(owner: BatchOwner, currentGate: () -> ReadGate): QueueResult<QueuedBatch?> = tx {
        val paired = current(owner, currentGate)
        val h = load(owner).head
        val result = if (h.ack == h.allocated) null else {
            val pending = pending(owner, paired, increment(h.ack))
            QueuedBatch(pending.bytes)
        }
        ensureCurrent(owner, paired, currentGate)
        result
    }

    override fun objectParts(owner: BatchOwner, batch: QueuedBatch,
        currentGate: () -> ReadGate): QueueResult<List<ByteArray>> = tx {
        val paired = current(owner, currentGate)
        val supplied = wire(owner, paired, batch.copyWire())
        if (supplied.frame.kind != "object-finalise") reject("batch-mismatch")
        val head = load(owner).head
        if (supplied.sequence != increment(head.ack) || supplied.sequence > head.allocated) {
            reject("noncontiguous-object")
        }
        val persisted = pending(owner, paired, supplied.sequence, false)
        if (!persisted.bytes.contentEquals(supplied.bytes)) reject("batch-mismatch")
        val parts = readParts(owner, persisted)
        try {
            CompleteRecordObject.validateParts(protocol, context(owner, paired), persisted.frame, parts)
            ensureCurrent(owner, paired, currentGate)
            parts
        } catch (failure: Exception) {
            parts.forEach { it.fill(0) }
            throw failure
        }
    }

    override fun acknowledge(owner: BatchOwner, batch: QueuedBatch, receipt: HealthFrame,
        currentGate: () -> ReadGate): QueueResult<Unit> = tx {
        val paired = current(owner, currentGate)
        val loaded = load(owner)
        val h = loaded.head
        val supplied = wire(owner, paired, batch.copyWire())
        val verified = protocol.decode(ControlJson.text(receipt.fields).toByteArray(Charsets.UTF_8), context(owner, paired))
        if (verified.kind != "durable-receipt" || verified.fields["binding"] != owner.binding ||
            verified.fields["recordType"] != owner.recordType ||
            verified.fields["sequence"] != supplied.sequence.toString() ||
            verified.fields["batchId"] != supplied.batchId || verified.fields["payloadDigest"] != supplied.digest) {
            reject("receipt-mismatch")
        }
        val identity = Ack(supplied.sequence, supplied.batchId, supplied.digest)
        if (supplied.sequence == h.ack && h.lastAck == identity) {
            ensureCurrent(owner, paired, currentGate)
        } else {
            if (supplied.sequence != increment(h.ack) || supplied.sequence > h.allocated) reject("noncontiguous-ack")
            val persisted = pending(owner, paired, supplied.sequence)
            if (!persisted.bytes.contentEquals(supplied.bytes)) reject("receipt-mismatch")
            ensureCurrent(owner, paired, currentGate)
            val next = h.copy(ack = supplied.sequence, lastAck = identity)
            replaceHead(owner, loaded.row, next)
            if (persisted.frame.kind == "object-finalise") {
                val count = (persisted.frame.fields["partCount"] as Long).toInt()
                for (index in 0 until count) delete(owner, partId(owner, supplied.sequence, index), BlobKind.PAYLOAD)
            }
            delete(owner, payloadId(owner, supplied.sequence), BlobKind.PAYLOAD)
            val acknowledgedCursor = cursorId(owner, supplied.sequence)
            if (acknowledgedCursor != h.cursor) delete(owner, acknowledgedCursor, BlobKind.CURSOR)
            checkBounds(owner)
            ensureCurrent(owner, paired, currentGate)
        }
        Unit
    }

    private fun pending(owner: BatchOwner, paired: PairedBatchScope, sequence: Long,
        validateObject: Boolean = true): Wire {
        val value = wire(owner, paired, readOwned(owner, payloadId(owner, sequence), BlobKind.PAYLOAD))
        if (value.sequence != sequence) reject("corrupt-queue")
        val cursor = checkedCursor(owner, cursorId(owner, sequence))
        val head = load(owner).head
        if (cursor["query"] != queryObject(head.query) || decimal(cursor["revision"] as String) > head.revision ||
            cursor["sequence"] != sequence.toString() || cursor["batchId"] != value.batchId ||
            cursor["payloadDigest"] != value.digest || cursor["uploadEligible"] != true) reject("corrupt-queue")
        if (validateObject && value.frame.kind == "object-finalise") {
            val parts = readParts(owner, value)
            try { CompleteRecordObject.validateParts(protocol, context(owner, paired), value.frame, parts) }
            finally { parts.forEach { it.fill(0) } }
        }
        return value
    }

    private fun readParts(owner: BatchOwner, wire: Wire): List<ByteArray> {
        val result = mutableListOf<ByteArray>()
        try {
            val count = (wire.frame.fields["partCount"] as Long).toInt()
            for (index in 0 until count) {
                result.add(readOwned(owner, partId(owner, wire.sequence, index), BlobKind.PAYLOAD))
            }
            return result
        } catch (failure: Exception) {
            result.forEach { it.fill(0) }
            throw failure
        }
    }

    private fun wire(owner: BatchOwner, paired: PairedBatchScope, bytes: ByteArray): Wire {
        val frame = protocol.decode(bytes, context(owner, paired))
        val payload = when (frame.kind) {
            "batch" -> StrictJson.parse((frame.fields["payloadJson"] as String).toByteArray(Charsets.UTF_8)).objectValue()
            "object-finalise" -> frame.fields
            else -> reject("batch-mismatch")
        }
        if (payload["binding"] != owner.binding || payload["recordType"] != owner.recordType) reject("stale-binding")
        val sequence = decimal(payload["sequence"] as String)
        if (sequence == 0L) reject("batch-mismatch")
        return Wire(bytes.copyOf(), frame, payload, sequence, payload["batchId"] as String,
            (frame.fields["payloadDigest"] ?: frame.fields["objectDigest"]) as String)
    }

    private fun expectedPayloadText(owner: BatchOwner, page: OrdinaryRecordPage,
        sequence: Long, batchId: String): String {
        val changes = page.records.joinToString(",", "[", "]") { record ->
            val identity = linkedMapOf("tenantId" to owner.binding.getValue("tenantId"),
                "sourceStoreId" to owner.binding.getValue("sourceStoreId"),
                "recordType" to owner.recordType, "nativeRecordId" to record.nativeRecordId)
            "{\"operation\":\"upsert\",\"identity\":" + ControlJson.text(identity) +
                ",\"dataFamily\":" + ControlJson.text(record.dataFamily) +
                ",\"projection\":\"raw-only\",\"record\":" + record.recordJson +
                ",\"serializerId\":" + ControlJson.text(record.serializerId) +
                ",\"serializerVersion\":" + record.serializerVersion.toString() + "}"
        }
        return "{\"binding\":" + ControlJson.text(owner.binding) +
            ",\"recordType\":" + ControlJson.text(owner.recordType) +
            ",\"sequence\":" + ControlJson.text(sequence.toString()) +
            ",\"batchId\":" + ControlJson.text(batchId) + ",\"changes\":" + changes + "}"
    }

    private fun load(owner: BatchOwner, stoppedScope: PairedBatchScope? = null): Loaded {
        val row = db.blobs().find(headId(owner)) ?: reject("fresh-scan-required")
        val fields = StrictJson.parse(readOwned(owner, row.rowId, BlobKind.STATE)).objectValue()
        if (fields.keys != HEAD_KEYS || fields["format"] != "immutable-batch-head-v1" ||
            fields["binding"] != owner.binding || fields["recordType"] != owner.recordType ||
            fields["localStreamId"] != owner.localStreamId ||
            fields["localFenceEpoch"] != owner.localFenceEpoch.toString()) reject("stale-binding")
        val query = query(fields["query"].objectValue())
        val allocated = decimal(fields["allocated"] as String)
        val ack = decimal(fields["acknowledged"] as String)
        val revision = decimal(fields["revision"] as String)
        val token = nullableString(fields["nextToken"])
        val terminal = fields["terminal"] as? Boolean ?: reject("corrupt-queue")
        val cursor = nullableString(fields["cursorRowId"])
        val lastAck = fields["lastAck"]?.objectValue()?.let {
            if (it.keys != setOf("sequence", "batchId", "digest")) reject("corrupt-queue")
            Ack(decimal(it["sequence"] as String), it["batchId"] as String, it["digest"] as String)
        }
        if (ack > allocated || (terminal && token != null) || (revision == 0L) != (cursor == null) ||
            (revision == 0L && (token != null || terminal || allocated != ack || lastAck != null)) ||
            (lastAck != null && (lastAck.sequence != ack || lastAck.sequence == 0L || lastAck.batchId.isEmpty() ||
                !lastAck.digest.matches(Regex("sha256:[0-9a-f]{64}"))))) reject("corrupt-queue")
        val head = Head(query, allocated, ack, revision, token, terminal, cursor, lastAck)
        if (cursor != null) {
            val saved = checkedCursor(owner, cursor)
            if (saved["query"] != queryObject(query) || saved["revision"] != revision.toString() ||
                saved["nextToken"] != token || saved["terminal"] != terminal ||
                (saved["uploadEligible"] == true && saved["sequence"] != allocated.toString())) {
                reject("corrupt-queue")
            }
            if (saved["uploadEligible"] == true) {
                if (allocated > ack) {
                    val paired = stoppedScope ?: session.batchScope(owner.recordType)
                    if (paired.binding != owner.binding) reject("stale-binding")
                    val latest = wire(owner, paired, readOwned(owner, payloadId(owner, allocated), BlobKind.PAYLOAD))
                    if (latest.sequence != allocated || saved["batchId"] != latest.batchId ||
                        saved["payloadDigest"] != latest.digest) reject("corrupt-queue")
                } else if (lastAck == null || saved["batchId"] != lastAck.batchId ||
                    saved["payloadDigest"] != lastAck.digest) reject("corrupt-queue")
            }
        }
        return Loaded(row, head)
    }

    private fun headBytes(owner: BatchOwner, h: Head): ByteArray = localBytes(linkedMapOf(
        "format" to "immutable-batch-head-v1", "binding" to owner.binding,
        "localStreamId" to owner.localStreamId, "recordType" to owner.recordType,
        "localFenceEpoch" to owner.localFenceEpoch.toString(), "query" to queryObject(h.query),
        "allocated" to h.allocated.toString(), "acknowledged" to h.ack.toString(),
        "revision" to h.revision.toString(), "nextToken" to h.nextToken, "terminal" to h.terminal,
        "cursorRowId" to h.cursor, "lastAck" to h.lastAck?.let { linkedMapOf(
            "sequence" to it.sequence.toString(), "batchId" to it.batchId, "digest" to it.digest) }
    ))

    private fun cursorBytes(owner: BatchOwner, h: Head, requested: String?, wire: Wire?): ByteArray =
        localBytes(linkedMapOf("format" to "immutable-page-cursor-v1", "binding" to owner.binding,
            "localStreamId" to owner.localStreamId, "recordType" to owner.recordType,
            "localFenceEpoch" to owner.localFenceEpoch.toString(), "query" to queryObject(h.query),
            "revision" to h.revision.toString(), "requestedToken" to requested, "nextToken" to h.nextToken,
            "terminal" to h.terminal, "uploadEligible" to (wire != null),
            "sequence" to wire?.sequence?.toString(), "batchId" to wire?.batchId,
            "payloadDigest" to wire?.digest))

    private fun firstTokenBytes(owner: BatchOwner, scope: WeightReadScope, token: String,
        page: OrdinaryRecordPage): ByteArray = localBytes(linkedMapOf(
        "format" to "initial-ordinary-token-v1", "binding" to owner.binding,
        "localStreamId" to owner.localStreamId, "recordType" to owner.recordType,
        "localFenceEpoch" to owner.localFenceEpoch.toString(), "query" to queryObject(scope),
        "revision" to "1", "initialChangesToken" to token, "recordCount" to page.records.size.toString(),
        "nextPageToken" to page.nextPageToken, "terminalPage" to (page.nextPageToken == null)
    ))

    private fun changesProgress(owner: BatchOwner, head: Head, initialToken: String): NativeChangesProgress {
        val row = db.blobs().find(changesTokenId(owner))
        if (row == null) {
            val cursor = head.cursor ?: reject("corrupt-queue")
            if (checkedCursor(owner, cursor)["format"] == "immutable-native-changes-cursor-v1") {
                reject("missing-changes-token")
            }
            return NativeChangesProgress(head.query, initialToken, head.revision, false)
        }
        val fields = StrictJson.parse(readOwned(owner, row.rowId, BlobKind.CURSOR)).objectValue()
        if (fields.keys != CHANGES_TOKEN_KEYS || fields["format"] != "native-changes-token-v1" ||
            fields["binding"] != owner.binding || fields["recordType"] != owner.recordType ||
            fields["localStreamId"] != owner.localStreamId ||
            fields["localFenceEpoch"] != owner.localFenceEpoch.toString() ||
            fields["query"] != queryObject(head.query) ||
            fields["revision"] != head.revision.toString()) reject("corrupt-changes-token")
        val token = fields["changesToken"] as? String ?: reject("corrupt-changes-token")
        val more = fields["hasMore"] as? Boolean ?: reject("corrupt-changes-token")
        if (token.isEmpty()) reject("corrupt-changes-token")
        return NativeChangesProgress(head.query, token, head.revision, more)
    }

    private fun changesTokenBytes(owner: BatchOwner, head: Head, page: NativeChangesPage): ByteArray =
        localBytes(linkedMapOf("format" to "native-changes-token-v1", "binding" to owner.binding,
            "localStreamId" to owner.localStreamId, "recordType" to owner.recordType,
            "localFenceEpoch" to owner.localFenceEpoch.toString(), "query" to queryObject(head.query),
            "revision" to head.revision.toString(), "changesToken" to page.nextChangesToken,
            "hasMore" to page.hasMore))

    private fun nativeChangesCursorBytes(owner: BatchOwner, h: Head, wire: Wire?): ByteArray =
        localBytes(linkedMapOf("format" to "immutable-native-changes-cursor-v1", "binding" to owner.binding,
            "localStreamId" to owner.localStreamId, "recordType" to owner.recordType,
            "localFenceEpoch" to owner.localFenceEpoch.toString(), "query" to queryObject(h.query),
            "revision" to h.revision.toString(), "requestedToken" to null, "nextToken" to h.nextToken,
            "terminal" to h.terminal, "uploadEligible" to (wire != null),
            "sequence" to wire?.sequence?.toString(), "batchId" to wire?.batchId,
            "payloadDigest" to wire?.digest))

    private fun localBytes(fields: JsonObject): ByteArray =
        ControlJson.text(fields).toByteArray(Charsets.UTF_8).also { StrictJson.parse(it) }

    private fun checkedCursor(owner: BatchOwner, rowId: String): JsonObject {
        val value = StrictJson.parse(readOwned(owner, rowId, BlobKind.CURSOR)).objectValue()
        if (value.keys != CURSOR_KEYS || value["format"] !in
                setOf("immutable-page-cursor-v1", "immutable-native-changes-cursor-v1") ||
            value["binding"] != owner.binding || value["localStreamId"] != owner.localStreamId ||
            value["recordType"] != owner.recordType || value["localFenceEpoch"] != owner.localFenceEpoch.toString()) {
            reject("corrupt-queue")
        }
        query(value["query"].objectValue())
        val revision = decimal(value["revision"] as String)
        if (revision == 0L || value["terminal"] !is Boolean ||
            value["terminal"] != (nullableString(value["nextToken"]) == null)) reject("corrupt-queue")
        nullableString(value["requestedToken"])
        if (value["uploadEligible"] == true) {
            val sequence = decimal(value["sequence"] as String)
            if (sequence == 0L || rowId != cursorId(owner, sequence) ||
                (value["batchId"] as? String).isNullOrEmpty() ||
                !(value["payloadDigest"] as? String ?: "").matches(Regex("sha256:[0-9a-f]{64}"))) reject("corrupt-queue")
        } else if (value["uploadEligible"] != false || value["sequence"] != null || value["batchId"] != null ||
            value["payloadDigest"] != null || rowId != prefix(owner) + ":empty:" + revision) reject("corrupt-queue")
        return value
    }

    private fun replaceHead(owner: BatchOwner, before: QueueBlob, head: Head) {
        val bytes = headBytes(owner, head)
        val aad = JSONArray(listOf("klebb-health-queue-v1", 1, BlobKind.STATE.stored,
            before.rowId, owner.localStreamId)).toString().toByteArray(Charsets.UTF_8)
        val sealed = cipher.seal(bytes.copyOf(), aad)
        val nonce = sealed.nonce.copyOf()
        val ciphertext = sealed.ciphertextAndTag.copyOf()
        val count = nonce.size.toLong() + ciphertext.size.toLong()
        if (sealed.version != 1 || nonce.size != 12 || ciphertext.size < 16 || count > Int.MAX_VALUE) {
            reject("encryption-failed")
        }
        val changed = db.blobs().replaceStateIfUnchanged(before.rowId, owner.localStreamId,
            before.version, before.nonce.copyOf(), before.ciphertextAndTag.copyOf(), before.encryptedBytes,
            sealed.version, nonce, ciphertext, count.toInt())
        if (changed != 1) reject("state-conflict")
    }

    private fun readOwned(owner: BatchOwner, rowId: String, kind: BlobKind): ByteArray {
        val row = db.blobs().find(rowId) ?: reject("corrupt-queue")
        if (row.localStreamId != owner.localStreamId || row.kind != kind.stored) reject("stale-binding")
        return requireOk(store.read(rowId)) ?: reject("corrupt-queue")
    }
    private fun discardUnneededCursor(owner: BatchOwner, h: Head, next: String) {
        val old = h.cursor ?: return
        if (old == next) return
        val isEmpty = old.startsWith(prefix(owner) + ":empty:")
        val oldSequence = if (old.startsWith(prefix(owner) + ":cursor:")) old.substringAfterLast(':').toLongOrNull() else null
        if (isEmpty || (oldSequence != null && oldSequence <= h.ack)) delete(owner, old, BlobKind.CURSOR)
    }
    private fun delete(owner: BatchOwner, rowId: String, kind: BlobKind) {
        if (db.blobs().deleteOwnedRow(rowId, owner.localStreamId, kind.stored) != 1) reject("state-conflict")
    }
    private fun checkBounds(owner: BatchOwner) {
        val usage = db.blobs().usageForStream(owner.localStreamId)
        if (maximumRows <= 0L || maximumEncryptedBytes <= 0L || usage.rowCount < 1L ||
            usage.encryptedBytes < 1L || usage.invalidRows != 0L || usage.rowCount > maximumRows ||
            usage.encryptedBytes > maximumEncryptedBytes) reject("stage-bound-exceeded")
    }
    private fun current(owner: BatchOwner, currentGate: () -> ReadGate): PairedBatchScope {
        gate(currentGate)
        val scope = session.batchScope(owner.recordType)
        if (binding(scope.binding) != owner.binding) reject("stale-binding")
        return scope
    }
    private fun ensureCurrent(owner: BatchOwner, paired: PairedBatchScope, currentGate: () -> ReadGate) {
        gate(currentGate)
        if (!session.isCurrentBatchScope(paired) || binding(paired.binding) != owner.binding) reject("stale-binding")
    }
    private fun gate(currentGate: () -> ReadGate) {
        try {
            when (currentGate()) {
                ReadGate.OPEN -> Unit
                ReadGate.PERMISSION_DENIED -> throw Refused(Blocked("permission-denied", "permission-denied"))
                ReadGate.STALE_BINDING -> reject("stale-binding")
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (refused: Refused) { throw refused }
        catch (_: Exception) { throw Refused(Blocked("permission-unknown", "gate-unavailable")) }
    }
    private fun context(owner: BatchOwner, paired: PairedBatchScope) = ValidationContext(
        limits = paired.limits, binding = owner.binding, categories = setOf(owner.recordType))
    private fun binding(value: Map<String, String>): Map<String, String> {
        if (value.keys != BINDING_KEYS.toSet() || value.values.any { it.isEmpty() }) reject("stale-binding")
        return BINDING_KEYS.associateWith { value.getValue(it) }
    }
    private fun prefix(owner: BatchOwner): String = "immutable-queue-v1:" + protocol.payloadDigest(
        ControlJson.text(listOf(binding(owner.binding), owner.recordType))).removePrefix("sha256:")
    private fun firstTokenId(owner: BatchOwner) = prefix(owner) + ":first-token"
    private fun changesTokenId(owner: BatchOwner) = prefix(owner) + ":changes-token"
    private fun headId(owner: BatchOwner) = prefix(owner) + ":head"
    private fun payloadId(owner: BatchOwner, sequence: Long) = prefix(owner) + ":payload:" + sequence
    private fun cursorId(owner: BatchOwner, sequence: Long) = prefix(owner) + ":cursor:" + sequence
    private fun partId(owner: BatchOwner, sequence: Long, index: Int) =
        payloadId(owner, sequence) + ":part:" + index
    private fun queryObject(scope: WeightReadScope) = linkedMapOf(
        "start" to scope.start.toString(), "end" to scope.end.toString(), "pageSize" to scope.pageSize.toLong())
    private fun query(fields: JsonObject): WeightReadScope {
        if (fields.keys != setOf("start", "end", "pageSize")) reject("corrupt-queue")
        val count = fields["pageSize"] as? Long ?: reject("corrupt-queue")
        if (count !in 1L..500L) reject("invalid-query")
        return WeightReadScope(Instant.parse(fields["start"] as String), Instant.parse(fields["end"] as String),
            count.toInt()).also { if (!it.supported()) reject("invalid-query") }
    }
    private fun sameQuery(a: WeightReadScope, b: WeightReadScope) =
        a.start == b.start && a.end == b.end && a.pageSize == b.pageSize
    private fun sameOwner(a: BatchOwner, b: BatchOwner) = a.localStreamId == b.localStreamId &&
        a.recordType == b.recordType && a.binding == b.binding && a.localFenceEpoch == b.localFenceEpoch
    private fun nullableString(value: Any?): String? = when (value) {
        null -> null
        is String -> value
        else -> reject("corrupt-queue")
    }
    private fun decimal(value: String): Long = value.toLongOrNull()?.takeIf {
        it >= 0L && it.toString() == value } ?: reject("corrupt-queue")
    private fun increment(value: Long): Long = if (value == Long.MAX_VALUE) reject("sequence-exhausted") else value + 1L
    private fun reject(cause: String): Nothing = throw Refused(Blocked("queue-unavailable", cause))
    private fun <T> requireOk(result: QueueResult<T>): T = when (result) {
        is Ok -> result.value
        is Blocked -> throw Refused(result)
    }
    private fun <T> tx(operation: () -> T): QueueResult<T> =
        ManualFirstPageCapture.underCommitFence {
            try {
                db.runInTransaction(Callable<QueueResult<T>> { Ok(operation()) })
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (refused: Refused) { refused.result }
            catch (_: Exception) { Blocked("queue-unavailable", "storage-or-control-failed") }
        }

    private companion object {
        val PURGE_MARKER = "[\"klebb-queue-reconciliation-v1\",1,\"fresh-scan-required\"]"
            .toByteArray(Charsets.UTF_8)
        val CHANGES_TOKEN_KEYS = setOf("format", "binding", "localStreamId", "recordType",
            "localFenceEpoch", "query", "revision", "changesToken", "hasMore")
        val FIRST_TOKEN_KEYS = setOf("format", "binding", "localStreamId", "recordType", "localFenceEpoch",
            "query", "revision", "initialChangesToken", "recordCount", "nextPageToken", "terminalPage")
        val BINDING_KEYS = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "generation", "restoreEpoch")
        val CURSOR_KEYS = setOf("format", "binding", "localStreamId", "recordType", "localFenceEpoch", "query",
            "revision", "requestedToken", "nextToken", "terminal", "uploadEligible", "sequence", "batchId", "payloadDigest")
        val HEAD_KEYS = setOf("format", "binding", "localStreamId", "recordType", "localFenceEpoch", "query",
            "allocated", "acknowledged", "revision", "nextToken", "terminal", "cursorRowId", "lastAck")
    }
}
