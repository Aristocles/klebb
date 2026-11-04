// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.time.Instant
import java.util.Base64
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
    val recordType: String,
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

/** Session-issued authenticated BEGIN facts; it carries no credential or native completeness. */
class NativeFirstPageChallenge internal constructor(
    internal val sessionEpoch: Long,
    internal val pairedOwner: Any,
    val recordType: String,
    val scope: app.klebb.companion.sync.WeightReadScope,
    binding: Map<String, String>,
    val policyRevision: String,
    val queryJson: String,
    val filterDigest: String,
    val acknowledgedSequence: String,
    val readinessId: String,
    val expiresAt: Instant
) {
    val binding: Map<String, String> = Collections.unmodifiableMap(LinkedHashMap(binding))
    override fun toString() = "NativeFirstPageChallenge"
}

/** Session-issued local stop fence. Its captured scope is purge evidence, not upload authority. */
internal class LocalCategoryStopReceipt internal constructor(
    internal val pairedScope: PairedBatchScope,
    val challenge: NativeFirstPageChallenge?
) {
    val recordType: String get() = pairedScope.recordType
    val binding: Map<String, String> get() = pairedScope.binding
    val acknowledgedSequence: String get() = pairedScope.acknowledgedSequence
    override fun toString() = "LocalCategoryStopReceipt"
}

internal interface PairingSessionPersistence {
    val owner: Any
    fun checkCurrent()
    fun save(state: ByteArray?)
    fun forget()
}

