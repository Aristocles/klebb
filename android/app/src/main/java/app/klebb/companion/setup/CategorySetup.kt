// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.setup

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import app.klebb.companion.records.RecordCodecs
import app.klebb.companion.sync.HealthConnectRecordReader
import java.util.Collections
import kotlin.coroutines.cancellation.CancellationException
import kotlin.reflect.KClass

enum class CategoryTruth { UNKNOWN, YES, NO }
enum class CategoryAvailability { UNKNOWN, AVAILABLE, UNAVAILABLE }

data class CategoryAdapter internal constructor(
    val name: String,
    val recordType: KClass<out Record>,
    val readPermission: String
)

/** Each value requires its own evidence; a grant or a record does not fill another field. */
data class CategoryEvidence(
    val available: CategoryAvailability = CategoryAvailability.UNKNOWN,
    val observed: CategoryTruth = CategoryTruth.UNKNOWN,
    val saved: CategoryTruth = CategoryTruth.UNKNOWN,
    val displayed: CategoryTruth = CategoryTruth.UNKNOWN
)

data class CategoryState internal constructor(
    val adapter: CategoryAdapter,
    val selected: Boolean,
    val permitted: CategoryTruth,
    val available: CategoryAvailability,
    val observed: CategoryTruth,
    val saved: CategoryTruth,
    val displayed: CategoryTruth
) {
    /** A setup precondition, never upload, deletion, revocation or durable-page authority. */
    val canCollect: Boolean
        get() = selected && permitted == CategoryTruth.YES &&
            available == CategoryAvailability.AVAILABLE
}

/**
 * Ordinary setup inventory follows the existing mapper, not a separate list of SDK types.
 * Mapping a type does not prove native availability or a successful read.
 */
object CategorySetup {
    val registry: Map<String, CategoryAdapter> = Collections.unmodifiableMap(
        RecordCodecs.supportedRecordTypes.associateWith { name ->
            val type = Class.forName(
                "androidx.health.connect.client.records.$name",
                false,
                Record::class.java.classLoader
            ).asSubclass(Record::class.java).kotlin
            CategoryAdapter(name, type, HealthPermission.getReadPermission(type))
        }
    )

    /** Shared SDK permissions are deduplicated; write, history and background are separate. */
    fun requestedReadPermissions(selected: Set<String>): Set<String> {
        requireSupported(selected)
        return selected.mapTo(linkedSetOf()) { registry.getValue(it).readPermission }
    }

    /** Null means the grant query was not established; an empty complete query means no grants. */
    fun states(
        selected: Set<String>,
        grantedPermissions: Set<String>?,
        evidence: Map<String, CategoryEvidence> = emptyMap()
    ): Map<String, CategoryState> {
        requireSupported(selected)
        requireSupported(evidence.keys)
        return Collections.unmodifiableMap(registry.mapValues { (name, adapter) ->
            val known = evidence[name] ?: CategoryEvidence()
            CategoryState(
                adapter = adapter,
                selected = name in selected,
                permitted = when {
                    grantedPermissions == null -> CategoryTruth.UNKNOWN
                    adapter.readPermission in grantedPermissions -> CategoryTruth.YES
                    else -> CategoryTruth.NO
                },
                available = known.available,
                observed = known.observed,
                saved = known.saved,
                displayed = known.displayed
            )
        })
    }

    /** Query only permission custody; failed queries do not establish denial or revocation. */
    suspend fun snapshot(
        client: HealthConnectClient,
        selected: Set<String>,
        evidence: Map<String, CategoryEvidence> = emptyMap()
    ): Map<String, CategoryState> {
        val selection = selected.toSet()
        val known = evidence.toMap()
        requireSupported(selection)
        requireSupported(known.keys)
        val grants = try {
            client.permissionController.getGrantedPermissions()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        return states(selection, grants, known)
    }

    /** Construct the existing inert Weight adapter only after all three setup facts agree. */
    fun weightReaderIfEligible(
        state: CategoryState,
        createReader: () -> HealthConnectRecordReader
    ): HealthConnectRecordReader? =
        if (state.adapter.recordType == WeightRecord::class && state.canCollect) {
            createReader()
        } else {
            null
        }

    fun weightReaderIfEligible(
        client: HealthConnectClient,
        state: CategoryState
    ): HealthConnectRecordReader? =
        weightReaderIfEligible(state) { HealthConnectRecordReader(client) }

    private fun requireSupported(names: Set<String>) {
        require(registry.keys.containsAll(names)) { "Unsupported ordinary category" }
    }
}
