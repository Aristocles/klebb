# Manifest schema — `klebb.datafile.v1`

This is the machine-readable spec for the v2 manifest format used by the
Klebb dashboard. For the human-friendly tour, see
[`docs/CARDS.md`](./docs/CARDS.md).

---

## File structure

```json
{
  "$schema":     "klebb.datafile.v1",
  "meta":        { /* required */ },
  "description": "free text (optional)",
  "schema":      { /* optional hint for validators */ },
  "data":        /* required; array or object; card-specific */
}
```

- `$schema`: must be `"klebb.datafile.v1"` for the file to load.
- `meta`: required object, shape below.
- `description`: optional prose. Shown under the title in Settings. Preserved
  verbatim on writes.
- `schema`: optional hint for external validators (the registry itself
  doesn't enforce it).
- `data`: required. Array, object, or primitive; see the renderer's
  expectations.

---

## `meta`

```json
{
  "id":       "weight",              // required, matches filename stem
  "label":   "Weight",                // required, human-readable title
  "emoji":    "⚖️",                   // optional, prefixed to title
  "order":    100,                    // optional int, lower = earlier;
                                      //   sparse convention: 100, 200, 300…
                                      //   so inserts can use gaps (150, 250…)
  "enabled":  true,                   // optional bool, default true;
                                      //   false hides card from EVERY view
  "view":     { ... },                // optional view config
  "trends":   { ... },                // optional trends config
  "calendar": { ... },                // optional calendar config
  "reports":  { ... },                // optional reports config
  "writeable": { ... }                // optional input config
}
```

### Master `meta.enabled`

`meta.enabled: false` hides the card from all views (Today, Trends,
Calendar, Reports). Settings still shows it so you can re-enable. Absent
or `true` means the card participates according to its per-view config.

### Modal prompt (`meta.prompt`)

Opt-in. Makes the card fire a full-screen modal on app load, once per
day, until the user saves or dismisses. Applies to any card that has
`meta.writeable.inputs`.

```json
"meta": {
  "prompt": {
    "enabled": true,         // required — default false
    "mode": "modal",         // only mode supported today
    "whenMissing": true      // default true; skip if today already logged
  }
}
```

Queue semantics: if multiple cards qualify, they render sequentially
in `meta.order` ascending. Shown-today state is tracked in
`localStorage` under the key `klebb-prompt-shown-{cardId}-{YYYY-MM-DD}`.
Dismissing still marks as shown. See `docs/CARDS.md` for the full
behaviour notes.

### View config (`meta.view`, `meta.trends`, etc.)

All view configs share the same shape:

```json
{
  "enabled":     true,                // required — opts card into this view
  "component":   "generic-card",      // required — renderer name
  "order":       5,                   // view-specific sort override
  "slot":        "top",               // "top" spans the full row
  "dateContext": "viewedDate",        // "viewedDate" | "latest"
  "expanded":    false,               // allow click-to-expand
  "display":     { ... },             // template config (generic-card)
  "source":      "other-card-id"      // virtual/computed cards only
}
```

### `display` (generic-card)

Used by `component: "generic-card"` to render rows without custom code.

```json
{
  "template":       "{kg:round(1)}",
  "secondary":      "{notes|(no notes)}",
  "emptyHeadline":  "No weight today",
  "unit":           "kg",
  "emojiMap": {
    "mood": { "1": "😩", "5": "😄" }
  },
  "thresholds": [
    { "ifField": "kg", "max": 80, "colour": "#44ff88", "label": "Optimal" },
    { "ifField": "kg", "max": 100, "colour": "#ff7733", "label": "Above target" }
  ],
  "trendArrow": { "field": "kg" }
}
```

Template syntax:
- `{key}` → `row[key]`
- `{key:round(N)}` → round to N decimals
- `{key:emoji}` → look up in `emojiMap[key]`
- `{key|default}` → fallback when empty
- `{key?yes:no}` → ternary on truthiness
- `{nested.path}` → dotted access
- Missing keys render as empty string

`unit` prints a small secondary string next to the headline.

`thresholds` is an array of rules. Each rule matches when `ifField`
(or alias `field`) is present on the row AND either:
- `min <= row[ifField] <= max` (both optional, at least one required), OR
- `row[ifField]` stringly-equals `eq`.

First match wins. The card gets a side-bar in `colour` and an inline
label pill.

`trendArrow` shows ↑/↓/→ next to the headline, comparing the current
row to the most recent earlier entry on `field`.

### `writeable`

```json
{
  "fromWebapp":        true,
  "todayAllowed":      true,
  "pastAllowed":       true,
  "futureAllowed":     false,
  "maxReadingsPerDay": 1,
  "inputs": [
    {
      "key":         "kg",
      "type":        "number",
      "label":       "Weight (kg)",
      "placeholder": "85.0",
      "required":    true,
      "min":         0,
      "max":         500,
      "step":        0.1
    }
  ]
}
```

`maxReadingsPerDay` defaults to `1` (upsert: the new entry replaces the
existing entry for that date). Values `>1` append and keep the N most
recent same-day entries.

### Input types

| type | extra fields |
|------|--------------|
| `number` | `min`, `max`, `step`, `placeholder` |
| `stepper` | `min`, `max`, `step`, `default` (−/+ buttons around a number) |
| `text` | `maxLength`, `placeholder` |
| `textarea` | `rows`, `maxLength`, `placeholder` |
| `select` | `options: [string]` or `[{value,label}]`, `placeholder` |
| `emoji-picker` | `emojis: [...]`, `emitIndex: true` |
| `colour` / `color` | — |
| `checkbox` | — |
| `date` | — |
| `time` | — |
| `rating` | `min`, `max` (1..5 default) |

All support: `key` (required), `label`, `required`, `default`, `help`.

---

## Built-in renderers

Use one of these names in `meta.view.component` / `meta.trends.component`:

| name | card shape |
|------|-----------|
| `generic-card` | Zero-code headline + secondary + input form (preferred default) |
| `list-card` | Persistent roster of items (symptoms, allergies, etc.) — rows stay until explicitly deleted |
| `schedule-card` | Peptide/medication schedule with dot-grid visualisation |
| `checklist-card` | Daily checklist |
| `markdown-doc` | Static markdown content |
| `line-chart` | Trends line chart |
| `schedule-timeline` | Gantt-style timeline |
| `table-list` | Tabular data |
| `adherence-report` | Med adherence summary |
| `greeting-banner` | Top-of-page greeting |

Unknown renderer names fall back to `eh-unknown-card`, which shows an
inline warning but keeps the dashboard running.

---

## Schedule block (items with recurrence)

Cards that track recurring items (peptides, medications, supplements) put
each item under `data.items[]` (or `data.current[]` for supplements) and
give each item a `schedule` object describing when it's due.

The canonical schema is:

```json
"schedule": {
  "type": "daily" | "weekly" | "every_n_days" | "on_off" | "phased" | "as_needed",
  "on_days": ["Mon", "Wed", "Fri"],       // for weekly / on_off
  "off_days": ["Sat", "Sun"],              // for on_off (optional — everything not in on_days is rest)
  "interval_days": 2,                       // for every_n_days
  "times_per_day": 1,                       // optional, default 1
  "start_date": "2026-04-21",               // for every_n_days; falls back to cycle start
  "loading": { "days": ["Tue","Fri"], "duration_weeks": 4 },  // phased
  "maintenance": { "days": ["Tue"] }         // phased
}
```

**Rules:**

- `type` is canonical. Legacy `frequency` key is still read by the lib for
  back-compat but new cards must use `type`.
- `on_days` / `off_days` accept 3-letter or full-name day strings.
- `every_n_days` anchors on `start_date`. If omitted, the earliest `cycles[].start`
  is used instead.
- `as_needed` (PRN) renders as "not scheduled" — use it for items that are
  always available but not on a fixed cadence. The UI can still offer a
  "log anyway" path.

**Migrating old cards:**
`scripts/migrate-schedule-vocabulary.js` converts files in place with a
timestamped backup. Run it against any data dir that predates the
unification:

```sh
node scripts/migrate-schedule-vocabulary.js ~/axis/workspace/.private/health/data
```

Legacy keys supported transparently by `lib/schedule.js` (no migration
required, but recommended for new work):

| Legacy | Canonical |
|--------|-----------|
| `schedule.frequency` | `schedule.type` |
| `schedule.nDays` / `schedule.every` | `schedule.interval_days` |
| `schedule.startDate` | `schedule.start_date` |
| `schedule.dayOfWeek: "Thu"` | `schedule.on_days: ["Thu"]` |
| Flat `item.frequency: "daily"` | `item.schedule: { type: "daily" }` |

---

## Data block conventions

Most cards use an array of dated entries:

```json
"data": [
  { "date": "2026-04-20", "kg": 85.5 },
  { "date": "2026-04-21", "kg": 86.0 }
]
```

Single-document cards use an object:

```json
"data": { "markdown": "## Heading\n\nContent..." }
```

The registry imposes no schema on `data`. Your renderer + your writer must
agree.

---

## Rules and conventions

1. **Filename = id.** The filename without `.json` should match `meta.id`.
   This isn't enforced but simplifies debugging.
2. **Reserved directory.** `$HEALTH_HOME/data/_archive/` is not scanned
   (reserved for legacy archive migration). Any other subdir is recursed.
3. **Unique ids.** Two files with the same `meta.id` cause one to win and
   the other to be logged as an error.
4. **Legacy compatibility.** Files without `$schema` are silently skipped
   — they may still be valid flat JSON consumed by legacy integrations.
5. **Empty data hides the card.** Cards with `data: []` or `data: {}` do
   not render in views (avoids "ghost" cards). Write a dummy entry or
   just wait until real data exists.

---

## Versioning

The only supported schema is `klebb.datafile.v1`. Future breaking
changes will bump to v2 and ship a migration script.

Non-breaking additions (new optional fields, new input types, new
renderers) do NOT require a version bump — v1 manifests are
forward-compatible as long as they don't rely on fields introduced later.
