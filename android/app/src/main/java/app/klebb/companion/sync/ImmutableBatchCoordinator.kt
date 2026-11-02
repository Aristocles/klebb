// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import app.klebb.companion.protocol.ControlJson
import app.klebb.companion.protocol.HealthFrame
import app.klebb.companion.protocol.HealthProtocol
import app.klebb.companion.protocol.InMemoryPairingSession
import app.klebb.companion.protocol.PairingTransport
import app.klebb.companion.protocol.ProtocolException
import app.klebb.companion.protocol.StrictJson
import app.klebb.companion.protocol.ValidationContext
import app.klebb.companion.protocol.objectValue
import app.klebb.companion.queue.Blocked
import app.klebb.companion.queue.Ok
import app.klebb.companion.queue.QueueResult
import java.util.Collections
import kotlin.coroutines.cancellation.CancellationException

/** A queue-issued local fence. Its durable owner is revalidated by every queue operation. */
internal class BatchOwner(
    val localStreamId: String,
    val recordType: String,
    binding: Map<String, String>,
    val localFenceEpoch: Long
) {
    val binding: Map<String, String> = Collections.unmodifiableMap(LinkedHashMap(binding))
    override fun toString() = "BatchOwner"
}

/** Exact decrypted persisted bytes, never a newly generated retry body. */
internal class QueuedBatch(wire: ByteArray) {
    private val immutableWire = wire.copyOf()
    fun copyWire(): ByteArray = immutableWire.copyOf()
    override fun toString() = "QueuedBatch"
}

/** Issued only after the queue's complete page/checkpoint transaction has committed. */
internal class StageReceipt(val batch: QueuedBatch?) {
    override fun toString() = "StageReceipt"
}

/**
 * Required durable queue seam, not an implementation supplied by EncryptedBlobStore.
 * The caller holds the existing shared coordinator lock and current permission fence.
 * Every method validates the queue's persisted stream binding, generation and local epoch.
 */
internal interface DurableBatchQueue {
    /**
     * ONE Room transaction allocates sequence/identity, builds and encrypts the complete
     * batch, stages payload/checkpoint and updates local-read STATE. Cloud ACK is unchanged.
     * Empty pages stage only a local checkpoint, without allocation or an empty wire batch.
     * makeBatch is called once inside the transaction; it must not suspend or perform I/O.
     * The final currentGate check precedes synchronous mutations under the same held fence.
     * Any allocation/build/seal/insert/head-update/commit failure rolls back all changes.
     */
    fun stagePage(
        owner: BatchOwner,
        checkpoint: PreparedOrdinaryPage,
        hasRecords: Boolean,
        currentGate: () -> ReadGate,
        makeBatch: (sequence: String, batchId: String) -> ByteArray
    ): QueueResult<StageReceipt>

    /** Oldest owned pending frontier+1, using its exact persisted immutable bytes. */
    fun nextPending(owner: BatchOwner, currentGate: () -> ReadGate): QueueResult<QueuedBatch?>

    /**
     * ONE Room transaction verifies exact persisted bytes and receipt binding/type/sequence/
     * batch/digest, then current owner/fence and contiguous frontier before ACK advancement.
     * Repeated exact ACK is idempotent; a gap/stale owner/stop has no mutation. Never purge here.
     */
    fun acknowledge(
        owner: BatchOwner,
        batch: QueuedBatch,
        receipt: HealthFrame,
        currentGate: () -> ReadGate
    ): QueueResult<Unit>
}

