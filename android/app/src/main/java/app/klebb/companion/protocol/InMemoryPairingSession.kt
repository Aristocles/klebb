// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.time.Instant
import java.util.Collections
import java.util.UUID

class ExchangeAttempt internal constructor(
    internal val epoch: Long,
    val body: ByteArray,
    internal val binding: Map<String, String>,
    internal val categories: Set<String>,
    internal val negotiatedLimits: Map<String, Long>
) {
    internal fun clear() { body.fill(0) }
    override fun toString() = "ExchangeAttempt"
}
/** Read-only current pairing scope; it contains no credential or upload authority. */
internal class PairedBatchScope internal constructor(
    internal val sessionEpoch: Long,
    internal val pairedOwner: Any,
    binding: Map<String, String>,
    limits: Map<String, Long>,
    val acknowledgedSequence: String
) {
    val binding: Map<String, String> = Collections.unmodifiableMap(LinkedHashMap(binding))
    val limits: Map<String, Long> = Collections.unmodifiableMap(LinkedHashMap(limits))
    override fun toString() = "PairedBatchScope"
}

class AuthorisedRequest internal constructor(
    internal val epoch: Long,
    val path: String,
    private var authorityHeaders: Map<String, String>,
    internal val recordType: String?,
    internal val context: ValidationContext
) {
    val headers: Map<String, String> get() = authorityHeaders
    internal fun clear() { authorityHeaders = emptyMap() }
    override fun toString() = "AuthorisedRequest"
}

