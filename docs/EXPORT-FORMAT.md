# The portable export format

`scripts/export-embed.js` (`npm run export -- <target-dir>`) writes a portable
copy of a supported legacy instance: every card file with its data re-embedded from the
datastore, the non-card data files, the reports, and the instance config.
Drop the tree into a fresh `$HEALTH_HOME`, start the server, and the boot
import brings every card back with its history.

This page is the contract for that tree: the layout, what is deliberately
left out, and the provenance manifest (`klebb-export.json`) every export
carries. Anything that reads an exported tree (a restore, a migration tool,
an importer) should follow the reader rules at the end.

## Native source refusal

Format1 does not carry native Health Connect history, deletions or sync state.
The CLI and `exportTo` refuse any reserved native table or view, including an
initialized empty schema, or retained native grants/connectors. A valid unused
native authority with empty arrays and no native schema permits legacy export.

The check uses the resolved database and credentials paths, including
`HEALTH_DB_FILE`, `HEALTH_DB_DIR` and `HEALTH_CREDENTIALS_DIR` overrides.
Before legacy storage opens or output is created, the database is inspected in
a closed read-only snapshot and the authority is read with strict byte bounds.
Unsupported native state throws `native-history-export-unsupported`; a present
unreadable/corrupt source or malformed authority throws
`native-history-source-unavailable`. The CLI reports the token and exits2;
only genuine file absence is treated as absence. The existing strict import
safety snapshot propagates refusal before wipe or incoming copy.

This preflight covers the state observed at that boundary. Live writers can
initialize absent native components later; this does not provide a coherent
live export or native restore. Complete native recovery remains required
before personal capture. Refs #823.

---

## 1. Tree layout

```
<export root>/
├── klebb-export.json     # provenance manifest, written last (section 3)
├── config.json           # instance config, secrets stripped by default
├── data/                 # card files with data re-embedded, plus non-card
│   │                     # data files (info/, auto-export/ state) verbatim
│   └── auto-export/
│       └── samples.json  # HAE push history (only when there is any)
└── reports/              # markdown reports, verbatim
```

The layout mirrors `$HEALTH_HOME`, so restoring is copying. Card files carry
their data again, exactly as a pre-datastore tree did: a card that has never
held data exports without a `data` key, and a card whose stored value is
`null` exports with `data: null`. The boot import records the same
distinction on re-import, so `hasData` parity survives the round trip.

---

## 2. What is excluded, and why

| Never exported | Why |
|---|---|
| `credentials/`, `sessions/` | Passkey material and live session tokens. A fresh instance mints its own auth state; an archive must not hold keys to the source instance. |
| `keys/`, `push-subscriptions.json`, `notifications.state.json` | The Web Push keypair and per-device endpoints are capabilities against the source instance, and the notification state ring leaks subscription ids. |
| `db/` | For supported legacy sources, card files and `samples.json` carry portable history. Native sources are refused; a raw copy of a live WAL database can be torn. |
| `user.json` | Local preferences the fresh instance re-creates on first use. |
| `chat/` | The chat transcript is private conversation history, not instance data. |
| `inbox/` | Transient upload staging; anything that mattered has already become a report. |
| `data/auto-export/raw/`, `data/auto-export/raw.migrated-*/` | Superseded duplicate archives from before the samples table, often hundreds of megabytes. |
| `*.tmp` strays, `*.json.<stamp>.json` backups | Atomic-write leftovers and import backups, not instance data. |
| Any file named `klebb-export.json` inside `data/` | Reserved name (section 5). |

The HAE ingest token and the invite codes are stripped from the exported
`config.json` by default. Pass `--include-secrets` to keep them, for a
personal full-fidelity copy rather than anything you hand to someone else.

---

## 3. The manifest: `klebb-export.json`

The export writes `klebb-export.json` into the tree root **last**, after
every other file. That ordering is the integrity mechanism: an export that
failed partway through leaves a tree with no manifest, and a tree with no
manifest is either torn or predates the manifest format. Neither is
importable; re-export from the source instance.