class InMemoryPairingSession(
    private val protocol: HealthProtocol,
    private val now: () -> Instant = Instant::now,
    private val installation: () -> String = { UUID.randomUUID().toString() }
) {
    @Volatile private var origin: ApprovedOrigin? = null
    private var grant: HealthFrame? = null
    private var pending: ExchangeAttempt? = null
    @Volatile private var paired: HealthFrame? = null
    @Volatile private var pairedLimits: Map<String, Long>? = null
    private val requests = mutableSetOf<AuthorisedRequest>()
    private data class ReceiptExpectation(val recordType: String, val sequence: String,
        val batchId: String, val payloadDigest: String)
    private val batchReceipts = mutableMapOf<AuthorisedRequest, ReceiptExpectation>()
    private val objectPartReceipts = mutableMapOf<AuthorisedRequest, JsonObject>()
    private val batchTransports = mutableMapOf<AuthorisedRequest, PairingTransport>()
    @Volatile private var epoch = 0L
    private var persistence: PairingSessionPersistence? = null
    @Volatile private var persistenceFault = false
    val destination: String? get() = origin?.text
    val categories: Set<String> get() = (paired?.fields?.get("categories") as? List<*>)
        ?.map { it as String }?.toSet() ?: emptySet()

    @Synchronized
    fun approveDestination(text: String) {
        clear()
        origin = ApprovedOrigin.parse(text)
    }
    @Synchronized
    fun prepareGrant(bytes: ByteArray) {
        checkDurableCurrent()
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
    @Synchronized
    fun beginExchange(): ExchangeAttempt {
        checkDurableCurrent()
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
    @Synchronized
    fun acceptPairing(attempt: ExchangeAttempt, response: ByteArray, httpStatus: Int = 200) {
        checkDurableCurrent()
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
            persistDurableState()
        } catch (failure: Exception) {
            clearMemory()
            throw failure
        }
    }
    @Synchronized
    internal fun batchScope(recordType: String): PairedBatchScope {
        checkDurableCurrent()
        if (recordType in localCategoryStops) throw ProtocolException("category-stopped")
        val owner = paired ?: throw ProtocolException("not-paired")
        if (recordType !in categories) throw ProtocolException("scope-denied")
        val limits = pairedLimits ?: throw ProtocolException("not-paired")
        if (limits.keys != setOf("maxBytes", "maxChanges", "maxDepth", "maxNodes",
                "maxSamples", "maxParts", "maxObjectBytes")) throw ProtocolException("invalid-message")
        val fields = owner.fields
        val stream = effectiveStream(fields, recordType)
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { fields[it] as String } + ("generation" to (stream["generation"] as String))
        return PairedBatchScope(epoch, owner, recordType, binding, limits, stream["acknowledgedSequence"] as String)
    }
    @Synchronized
    internal fun isCurrentBatchScope(scope: PairedBatchScope): Boolean =
        durableCurrent() && scope.sessionEpoch == epoch && paired === scope.pairedOwner && pairedLimits == scope.limits &&
            scope.recordType in categories && scope.recordType !in localCategoryStops &&
            scope.recordType !in firstPageBlocked &&
            effectiveStream(paired!!.fields, scope.recordType)["generation"] == scope.binding["generation"]

    private data class FirstPageStream(val binding: Map<String, String>, val acknowledged: String)
    private class FirstPageExchange(
        val epoch: Long, val owner: HealthFrame, val recordType: String,
        val binding: Map<String, String>, val limits: Map<String, Long>,
        val transport: PairingTransport, val destination: String,
        var headers: Map<String, String>
    ) { var settled = false }
    private val firstPageStreams = mutableMapOf<String, FirstPageStream>()
    private val firstPageChallenges = mutableMapOf<String, NativeFirstPageChallenge>()
    private val firstPageCompletions = mutableMapOf<String, JsonObject>()
    private val firstPageBlocked = mutableSetOf<String>()
    private data class ReadinessTransition(val status: JsonObject?, val response: JsonObject)
    private val firstPageTransitions = mutableMapOf<String, ReadinessTransition>()
    private val localCategoryStops = mutableMapOf<String, LocalCategoryStopReceipt>()
    private val categoryStopConfirmations = mutableMapOf<String, ReadinessTransition>()
    private var firstPageExchange: FirstPageExchange? = null
    private val firstPageBindingKeys = setOf("tenantId", "instanceId", "sourceStoreId",
        "installationId", "generation", "restoreEpoch")
    private val firstPageResultKeys = setOf("version", "kind", "recordType", "binding",
        "policyRevision", "sharing", "verification")
    private val firstPageChallengeKeys = setOf("version", "kind", "readinessId", "recordType",
        "binding", "policyRevision", "queryJson", "filterDigest", "acknowledgedSequence", "expiresAt")
    private val firstPageFactKeys = setOf("localReadRevision", "recordCount", "terminalPage",
        "permissionFingerprintStart", "permissionFingerprintEnd", "tokenValid",
        "historyWindowLimited", "interveningChangeCount", "changesHaveMore")
    private val firstPageTime = java.time.format.DateTimeFormatterBuilder()
        .appendInstant(3).toFormatter()

    /** The caller's commit fence must also exclude SDK staging and local acknowledgement. */
    @Synchronized
    internal fun stopCategory(recordType: String): LocalCategoryStopReceipt {
        checkDurableCurrent()
        if (recordType !in setOf("WeightRecord", "StepsRecord") || recordType !in categories) {
            throw ProtocolException("scope-denied")
        }
        val stop = localCategoryStops[recordType] ?: LocalCategoryStopReceipt(
            knownBatchScope(recordType), firstPageChallenges[recordType]).also {
            localCategoryStops[recordType] = it
        }
        // Repeated deselection must also cancel an in-flight readmission using this receipt.
        firstPageChallenges.remove(recordType)
        firstPageCompletions.remove(recordType)
        try { cancelCategoryRequestsLocked(recordType) }
        finally { persistDurableState() }
        return stop
    }

    @Synchronized
    internal fun localCategoryStop(recordType: String): LocalCategoryStopReceipt? {
        checkDurableCurrent()
        return localCategoryStops[recordType]?.takeIf { isCurrentLocalStop(it) }
    }

    @Synchronized
    internal fun stoppedCategories(): Set<String> {
        checkDurableCurrent()
        return Collections.unmodifiableSet(localCategoryStops.keys.toSet())
    }

    @Synchronized
    internal fun isCurrentLocalStop(stop: LocalCategoryStopReceipt): Boolean =
        durableCurrent() && localCategoryStops[stop.recordType] === stop &&
            stop.pairedScope.sessionEpoch == epoch && paired === stop.pairedScope.pairedOwner &&
            pairedLimits == stop.pairedScope.limits && stop.recordType in categories

    /** Full accepted stopped wire facts; uncertainty never becomes an enabled/stopped Boolean. */
    @Synchronized
    internal fun confirmedCategoryStop(stop: LocalCategoryStopReceipt): JsonObject? {
        if (!isCurrentLocalStop(stop) || stop.recordType in firstPageBlocked) return null
        return categoryStopConfirmations[stop.recordType]?.response
    }

    internal fun confirmCategoryStop(transport: PairingTransport,
        stop: LocalCategoryStopReceipt): JsonObject {
        val start = synchronized(this) {
            if (!isCurrentLocalStop(stop)) throw ProtocolException("cancelled")
            confirmedCategoryStop(stop)?.let { return it }
            val needsRecovery = stop.recordType in firstPageBlocked
            // A previously accepted STOP is the latest known predecessor after canceled readmission.
            // Prior uncertainty recovers its actual current binding without enabling collection.
            val binding = categoryStopConfirmations[stop.recordType]?.response?.get("binding")
                ?.let { firstPageBinding(it) } ?: stop.binding
            val operation = startBoundFirstPageExchange(transport, stop.recordType, binding, stop.pairedScope.limits)
            firstPageBlocked.add(stop.recordType)
            persistDurableState()
            operation to needsRecovery
        }
        var ticket = start.first
        try {
            if (start.second) ticket = recoverStoppedBinding(ticket, stop)
            val status = firstPageCall(ticket, linkedMapOf("version" to 2L, "kind" to "readiness-status",
                "recordType" to stop.recordType, "binding" to ticket.binding))
            validateFirstPageResult(status, stop.recordType, ticket.binding)
            val revision = firstPageUint(status["policyRevision"])
            val generation = firstPageUint(ticket.binding["generation"])
            if (revision == Long.MAX_VALUE || generation == Long.MAX_VALUE) {
                throw ProtocolException("limit-exceeded")
            }
            val response = firstPageCall(ticket, linkedMapOf("version" to 2L, "kind" to "readiness-stop",
                "recordType" to stop.recordType, "binding" to ticket.binding,
                "policyRevision" to revision.toString()))
            validateStoppedTransition(status, response, stop.recordType)
            return synchronized(this) {
                checkFirstPageExchange(ticket)
                if (!isCurrentLocalStop(stop)) throw ProtocolException("cancelled")
                val accepted = immutableResult(response)
                categoryStopConfirmations[stop.recordType] = ReadinessTransition(immutableResult(status), accepted)
                firstPageBlocked.remove(stop.recordType)
                persistDurableState()
                ticket.settled = true
                accepted
            }
        } catch (failure: Exception) {
            refuseFirstPageExchange(ticket)
            throw failure
        } finally { finishFirstPageExchange(ticket) }
    }

    /** Recovery is STOP-control evidence only; it never installs a stream or upload/read scope. */
    private fun recoverStoppedBinding(ticket: FirstPageExchange,
        stop: LocalCategoryStopReceipt): FirstPageExchange {
        val namespace = ticket.binding.filterKeys { it != "generation" }
        val ownedCategories = (ticket.owner.fields["categories"] as List<*>).map { it as String }.toSet()
        val headers = synchronized(this) {
            checkFirstPageExchange(ticket)
            if (!isCurrentLocalStop(stop)) throw ProtocolException("cancelled")
            linkedMapOf("Authorization" to (ticket.headers["Authorization"]
                ?: throw ProtocolException("not-paired")), "Klebb-Health-Protocol" to "1")
        }
        val response = ticket.transport.request("GET", "$BASE/capabilities", headers = headers)
        try {
            val frame = protocol.decode(response.body, ValidationContext(limits = ticket.limits,
                binding = namespace, categories = ownedCategories))
            if (frame.kind == "error") throw ProtocolException(frame.fields["code"] as String)
            if (response.status != 200) throw ProtocolException("request-refused")
            val fields = frame.fields
            if (frame.kind != "capabilities" || fields["destination"] != ticket.destination ||
                fields["connectorId"] != ticket.owner.fields["connectorId"] ||
                namespace.any { (key, value) -> fields[key] != value } ||
                (fields["categories"] as? List<*>)?.toSet() != ownedCategories) {
                throw ProtocolException("binding-mismatch")
            }
            val streams = fields["streams"].objectValue()
            if (streams.keys != ownedCategories) throw ProtocolException("binding-mismatch")
            val selected = streams[ticket.recordType].objectValue()
            val generation = firstPageUint(selected["generation"]).toString()
            // Validate the observed frontier without granting it to the old purge owner or any batch scope.
            firstPageUint(selected["acknowledgedSequence"])
            val binding = firstPageBinding(namespace + ("generation" to generation))
            return synchronized(this) {
                checkFirstPageExchange(ticket)
                if (!isCurrentLocalStop(stop)) throw ProtocolException("cancelled")
                FirstPageExchange(ticket.epoch, ticket.owner, ticket.recordType, binding, ticket.limits,
                    ticket.transport, ticket.destination, LinkedHashMap(ticket.headers)).also {
                    ticket.headers = emptyMap()
                    firstPageExchange = it
                }
            }
        } finally { response.body.fill(0) }
    }

    /** Captures the last authenticated scope even when it is already locally unusable. */
    private fun knownBatchScope(recordType: String): PairedBatchScope {
        val owner = paired ?: throw ProtocolException("not-paired")
        val limits = pairedLimits ?: throw ProtocolException("not-paired")
        val stream = firstPageStreams[recordType]
        if (stream != null) return PairedBatchScope(epoch, owner, recordType,
            stream.binding, limits, stream.acknowledged)
        val fields = owner.fields
        val base = fields["streams"].objectValue()[recordType].objectValue()
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { fields[it] as String } + ("generation" to (base["generation"] as String))
        return PairedBatchScope(epoch, owner, recordType, binding, limits, base["acknowledgedSequence"] as String)
    }

    private fun cancelCategoryRequestsLocked(recordType: String) {
        var cancellationFailure: Exception? = null
        fun cancel(transport: PairingTransport) {
            try { transport.cancel() } catch (failure: Exception) {
                if (cancellationFailure == null) cancellationFailure = failure
                else cancellationFailure!!.addSuppressed(failure)
            }
        }
        firstPageExchange?.takeIf { it.recordType == recordType }?.let { ticket ->
            if (!ticket.settled) firstPageBlocked.add(recordType)
            ticket.headers = emptyMap()
            firstPageExchange = null
            cancel(ticket.transport)
        }
        val owned = requests.filter { it.recordType == recordType }
        val siblingTransports = batchTransports.filterKeys { it.recordType != recordType }.values.toSet()
        owned.forEach { request ->
            val transport = batchTransports.remove(request)
            // A shared transport cannot be canceled without also canceling its sibling connection.
            // Retiring this exact request still fences every late selected reply.
            batchReceipts.remove(request)
            objectPartReceipts.remove(request)
            requests.remove(request)
            request.clear()
            if (transport != null && transport !in siblingTransports) cancel(transport)
        }
        cancellationFailure?.let { throw it }
    }

    private fun immutableResult(result: JsonObject): JsonObject =
        Collections.unmodifiableMap(LinkedHashMap(result + ("binding" to firstPageBinding(result["binding"]))))

    private fun validateStoppedTransition(status: JsonObject, response: JsonObject, recordType: String) {
        val before = firstPageBinding(status["binding"])
        validateFirstPageResult(status, recordType, before)
        val generation = firstPageUint(before["generation"])
        val revision = firstPageUint(status["policyRevision"])
        if (generation == Long.MAX_VALUE || revision == Long.MAX_VALUE) {
            throw ProtocolException("limit-exceeded")
        }
        validateFirstPageResult(response, recordType, before + ("generation" to (generation + 1L).toString()))
        if (firstPageUint(response["policyRevision"]) != revision + 1L ||
            response["sharing"] != "stopped" || response["verification"] != "unverified") {
            throw ProtocolException("readiness-unverified")
        }
    }

    /** Wire authority only. The manual caller owns selection, native facts and the Room receipt. */
    fun beginFirstPage(transport: PairingTransport, recordType: String,
        scope: app.klebb.companion.sync.WeightReadScope): NativeFirstPageChallenge {
        if (!scope.supported()) throw ProtocolException("invalid-message")
        val ticket = synchronized(this) {
            if (recordType in localCategoryStops) throw ProtocolException("category-stopped")
            if (firstPageChallenges.containsKey(recordType)) {
                throw ProtocolException("first-page-already-begun")
            }
            val operation = startFirstPageExchange(transport, recordType)
            firstPageBlocked.add(recordType)
            firstPageChallenges.remove(recordType)
            // An uncertain remote BEGIN must never restore the old generation as usable.
            persistDurableState()
            operation
        }
        return requestFirstPage(ticket, scope, null)
    }

    /** Requires the current queue-issued purge proof; Room is never called under the Session monitor. */
    internal fun reenableFirstPage(transport: PairingTransport, stop: LocalCategoryStopReceipt,
        purge: app.klebb.companion.sync.CategoryPurgeReceipt,
        queue: app.klebb.companion.sync.RoomDurableBatchQueue,
        scope: app.klebb.companion.sync.WeightReadScope): NativeFirstPageChallenge {
        if (!scope.supported()) throw ProtocolException("invalid-message")
        val admitted = queue.acceptsCategoryPurge(stop, purge)
        if (admitted !is app.klebb.companion.queue.Ok<*> || admitted.value != true) {
            throw ProtocolException("category-purge-unconfirmed")
        }
        val ticket = synchronized(this) {
            if (!isCurrentLocalStop(stop)) throw ProtocolException("cancelled")
            val stopped = confirmedCategoryStop(stop) ?: throw ProtocolException("readiness-unverified")
            val operation = startBoundFirstPageExchange(transport, stop.recordType,
                firstPageBinding(stopped["binding"]), stop.pairedScope.limits)
            firstPageBlocked.add(stop.recordType)
            persistDurableState()
            operation
        }
        return requestFirstPage(ticket, scope, stop)
    }

    private fun requestFirstPage(ticket: FirstPageExchange,
        scope: app.klebb.companion.sync.WeightReadScope,
        stopped: LocalCategoryStopReceipt?): NativeFirstPageChallenge {
        val recordType = ticket.recordType
        try {
            val status = firstPageCall(ticket, linkedMapOf(
                "version" to 2L, "kind" to "readiness-status",
                "recordType" to recordType, "binding" to ticket.binding))
            validateFirstPageResult(status, recordType, ticket.binding)
            val revision = firstPageUint(status["policyRevision"])
            if (revision == Long.MAX_VALUE) throw ProtocolException("limit-exceeded")
            val generation = firstPageUint(ticket.binding["generation"])
            if (generation == Long.MAX_VALUE) throw ProtocolException("limit-exceeded")
            val queryJson = ControlJson.text(linkedMapOf(
                "recordType" to recordType,
                "window" to linkedMapOf("start" to firstPageTime.format(scope.start),
                    "end" to firstPageTime.format(scope.end)),
                "pageSize" to scope.pageSize.toLong()))
            val filterDigest = protocol.payloadDigest(queryJson)
            val response = firstPageCall(ticket, linkedMapOf(
                "version" to 2L, "kind" to "readiness-begin", "recordType" to recordType,
                "binding" to ticket.binding, "policyRevision" to revision.toString(),
                "queryJson" to queryJson, "filterDigest" to filterDigest))
            if (response.keys != firstPageChallengeKeys ||
                response["kind"] != "readiness-challenge" || response["recordType"] != recordType ||
                response["queryJson"] != queryJson || response["filterDigest"] != filterDigest ||
                firstPageUint(response["policyRevision"]) != revision + 1L) {
                throw ProtocolException("binding-mismatch")
            }
            val expectedBinding = ticket.binding + ("generation" to (generation + 1L).toString())
            val returnedBinding = firstPageBinding(response["binding"])
            if (returnedBinding != expectedBinding) throw ProtocolException("binding-mismatch")
            val readinessId = response["readinessId"] as? String
                ?: throw ProtocolException("invalid-message")
            if (!Regex("hc_ready_[A-Za-z0-9_-]{43}").matches(readinessId)) {
                throw ProtocolException("invalid-message")
            }
            val acknowledgement = firstPageUint(response["acknowledgedSequence"]).toString()
            val expiryText = response["expiresAt"] as? String ?: throw ProtocolException("invalid-message")
            val expiry = try { Instant.parse(expiryText) }
                catch (_: Exception) { throw ProtocolException("invalid-message") }
            if (firstPageTime.format(expiry) != expiryText || !expiry.isAfter(now()) ||
                expiry.isAfter(now().plusSeconds(300))) {
                throw ProtocolException("readiness-unverified")
            }
            val challenge = NativeFirstPageChallenge(ticket.epoch, ticket.owner, recordType,
                scope, returnedBinding, (revision + 1L).toString(), queryJson, filterDigest,
                acknowledgement, readinessId, expiry)
            return synchronized(this) {
                checkFirstPageExchange(ticket)
                if (stopped != null && !isCurrentLocalStop(stopped)) throw ProtocolException("cancelled")
                if (!expiry.isAfter(now())) throw ProtocolException("readiness-unverified")
                firstPageStreams[recordType] = FirstPageStream(challenge.binding, acknowledgement)
                firstPageChallenges[recordType] = challenge
                firstPageTransitions[recordType] = ReadinessTransition(immutableResult(status),
                    immutableResult(response))
                firstPageBlocked.remove(recordType)
                if (stopped != null) {
                    localCategoryStops.remove(recordType)
                    categoryStopConfirmations.remove(recordType)
                }
                persistDurableState()
                ticket.settled = true
                challenge
            }
        } catch (failure: Exception) {
            refuseFirstPageExchange(ticket)
            throw failure
        } finally { finishFirstPageExchange(ticket) }
    }

    /**
     * The caller must first admit the actual Room-issued receipt and matching SDK facts.
     * This method validates/authenticates the report; it cannot attest caller-supplied facts.
     * A matching successful response is activation; no retry or guessed success is performed.
     */
    fun completeFirstPage(transport: PairingTransport, challenge: NativeFirstPageChallenge,
        firstPage: JsonObject): JsonObject {
        val ticket = synchronized(this) {
            if (!isCurrentFirstPage(challenge)) throw ProtocolException("readiness-unverified")
            if (firstPageCompletions.containsKey(challenge.recordType)) {
                throw ProtocolException("first-page-already-completed")
            }
            startFirstPageExchange(transport, challenge.recordType)
        }
        try {
            val copied = StrictJson.parse(ControlJson.text(firstPage).toByteArray(Charsets.UTF_8),
                firstPageLimits(ticket)).objectValue()
            if (copied.keys != firstPageFactKeys || copied["localReadRevision"] != "1" ||
                firstPageUint(copied["recordCount"]) > challenge.scope.pageSize.toLong() ||
                copied["terminalPage"] !is Boolean || copied["historyWindowLimited"] !is Boolean ||
                copied["changesHaveMore"] !is Boolean || copied["tokenValid"] != true) {
                throw ProtocolException("readiness-unverified")
            }
            firstPageUint(copied["interveningChangeCount"])
            val fingerprint = copied["permissionFingerprintStart"] as? String
                ?: throw ProtocolException("readiness-unverified")
            if (!Regex("sha256:[a-f0-9]{64}").matches(fingerprint) ||
                copied["permissionFingerprintEnd"] != fingerprint) {
                throw ProtocolException("readiness-unverified")
            }
            synchronized(this) {
                checkFirstPageExchange(ticket)
                if (!isCurrentFirstPage(challenge)) throw ProtocolException("readiness-unverified")
                if (persistence != null) {
                    firstPageBlocked.add(challenge.recordType)
                    persistDurableState()
                }
            }
            val result = firstPageCall(ticket, linkedMapOf(
                "version" to 2L, "kind" to "readiness-complete",
                "recordType" to challenge.recordType, "readinessId" to challenge.readinessId,
                "binding" to challenge.binding, "policyRevision" to challenge.policyRevision,
                "filterDigest" to challenge.filterDigest, "firstPage" to copied))
            validateFirstPageResult(result, challenge.recordType, challenge.binding)
            val revision = firstPageUint(challenge.policyRevision)
            if (revision == Long.MAX_VALUE || firstPageUint(result["policyRevision"]) != revision + 1L ||
                result["sharing"] != "enabled" || result["verification"] != "authenticated-companion-report") {
                throw ProtocolException("readiness-unverified")
            }
            return synchronized(this) {
                checkFirstPageExchange(ticket)
                if (!sameFirstPage(challenge) || !challenge.expiresAt.isAfter(now())) {
                    throw ProtocolException("readiness-unverified")
                }
                val accepted = Collections.unmodifiableMap(LinkedHashMap(
                    result + ("binding" to challenge.binding)))
                firstPageCompletions[challenge.recordType] = accepted
                firstPageBlocked.remove(challenge.recordType)
                persistDurableState()
                ticket.settled = true
                accepted
            }
        } catch (failure: Exception) {
            refuseFirstPageExchange(ticket)
            throw failure
        } finally { finishFirstPageExchange(ticket) }
    }

    /** Current BEGIN is local preparation authority, not proof that sharing has become enabled. */
    fun isCurrentFirstPage(challenge: NativeFirstPageChallenge): Boolean = synchronized(this) {
        durableCurrent() && sameFirstPage(challenge) &&
            challenge.recordType !in localCategoryStops &&
            challenge.recordType !in firstPageBlocked && challenge.expiresAt.isAfter(now())
    }

    private fun sameFirstPage(challenge: NativeFirstPageChallenge): Boolean =
        challenge.sessionEpoch == epoch && paired === challenge.pairedOwner &&
            firstPageChallenges[challenge.recordType] === challenge &&
            firstPageStreams[challenge.recordType]?.binding == challenge.binding

    /** Recovery facts only, including expired/completed challenges; this grants no read/upload authority. */
    @Synchronized
    internal fun firstPageChallenge(recordType: String): NativeFirstPageChallenge? {
        checkDurableCurrent()
        return firstPageChallenges[recordType]?.takeIf { sameFirstPage(it) }
    }

    /** The full genuine response, bound to the current owner; never a cached enabled Boolean. */
    @Synchronized
    internal fun readinessCompleted(recordType: String): JsonObject? {
        if (!durableCurrent() || recordType in firstPageBlocked || recordType in localCategoryStops) return null
        val challenge = firstPageChallenges[recordType] ?: return null
        if (!sameFirstPage(challenge)) return null
        return firstPageCompletions[recordType]?.takeIf { it["binding"] == challenge.binding }
    }

    private fun startFirstPageExchange(transport: PairingTransport, recordType: String): FirstPageExchange {
        checkDurableCurrent()
        if (recordType !in setOf("WeightRecord", "StepsRecord") || recordType !in categories) {
            throw ProtocolException("scope-denied")
        }
        if (firstPageExchange != null || requests.isNotEmpty()) throw ProtocolException("request-active")
        if (recordType in localCategoryStops) throw ProtocolException("category-stopped")
        if (recordType in firstPageBlocked) throw ProtocolException("readiness-unverified")
        val scope = batchScope(recordType)
        return startBoundFirstPageExchange(transport, recordType, scope.binding, scope.limits)
    }

    private fun startBoundFirstPageExchange(transport: PairingTransport, recordType: String,
        binding: Map<String, String>, limits: Map<String, Long>): FirstPageExchange {
        checkDurableCurrent()
        if (recordType !in setOf("WeightRecord", "StepsRecord") || recordType !in categories) {
            throw ProtocolException("scope-denied")
        }
        if (firstPageExchange != null || requests.isNotEmpty()) throw ProtocolException("request-active")
        val owner = paired ?: throw ProtocolException("not-paired")
        val selected = destination ?: throw ProtocolException("not-paired")
        if (transport.destination != selected) throw ProtocolException("invalid-destination")
        val credential = owner.fields["credential"] as? String ?: throw ProtocolException("not-paired")
        if (!Regex("klebb_hc1_[A-Za-z0-9_-]{43}").matches(credential)) {
            throw ProtocolException("invalid-message")
        }
        return FirstPageExchange(epoch, owner, recordType, binding, limits,
            transport, selected, linkedMapOf("Authorization" to "Bearer $credential",
                "Klebb-Health-Protocol" to "2")).also { firstPageExchange = it }
    }

    private fun checkFirstPageExchange(ticket: FirstPageExchange) {
        checkDurableCurrent()
        if (firstPageExchange !== ticket || epoch != ticket.epoch || paired !== ticket.owner ||
            destination != ticket.destination || pairedLimits != ticket.limits) {
            throw ProtocolException("cancelled")
        }
    }

    private fun firstPageCall(ticket: FirstPageExchange, fields: JsonObject): JsonObject {
        val bytes = ControlJson.text(fields).toByteArray(Charsets.UTF_8)
        try {
            StrictJson.parse(bytes, firstPageLimits(ticket))
            val headers = synchronized(this) {
                checkFirstPageExchange(ticket)
                LinkedHashMap(ticket.headers)
            }
            val response = ticket.transport.request("POST",
                "/api/connectors/health-connect/v2/streams/${ticket.recordType}/readiness", bytes, headers)
            try {
                val result = StrictJson.parse(response.body, firstPageLimits(ticket)).objectValue()
                synchronized(this) { checkFirstPageExchange(ticket) }
                if (result["version"] != 2L) throw ProtocolException("unsupported-version")
                if (result["kind"] == "error") {
                    if (result.keys != setOf("version", "kind", "code", "retryable") ||
                        result["retryable"] !is Boolean) throw ProtocolException("invalid-message")
                    val code = result["code"] as? String ?: throw ProtocolException("invalid-message")
                    if (code.isEmpty() || code.length > 256) throw ProtocolException("invalid-message")
                    throw ProtocolException(code)
                }
                if (response.status != 200) throw ProtocolException("request-refused")
                return result
            } finally { response.body.fill(0) }
        } finally { bytes.fill(0) }
    }

    private fun firstPageLimits(ticket: FirstPageExchange) = StrictJson.Limits(
        ticket.limits.getValue("maxBytes").toInt(), ticket.limits.getValue("maxDepth").toInt(),
        ticket.limits.getValue("maxNodes").toInt())
    private fun firstPageUint(value: Any?): Long {
        val text = value as? String ?: throw ProtocolException("invalid-message")
        return text.toLongOrNull()?.takeIf { it >= 0L && it.toString() == text }
            ?: throw ProtocolException("invalid-message")
    }
    private fun firstPageBinding(value: Any?): Map<String, String> {
        val fields = value.objectValue()
        if (fields.keys != firstPageBindingKeys || fields.values.any { it !is String || it.isEmpty() }) {
            throw ProtocolException("binding-mismatch")
        }
        val binding = firstPageBindingKeys.associateWith { fields[it] as String }
        firstPageUint(binding["generation"])
        return Collections.unmodifiableMap(LinkedHashMap(binding))
    }
    private fun validateFirstPageResult(result: JsonObject, recordType: String, binding: Map<String, String>) {
        if (result.keys != firstPageResultKeys || result["version"] != 2L ||
            result["kind"] != "readiness-result" || result["recordType"] != recordType ||
            firstPageBinding(result["binding"]) != binding ||
            result["sharing"] !in setOf("stopped", "enabled") ||
            result["verification"] !in setOf("unverified", "authenticated-companion-report")) {
            throw ProtocolException("binding-mismatch")
        }
        firstPageUint(result["policyRevision"])
    }
    private fun refuseFirstPageExchange(ticket: FirstPageExchange) = synchronized(this) {
        if (epoch == ticket.epoch && paired === ticket.owner && firstPageExchange === ticket) {
            if (persistence == null) firstPageChallenges.remove(ticket.recordType)
            firstPageBlocked.add(ticket.recordType)
            persistDurableState()
        }
    }
    private fun finishFirstPageExchange(ticket: FirstPageExchange) = synchronized(this) {
        ticket.headers = emptyMap()
        if (firstPageExchange === ticket) firstPageExchange = null
    }

    /** Called only under the session monitor. It never changes a sibling stream. */
    private fun effectiveStream(fields: JsonObject, recordType: String): JsonObject {
        if (recordType in localCategoryStops) throw ProtocolException("category-stopped")
        if (recordType in firstPageBlocked) throw ProtocolException("readiness-unverified")
        val override = firstPageStreams[recordType]
        return if (override == null) fields["streams"].objectValue()[recordType].objectValue()
            else linkedMapOf("generation" to override.binding.getValue("generation"),
                "acknowledgedSequence" to override.acknowledged)
    }

    @Synchronized
    internal fun attachPersistence(sink: PairingSessionPersistence) {
        if (persistence != null || firstPageExchange != null || requests.isNotEmpty() || pending != null) {
            throw ProtocolException("request-active")
        }
        sink.checkCurrent()
        persistence = sink
    }

    @Synchronized
    internal fun checkStoredPairingCurrent() { checkDurableCurrent() }

    private fun durableCurrent(): Boolean {
        if (persistenceFault) return false
        return try {
            persistence?.checkCurrent()
            true
        } catch (_: Exception) {
            persistenceFault = true
            cancelActiveRequestsLocked(false)
            false
        }
    }

    private fun checkDurableCurrent() {
        if (!durableCurrent()) throw ProtocolException("pairing-storage-unavailable")
    }

    private fun persistDurableState() {
        val sink = persistence ?: return
        var bytes: ByteArray? = null
        try {
            checkDurableCurrent()
            bytes = durableState()
            sink.save(bytes)
        } catch (_: Exception) {
            persistenceFault = true
            cancelActiveRequestsLocked(false)
            throw ProtocolException("pairing-storage-unavailable")
        } finally { bytes?.fill(0) }
    }

    /** Activity pause/offline cancellation invalidates requests, not the durable paired owner. */
    @Synchronized
    internal fun cancelActiveRequests() {
        checkDurableCurrent()
        cancelActiveRequestsLocked(true)
    }

    /** A caller may discard only the exact request it owns; pairing and sibling callers remain. */
    @Synchronized
    internal fun cancelOwnedRequest(request: AuthorisedRequest) {
        if (request.epoch != epoch || request !in requests) return
        batchTransports.remove(request)?.cancel()
        batchReceipts.remove(request)
        objectPartReceipts.remove(request)
        requests.remove(request)
        request.clear()
    }

    /** Cleanup for a single runner transport, never another caller's active exchange. */
    @Synchronized
    internal fun cancelTransportRequests(transport: PairingTransport) {
        try {
            val ticket = firstPageExchange?.takeIf { it.transport === transport }
            if (ticket != null) {
                val uncertain = !ticket.settled
                ticket.headers = emptyMap()
                firstPageExchange = null
                if (uncertain) {
                    firstPageBlocked.add(ticket.recordType)
                    persistDurableState()
                }
            }
            batchTransports.entries.filter { it.value === transport }.map { it.key }
                .forEach { cancelOwnedRequest(it) }
        } finally { transport.cancel() }
    }

    private fun cancelActiveRequestsLocked(saveUncertainty: Boolean) {
        val uncertainType = firstPageExchange?.takeIf { !it.settled }?.recordType
        firstPageExchange?.transport?.cancel()
        firstPageExchange?.headers = emptyMap()
        firstPageExchange = null
        if (uncertainType != null) firstPageBlocked.add(uncertainType)
        batchTransports.values.toList().forEach { it.cancel() }
        batchTransports.clear()
        pending?.clear()
        pending = null
        grant = null
        requests.forEach { it.clear() }
        requests.clear()
        batchReceipts.clear()
        objectPartReceipts.clear()
        if (saveUncertainty && uncertainType != null) persistDurableState()
    }

    private fun savedChallenge(challenge: NativeFirstPageChallenge): JsonObject = linkedMapOf(
        "version" to 2L, "kind" to "readiness-challenge",
        "readinessId" to challenge.readinessId, "recordType" to challenge.recordType,
        "binding" to challenge.binding, "policyRevision" to challenge.policyRevision,
        "queryJson" to challenge.queryJson, "filterDigest" to challenge.filterDigest,
        "acknowledgedSequence" to challenge.acknowledgedSequence,
        "expiresAt" to firstPageTime.format(challenge.expiresAt))

    private fun durableState(): ByteArray? {
        val owner = paired ?: return null
        val state = linkedMapOf(
            "version" to 2L, "kind" to "saved-paired-owner", "origin" to origin!!.text,
            "paired" to owner.fields, "limits" to pairedLimits!!,
            "streams" to firstPageStreams.mapValues { (_, stream) -> linkedMapOf(
                "binding" to stream.binding, "acknowledgedSequence" to stream.acknowledged) },
            "challenges" to firstPageChallenges.mapValues { (_, challenge) -> savedChallenge(challenge) },
            "completed" to firstPageCompletions.toMap(), "blocked" to firstPageBlocked.sorted(),
            "transitions" to firstPageTransitions.mapValues { (_, transition) ->
                linkedMapOf("status" to transition.status, "response" to transition.response) },
            "stops" to localCategoryStops.mapValues { (type, stop) ->
                val confirmation = categoryStopConfirmations[type]
                linkedMapOf("binding" to stop.binding, "acknowledgedSequence" to stop.acknowledgedSequence,
                    "challenge" to stop.challenge?.let { savedChallenge(it) },
                    "status" to confirmation?.status, "response" to confirmation?.response) })
        return ControlJson.text(state).toByteArray(Charsets.UTF_8).also { StrictJson.parse(it) }
    }

    /** Only the encrypted vault invokes this; every persisted authority field is revalidated. */
    @Synchronized
    internal fun restoreDurableState(bytes: ByteArray) {
        if (paired != null || origin != null || persistence != null) {
            throw ProtocolException("pairing-owner-mismatch")
        }
        val state = StrictJson.parse(bytes).objectValue()
        val legacy = state["version"] == 1L
        val legacyKeys = setOf("version", "kind", "origin", "paired", "limits", "streams",
            "challenges", "completed", "blocked")
        if (state.keys != (if (legacy) legacyKeys else legacyKeys + setOf("transitions", "stops")) ||
            (!legacy && state["version"] != 2L) || state["kind"] != "saved-paired-owner") {
            throw ProtocolException("invalid-message")
        }
        val savedOrigin = ApprovedOrigin.parse(state["origin"] as? String
            ?: throw ProtocolException("invalid-destination"))
        val rawLimits = state["limits"].objectValue()
        if (rawLimits.keys != setOf("maxBytes", "maxChanges", "maxDepth", "maxNodes",
                "maxSamples", "maxParts", "maxObjectBytes") || rawLimits.values.any { it !is Long }) {
            throw ProtocolException("invalid-message")
        }
        val limits = Collections.unmodifiableMap(LinkedHashMap(rawLimits.mapValues { it.value as Long }))
        val pairedBytes = ControlJson.text(state["paired"].objectValue()).toByteArray(Charsets.UTF_8)
        val owner = try { protocol.decode(pairedBytes, ValidationContext(limits = limits)) }
            finally { pairedBytes.fill(0) }
        if (owner.kind != "paired" || owner.fields["destination"] != savedOrigin.text) {
            throw ProtocolException("binding-mismatch")
        }
        val savedCategories = (owner.fields["categories"] as List<*>).map { it as String }.toSet()
        val baseStreams = owner.fields["streams"].objectValue()
        val namespace = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { owner.fields[it] as String }
        val streams = state["streams"].objectValue()
        val challenges = state["challenges"].objectValue()
        val completed = state["completed"].objectValue()
        val transitions = if (legacy) emptyMap() else state["transitions"].objectValue()
        val stops = if (legacy) emptyMap() else state["stops"].objectValue()
        val selectedTypes = setOf("WeightRecord", "StepsRecord")
        if (streams.keys.any { it !in savedCategories || it !in selectedTypes } ||
            challenges.keys.any { it !in streams || it in stops } ||
            streams.keys.any { it !in challenges && it !in stops } ||
            stops.keys.any { it !in savedCategories || it !in selectedTypes } ||
            completed.keys.any { it !in challenges } ||
            (!legacy && transitions.keys != streams.keys)) {
            throw ProtocolException("binding-mismatch")
        }
        val restoredStreams = mutableMapOf<String, FirstPageStream>()
        val restoredChallenges = mutableMapOf<String, NativeFirstPageChallenge>()
        val restoredCompleted = mutableMapOf<String, JsonObject>()
        val restoredTransitions = mutableMapOf<String, ReadinessTransition>()
        val retiredChallenges = mutableMapOf<String, NativeFirstPageChallenge>()
        for ((type, value) in streams) {
            val stream = value.objectValue()
            if (stream.keys != setOf("binding", "acknowledgedSequence")) {
                throw ProtocolException("invalid-message")
            }
            val binding = firstPageBinding(stream["binding"])
            val generation = firstPageUint(baseStreams[type].objectValue()["generation"])
            val ack = firstPageUint(stream["acknowledgedSequence"]).toString()
            // An ACK belongs to its own generation; the paired generation's frontier is not its lower bound.
            val row = (if (type in challenges) challenges[type] else stops[type].objectValue()["challenge"]).objectValue()
            if (row.keys != firstPageChallengeKeys || row["version"] != 2L ||
                row["kind"] != "readiness-challenge" || row["recordType"] != type ||
                firstPageBinding(row["binding"]) != binding || row["acknowledgedSequence"] != ack) {
                throw ProtocolException("binding-mismatch")
            }
            val transition = if (legacy) null else transitions[type].objectValue()
            if (transition != null && (transition.keys != setOf("status", "response") ||
                    transition["response"].objectValue() != row)) throw ProtocolException("binding-mismatch")
            val status = transition?.get("status")?.objectValue()
            if (status == null) {
                // Exact legacy snapshots can be migrated without inventing their unavailable STATUS reply.
                if (generation == Long.MAX_VALUE ||
                    binding != namespace + ("generation" to (generation + 1L).toString())) {
                    throw ProtocolException("binding-mismatch")
                }
            } else {
                val predecessor = firstPageBinding(status["binding"])
                val predecessorGeneration = firstPageUint(predecessor["generation"])
                val predecessorRevision = firstPageUint(status["policyRevision"])
                validateFirstPageResult(status, type, predecessor)
                if (predecessor.filterKeys { it != "generation" } != namespace ||
                    predecessorGeneration < generation || predecessorGeneration == Long.MAX_VALUE ||
                    predecessorRevision == Long.MAX_VALUE ||
                    binding != predecessor + ("generation" to (predecessorGeneration + 1L).toString()) ||
                    firstPageUint(row["policyRevision"]) != predecessorRevision + 1L) {
                    throw ProtocolException("binding-mismatch")
                }
            }
            val revision = firstPageUint(row["policyRevision"]).toString()
            val queryText = row["queryJson"] as? String ?: throw ProtocolException("invalid-message")
            if (row["filterDigest"] != protocol.payloadDigest(queryText)) {
                throw ProtocolException("digest-mismatch")
            }
            val query = StrictJson.parse(queryText.toByteArray(Charsets.UTF_8)).objectValue()
            if (query.keys != setOf("recordType", "window", "pageSize") || query["recordType"] != type ||
                query["pageSize"] !is Long || query["pageSize"] as Long !in 1L..500L) {
                throw ProtocolException("invalid-message")
            }
            val window = query["window"].objectValue()
            if (window.keys != setOf("start", "end")) throw ProtocolException("invalid-message")
            val startText = window["start"] as? String ?: throw ProtocolException("invalid-message")
            val endText = window["end"] as? String ?: throw ProtocolException("invalid-message")
            val start = Instant.parse(startText)
            val end = Instant.parse(endText)
            if (firstPageTime.format(start) != startText || firstPageTime.format(end) != endText) {
                throw ProtocolException("invalid-message")
            }
            val scope = app.klebb.companion.sync.WeightReadScope(start, end, (query["pageSize"] as Long).toInt())
            if (!scope.supported() || queryText != ControlJson.text(linkedMapOf(
                    "recordType" to type, "window" to linkedMapOf("start" to startText, "end" to endText),
                    "pageSize" to query["pageSize"]))) throw ProtocolException("invalid-message")
            val id = row["readinessId"] as? String ?: throw ProtocolException("invalid-message")
            if (!Regex("hc_ready_[A-Za-z0-9_-]{43}").matches(id)) throw ProtocolException("invalid-message")
            val expiryText = row["expiresAt"] as? String ?: throw ProtocolException("invalid-message")
            val expiry = Instant.parse(expiryText)
            if (firstPageTime.format(expiry) != expiryText || expiry.isAfter(now().plusSeconds(300))) {
                throw ProtocolException("readiness-unverified")
            }
            val challenge = NativeFirstPageChallenge(epoch, owner, type, scope, binding, revision,
                queryText, row["filterDigest"] as String, ack, id, expiry)
            restoredStreams[type] = FirstPageStream(binding, ack)
            restoredTransitions[type] = ReadinessTransition(status?.let { immutableResult(it) }, immutableResult(row))
            if (type in challenges) restoredChallenges[type] = challenge else retiredChallenges[type] = challenge
            completed[type]?.let {
                val result = it.objectValue()
                validateFirstPageResult(result, type, binding)
                val beginRevision = firstPageUint(revision)
                if (beginRevision == Long.MAX_VALUE ||
                    firstPageUint(result["policyRevision"]) != beginRevision + 1L ||
                    result["sharing"] != "enabled" ||
                    result["verification"] != "authenticated-companion-report") {
                    throw ProtocolException("readiness-unverified")
                }
                restoredCompleted[type] = Collections.unmodifiableMap(LinkedHashMap(
                    result + ("binding" to binding)))
            }
        }
        val blocked = state["blocked"] as? List<*> ?: throw ProtocolException("invalid-message")
        if (blocked.any { it !is String || it !in savedCategories || it !in selectedTypes } ||
            blocked.size != blocked.toSet().size) throw ProtocolException("invalid-message")
        val restoredStops = mutableMapOf<String, LocalCategoryStopReceipt>()
        val restoredStopsConfirmed = mutableMapOf<String, ReadinessTransition>()
        for ((type, value) in stops) {
            val row = value.objectValue()
            if (row.keys != setOf("binding", "acknowledgedSequence", "challenge", "status", "response")) {
                throw ProtocolException("invalid-message")
            }
            val binding = firstPageBinding(row["binding"])
            val ack = firstPageUint(row["acknowledgedSequence"]).toString()
            val stream = restoredStreams[type]
            val expectedBinding = stream?.binding ?: (namespace + ("generation" to
                baseStreams[type].objectValue()["generation"]))
            val expectedAck = stream?.acknowledged ?: baseStreams[type].objectValue()["acknowledgedSequence"]
            if (binding != expectedBinding || ack != expectedAck ||
                (stream == null && row["challenge"] != null)) throw ProtocolException("binding-mismatch")
            val retired = retiredChallenges[type]
            if (stream != null && (retired == null || retired.binding != binding ||
                    retired.acknowledgedSequence != ack)) throw ProtocolException("binding-mismatch")
            restoredStops[type] = LocalCategoryStopReceipt(
                PairedBatchScope(epoch, owner, type, binding, limits, ack), retired)
            if ((row["status"] == null) != (row["response"] == null)) {
                throw ProtocolException("binding-mismatch")
            }
            if (row["status"] != null) {
                val status = row["status"].objectValue()
                val response = row["response"].objectValue()
                val predecessor = firstPageBinding(status["binding"])
                if (predecessor.filterKeys { it != "generation" } != namespace ||
                    firstPageUint(predecessor["generation"]) < firstPageUint(binding["generation"])) {
                    throw ProtocolException("binding-mismatch")
                }
                validateStoppedTransition(status, response, type)
                restoredStopsConfirmed[type] = ReadinessTransition(immutableResult(status), immutableResult(response))
            }
        }
        origin = savedOrigin
        paired = owner
        pairedLimits = limits
        firstPageStreams.putAll(restoredStreams)
        firstPageChallenges.putAll(restoredChallenges)
        firstPageCompletions.putAll(restoredCompleted)
        firstPageBlocked.addAll(blocked.map { it as String })
        firstPageTransitions.putAll(restoredTransitions)
        localCategoryStops.putAll(restoredStops)
        categoryStopConfirmations.putAll(restoredStopsConfirmed)
    }

    fun capabilityRequest(): AuthorisedRequest = authorised("$BASE/capabilities", null)
    fun statusRequest(recordType: String): AuthorisedRequest {
        if (recordType !in categories) throw ProtocolException("scope-denied")
        return authorised("$BASE/streams/$recordType/status", recordType)
    }
    /** A durable upload receipt is page acceptance, never native coverage or policy authority. */
    fun uploadBatch(transport: PairingTransport, bytes: ByteArray): HealthFrame =
        upload(transport, bytes, ::batchRequest)
    /** Part custody is not a durable record receipt and must never advance the queue ACK. */
    internal fun uploadObjectPart(transport: PairingTransport, bytes: ByteArray): HealthFrame =
        upload(transport, bytes) { objectRequest(it, false) }
    /** Only the complete object digest can receive the ordinary durable receipt. */
    internal fun uploadObjectFinalise(transport: PairingTransport, bytes: ByteArray): HealthFrame =
        upload(transport, bytes) { objectRequest(it, true) }
    private fun upload(transport: PairingTransport, bytes: ByteArray,
        prepare: (ByteArray) -> AuthorisedRequest): HealthFrame {
        val selected = destination ?: throw ProtocolException("not-paired")
        if (transport.destination != selected) throw ProtocolException("invalid-destination")
        val body = bytes.copyOf()
        try {
            val request = prepare(body)
            val owner = paired
            synchronized(this) {
                if (request.epoch != epoch || request !in requests || paired !== owner) {
                    throw ProtocolException("cancelled")
                }
                batchTransports[request] = transport
            }
            try {
                val response = transport.request("POST", request.path, body, request.headers)
                return acceptResult(request, response.body, response.status)
            } catch (failure: Exception) {
                // A lost reply may follow a remote commit; only its current owner may be cleared.
                synchronized(this) {
                    if (request.epoch == epoch && paired === owner && request in requests) {
                        if (persistence == null) clear() else cancelOwnedRequest(request)
                    }
                }
                throw failure
            } finally { synchronized(this) { batchTransports.remove(request) } }
        } finally { body.fill(0) }
    }
    @Synchronized
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
    @Synchronized
    private fun objectRequest(bytes: ByteArray, finalise: Boolean): AuthorisedRequest {
        if (paired == null) throw ProtocolException("not-paired")
        val frame = protocol.decode(bytes, ValidationContext(
            limits = pairedLimits ?: throw ProtocolException("not-paired"), categories = categories))
        val kind = if (finalise) "object-finalise" else "object-part"
        if (frame.kind != kind) throw ProtocolException("invalid-message")
        val recordType = frame.fields["recordType"] as String
        val request = authorised(if (finalise) "$BASE/object-finalise" else "$BASE/object-parts", recordType)
        try {
            val verified = protocol.decode(bytes, request.context)
            if (finalise) {
                batchReceipts[request] = ReceiptExpectation(recordType, verified.fields["sequence"] as String,
                    verified.fields["batchId"] as String, verified.fields["objectDigest"] as String)
            } else {
                val expected = LinkedHashMap(verified.fields)
                val part = Base64.getDecoder().decode(expected.remove("partBase64") as String)
                expected["kind"] = "object-part-receipt"
                expected["partBytes"] = part.size.toLong()
                part.fill(0)
                objectPartReceipts[request] = Collections.unmodifiableMap(expected)
            }
            return request
        } catch (failure: Exception) {
            request.clear()
            requests.remove(request)
            batchReceipts.remove(request)
            objectPartReceipts.remove(request)
            throw failure
        }
    }
    @Synchronized
    private fun authorised(path: String, recordType: String?): AuthorisedRequest {
        checkDurableCurrent()
        if (firstPageExchange != null) throw ProtocolException("request-active")
        if (recordType == null && firstPageBlocked.isNotEmpty()) {
            throw ProtocolException("readiness-unverified")
        }
        val fields = paired?.fields ?: throw ProtocolException("not-paired")
        val binding = listOf("tenantId", "instanceId", "sourceStoreId", "installationId", "restoreEpoch")
            .associateWith { fields[it] as String }
        val headers = linkedMapOf("Authorization" to "Bearer ${fields["credential"]}",
            "Klebb-Health-Protocol" to "1")
        var selectedBinding = binding
        if (recordType != null) {
            val stream = effectiveStream(fields, recordType)
            val generation = stream["generation"] as String
            headers["Klebb-Health-Generation"] = generation
            headers["Klebb-Health-Restore-Epoch"] = fields["restoreEpoch"] as String
            selectedBinding = binding + ("generation" to generation)
        }
        return AuthorisedRequest(epoch, path, headers, recordType,
            ValidationContext(limits = pairedLimits ?: throw ProtocolException("not-paired"),
                binding = selectedBinding, categories = categories)).also { requests.add(it) }
    }
    @Synchronized
    fun acceptResult(request: AuthorisedRequest, response: ByteArray, httpStatus: Int = 200): HealthFrame {
        checkDurableCurrent()
        if (request.epoch != epoch || paired == null || request !in requests) {
            throw ProtocolException("cancelled")
        }
        try {
            val frame = protocol.decode(response, request.context)
            if (frame.kind == "error") throw ProtocolException(frame.fields["code"] as String)
            if (httpStatus !in 200..299) throw ProtocolException("request-refused")
            val receipt = batchReceipts[request]
            val partReceipt = objectPartReceipts[request]
            if (partReceipt != null) {
                if (frame.kind != "object-part-receipt") throw ProtocolException("binding-mismatch")
                if (frame.fields["objectDigest"] != partReceipt["objectDigest"] ||
                    frame.fields["partDigest"] != partReceipt["partDigest"]) {
                    throw ProtocolException("digest-mismatch")
                }
                if (frame.fields != partReceipt) throw ProtocolException("binding-mismatch")
            } else if (receipt != null) {
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
                val expected = categories.associateWith { effectiveStream(paired!!.fields, it) }
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
            if (persistence == null || (failure as? ProtocolException)?.code == "revoked") clear()
            else cancelOwnedRequest(request)
            throw failure
        } finally {
            request.clear()
            requests.remove(request)
            batchReceipts.remove(request)
            objectPartReceipts.remove(request)
        }
    }
    @Synchronized
    fun clear() {
        try {
            if (persistence != null) {
                // Explicit user clear/revocation deletes the vault before discarding its owner.
                persistence!!.forget()
                persistenceFault = false
            }
        } catch (_: Exception) {
            persistenceFault = true
            throw ProtocolException("pairing-storage-unavailable")
        } finally { clearMemory() }
    }

    private fun clearMemory() {
        firstPageExchange?.transport?.cancel()
        firstPageExchange?.headers = emptyMap()
        firstPageExchange = null
        firstPageChallenges.clear()
        firstPageCompletions.clear()
        firstPageStreams.clear()
        firstPageBlocked.clear()
        firstPageTransitions.clear()
        localCategoryStops.clear()
        categoryStopConfirmations.clear()
        epoch++
        batchTransports.values.forEach { it.cancel() }
        batchTransports.clear()
        pending?.clear()
        pending = null
        requests.forEach { it.clear() }
        requests.clear()
        batchReceipts.clear()
        objectPartReceipts.clear()
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
