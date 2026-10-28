<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Native deletion-guard storage migration

Native storage V2 requires `health_deletion_guards` alongside the original
native tables. Its persistent key is tenant, logical source store, record type
and native ID. Source deletion and user suppression have separate flags;
source provenance and an optional compact footprint remain distinct from
record payloads. Null means an unknown footprint. Storage V2 and the unchanged
wire protocol V1 are separate versions.

The exact definitions are in [schema.js](../../lib/health-connect/schema.js).
V1 with a guard table, mismatched version markers, and V2 with missing or
changed guard storage return `storage-unavailable`. Required storage is
validated rather than recreated. Default native transactions and fresh native
initialisation keep their existing V1 behaviour. The explicit migration also
validates existing receipt-order and object-expiry indexes and complete
optional object/index components. Additional indexes or triggers owned by the
version marker, and foreign keys referencing it, refuse before copy creation:
replacing that table could otherwise drop those objects or alter other rows.

## Explicit migration

Use an isolated copy of the configured health home for validation. The existing
`HEALTH_HOME`, `HEALTH_DB_DIR` and `HEALTH_DB_FILE` settings select the database.
`HEALTH_DB_DIR` and `HEALTH_DB_FILE` override `HEALTH_HOME`, so pin all three
settings to the isolated copy when inherited overrides may exist. The target
directory must already have private permissions; whole-database safety copies
contain health history.

```sh
HEALTH_HOME=/tmp/klebb-migration-copy HEALTH_DB_DIR=/tmp/klebb-migration-copy/db HEALTH_DB_FILE=/tmp/klebb-migration-copy/db/klebb.db node scripts/migrate-health-connect-deletion-guards.js --dry-run
HEALTH_HOME=/tmp/klebb-migration-copy HEALTH_DB_DIR=/tmp/klebb-migration-copy/db HEALTH_DB_FILE=/tmp/klebb-migration-copy/db/klebb.db node scripts/migrate-health-connect-deletion-guards.js --apply
```

Dry-run opens a read-only snapshot, validates required components and reports
the schema version. Apply requests
`withHistoryTransaction(work, { deletionSchema: true })`. Its result contains
only `version`, `migrated`, `safetyCopy` (a basename or null) and
`directoryDurability`. A valid V2 repeat creates no further copy. Invalid or
conflicting modes exit before storage access.

The own WAL/FULL writer holds `BEGIN IMMEDIATE` through a separate read-only
connection's parameterised `VACUUM INTO ?`. Before any original schema or row
change, the copy passes integrity, complete semantic schema and exact typed
row comparisons, including `sqlite_sequence` allocator state. Comparison
iterates one row at a time and preserves signed Int64, BLOBs, null, duplicate
rows, exact floating values and strings with embedded NUL. Physical page
placement and implicit rowids are outside that logical comparison.

The private temporary sibling is reserved exclusively with POSIX mode 0600.
Its file is flushed, renamed to
`<database>.pre-health-deletion-v2-<UTC digits>-<random UUID>.db`, and its parent
directory is flushed before the original writer creates empty guards and
replaces the version marker. Copy or publication failure preserves V1.
Interruption before COMMIT preserves V1; interruption after the actual COMMIT
leaves complete V2. A published pre-migration copy stays available after a
later transaction refusal.

## Filesystem and recovery boundaries

POSIX production requires successful file and post-rename directory fsync.
The explicit Windows development profile additionally requires
`--windows-development`, or `windowsDevelopment: true` on the transaction
option. Verify the development directory's private NTFS ACL first; POSIX mode
0600 does not verify that ACL. Windows file flushing and rename do not establish
the POSIX directory guarantee. The flag cannot bypass POSIX directory flushing.

The runtime floor remains Node 22.13. Migration uses the caller's tracked
successful BEGIN rather than the later `DatabaseSync.isTransaction` API.

This script keeps existing safety copies and provides no restore or pruning
operation. Existing managed recovery must preserve the latest deletion ledger
and rotate restore epochs before restoring old history. Guard population,
sticky admission, browser deletion, physical page/managed-copy retention and
CORE-06.R0 remain required programme gates.