class InMemoryPairingSession(
    private val protocol: HealthProtocol,
    private val now: () -> Instant = Instant::now,
    private val installation: () -> String = { UUID.randomUUID().toString() }
) {
    private var origin: ApprovedOrigin? = null
    private var grant: HealthFrame? = null
    private var pending: ExchangeAttempt? = null
    private var paired: HealthFrame? = null
    private var pairedLimits: Map<String, Long>? = null
    private val requests = mutableSetOf<AuthorisedRequest>()
    private data class ReceiptExpectation(val recordType: String, val sequence: String,
        val batchId: String, val payloadDigest: String)
    private val batchReceipts = mutableMapOf<AuthorisedRequest, ReceiptExpectation>()
    private val batchTransports = mutableMapOf<AuthorisedRequest, PairingTransport>()
    private var epoch = 0L
    val destination: String? get() = origin?.text
    val categories: Set<String> get() = (paired?.fields?.get("categories") as? List<*>)
        ?.map { it as String }?.toSet() ?: emptySet()

    fun approveDestination(text: String) {
        clear()
        origin = ApprovedOrigin.parse(text)
    }
    fun prepareGrant(bytes: ByteArray) {
        val selected = origin ?: throw ProtocolException("invalid-destination")
        val frame = protocol.decode(bytes)
        if (frame.kind != "pairing-grant" || frame.fields["sourceStoreId"] !is String ||
            frame.fields["restoreEpoch"] !is String) throw ProtocolException("invalid-message")
        if (frame.fields["destination"] != selected.text) throw ProtocolException("invalid-destination")
        if (!Instant.parse(frame.fields["expiresAt"] as String).isAfter(now())) {
            throw ProtocolException("expired-grant")
        }
        grant = frame
    }
    fun beginExchange(): ExchangeAttempt {
        val frame = grant ?: throw ProtocolException("not-prepared")
        if (!Instant.parse(frame.fields["expiresAt"] as String).isAfter(now())) {
            throw ProtocolException("expired-grant")
        }
        val fields = frame.fields
        val installationId = installation()
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "restoreEpoch")
            .associateWith { fields[it] as String } + ("installationId" to installationId)
        val categories = (fields["categories"] as List<*>).map { it as String }.toSet()
        val body = ControlJson.text(linkedMapOf(
            "version" to 1L, "kind" to "pairing-exchange", "tenantId" to fields["tenantId"],
            "instanceId" to fields["instanceId"], "grant" to fields["grant"],
            "installationId" to installationId, "sourceStoreId" to fields["sourceStoreId"],
            "categories" to fields["categories"]
        )).toByteArray()
        grant = null
        val limits = Collections.unmodifiableMap(LinkedHashMap(
            fields["limits"].objectValue().mapValues { it.value as Long }
        ))
        return ExchangeAttempt(epoch, body, binding, categories, limits).also { pending = it }
    }
    fun acceptPairing(attempt: ExchangeAttempt, response: ByteArray, httpStatus: Int = 200) {
        if (attempt.epoch != epoch || pending !== attempt || origin == null) {
            throw ProtocolException("cancelled")
        }
        try {
            val frame = protocol.decode(response, ValidationContext(
                binding = attempt.binding, categories = attempt.categories
            ))
            if (frame.kind == "error") throw ProtocolException(frame.fields["code"] as String)
            if (httpStatus !in 200..299) throw ProtocolException("request-refused")
            if (frame.kind != "paired" || frame.fields["destination"] != origin?.text) {
                throw ProtocolException("invalid-message")
            }
            if ((frame.fields["categories"] as List<*>).toSet() != attempt.categories) {
                throw ProtocolException("scope-mismatch")
            }
            paired = frame
            pairedLimits = attempt.negotiatedLimits
            pending = null
            attempt.clear()
        } catch (failure: Exception) {
            clear()
            throw failure
        }
    }
    internal fun batchScope(recordType: String): PairedBatchScope {
        val owner = paired ?: throw ProtocolException("not-paired")
        if (recordType !in categories) throw ProtocolException("scope-denied")
        val limits = pairedLimits ?: throw ProtocolException("not-paired")
        if (limits.keys != setOf("maxBytes", "maxChanges", "maxDepth", "maxNodes",
                "maxSamples", "maxParts", "maxObjectBytes")) throw ProtocolException("invalid-message")
        val fields = owner.fields
        val stream = fields["streams"].objectValue()[recordType].objectValue()
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { fields[it] as String } + ("generation" to (stream["generation"] as String))
        return PairedBatchScope(epoch, owner, binding, limits, stream["acknowledgedSequence"] as String)
    }
    internal fun isCurrentBatchScope(scope: PairedBatchScope): Boolean =
        scope.sessionEpoch == epoch && paired === scope.pairedOwner && pairedLimits == scope.limits

    fun capabilityRequest(): AuthorisedRequest = authorised("$BASE/capabilities", null)
    fun statusRequest(recordType: String): AuthorisedRequest {
        if (recordType !in categories) throw ProtocolException("scope-denied")
        return authorised("$BASE/streams/$recordType/status", recordType)
    }
    /** A durable upload receipt is page acceptance, never native coverage or policy authority. */
    fun uploadBatch(transport: PairingTransport, bytes: ByteArray): HealthFrame {
        val selected = destination ?: throw ProtocolException("not-paired")
        if (transport.destination != selected) throw ProtocolException("invalid-destination")
        val body = bytes.copyOf()
        try {
            val request = batchRequest(body)
            val owner = paired
            batchTransports[request] = transport
            try {
                val response = transport.request("POST", request.path, body, request.headers)
                return acceptResult(request, response.body, response.status)
            } catch (failure: Exception) {
                // A lost reply may follow a remote commit; only its current owner may be cleared.
                if (request.epoch == epoch && paired === owner && request in requests) clear()
                throw failure
            } finally { batchTransports.remove(request) }
        } finally { body.fill(0) }
    }
    private fun batchRequest(bytes: ByteArray): AuthorisedRequest {
        if (paired == null) throw ProtocolException("not-paired")
        val frame = protocol.decode(bytes, ValidationContext(
            limits = pairedLimits ?: throw ProtocolException("not-paired"), categories = categories))
        if (frame.kind != "batch") throw ProtocolException("invalid-message")
        val payload = StrictJson.parse((frame.fields["payloadJson"] as String).toByteArray()).objectValue()
        val recordType = payload["recordType"] as String
        val request = authorised("$BASE/batches", recordType)
        try {
            protocol.decode(bytes, request.context)
            batchReceipts[request] = ReceiptExpectation(recordType, payload["sequence"] as String,
                payload["batchId"] as String, frame.fields["payloadDigest"] as String)
            return request
        } catch (failure: Exception) {
            request.clear()
            requests.remove(request)
            throw failure
        }
    }
    private fun authorised(path: String, recordType: String?): AuthorisedRequest {
        val fields = paired?.fields ?: throw ProtocolException("not-paired")
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { fields[it] as String }
        val headers = linkedMapOf("Authorization" to "Bearer ${fields["credential"]}",
            "Klebb-Health-Protocol" to "1")
        var selectedBinding = binding
        if (recordType != null) {
            val stream = fields["streams"].objectValue()[recordType].objectValue()
            val generation = stream["generation"] as String
            headers["Klebb-Health-Generation"] = generation
            headers["Klebb-Health-Restore-Epoch"] = fields["restoreEpoch"] as String
            selectedBinding = binding + ("generation" to generation)
        }
        return AuthorisedRequest(epoch, path, headers, recordType,
            ValidationContext(limits = pairedLimits ?: throw ProtocolException("not-paired"),
                binding = selectedBinding, categories = categories)).also { requests.add(it) }
    }
    fun acceptResult(request: AuthorisedRequest, response: ByteArray, httpStatus: Int = 200): HealthFrame {
        if (request.epoch != epoch || paired == null || request !in requests) {
            throw ProtocolException("cancelled")
        }
        try {
            val frame = protocol.decode(response, request.context)
            if (frame.kind == "error") throw ProtocolException(frame.fields["code"] as String)
            if (httpStatus !in 200..299) throw ProtocolException("request-refused")
            val receipt = batchReceipts[request]
            if (receipt != null) {
                if (frame.kind != "durable-receipt" || frame.fields["recordType"] != receipt.recordType ||
                    frame.fields["sequence"] != receipt.sequence || frame.fields["batchId"] != receipt.batchId) {
                    throw ProtocolException("binding-mismatch")
                }
                if (frame.fields["payloadDigest"] != receipt.payloadDigest) {
                    throw ProtocolException("digest-mismatch")
                }
            } else if (request.recordType == null && frame.kind == "capabilities") {
                if (frame.fields["destination"] != origin?.text ||
                    frame.fields["connectorId"] != paired!!.fields["connectorId"] ||
                    (frame.fields["categories"] as List<*>).toSet() != categories) {
                    throw ProtocolException("binding-mismatch")
                }
                val expected = paired!!.fields["streams"].objectValue()
                val actual = frame.fields["streams"].objectValue()
                if (categories.any {
                    expected[it].objectValue()["generation"] != actual[it].objectValue()["generation"]
                }) throw ProtocolException("binding-mismatch")
            } else if (request.recordType == null || frame.kind != "stream-status" ||
                frame.fields["recordType"] != request.recordType) {
                throw ProtocolException("binding-mismatch")
            }
            return frame
        } catch (failure: Exception) {
            clear()
            throw failure
        } finally {
            request.clear()
            requests.remove(request)
            batchReceipts.remove(request)
        }
    }
    fun clear() {
        epoch++
        batchTransports.values.forEach { it.cancel() }
        batchTransports.clear()
        pending?.clear()
        pending = null
        requests.forEach { it.clear() }
        requests.clear()
        batchReceipts.clear()
        paired = null
        pairedLimits = null
        grant = null
        origin = null
    }
    override fun toString() = "InMemoryPairingSession"

    companion object {
        const val BASE = "/api/connectors/health-connect/v1"
        const val EXCHANGE = "$BASE/pairing/exchange"
    }
}
