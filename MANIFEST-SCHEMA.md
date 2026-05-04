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

### `combines` (combination-card)

Used by `component: "combination-card"` to compose a single card from
several sibling manifests. The combination card reads each listed
source's `data` at render time; it typically carries no `data` of its
own (`data: []`).

```json
"meta": {
  "view": {
    "component": "combination-card",
    "layout":    "stack",
    "skin":      "sleep-stages",
    "combines": [
      {
        "sourceId": "sleep-hours",
        "role":     "primary",
        "label":    "Asleep",
        "units":    "h",
        "accessor": "value",
        "colour":   "#6366f1"
      },
      {
        "sourceId": "sleep-stages",
        "role":     "ring-segment",
        "label":    "Deep",
        "accessor": "stages.deep",
        "colour":   "#3b82f6"
      },
      {
        "sourceId": "mood",
        "role":     "annotation"
      }
    ]
  }
}
```

Top-level view fields:

| field | type | default | purpose |
|-------|------|---------|---------|
| `layout` | `"stack"` \| `"grid"` \| `"ring"` | `"stack"` | Overall arrangement of the combined metrics. |
| `skin` | string \| null | null | Optional pixel-perfect visual preset. Current skins: `"sleep-stages"` (stacked horizontal bar of sleep stages), `"activity-ring"` (close-your-rings visual). |
| `combines` | array | — | Required, non-empty. Each entry binds one sibling manifest into this card. |

Each `combines[]` entry:

| field | type | required | purpose |
|-------|------|----------|---------|
| `sourceId` | string | yes | `meta.id` of the source manifest to read from. |
| `role` | `"primary"` \| `"secondary"` \| `"annotation"` \| `"ring-segment"` | yes | How this source contributes to the composed view. Renderers use role plus layout/skin to decide visual treatment. |
| `label` | string | no | Override for the source's own label. Defaults to the source manifest's `meta.label`. |
| `units` | string | no | Short suffix printed next to the value (e.g. `"h"`, `"kcal"`). |
| `accessor` | string | no | Dotted path into the source's matched data entry (e.g. `"value"`, `"stages.deep"`). Defaults to the entry for the current date; if the entry is a primitive, it is used directly. |
| `colour` | string | no | CSS colour for this entry's visual slot (bar segment, ring arc, threshold pill, etc). |

Resolution rules:

- The combination card matches each source's data for the view's
  current date. If no entry exists for that date, the source is
  considered empty (renderer decides whether to show "no data" or fall
  back to the most recent prior entry; default is "no data").
- Unknown `sourceId`, or a source whose file has been deleted,
  surfaces inline in the card rather than failing the whole view.
- The combination card emits no writes. To edit a displayed value the
  user navigates to the atomic source card.

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

See `data.example/example-*.example.json` for runnable versions of each.

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
| `combination-card` | Composite view over several sibling manifests (see `combines` config above) |

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
