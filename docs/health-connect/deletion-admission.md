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

Logical removal does not erase retired SQLite pages or backups. Browser
preview/apply and actual user-guard creation, wider deletion selectors,
readable-scope reconciliation, sensitive records, phone stop/re-enable,
portable ownership, CORE-06.R0 and managed deletion-ledger recovery remain
separate required work. Complete loss of all native tables cannot yet be
distinguished from legitimate first use without the trusted recovery
catalogue. Component checks establish no personal-capture or release gate.
