// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.response.ChangesResponse
import app.klebb.companion.queue.QueueResult
import app.klebb.companion.setup.CategorySetup
import java.security.MessageDigest
import kotlin.coroutines.cancellation.CancellationException

/**
 * Native facts for the existing Weight pager. This does not issue policy authority,
 * publish coverage, save a change cursor, or infer a Cloud acknowledgement.
 */
class WeightScopeFacts internal constructor(
    val reason: String,
    val readPermissionGranted: Boolean?,
    val permissionsStable: Boolean?,
    val historyIncludesScope: Boolean?,
    val permissionFingerprintStart: String?,
    val permissionFingerprintEnd: String?,
    val pagesFinished: Boolean?,
    val tokenValid: Boolean?,
    val changesBarrierDrained: Boolean?,
    val pendingChanges: Int?
) {
    val nativeCompleteness: String get() = "UNKNOWN"
    val enableEligible: Boolean get() = false
    val reconciliationEligible: Boolean get() = false
    val deletionEligible: Boolean get() = false
    // Null is an unlimited readable-history boundary only when historyIncludesScope is true.
    // With unknown historyIncludesScope, this is not a serializable coverage query.
    val historyStart: String? get() = null
}

class NativeWeightScopeFacts internal constructor(
    private val permissions: suspend () -> Set<String>,
    private val historyFeature: () -> Int,
    private val newToken: suspend () -> String,
    private val changes: suspend (String) -> ChangesResponse,
    private val reader: OrdinaryRecordReader
) {
    constructor(client: HealthConnectClient) : this(
        { client.permissionController.getGrantedPermissions() },
        { client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) },
        { client.getChangesToken(ChangesTokenRequest(recordTypes = setOf(WeightRecord::class))) },
        { token -> client.getChanges(token) },
        HealthConnectRecordReader(client)
    )

    private data class PermissionPoint(val grants: Set<String>, val feature: Int)

    private suspend fun point(): PermissionPoint? = try {
        PermissionPoint(permissions().toSet(), historyFeature())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    private fun fingerprint(point: PermissionPoint): String {
        // Length prefixes avoid ambiguity; these bytes stay local to the factual producer.
        val text = point.grants.sorted().joinToString("") { "${it.length}:$it" } +
            ":history-feature:${point.feature}"
        return "sha256:" + MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    suspend fun capture(
        recordType: String,
        scope: WeightReadScope,
        maximumPages: Int,
        gate: suspend () -> ReadGate,
        acceptPage: suspend (OrdinaryRecordPage) -> QueueResult<Unit>
    ): WeightScopeFacts {
        require(CategorySetup.registry.containsKey(recordType)) { "Unsupported ordinary category" }
        require(maximumPages > 0)
        require(scope.supported()) { "Unsupported native query" }
        if (recordType != "WeightRecord") {
            return WeightScopeFacts("adapter-unimplemented", null, null, null,
                null, null, null, null, null, null)
        }
        val before = point()
        if (before == null) {
            return WeightScopeFacts("permission-or-feature-unknown", null, null, null,
                null, null, null, null, null, null)
        }
        val readPermission = CategorySetup.registry.getValue(recordType).readPermission
        val granted = before.grants.contains(readPermission)
        val history =
            HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in before.grants &&
            before.feature == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        if (granted != true || !history) {
            return WeightScopeFacts(
                if (granted == false) "read-permission-denied" else "readable-history-unknown",
                granted, null, null, fingerprint(before), null,
                null, null, null, null
            )
        }
        if (gate() != ReadGate.OPEN) {
            return WeightScopeFacts("binding-not-current", granted, null, true,
                fingerprint(before), null, false, null, false, null)
        }
        var finished: Boolean? = null
        var tokenValid: Boolean? = null
        var drained: Boolean? = null
        var pending: Int? = null
        var permissionChanged = false
        var permissionUnknown = false
        var reason = "native-facts-only"
        try {
            val token = newToken()
            require(token.isNotEmpty())
            check(gate() == ReadGate.OPEN) { "Binding changed while obtaining token" }
            val scan = OrdinaryRecordPager(reader).scan(scope, maximumPages, {
                val bindingGate = gate()
                if (bindingGate != ReadGate.OPEN) bindingGate
                else {
                    val current = point()
                    if (current == null) {
                        permissionUnknown = true
                        throw IllegalStateException("Permission observation unknown")
                    }
                    if (current != before) permissionChanged = true
                    if (readPermission !in current.grants ||
                        HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY !in current.grants) {
                        ReadGate.PERMISSION_DENIED
                    } else {
                        check(current == before) { "Permission or feature observation changed" }
                        ReadGate.OPEN
                    }
                }
            }, acceptPage)
            finished = scan is PageScanResult.Finished
            if (finished == true) {
                check(gate() == ReadGate.OPEN) { "Binding changed before the changes barrier" }
                val response = changes(token)
                check(gate() == ReadGate.OPEN) { "Binding changed during the changes barrier" }
                tokenValid = !response.changesTokenExpired
                pending = response.changes.size
                // An outstanding change has not been durably accepted by this pager.
                drained = tokenValid == true && !response.hasMore && pending == 0
                if (drained != true) reason = "changes-barrier-incomplete"
            } else {
                drained = false
                reason = "page-scan-incomplete"
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            reason = "native-observation-unknown"
        }
        val after = point()
        val current = try { gate() == ReadGate.OPEN }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        val stable = if (permissionChanged) false
            else if (permissionUnknown) null else after?.let { it == before }
        val historyStable = if (stable == true) true else null
        val scopedDrained = if (stable == true) {
            if (current == true) drained else if (current == false && drained != null) false else null
        } else if (stable == false) false else null
        if (stable != true) reason = "permission-or-feature-unstable"
        else if (current != true) reason = "binding-not-current"
        return WeightScopeFacts(reason, granted, stable, historyStable,
            fingerprint(before), after?.let(::fingerprint), finished, tokenValid,
            scopedDrained, pending)
    }
}
