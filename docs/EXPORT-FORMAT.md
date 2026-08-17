# The portable export format

`scripts/export-embed.js` (`npm run export -- <target-dir>`) writes a portable
copy of an instance: every card file with its data re-embedded from the
datastore, the non-card data files, the reports, and the instance config.
Drop the tree into a fresh `$HEALTH_HOME`, start the server, and the boot
import brings every card back with its history.

This page is the contract for that tree: the layout, what is deliberately
left out, and the provenance manifest (`klebb-export.json`) every export
carries. Anything that reads an exported tree (a restore, a migration tool,
an importer) should follow the reader rules at the end.

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
| `db/` | The exported card files and `samples.json` carry all the data, and a raw copy of a live WAL database can be torn. |
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
