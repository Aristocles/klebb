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
  "category": "vitals",               // optional free-form grouping label;
                                      //   pass-through (not used in core
                                      //   layout today; surfaces as data
                                      //   for agents and future filters)
  "view":     { ... },                // optional view config
  "trends":   { ... },                // optional trends config
  "calendar": { ... },                // optional calendar config
  "reports":  { ... },                // optional reports config
  "writeable": { ... },               // optional input config
  "ingest":   { ... }                 // optional ingest subscription
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

### Ingest subscription (`meta.ingest`)

Opts a manifest into receiving data from an external ingest source. Today
the only supported source is the iPhone Health Auto Export webhook.

```json
"meta": {
  "ingest": {
    "source": "hae",           // required; only "hae" today
    "metric": "sleep_analysis" // required; must match a catalogue key
  },
  "writeable": { "fromWebapp": false }  // recommended for HAE-fed cards
}
```

Behaviour:

- On every HAE push, the dispatcher walks all manifests with
  `meta.ingest.source === "hae"`, reshapes the payload slice for each
  via `health-auto-export/catalogue.js`, and upserts daily rows into
  `data[]` by date.
- Any number of manifests can subscribe to the same metric.
- Multiple subscribers to the same metric each receive their own copy
  of the rows; they do not share storage.
- If `metric` is not in the catalogue, the manifest still loads; it
  simply never receives ingest data. Server logs a warning per push.
- Setting `writeable.fromWebapp: false` is the recommended default for
  ingest-fed cards — otherwise the webapp input form can overwrite
  rows that the next push will then re-overwrite.
- The four historically-autoseeded manifests (`sleep-hours`, `steps`,
  `active-minutes`, `workouts`) are no longer created on first push.
  Author them via `templates/*.klebb.json` or drop them directly into
  `$HEALTH_HOME/data/`.

See `docs/HEALTH-AUTO-EXPORT.md` for the supported-metrics table and
catalogue row shapes.

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

### `calendar` — month-grid marker config

`meta.calendar` opts the card into the Calendar view. Each day cell in
the grid can carry up to three glyphs (capped with `+N` overflow); a
card contributes one glyph per day it has data for.

```json
"calendar": {
  "enabled": true,
  "component": "day-marker",
  "marker": "💊"
}
```

Fields:
- `enabled` (bool): include in Calendar. Default `false` (absent = not
  in Calendar).
- `component` (string): always `"day-marker"` today. Reserved for
  future cell renderers.
- `marker` (string | object): the glyph shown on days this card has
  data. See below.

#### `marker` — what glyph to show

**Static string** — same glyph every logged day:

```json
"marker": "💊"
```

If `marker` is absent, the card's `meta.emoji` is used instead.

**`type: "field-emoji"`** — pick the glyph from an emoji map keyed by a
field value on that day's row:

```json
"marker": {
  "type":      "field-emoji",
  "field":     "mood",
  "emojiMap":  { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" },
  "fallback":  "🙂"
}
```

- `field` (string, required): field on the day's row to read. Dotted
  paths work (`stats.mood`).
- `emojiMap` (object, required): `stringifiedValue -> emoji`.
- `fallback` (string, optional): glyph when the row is missing, the
  field is empty, or the value isn't in the map. Defaults to the card's
  `meta.emoji` then `•`.

**`type: "trend-arrow"`** — compare the day's row to the most recent
earlier entry with a numeric value on `field`, render up/down/flat:

```json
"marker": {
  "type":     "trend-arrow",
  "field":    "kg",
  "up":       "⬆️",
  "down":     "⬇️",
  "flat":     "➡️",
  "fallback": "⚖️"
}
```

- `field` (string, required): numeric field to compare. Dotted paths
  work.
- `up`, `down`, `flat` (string, optional): direction glyphs. Defaults:
  `⬆️` / `⬇️` / `➡️`.
- `fallback` (string, optional): glyph for the very first entry (no
  previous to compare), non-numeric values, or missing field.

**`type: "threshold"`** — evaluate the day's row against a list of
rules; the first matching rule's emoji wins. Mirrors the
`display.thresholds` matcher shape (so `min`/`max`/`eq` behave the
same). Good for clinical bands (BP, body temp, SpO₂) or discrete
phase labels.

```json
"marker": {
  "type":  "threshold",
  "field": "systolic",
  "rules": [
    { "max": 119, "emoji": "🟢" },
    { "max": 129, "emoji": "🟡" },
    { "max": 139, "emoji": "🟠" },
    { "emoji": "🔴" }
  ],
  "fallback": "•"
}
```

- `field` (string, required): field on the day's row to evaluate.
- `rules` (array, required): each rule is
  `{ min?, max?, eq?, emoji }`. Rules iterate top-to-bottom; the
  first rule whose field exists and satisfies the matcher wins.