```json
{
  "format": "klebb.export.v1",
  "formatVersion": 1,
  "appVersion": "3.5.0",
  "exportedAt": "2026-08-17T04:20:00.000Z",
  "inventory": {
    "cards": [
      { "id": "weight", "file": "data/weight.json", "data": "embedded",
        "rows": 412, "sha256": "9f86d081..." }
    ],
    "samples": { "file": "data/auto-export/samples.json", "pushes": 27,
      "sha256": "60303ae2..." },
    "reports": [
      { "file": "reports/bloods-2026-05.md", "bytes": 1834,
        "sha256": "fd61a03a..." }
    ],
    "other": [
      { "file": "config.json", "sha256": "a665a459..." }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `format` | Always `klebb.export.v1`. |
| `formatVersion` | Integer, currently `1`. The **only** compatibility gate a reader checks. |
| `appVersion` | The Klebb version that wrote the export. Informational. |
| `exportedAt` | When the export ran, ISO 8601 UTC. |
| `inventory.cards[]` | One entry per exported card file: `id` (the card's `meta.id`), `file`, `data` (the data state, below), `rows` (the row count, below), `sha256`. |
| `inventory.samples` | The HAE push history file: `file`, `pushes` (how many pushes it holds), `sha256`. **Absent** when no samples file was exported. |
| `inventory.reports[]` | One entry per report file: `file`, `bytes`, `sha256`. |
| `inventory.other[]` | Every other written file (the config and the non-card data files): `file`, `sha256`. |

Every `sha256` is the hex SHA-256 of the file's bytes exactly as written, so
a reader can verify the tree arrived intact. Every `file` is a relative path
with forward slashes. The manifest never lists itself, and it never contains
hostnames, paths outside the tree, or token material.

### Card data states

| `data` | Exported card file | Meaning |
|---|---|---|
| `embedded` | `data` key present | The value was re-embedded from the datastore. The normal state. |
| `inline` | `data` key present | The file already carried its data (a pre-migration tree, or a hand-added block the boot import has not yet consumed) and was exported as found. |
| `null` | `data: null` | The stored value is `null`: a real recorded value, distinct from never having held data. |
| `none` | no `data` key | The card has never held data. |

The `null` / `none` distinction is not pedantry: the boot import preserves
it, so a card's `hasData` flag round-trips correctly.

### Row counts

`rows` comes from the same shape decomposition the datastore itself uses,
never from a parallel counter: an array value counts its elements, an object
value counts the elements of its top-level array keys summed, and a document
value, a `null`, or an absent value counts `0`.

---

## 4. Reader rules

1. **`formatVersion` is the only gate.** Refuse a `formatVersion` you do not
   support; accept everything else.
2. **Ignore unknown keys.** A later export may add keys anywhere in the
   manifest without bumping `formatVersion`. A reader that rejects keys it
   does not recognise will break on forward-compatible changes.
3. **No manifest, no import.** A tree without `klebb-export.json` is torn or
   pre-manifest. Do not guess at its completeness; re-export from the source
   instance.

---

## 5. The reserved file name

`klebb-export.json` is a reserved name at every level of the source `data/`
tree. A tree that was restored from an export and later re-exported would
otherwise carry the old manifest along as data, nesting a stale inventory
inside the new tree. The export skips any such file and logs a warning.


## Partial ordinary-history byte component

The internal ordinary-history encoder and decoder preserve the five families
`catalog`, `records`, `sourcePolicies`, `tombstones` and `suppressions`.
The entry names are
`data/health-connect/ordinary-history.json` and
`data/health-connect/ordinary-history-footer.json`. This component does not
write an archive manifest or activate a complete format or importer.

The payload is compact UTF-8 JSON with those root families in that order.
Nested object property order and complete `recordJson` strings are preserved;
explicit null values, including a scope-less tombstone type, remain null.
The footer is compact JSON with `version`, `counts` and `sha256`, in that order.
Its five count keys are `sources`, `records`, `sourcePolicies`, `tombstones`
and `suppressions`. The digest covers the original payload bytes exactly.

Each buffer is bounded to the existing 16 MiB limit before copying or parsing.
The decoder owns a copy, rejects invalid UTF-8, hashes the original bytes
before payload parsing, and verifies compact canonical encoding separately.
It reuses the existing family and footer validators. The encoder also retains
the existing 1 MiB record limit and family-count bounds. These limits do not
establish realistic-history scale or streaming-memory evidence.

The pure helpers return bytes or values and confer no approval, database,
deletion, replay, restore or boot authority. The existing `preparePublication`
constructor authenticates its owner first, accepts a payload/footer Buffer
pair through this decoder, and retains those exact strings in its existing
private capability. Its original object input remains supported.

Legacy-only exports retain format version 1. The verified initial-publication
writer described below adds a limited format version 2 archive. Apply, active
policy/control mapping, epochs, boot recovery and the fresh-instance round trip
remain pending. Preserving a null control
in this byte profile does not assign it an active typed deletion meaning.
Refs #850 and #762.


## Owner-bound initial SQL byte output

The existing recovery reader accepts `initialOrdinaryBytes: true` only with
a genuine `initialPreparedToken` for the current owner and selected database.
It returns `{publication, inputBytes, footerBytes}`; other option values retain
the existing authority result. Missing or copied tokens, foreign current
owners and alternate databases are refused before the selected database read.

The mode uses one bounded read-only SQL snapshot. Output record strings and
identity fields come from SQL rows; catalog and control values come from stored
family metadata, and footer bytes come from the stored footer. Trusted original
input supplies field order only. Its original checksum verification remains
separate; a reconstructed output checksum does not certify the producer input.
Returned buffers are fresh copies. Changed initial data is refused, while the
default reader continues to accept legitimate later corrections and deletions.

This initial component does not provide complete archive extraction, active
policy or deletion mapping, apply, epochs, boot recovery or capture readiness.
This owner-bound reader does not enable archive apply or change the default
live-authority reader. The separate export writer below does not relax its
owner/prepared-token requirements.
Refs #851 and #762.


## Verified initial-publication archive writer

The portable exporter can write an ordinary-history archive from a complete,
verified persisted publication. Its outer `formatVersion` is **2**, and
`inventory.ordinaryHistory.version` is **1**. The five-family payload and
footer both use ordinary stream version **1**. These versions are distinct
from typed deletion-controls stream version 2 and source-policy authority
version 3; neither later profile is enabled by this writer.

The manifest adds this descriptor shape alongside the existing card, report
and other-file inventories:

```json
{
  "ordinaryHistory": {
    "version": 1,
    "payload": {
      "file": "data/health-connect/ordinary-history.json",
      "bytes": 4419,
      "sha256": "0331b06e9595a6115e11ab8712d7d5884a3e89f96b48fc0348350396342ff00b"
    },
    "footer": {
      "file": "data/health-connect/ordinary-history-footer.json",
      "bytes": 182,
      "sha256": "6a29e1acbdc2b06cca969ae35b9acd771717ac69f39fbdcb194104d9e3ef2373"
    }
  }
}
```

The example lengths and hashes describe the fixed ordinary-history fixture.
Real descriptors cover the exact written UTF-8 bytes. The footer also verifies
all five family counts and the original complete payload digest.

Capture uses one read-only SQL snapshot for native records, publication
metadata, source ownership and legacy card values. It checks the initial
version 1 native schema, physical TEXT encoding, complete identity inventory,
serializer versions, record lengths and digests, metadata checksum, retained
family metadata and original footer. UTF-8 and valid UTF-16 databases produce
UTF-8 archive streams; malformed stored bytes are refused.

This first profile supports the original record layout with `recordJson`
immediately after `identity`, preserving every other descriptor field's
position. The persisted footer must verify that reconstruction. A publication
whose unrecorded original layout cannot be reconstructed is refused; the
writer never replaces the original footer with a newly computed authority.
Existing byte, family and record bounds apply. Legacy SQL card capture is
also bounded to 10,000 cards/rows, 1 MiB per selected TEXT value and 16 MiB
aggregate selected TEXT bytes per table. These limits do not establish
realistic-history scale.

Nonempty native transport or SQL deletion state, unknown native objects,
partial legacy schemas and retained credential authority remain refused.
HAE SQL history must be wholly absent or have both known tables empty;
partial or nonempty HAE history is refused rather than omitted. Legacy-only
exports continue through their existing format version 1 path. Mixed-history
capture remains a separate delivery.

The payload and footer are written and checked before sealing. The success
manifest is written to an exclusively created temporary file, closed,
checked and renamed last. A failed capture or output does not seal an archive.
Native exports do not open the legacy datastore or HAE writer interfaces.

Retained policies, tombstones and suppressions are historical data in this
profile, not operative sharing or deletion authority. Non-SQL files are not
part of a live multi-store freeze. Default import/apply still refuses outer
format version 2; the internal read-only archive preflight can inspect it.
Ordinary apply, live policy/deletion extraction, credential/cursor exclusion,
stale restore epochs, complete R0 recovery and personal capture readiness
remain open. Refs #868 and #762.


## Explicit source-policy byte profile 3

The pure `encodeOrdinaryHistory` and `decodeOrdinaryHistory` helpers accept
`{controlProfileVersion: 3}` only when the selector is the numeric value `3`.
This representation carries independent category decisions. Profile 1 remains
the default, and profile 2 retains its explicit typed-control contract.
Neither selection changes the native SQL schema or outer archive version.

Profile 3 retains the ordered root families `catalog`, `records`,
`sourcePolicies`, `tombstones`, `suppressions` and `deletionGuards`. Its catalog
has ordered fields `version`, `logicalTenantId`, `sources` and
`policyAuthority`. The latter has `epoch`, `revision` and `knowledge`, with
`knowledge` equal to `COMPLETE` for a declared complete descriptor. The epoch
is an opaque UUID; revision is a canonical nonnegative decimal string bounded
to the signed 64-bit maximum.

Each source policy has ordered fields `id`, `sourceStoreId`, `lifecycle`,
`retainCommittedHistory`, `categoryCount` and `categories`. Lifecycle is
`active` or `retired`. Each category has ordered fields `recordType`,
`sharing` and `generation`; supported record types must be unique and in
ascending ASCII order, sharing is `enabled` or `stopped`, and generation uses
the same canonical decimal-string bound. The declared category count must
match the list. This preserves, for example, Steps enabled at generation 3
alongside Weight stopped at generation 8 for the same source.

Raw record JSON, unresolved display types, typed four-key deletion identities,
independent source/user guard flags and nullable footprints remain unchanged.
Historical transport generation and source sequence are retained separately
from current category intent. The footer has ordered fields `version`,
`counts` and `sha256`; profile 3 uses the six profile-2 count keys with version
`3`, and its digest covers the original compact UTF-8 payload bytes.

The existing limits remain: 16 MiB per payload/footer, 1 MiB per record,
128 sources and categories per source, 10000 rows per record/control family,
8192 bytes per source stream key and 2048 bytes per footprint. Supported type
and uniqueness checks further constrain categories. Invalid, incomplete,
unsorted, duplicate, overflowing or incompatible descriptors are refused.
Original byte checks and independently owned output buffers still apply.

A declared descriptor and its decoded bytes do not issue owner, source,
permission, deletion, database or admission authority. The real publication,
owner, lifecycle and SQL paths are unchanged; the opt-in source-policy SQL
reader continues to refuse UNKNOWN authority. Persisted policy, coherent
capture and apply remain separate prerequisites. This internal profile does
not activate a complete archive format or satisfy recovery readiness.
Refs #871, #856 and #762.
