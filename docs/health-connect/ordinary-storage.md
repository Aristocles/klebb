# Ordinary Health Connect storage

The ordinary batch endpoint saves supported source envelopes independently of
cards and metric definitions. It preserves every producer represented in an
authorised batch, including opaque display extensions inside the bounded
ordinary envelope. Unsupported serializers and sensitive families refuse
before any ACK. This storage service does not perform Health Connect reads,
native scheduling, phone checkpointing or card projection.

## Atomic save and readback

The additive version-1 tables live in the existing `db/klebb.db`:

| Table | Stored state |
| --- | --- |
| `health_schema_version` | Required version marker |
| `health_records` | Current complete raw record JSON, serializer/version, family and projection declaration |
| `health_tombstones` | Source-deleted native identity and the deletion's transport stream/sequence |
| `health_batch_receipts` | Compact original receipt, digest and unique sequence/batch ID |
| `health_streams` | Contiguous acknowledged sequence per complete transport scope/type |
| `health_projection_outbox` | Queued source/type rebuild reference, sequence, batch ID and digest |

Native record identity is exactly tenant/source-store/type/native-record-ID.
Installation, instance, generation, digest and restore epoch do not rename a
record. Transport stream keys include tenant, instance, source store,
installation, category, generation and restore epoch. Both sequence and batch
ID are unique within that scope. The server derives the trusted scope from
current authority; caller labels cannot establish ownership.

The raw changes, source tombstones, immutable receipt, frontier and outbox
reference share one `BEGIN IMMEDIATE` transaction. New schema creation also
belongs to that transaction. Duplicate retries do not replay effects or create
another job. A delete of an unknown identity still creates a tombstone. An
upsert clears that source tombstone and replaces the current record payload.
An upsert followed by a delete in the same batch follows the declared order.

Receipts and jobs retain no full batch or record payload. A source deletion or
correction therefore removes the old reading from logical raw history without
leaving an indefinite plaintext payload archive. This is logical deletion;
SQLite pages, WAL/checkpoints and container backups have their own physical
retention and deletion gates. Compact receipt retention and capacity/cleanup
limits remain part of the wider programme.

Frontier reads use a separate read-only SQLite transaction. A nonzero frontier
requires the latest canonical saved receipt, structurally valid with the same full binding,
type, sequence, batch ID and digest. A zero or missing stream cannot have saved
receipts. Missing or changed required tables, unsupported version, malformed
frontier, missing main database or inconsistent frontier/receipt state fails closed. No refused read
or upload resets history to an empty database.

## Durability and compatibility

Each ingest request opens its own synchronous `node:sqlite` connection to the
existing instance database. It sets a five-second busy timeout, WAL journal
mode and `synchronous=FULL`, then checks WAL and FULL on that same connection
before BEGIN. Instance bootstrap owns creating the main database; this service
requires an existing file. Database replacement must use the coordinated
import/restore gates, rather than externally unlinking files during a request.
The legacy card/Health Auto Export handles keep their existing
settings and tables. The health service holds no connection across requests.

A successful response follows native COMMIT. SQLite FULL in WAL mode flushes
the WAL on commit, subject to the filesystem and device honouring flushes.
Production requires a local filesystem supporting SQLite locking and shared
WAL state, with the database/WAL/shm in the persistent instance volume.
Network shares, storage that lies about flushes, power-loss behaviour of an
unverified device, and copies omitting a live WAL do not satisfy this assumption.
Use the existing supported backup/recovery paths; complete native-history
portable export/import is a later recovery gate.

Actual SQLite busy/full or transaction statement failure returns
`503 storage-unavailable`; failed transactions roll back all effects. Process
death before COMMIT leaves no new batch. Death after COMMIT may lose the
response while retaining the complete batch. A post-commit error can also
leave an uncertain caller outcome. Retry the original batch to recover the
immutable receipt rather than assigning a new sequence or assuming a 503
means nothing was saved.

No canonical cards are projected by this slice. Queued references permit a
later worker to rebuild a source/category from current raw records and
tombstones without retaining deleted historical payloads. Outbox execution,
failure state and rebuild proof remain required under CORE-02; the current
table accepts only the implemented `queued` state.

## Verification and remaining gates

Actual API tests pair with scoped authority in isolated synthetic homes,
preserve a nonempty legacy card sentinel and compare independent cold SQL
readback. They exercise original receipt retries, a discarded response body
with readback before retry, conflict/gap rules, both producers, raw-only opaque
fields, deletion/correction, unsupported envelopes, scope/revocation, Int64
arithmetic and refusal of malformed/inconsistent storage.

Child-only fault instrumentation observes the actual ingest connection before
BEGIN. Native `max_page_count` triggers SQLite FULL; a separate live write lock
triggers busy. A late outbox statement failure proves rollback after raw
writes. Actual process termination immediately before/after native COMMIT
proves the expected cold atomic state and original retry receipt. These tests
run in the regular Node API suite; shared receipt expectations run in both the
regular Node and Android Kotlin suites.

```sh
node --test tests/api/health-connect-durable-ingestion.test.js tests/api/health-connect-ingest-faults.test.js tests/health-connect-durable-receipt.test.js
cd android
./gradlew :app:testDebugUnitTest
```

These are component/storage proofs, not native capture or release readiness.
CORE-02 remains open for physical multipart assembly, abandoned-part cleanup
and projector failure/rebuild. Native permission, pending-copy purge, restore,
real Health Auto Export client and release/48-hour soak gates remain pending.
Use synthetic or controlled data until merged CORE-06.R0 proves recovery of
raw-only records, identity/policy and tombstones into a fresh instance.
