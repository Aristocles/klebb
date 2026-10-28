<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Complete-record object storage

This is the bounded multipart path within ordinary Health Connect ingestion.
Each HTTP part/finalise frame and ordinary batch retains the inclusive
1,048,576-byte uncompressed UTF-8 ceiling. The reconstructed object is the
original whole batch payload JSON for exactly one ordinary upsert, at most
67,108,864 bytes and 128 parts. It preserves raw-only records and opaque exposed
fields under the existing serializer and structural budgets.

Both routes require the current scoped connector bearer, protocol version,
sharing generation and restore epoch. Authority, category and import lifecycle
are rechecked after the asynchronous request body. Reconstruction and SQL then
run synchronously, with no intervening await. These checks grant no broader
browser, administrative or card access.

## Reservation and physical staging

The existing `db/klebb.db` gains three additive tables within its existing
version-1 health schema. Creation is transactional and idempotent; a partial
or changed required object schema refuses rather than resetting history.
The configured main database must already exist.

| Table | Purpose |
|---|---|
| `health_object_staging` | One immutable declaration, absolute expiry and full declared reservation per transport stream |
| `health_object_parts` | Actual indexed SQLite BLOBs and their saved digests, with a cascading staging foreign key |
| `health_object_receipts` | Compact original declaration and ordered part metadata for committed retries |

A full transport stream includes tenant, instance, source store, installation,
record type, generation and restore epoch. Before reserving any new object,
the server requires the next contiguous sequence and unused batch ID. It
reserves the object's **whole declared total**, not only the received part's
bytes. At most one active object belongs to a stream. An identical repeated
part uses no new reservation and does not extend expiry; changed immutable
metadata or part bytes conflict without replacement.
Declaration and manifest values compare independently of JSON member order;
the original whole payload digest continues to cover its exact original bytes.

The aggregate default is 268,435,456 declared bytes. Set
`HEALTH_CONNECT_STAGING_MAX_BYTES` to a canonical positive integer at or below
that bound to narrow it. Invalid configuration refuses startup rather than
silently expanding a requested limit. Capabilities and pairing grants advertise
`maxObjectBytes = min(67,108,864, configured aggregate cap)`.

An intrinsically oversized declaration returns `400 limit-exceeded` at the
negotiated limit; a declaration beyond the hard schema's 64 MiB/128-part bounds
returns `400 invalid-message`. Temporary aggregate occupancy returns retryable
`503 storage-unavailable`. An upload must retry its same immutable declaration,
not discard a still-shared pending record or advance its checkpoint.

## Finalisation and retries

Finalisation requires every actual indexed BLOB and a dense ordered manifest.
It checks real byte lengths before allocation, rehashes each physical part,
and verifies total bytes and the complete object's exact-byte SHA-256. A missing
part returns `409 missing-parts`; changed finalise metadata conflicts; corrupted
saved physical bytes return `503 storage-unavailable`. No partial object becomes
a saved record or frontier.

The separate Node/Kotlin assembled-payload validator enforces the same strict
source contract and structural budgets as ordinary payloads. Unknown serializers,
multiple changes, deletes, nonordinary families, invalid UTF-8, duplicate keys
and unsafe numeric Int64 spelling are refused without dropping fields.

The own-handle WAL/FULL transaction commits the complete raw upsert, tombstone
effects, immutable receipt, contiguous frontier, one queued projection reference,
compact object declaration/manifest and staging deletion together. The staging
foreign key removes all its current BLOBs in that transaction. Before COMMIT,
failure retains the prior staged object and history; after COMMIT, the saved
record and retry metadata exist with no active staged parts or reservation.
Part receipts never mean saved history.

An identical already committed retry is matched against the compact original
declaration and ordered manifest before requiring physical parts. It returns
the original batch receipt after a restart and later raw correction/deletion,
without resurrecting the old raw record or replaying effects. No full object
or base64 payload is archived in compact retry metadata.

New PART and FINALISE check [typed deletion admission](deletion-admission.md)
after committed retry resolution and before allocation, cleanup or
reconstruction. Source deletion atomically purges matching uncommitted staging
across transport streams while retaining compact committed receipts.

## Expiry and supported operating assumptions

An abandoned object expires exactly 86,400,000 milliseconds after its first
accepted part. Startup and pre-admission cleanup remove overdue active BLOBs
and reservations; a healthy process also checks at most every 300,000
milliseconds. The scheduled writer skips import freeze or refused recovery.
A crashed/offline process performs overdue cleanup before new staging admission.
Committed raw history and compact retry metadata are preserved.

Cold-read tests enumerate actual live SQLite BLOBs and recompute their digests;
their staging cleanup proof concerns those active copies. Cleanup leaves only
compact retry metadata in indexed staging. A synthetic Node 24.15.0/SQLite
3.51.3 probe with `secure_delete=0` retained retired bytes after checkpoint and
close. SQLite freelist/WAL page erasure, managed backup expiry and broader
deletion/recovery remain separately verified gates.

Reconstruction materialises at most one bounded object buffer and reads one
bounded part at a time, then materialises strict decoded JSON and the current
raw record. It uses synchronous Node SQLite and therefore blocks that process
during finalisation. A writable local filesystem with working SQLite WAL/FULL,
adequate database/WAL disk headroom and memory for that bounded decoding are
required. Structural ceilings do not certify every object at the declared
Cloud memory limit; the measured capacity matrix belongs to CLOUD-03.

Invented controlled records and component fault tests do not establish native
capture, encrypted phone queue, complete portable recovery, real Health Auto
Export retry or release readiness. Projection references use the existing
[source-index publisher](../HEALTH-CONNECT-SOURCE-INDEX.md). Merged CORE-06.R0 remains required before
personal-history capture; the real 48-hour release soak has not started.