- Matchers: `min <= row[field] <= max` (either bound optional), or
  `row[field]` stringly-equals `eq`, or — if the rule declares no
  `min`, `max`, or `eq` — it's a **catch-all** that matches any
  non-null value. Put a catch-all last to paint the "anything else"
  colour rather than falling through to `fallback`.
- `fallback` (string, optional): glyph when no rule matches or the
  field is missing. Typically unnecessary if you include a catch-all.

**`type: "template"`** — render a template string against the day's
row using the same mini-language as `view.display.template`. Great
for reusing an `emojiMap` that already lives in `display` rather than
duplicating it under `calendar`.

```json
"marker": {
  "type":     "template",
  "template": "{mood:emoji}",
  "fallback": "🙂"
}
```

- `template` (string, required): same syntax as
  `display.template` — supports `{key}`, `{key:emoji}`,
  `{key:round(N)}`, `{key|default}`, `{key?yes:no}`, dotted paths.
- The card's `meta.view.display` block is passed to the renderer so
  `{key:emoji}` resolves against `display.emojiMap[key]` — i.e. the
  same map the Today card uses.
- `fallback` (string, optional): glyph when the template renders
  empty (missing field, no match).

Because both the calendar and the Today card read from the same
`display.emojiMap`, the two stay in lock-step without you having to
edit the manifest in two places.

#### Multiple entries per day

If a card allows `maxReadingsPerDay > 1`, the **latest entry wins** for
the day's marker (last by array index for array data; last by `takenAt`
for `items[].doses[]` shapes). Earlier same-day entries are ignored by
the calendar.

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

## Reports config (`meta.reports`)

The Reports view has its own small set of renderers geared at summarised
or tabular output. Config shape depends on the renderer:

### `adherence-report`

