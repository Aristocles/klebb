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
import java.util.Base64
import java.security.MessageDigest
import app.klebb.companion.protocol.JsonObject
import app.klebb.companion.records.EncodedRecord
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
     * Owned immutable object-part rows, in manifest order. A part response has no ACK authority.
     * The implementation validates all parts and the assembled original before returning them.
     */
    fun objectParts(owner: BatchOwner, batch: QueuedBatch,
        currentGate: () -> ReadGate): QueueResult<List<ByteArray>> =
        Blocked("queue-unavailable", "object-parts-unavailable")

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
            val payload: JsonObject
            val receipt: HealthFrame
            if (frame.kind == "batch") {
                payload = StrictJson.parse(
                    (frame.fields["payloadJson"] as String).toByteArray(Charsets.UTF_8)
                ).objectValue()
                gateFailure()?.let { return it }
                receipt = session.uploadBatch(transport, bytes)
            } else if (frame.kind == "object-finalise") {
                val parts = when (val result = queue.objectParts(owner, batch, currentGate)) {
                    is Blocked -> return result
                    is Ok -> result.value
                }
                try {
                    // Validate the complete declaration, every persisted part and original first.
                    payload = CompleteRecordObject.validateParts(protocol, context(owner), frame, parts)
                    for (part in parts) {
                        gateFailure()?.let { return it }
                        // Only the scoped paired transport admits this exact part receipt.
                        session.uploadObjectPart(transport, part)
                    }
                    gateFailure()?.let { return it }
                    receipt = session.uploadObjectFinalise(transport, bytes)
                } finally {
                    parts.forEach { it.fill(0) }
                }
            } else throw ProtocolException("invalid-message")
            if (receipt.kind != "durable-receipt" ||
                receipt.fields["binding"] != owner.binding ||
                receipt.fields["recordType"] != owner.recordType ||
                receipt.fields["sequence"] != payload["sequence"] ||
                receipt.fields["batchId"] != payload["batchId"] ||
                receipt.fields["payloadDigest"] != (frame.fields["payloadDigest"] ?: frame.fields["objectDigest"])) {
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
        val validation = context(owner)
        if (bytes.size.toLong() > (validation.limits["maxBytes"] ?: 1048576L) &&
            page.records.size == 1) {
            // Mixed/multi-record oversized pages still refuse atomically until partitioned.
            return CompleteRecordObject.finalise(owner, page.records.single(), sequence, batchId,
                protocol, validation)
        }
        // Other malformed/unserialisable or oversized pages cannot advance their checkpoint.
        protocol.decode(bytes, validation)
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


/** Complete single ordinary record object wire. No queue/frontier or permission authority. */
internal object CompleteRecordObject {
    private val declarationKeys = listOf("binding", "recordType", "batchId", "sequence", "identity",
        "objectId", "objectDigest", "partCount", "totalBytes")
    fun declaration(frame: HealthFrame): JsonObject =
        declarationKeys.associateWith { frame.fields.getValue(it) }

    fun payload(owner: BatchOwner, record: EncodedRecord, sequence: String, batchId: String): ByteArray {
        val identity = linkedMapOf("tenantId" to owner.binding.getValue("tenantId"),
            "sourceStoreId" to owner.binding.getValue("sourceStoreId"),
            "recordType" to owner.recordType, "nativeRecordId" to record.nativeRecordId)
        // Preserve the original record text. This control ordering is fixed for the object path.
        return ("{\"binding\":" + ControlJson.text(owner.binding) +
            ",\"recordType\":" + ControlJson.text(owner.recordType) +
            ",\"sequence\":" + ControlJson.text(sequence) +
            ",\"batchId\":" + ControlJson.text(batchId) +
            ",\"changes\":[{\"operation\":\"upsert\",\"identity\":" + ControlJson.text(identity) +
            ",\"dataFamily\":" + ControlJson.text(record.dataFamily) +
            ",\"projection\":\"raw-only\",\"serializerId\":" + ControlJson.text(record.serializerId) +
            ",\"serializerVersion\":" + record.serializerVersion +
            ",\"record\":" + record.recordJson + "}]}").toByteArray(Charsets.UTF_8)
    }

    fun finalise(owner: BatchOwner, record: EncodedRecord, sequence: String, batchId: String,
        protocol: HealthProtocol, context: ValidationContext): ByteArray {
        val payload = payload(owner, record, sequence, batchId)
        try {
            val limit = context.limits["maxObjectBytes"] ?: 67108864L
            if (payload.size.toLong() > limit) throw ProtocolException("limit-exceeded")
            val identity = linkedMapOf("tenantId" to owner.binding.getValue("tenantId"),
                "sourceStoreId" to owner.binding.getValue("sourceStoreId"),
                "recordType" to owner.recordType, "nativeRecordId" to record.nativeRecordId)
            val declaration = linkedMapOf<String, Any?>("binding" to owner.binding,
                "recordType" to owner.recordType, "batchId" to batchId, "sequence" to sequence,
                "identity" to identity, "objectId" to (batchId + "-object"),
                "objectDigest" to digest(payload), "partCount" to 128L,
                "totalBytes" to payload.size.toLong())
            // Worst permitted index/count reserves enough control overhead for every part.
            val overhead = bytes(linkedMapOf("version" to 1L, "kind" to "object-part") +
                declaration + linkedMapOf("partIndex" to 127L, "partBase64" to "",
                    "partDigest" to ("sha256:" + "0".repeat(64)))).size
            val room = (context.limits["maxBytes"] ?: 1048576L) - overhead
            val size = minOf(524288L, (room / 4L) * 3L).toInt()
            if (size < 1) throw ProtocolException("limit-exceeded")
            val count = (payload.size.toLong() + size - 1L) / size
            if (count > (context.limits["maxParts"] ?: 128L)) throw ProtocolException("limit-exceeded")
            declaration["partCount"] = count
            val manifest = (0 until count.toInt()).map { index ->
                val start = index * size
                val raw = payload.copyOfRange(start, minOf(start + size, payload.size))
                try { linkedMapOf("index" to index.toLong(), "digest" to digest(raw),
                    "bytes" to raw.size.toLong()) } finally { raw.fill(0) }
            }
            protocol.decodeAssembledPayload(payload, declaration, context)
            return bytes(linkedMapOf("version" to 1L, "kind" to "object-finalise") +
                declaration + ("parts" to manifest)).also { protocol.decode(it, context) }
        } finally { payload.fill(0) }
    }

    /** Generates each exact persisted part once during the atomic page transaction. */
    fun partWires(protocol: HealthProtocol, context: ValidationContext,
        finalise: HealthFrame, payload: ByteArray): Sequence<ByteArray> = sequence {
        protocol.decodeAssembledPayload(payload, declaration(finalise), context)
        var offset = 0
        for (item in finalise.fields["parts"] as List<*>) {
            val entry = item.objectValue()
            val count = (entry["bytes"] as Long).toInt()
            val raw = payload.copyOfRange(offset, offset + count)
            offset += count
            try {
                if (digest(raw) != entry["digest"]) throw ProtocolException("digest-mismatch")
                val wire = bytes(linkedMapOf("version" to 1L, "kind" to "object-part") +
                    declaration(finalise) + linkedMapOf("partIndex" to entry["index"],
                        "partBase64" to Base64.getEncoder().encodeToString(raw),
                        "partDigest" to entry["digest"]))
                protocol.decode(wire, context)
                yield(wire)
            } finally { raw.fill(0) }
        }
        if (offset != payload.size) throw ProtocolException("invalid-message")
    }

    fun validateParts(protocol: HealthProtocol, context: ValidationContext,
        finalise: HealthFrame, parts: List<ByteArray>): JsonObject {
        if (finalise.kind != "object-finalise") throw ProtocolException("invalid-message")
        val manifest = finalise.fields["parts"] as List<*>
        if (parts.size != manifest.size) throw ProtocolException("invalid-message")
        val declared = declaration(finalise)
        val total = finalise.fields["totalBytes"] as Long
        if (total !in 1L..(context.limits["maxObjectBytes"] ?: 67108864L)) {
            throw ProtocolException("limit-exceeded")
        }
        val payload = ByteArray(total.toInt())
        try {
            var offset = 0
            parts.forEachIndexed { index, bytes ->
                val part = protocol.decode(bytes, context)
                val expected = manifest[index].objectValue()
                if (part.kind != "object-part" || declaration(part) != declared ||
                    part.fields["partIndex"] != index.toLong() ||
                    part.fields["partDigest"] != expected["digest"]) {
                    throw ProtocolException("binding-mismatch")
                }
                val raw = Base64.getDecoder().decode(part.fields["partBase64"] as String)
                try {
                    if (raw.size.toLong() != expected["bytes"] ||
                        raw.size.toLong() > total - offset) throw ProtocolException("invalid-message")
                    raw.copyInto(payload, offset)
                    offset += raw.size
                } finally { raw.fill(0) }
            }
            if (offset.toLong() != total) throw ProtocolException("invalid-message")
            return protocol.decodeAssembledPayload(payload, declared, context)
        } finally { payload.fill(0) }
    }
    private fun bytes(value: JsonObject) = ControlJson.text(value).toByteArray(Charsets.UTF_8)
    private fun digest(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
}
