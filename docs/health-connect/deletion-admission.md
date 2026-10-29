<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Typed deletion admission

Native identity is tenant, logical source store, record type and native record
ID. Source deletion remains sticky across transport sequences, installations,
sharing generations and restore epochs. Storage V1 uses its typed source
tombstones; V2 also uses the union of source-deleted and user-suppressed guard
flags. V2 migration remains an explicit operator action through the
[existing migration](deletion-guard-migration.md). Requests never choose it.

Current credential, binding, category and lifecycle checks precede receipt
resolution. An exact committed batch returns its original receipt before new
admission. A committed object's PART returns its original part receipt and
FINALISE returns its original durable receipt after later source deletion.
These retries do not replay raw records, frontiers, references or cleanup.
Changed immutable retry metadata still conflicts.

Every identity in a new batch is checked before mutation. An upsert of a
suppressed identity refuses the entire batch with `409 deletion-suppressed`.
Opposite upsert/delete operations for one typed identity return `409 conflict`
in either order. New PART and FINALISE perform the same admission before
allocation, staging cleanup or reconstruction; suppression precedes
`missing-parts`. The unchanged wire V1 error shape has `retryable:false`.

Confirmed source deletion removes its raw row and matching uncommitted object
staging across transport streams. Actual cascade-owned BLOBs disappear in the
same own WAL/FULL transaction as the source tombstone, V2 touched guard,
receipt, frontier and queued reference. Other source/type identities and
committed compact retry metadata remain. The existing source-index publisher
rebuilds from the changed verified native vector.

Selected staging is validated before deletion effects: at most 1,000 objects,
128,000 physical parts and the configured aggregate actual-byte limit,
which cannot exceed 268,435,456. Overflow returns `413 limit-exceeded`.
Declarations, transport keys, reservations, expiry, exact schema and physical
metadata must agree. Actual BLOB types and lengths are checked before loading;
each bounded part is rehashed. Corruption returns `503 storage-unavailable`.
Sparse incomplete uploads are eligible for deletion; finalisation completeness
is not required to remove them.

V2 source deletion preserves any existing user flag and updates only the
touched guard's source provenance. It stores the recognised common instant or
interval footprint with source UTC text, nanoseconds, signed extended years
and nullable `ZoneOffset.id` values, including offset seconds. SQL returns only
bounded typed common scalars, never the whole raw payload to JavaScript.
Unknown footprint is SQL NULL; a later unknown delete retains a known prior
footprint. Untouched historical tombstones stay authoritative.

## Browser-owner exact-ID deletion

The authenticated browser owner can POST JSON to
`/api/connectors/health-connect/deletions/preview` and
`/api/connectors/health-connect/deletions/apply`. The approved origin and current
session must pass the existing browser checks. Connector bearer credentials
cannot use these routes. Retained ownership still permits browser management
after phone revocation. Responses use `Cache-Control: no-store`.

Preview accepts exactly this shape; replace the placeholders with the retained
owned source and native ID. Select 1-100 unique typed IDs. Extra fields,
duplicate identities and invalid record types or IDs are refused.

```json
{"sourceStoreId":"<owned sourceStoreId>","identities":[{"recordType":"StepsRecord","nativeRecordId":"<native ID>"}]}
```

For an unseen ID in an owned source with no native streams or publication in
an already initialized store, preview returns this shape without writing. Flags and counts for another
selection reflect its actual saved state; no reading values are returned.

```json
{"version":1,"kind":"deletion-preview","sourceStoreId":"<owned sourceStoreId>","revision":"<preview revision>",
 "identities":[{"recordType":"StepsRecord","nativeRecordId":"<native ID>","sourceDeleted":false,"userSuppressed":false,"currentRecord":false,"footprint":null}],
 "effects":{"newlyUserSuppressed":1,"removedRecords":0,"removedStagedObjects":0,"removedParts":0,"removedPartBytes":0}}
```

Apply adds only the exact `revision` returned by preview:

```json
{"sourceStoreId":"<owned sourceStoreId>","identities":[{"recordType":"StepsRecord","nativeRecordId":"<native ID>"}],"revision":"<preview revision>"}
```

A successful HTTP 200 follows COMMIT. The guard-only example returns:

```json
{"version":1,"kind":"deletion-result","sourceStoreId":"<owned sourceStoreId>","revision":"<preview revision>",
 "effects":{"newlyUserSuppressed":1,"removedRecords":0,"removedStagedObjects":0,"removedParts":0,"removedPartBytes":0},"projectionQueued":false}
```

The revision is an opaque `sha256:` string followed by 64 lowercase hexadecimal
digits. Copy it unchanged. It binds the current restore fence, native schema,
complete saved vector and selected raw, guard, tombstone and physical staging
content. Selection order and publication progress alone do not change it.
Changed content requires a fresh preview; a stale revision returns 409.
Apply echoes the validated pre-apply revision.

Preview reads an existing valid V1 or V2 snapshot. Apply requires existing V2;
V1 apply returns `503 storage-unavailable`. Only an operator can run the
[explicit V2 migration](deletion-guard-migration.md). Neither endpoint creates
native storage, repairs a partial store, migrates it or chooses a Windows
migration profile. Session, ownership, import/recovery and restore-fence checks
remain effective through the body and final transaction boundary.

Apply persists user suppression while retaining source deletion/provenance and
known common footprints. It removes selected current raw rows and matching
uncommitted staging with its active parts. Native receipts, frontiers, outbox
references, source tombstones and committed compact retries remain. Existing
sticky admission blocks later new uploads; committed retries retain their
original receipts. Suppression has no clearing operation.

When effects are nonzero and a saved native stream or publication cycle exists,
apply queues and resets its source index in the same transaction and schedules the
worker after COMMIT. `projectionQueued:true` means queued work, not completed
publication. The previous publication pointer is retained but noncurrent until
the worker publishes. A fresh preview/apply with all five effects zero returns
`projectionQueued:false` without resetting or scheduling. Guard-only sources
invent no native receipt, frontier or publication.

| HTTP status / code | Meaning |
|---|---|
| 400 `invalid-message` | Invalid exact shape, selection, ID or revision syntax |
| 401 `unauthorised` | Missing/changed browser session or connector bearer |
| 403 `scope-mismatch` | Origin or retained source ownership mismatch |
| 409 `conflict` | Preview content changed; preview again |
| 413 `limit-exceeded` | Request body or supported storage capacity exceeded |
| 503 `storage-unavailable` | V1 apply, missing/corrupt required state, storage failure or changed retained fence |

The storage error is exactly
`{"version":1,"kind":"error","code":"storage-unavailable","retryable":true}`.
Other listed refusals retain these fields with their code and `retryable:false`.
Existing import/recovery blocks retain their own error envelope. Bound the UTF-8 body to 65,536 bytes,
IDs to 1-256 Unicode codepoints, the complete native vector to 1,000 streams,
and selected raw text to 64 MiB. Matched staging keeps the object/part/actual-byte
limits above. Capacity refusal or corrupt storage causes no deletion effects.

## Remaining deletion and recovery gates

Logical removal does not erase retired SQLite pages or backups. The exact-ID
API is a foundation for the browser deletion UI. Wider category/source/date/
all-history selectors, readable-scope reconciliation, sensitive owned records,
canonical cards, phone stop/re-enable, portable ownership, CORE-06.R0 and
managed latest-ledger recovery remain separate required work. Complete loss of
all native tables cannot yet be distinguished from legitimate first use without
the trusted recovery catalogue. Component checks establish no personal-capture
or release gate; #757 remains open.