Summarises scheduled-item adherence across a rolling window. Expects
the card's `data` to follow the schedule-block shape (`{groups, items,
items[].doses}` — see `medication-schedule.example.json` and
`example-adherence-report.example.json`).

```json
"reports": {
  "enabled": true,
  "component": "adherence-report",
  "showCompliance": true,     // optional, default true
  "showInventory":  true      // optional
}
```

### `schedule-timeline`

Stacked timeline of scheduled items across a window. Typically shares
the same `data` shape as `adherence-report`.

```json
"reports": {
  "enabled": true,
  "component": "schedule-timeline",
  "windowDays": 14,           // window to display
  "showPast":   true,
  "showFuture": true
}
```

### `table-list`

Generic rowset-as-table, useful for blood panels, SNPs, lab results,
and any ad-hoc tabular data. `data` is an array of row objects.

```json
"reports": {
  "enabled": true,
  "component": "table-list",
  "columns": [
    { "field": "date",   "header": "Date" },
    { "field": "test",   "header": "Test" },
    { "field": "result", "header": "Result", "format": "number" }
  ],
  "sort": { "field": "date", "dir": "desc" }
}
```


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
| `combination-card` | Read-only composite over sibling manifests (see [Combination cards](#combination-cards)) |

Unknown renderer names fall back to `eh-unknown-card`, which shows an
inline warning but keeps the dashboard running.

---

## Combination cards

A combination card is a read-only window over other cards' data. It
declares which sibling manifests to read from and how to surface their
values, and owns no data of its own (its `data` block is ignored).

Shape:

```json
"meta": {
  "view": {
    "enabled":   true,
    "component": "combination-card",
    "layout":    "stack",
    "combines": [
      {
        "sourceId": "sleep-hours",
        "role":     "primary",
        "label":    "Asleep",
        "accessor": "hours",
        "unit":     "h"
      },
      {
        "sourceId": "mood",
        "role":     "secondary",
        "label":    "Mood",
        "accessor": "mood",
        "emojiMap": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" }
      }
    ]
  }
}
```

### `layout`

Picks the visual treatment.

| value | behaviour |
|-------|-----------|
| `stack` | Vertical label/value rows. Primary rows render large, secondary smaller, annotation muted. |
| `rings` | Concentric progress arcs driven by `role: "ring-segment"` entries. Non-ring roles render as a stack row below the arcs. |

Value `chart` is reserved for a future line-chart layout. Unknown
layouts fall back to `stack`.

### `combines[]`

An ordered array of source entries. Each entry:

| field | required | meaning |
|-------|----------|---------|
| `sourceId` | yes | Must match a loaded manifest's `meta.id`. Missing source renders a placeholder, not an error. |
| `role` | yes | `primary` \| `secondary` \| `annotation` \| `ring-segment`. Drives visual treatment. `bar-series` is reserved. |
| `label` | no | Overrides the source's `meta.label` for this view. |
| `accessor` | no | Path into the day's row. Dotted paths (`stats.avg`) supported. Default: first non-`date` scalar on the row. |
| `unit` | no | Short string rendered next to the value (e.g. `h`, `kcal`). |
| `emojiMap` | no | Stringified-value → emoji, for enum sources (mood, etc). |
| `goalDaily` | yes for `ring-segment` | Positive finite number. Ring fills `min(value / goalDaily, 1)`; overshoot paints a "complete" glow. |
| `colour` | no | CSS colour for a `ring-segment`. Falls back to the renderer's theme palette by ring index. |

### Row resolution

For a viewed date, the renderer resolves each source to one of:

| state | meaning |
|-------|---------|
| `ok` | Source exists, has a row for that date, accessor yields a value. |
| `no-source` | `sourceId` is not a loaded manifest. |
| `no-entry` | Source loaded but has no row for the viewed date. |
| `no-accessor-match` | Row exists but the accessor yields `undefined`/`null`. |
| `no-goal` | Ring-segment entry missing a positive finite `goalDaily`. |

States other than `ok` render as a muted placeholder so partial data
doesn't break the layout. Ring-segment entries with `state: "ok"`
additionally carry `goalDaily`, `ratio` (unclamped; `>1` means
overshoot), and `complete` (boolean; `ratio >= 1`).

### Editing

Combination cards are read-only; they have no `writeable` block and
emit no writes. To change a value, edit the source manifest; the
combo re-resolves on `manifest-data-changed` (fired by the app shell
whenever any manifest's data block changes).

### Rings layout specifics

`layout: "rings"` renders one concentric progress arc per entry with
`role: "ring-segment"`. Each such entry needs a numeric accessor and
a `goalDaily` target. Overshoots (`value > goalDaily`) fill the full
ring and paint a complete indicator on the legend row; missing or
malformed goals render a muted placeholder.

Non-ring-segment roles in the same `combines[]` array (primary /
secondary / annotation) render as stack-style rows beneath the ring
figure — useful for a one-off "trained today?" flag or free-text
notes sitting next to rings.

Ring colour falls back to the renderer's theme palette by ring
index; set `colour` on the entry to override.

### Typical pairing

A combo card usually absorbs one or more atomic cards. To avoid
showing the same data twice, set the absorbed card's `meta.enabled:
false` (master disable) so it stays in Settings but drops from every
view.

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
node scripts/migrate-schedule-vocabulary.js /path/to/your/health/data
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
5. **Empty data still renders the card.** Cards with `data: []` or
   `data: {}` show in their renderer's empty state (e.g. generic-card
   uses `meta.view.display.emptyHeadline`), so a newly-created card is
   immediately visible and loggable. Hide a card by setting
   `meta.enabled: false` (master) or the per-view `enabled` flag — via
   the Settings page or by editing the file directly.

---

## Versioning

The only supported schema is `klebb.datafile.v1`. Future breaking
changes will bump to v2 and ship a migration script.

Non-breaking additions (new optional fields, new input types, new
renderers) do NOT require a version bump — v1 manifests are
forward-compatible as long as they don't rely on fields introduced later.

---

## HTTP API — create / delete cards

In addition to the existing read + data-replace endpoints (see
`docs/CHAT-AGENT.md`), two endpoints let callers author new cards
without touching the filesystem directly:

### `POST /api/manifests`

Creates a brand new card. Body is a full manifest object. Auth matches
the rest of the `/api/` surface (session cookie for the webapp, Bearer
token via `AGENT_API_TOKEN` for agents).

Required fields: `$schema === "klebb.datafile.v1"`, `meta.id` matching
`/^[a-z0-9][a-z0-9._-]*$/` (max 64 chars, not in the reserved set
`_archive`, `_virtual`, `_meta`, `auto-export`, `reports`, `index`),
and `meta.label`. Everything else is pass-through.

| Status | Meaning |
|--------|---------|
| 201 | Created. Response `{ok, id, source: "<filename>"}` |
| 400 | Malformed: bad JSON body, wrong `$schema`, missing `meta.id`/`meta.label` |
| 401 | No auth |
| 409 | `meta.id` already in use (in-memory or on-disk) |
| 422 | `meta.id` fails the sanitiser (bad chars, reserved name, path escape) |
| 500 | Filesystem write failed |

The endpoint is intentionally lenient: any renderer name is accepted,
including ones not (yet) implemented. Unknown renderers fall through to
`eh-unknown-card` until a real renderer ships — see "Ad-hoc manifests"
below.

### `DELETE /api/manifests/:id`

Removes the card from the registry and deletes its file. Same auth
model.

| Status | Meaning |
|--------|---------|
| 200 | Removed. Response `{ok, id}` |
| 401 | No auth |
| 404 | Unknown id |
| 500 | Unlink failed |

### Ad-hoc manifests

When an agent wants a renderer that doesn't exist yet, the
recommendation is to POST anyway with the best-guess component name.
The card persists; the renderer registry falls back to the unknown-card
placeholder on the frontend; a human can retrofit a dedicated renderer
later without migration. This is the supported path for extending the
system without a code change.
