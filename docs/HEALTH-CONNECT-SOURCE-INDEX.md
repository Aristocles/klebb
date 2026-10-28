# Health Connect source index

The `source-index-v1` target materialises the typed identities of saved native
records and tombstones, together with the complete saved transport frontier
vector for each tenant/source store. It retains neither source payloads nor
scientific quantities. This target is separate from canonical metric/card
publication, native capture and release readiness.

Ingestion still commits raw records, tombstones, the original compact receipt,
stream frontier and immutable queued reference in one WAL/FULL transaction.
The durable ACK concerns that save. Source-index failure cannot invalidate or
change the original receipt.

After ingestion and at startup, a coalesced worker verifies every saved
reference/receipt pair through every frontier before rebuilding from current
records and tombstones. It verifies original qualified digests and full
bindings; a missing, orphaned or inconsistent reference refuses. An older
receipt cannot restore an older source snapshot.

The publisher uses its own observed WAL/FULL writer. Typed identity rows,
the complete vector, publication epoch/time and current status share one
COMMIT. A failed transaction preserves the previous publication. The worker
records compact failure state separately when storage permits; failure to
record that state leaves recoverable noncurrent work, never invented success.
Failures before admission neither consume an attempt nor schedule a retry.

## Status and rebuild

The real browser session and origin establish authority for these routes:

| Route | Result |
|---|---|
| `GET /api/connectors/health-connect/projections/status` | `{target,sources}` with saved counts/vector, previous publication, current restore epoch, queued/failed/current state and persisted attempts |
| `POST /api/connectors/health-connect/projections/rebuild` | Exactly `{}` requests a new bounded cycle; `202 {target,queuedSources}` confirms saved requests, not completed publication or native ingestion |

Ownership comes from retained server connector entries, including revoked
phone entries. Revoked native credentials remain refused, while the browser
owner can inspect/rebuild retained history. Known other owners are filtered;
unknown or ambiguous saved namespaces refuse with 503. The routes do not
mint a replacement missing ownership catalogue or take a namespace from the
request body. They expose no payloads, credentials, verifiers or chat grants.

`current` requires persisted current state, the current restore epoch,
complete equal saved/published vectors and exact equal typed identity sets.
Counts alone are insufficient. A changed frontier or recovery fence reports
noncurrent state immediately, even before the asynchronous worker runs.
Status reads are read-only; fresh instances with no native history return an
empty source list without creating derived tables.

Each new frontier/fence or explicit rebuild permits three persisted attempts.
The first is immediate; retry deadlines are one then five seconds after the
preceding failure. Restart preserves the budget/deadlines. An exhausted or
intrinsically over-limit cycle waits for a new frontier or owner rebuild.
Duplicate ACK retries and already-current startup do not republish or reset
timestamps/counters. Shutdown stops pending work and retry timers.

## Storage, bounds and recovery

Three additive derived tables are created together only for admitted native
work: `health_source_index`, `health_source_index_frontiers` and
`health_source_index_state`. Existing history/object schemas, payloads,
receipts, queued-reference rows and legacy HAE/card data remain unchanged.
Partial or changed required schemas fail closed rather than being repaired
as empty history. These rebuildable tables are observed separately from the
immutable native-history test inventory.

| Component ceiling | Inclusive bound |
|---|---|
| Combined record/tombstone identities per source | 100,000 |
| Full frontier components per source | 1,000 |
| Owned saved sources per status/rebuild operation | 1,000 |
| Encoded UTF-8 status response | 1,048,576 bytes |
| Browser rebuild request | Existing 16,384-byte body ceiling; exactly `{}` |

The existing pairing catalogue also retains its 128-connector admission
ceiling. These are component bounds, not a passed Cloud capacity matrix.
SQL counts and bounded selections precede materialisation; identity
publication uses scoped SQL without parsing raw record JSON. Status budgets
encoded bytes incrementally.

Over-limit source work reports `failed`/`limit-exceeded`, preserving durable
raw history and any previous publication. An over-limit vector explicitly
reports `saved.frontiers:null` and `saved.complete:false`, never a truncated
current vector. Status/request overflow refuses 413 before queue effects.
Storage/catalogue inconsistency refuses 503 `storage-unavailable`.

Startup, admission and publication respect import freeze/refused recovery and
the current server restore fence. No asynchronous boundary separates source
selection from publication COMMIT. Future asynchronous publication must
recheck the live fence. Portable catalogue/deletion policy and complete
export/import are separate delivery gates; personal capture waits for the
merged early recovery proof.

Removal from active SQLite tables does not prove forensic page erasure or
expiry from managed backups. Physical cleanup and the verified existing
backup retention policy remain required lifecycle/release checks.