/** One page stage or one upload attempt. No scheduling, backoff, coverage or policy authority. */
internal class ImmutableBatchCoordinator(
    private val queue: DurableBatchQueue,
    private val protocol: HealthProtocol,
    private val session: InMemoryPairingSession,
    private val currentGate: () -> ReadGate
) {
    fun stagePage(
        owner: BatchOwner,
        page: OrdinaryRecordPage,
        checkpoint: PreparedOrdinaryPage
    ): QueueResult<StageReceipt> {
        gateFailure()?.let { return it }
        if (checkpoint.page !== page) return Blocked("queue-unavailable", "foreign-page")
        // OrdinaryRecordPage already retains a complete immutable list from the reader.
        if (page.records.any { it.recordType != owner.recordType }) {
            return Blocked("queue-unavailable", "wrong-record-type")
        }
        return try {
            queue.stagePage(owner, checkpoint, page.records.isNotEmpty(), currentGate) {
                sequence, batchId -> makeBatch(owner, page, sequence, batchId)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Blocked("queue-unavailable", "stage-failed")
        }
    }

    fun uploadNext(owner: BatchOwner, transport: PairingTransport): QueueResult<Boolean> {
        gateFailure()?.let { return it }
        val pending = try {
            queue.nextPending(owner, currentGate)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return Blocked("queue-unavailable", "pending-read-failed")
        }
        val batch = when (pending) {
            is Blocked -> return pending
            is Ok -> pending.value ?: return Ok(false)
        }
        val bytes = batch.copyWire()
        try {
            val frame = protocol.decode(bytes, context(owner))
            if (frame.kind != "batch") throw ProtocolException("invalid-message")
            val payload = StrictJson.parse(
                (frame.fields["payloadJson"] as String).toByteArray(Charsets.UTF_8)
            ).objectValue()
            gateFailure()?.let { return it }
            // This is the actual paired HTTPS transport path, with its own epoch/receipt checks.
            val receipt = session.uploadBatch(transport, bytes)
            if (receipt.kind != "durable-receipt" ||
                receipt.fields["binding"] != owner.binding ||
                receipt.fields["recordType"] != owner.recordType ||
                receipt.fields["sequence"] != payload["sequence"] ||
                receipt.fields["batchId"] != payload["batchId"] ||
                receipt.fields["payloadDigest"] != frame.fields["payloadDigest"]) {
                return Blocked("upload-unconfirmed", "receipt-mismatch")
            }
            gateFailure()?.let { return it }
            return when (val saved = queue.acknowledge(owner, batch, receipt, currentGate)) {
                is Blocked -> saved
                is Ok -> Ok(true)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // A remote commit may have occurred. The queue is retained; retry its SAME bytes.
            // Session recovery/re-pairing remains with its owner, never inferred from this error.
            return Blocked("upload-unconfirmed", "reply-or-ack-unconfirmed")
        } finally {
            bytes.fill(0)
        }
    }

    private fun makeBatch(
        owner: BatchOwner, page: OrdinaryRecordPage, sequence: String, batchId: String
    ): ByteArray {
        val number = sequence.toLongOrNull()
        if (number == null || number <= 0L || number.toString() != sequence || batchId.isEmpty()) {
            throw ProtocolException("invalid-message")
        }
        val changes = page.records.joinToString(",", "[", "]") { record ->
            val identity = linkedMapOf(
                "tenantId" to owner.binding.getValue("tenantId"),
                "sourceStoreId" to owner.binding.getValue("sourceStoreId"),
                "recordType" to owner.recordType,
                "nativeRecordId" to record.nativeRecordId
            )
            // Control fields are encoded; complete original record JSON is embedded unchanged.
            "{\"operation\":\"upsert\",\"identity\":" + ControlJson.text(identity) +
                ",\"dataFamily\":" + ControlJson.text(record.dataFamily) +
                ",\"projection\":\"raw-only\",\"record\":" + record.recordJson +
                ",\"serializerId\":" + ControlJson.text(record.serializerId) +
                ",\"serializerVersion\":" + record.serializerVersion.toString() + "}"
        }
        val payload = "{\"binding\":" + ControlJson.text(owner.binding) +
            ",\"recordType\":" + ControlJson.text(owner.recordType) +
            ",\"sequence\":" + ControlJson.text(sequence) +
            ",\"batchId\":" + ControlJson.text(batchId) + ",\"changes\":" + changes + "}"
        val bytes = ControlJson.text(linkedMapOf(
            "version" to 1L, "kind" to "batch", "payloadJson" to payload,
            "payloadDigest" to protocol.payloadDigest(payload)
        )).toByteArray(Charsets.UTF_8)
        // Refuse a malformed/oversized/unserialisable page before its checkpoint can commit.
        protocol.decode(bytes, context(owner))
        return bytes
    }

    private fun context(owner: BatchOwner): ValidationContext {
        val paired = session.batchScope(owner.recordType)
        if (paired.binding != owner.binding) throw ProtocolException("binding-mismatch")
        return ValidationContext(limits = paired.limits, binding = owner.binding,
            categories = setOf(owner.recordType))
    }

    private fun gateFailure(): Blocked? = try {
        when (currentGate()) {
            ReadGate.OPEN -> null
            ReadGate.PERMISSION_DENIED -> Blocked("permission-denied", "permission-denied")
            ReadGate.STALE_BINDING -> Blocked("stale-binding", "stale-binding")
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        Blocked("permission-unknown", "gate-unavailable")
    }
}
