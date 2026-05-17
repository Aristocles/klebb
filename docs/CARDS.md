# Cards — how the dashboard works

Klebb is a **file-driven** health dashboard. Every card you see on the
dashboard is a JSON file in `$HEALTH_HOME/data/`. There's no database, no
catalog, no "install" step — if the file exists and is a valid manifest, the
card appears. If you delete the file, the card is gone.

This doc is for **users and card authors** who want to hand-author
manifests. Most Klebb users won't need to; the built-in chat agent
writes these files for them from plain-English descriptions. See
[`CHAT-AGENT.md`](./CHAT-AGENT.md) for the agent integration, or
the [`templates/`](../templates/) directory in the repo for canonical
examples of every renderer type you can copy-paste from.

---

## Quickstart

Want to add a weight-tracking card right now? Create this file:

**`$HEALTH_HOME/data/weight.json`**
```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "weight",
    "label": "Weight",
    "emoji": "⚖️",
    "view":    { "enabled": true, "component": "generic-card",
                 "display": { "template": "{kg:round(1)} kg",
                              "emptyHeadline": "No weight today" } },
    "trends":  { "enabled": true, "component": "line-chart",
                 "xKey": "date", "yKey": "kg", "unit": "kg" },
    "writeable": {
      "fromWebapp": true,
      "todayAllowed": true,
      "pastAllowed": true,
      "futureAllowed": false,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "kg", "type": "number", "label": "Weight (kg)",
          "min": 0, "max": 500, "step": 0.1, "required": true }
      ]
    }
  },
  "description": "Daily body weight in kilograms.",
  "data": []
}
```

Refresh the dashboard. The card appears. Tap ➕ to add an entry.

---

## Anatomy of a manifest

Every card file has the same top-level shape:

```json
{
  "$schema": "klebb.datafile.v1",
  "meta":         { ... },            // required
  "description":  "optional prose",
  "data":         []                  // required; shape is card-specific
}
```

### `meta.id` (required)

A short string identifier, matching the filename (without `.json`). Must be
unique across all cards. Used in URLs (`/api/manifests/weight/data`) and
internal routing.

### `meta.label` (required)

Human-readable title shown on the card header.

### `meta.emoji` (optional)

A single emoji prefixed to the title. Helps cards be visually scannable.

### `meta.order` (optional, default `1000`)

Integer. Cards sort ascending. Use negative numbers to pin cards to the top.

### `meta.enabled` (optional, default `true`)

The master kill-switch. When `false`, the card is hidden from **every** view
(Today, Trends, Calendar, Reports, Settings still shows it so you can re-enable).
The data stays in the file; only visibility is suppressed. Toggle via the
Settings page, or just edit the file yourself.

### `meta.category` (optional)

Free-form grouping label (e.g. `"vitals"`, `"health"`, `"example"`). Used
by a handful of example manifests and surfaced as data for agents and
future filters, but not wired into the core layout today. Pass-through:
the registry stores whatever you give it.

### `meta.prompt` (optional, default: no prompt)

Turns the card into a **modal-prompt** on app open. Once per day per card,
the webapp shows a full-screen modal that asks the user to fill in the
card's inputs. Great for daily-log cards that are easy to forget — mood,
BP, weight, hydration.

```json
"meta": {
  "prompt": {
    "enabled": true,         // required to opt in; default false
    "mode": "modal",         // "modal" (default) or "checklist"
    "whenMissing": true      // default true — skip if today's entry exists
  }
}
```

**How it behaves:**

- On app load, every card with `prompt.enabled: true` is evaluated.
- If today's entry already exists (array has a row dated today, or the
  schedule/item has been ticked off), skip. This is `whenMissing: true`
  behaviour, the default. Set `whenMissing: false` to force the modal
  to fire every day regardless.
- If the modal was already shown today (tracked in `localStorage`
  under `klebb-prompt-shown-{cardId}-{YYYY-MM-DD}`), skip. The modal
  never re-appears the same day even if the user dismissed without
  saving. Tomorrow it's a fresh slate.
- Multiple qualifying cards are queued in `meta.order` ascending; the
  user fills or dismisses one at a time until the queue empties.

**Modal UX (`mode: "modal"`):**

- Full viewport on mobile (bottom-sheet style), centered card on
  desktop (≥ 640px).
- Same inputs as `meta.writeable.inputs` — whatever you'd see in the
  inline edit form, the modal renders.
- Save button is disabled until all `required` inputs have values.
- ✕ in the header dismisses without saving.
- Escape key also dismisses.

**Checklist UX (`mode: "checklist"`):**

For `schedule-card` manifests (peptides, medications, supplement stacks)
where the daily "did you take it?" question maps to multiple per-item
ticks, use `mode: "checklist"`. The modal renders one row per item
scheduled today, each with a single "Taken" button that writes
`{ scheduledDate, takenAt }` into that item's `doses[]`. Rows update
in place; the modal auto-closes once every scheduled item is marked.

The eligibility rule is per-item: the prompt fires when at least one
scheduled item lacks today's dose, and stays out of the queue once
they're all logged. There is no editable date or time — tapping
"Taken" stamps `now`. Out-of-band manual entry (logging a dose
yesterday, or off-schedule) still goes through the schedule-card's
own renderer; the prompt path only handles the "I just took it"
reminder.

Defaults: `enabled: false`, `mode: "modal"`. Opt-in only — no card
gets a modal unless you explicitly set this.

### `meta.view` — the Today view config

```json
"view": {
  "enabled": true,
  "component": "generic-card",
  "fallbackToLatest": false,
  "display": { ... },
  "slot": "top",
  "order": 5
}
```

Fields:
- `enabled` (bool): include in Today. Default `false` (i.e. absent = not in
  Today).
- `component` (string): renderer name. Built-ins:
  - `generic-card` — the zero-code renderer (preferred default, see below)
  - `list-card` — persistent roster of items (symptoms, allergies, etc.)
    — rows stay until explicitly deleted, not per-day
  - `schedule-card` — medication/supplement schedule grid
  - `checklist-card` — daily checklist
  - `markdown-doc` — static markdown content
  - `line-chart`, `schedule-timeline`, `table-list`, `adherence-report`,
    `greeting-banner`
- `fallbackToLatest` (boolean, default `false`): `generic-card` only.
  When `true`, on Today with no row for today, the card's headline
  falls back to the most recent prior row (so a slow-changing metric
  like weight still shows yesterday's value). On any past or future
  date the card resolves by exact date. The edit button always
  targets the viewed date regardless of this flag (see #227). The
  legacy `dateContext: "latest"` string is read as
  `fallbackToLatest: true` during the deprecation window — see #228.
- `slot` (`"top"` | `null`): if `"top"`, the card spans the full row
- `order` (int): view-specific ordering override; falls back to `meta.order`
- `display` (object): see the **generic-card** section below

### `meta.trends` — the Trends view config

Same shape as `meta.view`. Typical use: `component: "line-chart"` with `xKey`
and `yKey` pointing into the data rows.

### `meta.reports` — the Reports view config

Opts the card into the Reports view. Three renderers live here, each
with its own config. See `MANIFEST-SCHEMA.md` for the full spec; a
quick tour:

**`adherence-report`** — % adherence for scheduled items (reads
`data.items[].doses[]`):

```json
"reports": {
  "enabled": true,
  "component": "adherence-report",
  "showCompliance": true,
  "showInventory":  true
}
```

**`schedule-timeline`** — stacked timeline of scheduled items:

```json
"reports": {
  "enabled": true,
  "component": "schedule-timeline",
  "windowDays": 14,
  "showPast": true,
  "showFuture": true
}
```

**`table-list`** — rowset-as-table; rows are free-form objects. Useful
for blood panels, SNPs, anything ad-hoc:

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


### `meta.calendar` — Calendar view config

Opts the card into the Calendar view. The Calendar is a month grid
where each day cell shows up to three emoji glyphs, one per card that
has data for that day. Think of it as an at-a-glance "what did I log
when" map.

```json
"calendar": {
  "enabled":   true,
  "component": "day-marker",
  "marker":    "💊"
}
```

Fields:
- `enabled` (bool): include in Calendar. Default `false`.
- `component` (string): `"day-marker"` is the only renderer today.
- `marker` (string | object): which glyph to show. Three forms:

**1. Static glyph** — the simplest. Same emoji every day the card has
data for:

```json
"calendar": { "enabled": true, "component": "day-marker", "marker": "💊" }
```

If you omit `marker`, the card's `meta.emoji` is used.

**2. `field-emoji`** — the glyph changes per day based on a field
value. Great for categorical data where each value maps to its own
emoji:

```json
"calendar": {
  "enabled":   true,
  "component": "day-marker",
  "marker": {
    "type":     "field-emoji",
    "field":    "mood",
    "emojiMap": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" },
    "fallback": "🙂"
  }
}
```

The resolver reads `row[field]` for that day, stringifies it, and looks
it up in `emojiMap`. Missing / unmapped values fall through to
`fallback` (or the card's `meta.emoji`, or `•`).

**3. `trend-arrow`** — the glyph shows direction of change. Great for
numeric metrics where you care about whether today's reading went up
or down compared to the previous reading:

```json
"calendar": {
  "enabled":   true,
  "component": "day-marker",
  "marker": {
    "type":     "trend-arrow",
    "field":    "kg",
    "up":       "⬆️",
    "down":     "⬇️",
    "flat":     "➡️",
    "fallback": "⚖️"
  }
}
```

- Compares today's `row[field]` to the most recent earlier row that
  has a numeric value at the same field.
- First entry ever (no previous) uses `fallback`.
- `up` / `down` / `flat` default to `⬆️` / `⬇️` / `➡️` if omitted.

**4. `threshold`** — the glyph depends on which *range* (or exact
value) the reading falls into. Great for clinical bands (BP, body
temp, SpO₂) or discrete phase labels (`"loading"` / `"maintenance"` /
`"rest"`):

```json
"calendar": {
  "enabled":   true,
  "component": "day-marker",
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
}
```

Rules iterate top-to-bottom, first match wins. Each rule is one of:

- `{ min, max, emoji }` — numeric bands (either bound optional).
  `min <= row[field] <= max`.
- `{ eq, emoji }` — exact string match, for categorical values.
- `{ emoji }` with no `min`/`max`/`eq` — **catch-all**. Matches any
  non-null value at the field. Put it last; paints "anything that
  didn't match the explicit bands above" without falling through to
  `fallback`.

This mirrors `display.thresholds` from the generic-card renderer, so
if you already have threshold rules colour-coding the Today card you
can reuse the same mental model here.

**5. `template`** — reuse the `display.template` mini-language to
pick the glyph. Especially useful when you already wrote an
`emojiMap` under `view.display` (e.g. for Mood) and don't want to
duplicate it:

```json
"view": {
  "component": "generic-card",
  "display": {
    "template":  "{mood:emoji}",
    "emojiMap":  { "mood": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" } }
  }
},
"calendar": {
  "enabled":   true,
  "component": "day-marker",
  "marker": {
    "type":     "template",
    "template": "{mood:emoji}",
    "fallback": "🙂"
  }
}
```

Because `template` renders against `view.display`, the calendar reads
the very same `emojiMap` the Today card uses. One source of truth —
change the map in `display` and both follow.

Supported template syntax (identical to `display.template`):

- `{key}` — raw value
- `{key:emoji}` — lookup in `display.emojiMap[key]`
- `{key:round(N)}` — round numeric to N decimals
- `{key|default}` — fallback if missing
- `{key?yes:no}` — ternary on truthiness
- `{path.to.nested}` — dotted access

**Where the day's row comes from.** The calendar flattens a card's
`data` into `date -> row`:
- Array of `{ date, ... }` rows: the last entry for each date wins.
- Date-keyed object (`{ "2026-04-20": { ... } }`): the value is the row.
- `items[].doses[]` (medication-schedule shape): the dose with the
  latest `takenAt` for that day wins. Untaken doses (`takenAt: null`)
  don't count.

**Multiple entries per day.** When `maxReadingsPerDay > 1`, the latest
same-day entry is the one the marker resolves against. Earlier
same-day readings are still stored — just not reflected in the
calendar glyph.

**Extension space.** The marker object is discriminated by `type`, so
the resolver is open to new kinds without breaking the schema. Each
type is one branch in the resolver; adding a new one is a local
change. The five currently shipped cover the common cases.

### `meta.writeable` — input form config

```json
"writeable": {
  "fromWebapp": true,
  "todayAllowed": true,
  "pastAllowed": true,
  "futureAllowed": false,
  "maxReadingsPerDay": 1,
  "inputs": [ ... ]
}
```

- `fromWebapp` (bool): show the ✏️/➕ edit button on the card
- `todayAllowed`, `pastAllowed`, `futureAllowed`: time-window policy. Enforced
  by the generic input form.
- `maxReadingsPerDay` (int, default `1`): how many entries per day are allowed.
  `1` = upsert (the new entry replaces the old); `>1` = append (capped at
  `max`); keep the newest.
- `inputs`: array of input field descriptors — see below.

---

## Input types (for `writeable.inputs`)

Each input entry is an object with at minimum `{ key, type }`. The generic
input form renders the right widget per type.

| type | widget | extra fields |
|------|--------|--------------|
| `number` | numeric input | `min`, `max`, `step`, `placeholder` |
| `stepper` | −/+ number picker (good for small integers — wake-ups, glasses, reps) | `min`, `max`, `step`, `default` |
| `text` | text input | `maxLength`, `placeholder` |
| `textarea` | multi-line | `rows`, `maxLength`, `placeholder` |
| `select` | dropdown | `options: [string]` or `[{value, label}]`, `placeholder` |
| `emoji-picker` | emoji row | `emojis: [...]` (default mood set), `emitIndex: true` to store 1..N |
| `colour` (`color`) | colour picker | — |
| `checkbox` | toggle | — |
| `date` | date picker | — |
| `time` | time picker | — |
| `rating` | 1..N buttons | `min`, `max` (default 1..5) |

All types support: `key` (required), `label`, `required`, `default`, `help`.

**`required` on inputs.** Defaults to `false` (optional). When `required: true`:
- The inline edit form blocks Save with an error message if the field is empty.
- The **modal prompt** (see `meta.prompt`) renders the Save button as
  disabled until every required field has a value.
- `autoSubmit` inputs (like the emoji-picker in Mood) don't need Save
  at all — picking the value submits directly.

**Example: a mood card input block**
```json
"inputs": [
  { "key": "mood", "type": "emoji-picker",
    "emojis": ["😩", "😴", "😐", "🙂", "😄"],
    "emitIndex": true, "label": "Mood", "required": true },
  { "key": "wakeUps", "type": "number", "label": "Wake-ups", "min": 0 },
  { "key": "notes", "type": "textarea", "label": "Notes", "rows": 2 }
]
```

---

## The `generic-card` renderer — zero-code cards

`meta.view.component = "generic-card"` enables a renderer that needs NO
hand-coded component. You describe how to display each entry via a template
string and optional emoji maps.

### `meta.view.display.template`

A template string with `{key}` placeholders. Syntax:

| syntax | meaning |
|--------|---------|
| `{key}` | Replace with `row[key]` |
| `{key:round(1)}` | Round to N decimal places |
| `{key:emoji}` | Look up `row[key]` in `display.emojiMap[key]` |
| `{key\|default}` | Fall back to `default` if value is missing/empty |
| `{key?yes:no}` | Ternary: show `yes` if truthy, `no` otherwise |
| `{path.to.nested}` | Dotted paths work too |

Unresolved keys render as empty string (no `undefined` leakage).

### `meta.view.display.secondary`

Optional second template for a smaller sub-line.

### `meta.view.display.emptyHeadline`

Shown when no entry exists for the current date. Default: `"No entry yet"`.

### `meta.view.display.emojiMap`

A dict keyed by field name, mapping value → emoji. Used by `{key:emoji}`.

```json
"display": {
  "template": "{mood:emoji} · {wakeUps} wake-ups",
  "secondary": "{notes|(no notes)}",
  "emptyHeadline": "No mood logged",
  "emojiMap": {
    "mood": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" }
  }
}
```

This turns `{ mood: 4, wakeUps: 2, notes: "" }` into `🙂 · 2 wake-ups` /
`(no notes)`.

### `meta.view.display.unit`

Optional unit suffix shown in lighter text next to the headline. Saves
inlining the unit into the template each time.

```json
"display": { "template": "{kg:round(1)}", "unit": "kg" }
```

Renders: `85.4` `kg` (with the `kg` in a lighter, smaller font).

### `meta.view.display.thresholds`

Evaluate the current entry against a list of rules and paint a coloured
side-bar on the card + show a label pill next to the headline. First
match wins.

```json
"display": {
  "template": "{systolic}/{diastolic}",
  "thresholds": [
    { "ifField": "systolic", "max": 119, "colour": "#44ff88", "label": "Optimal" },
    { "ifField": "systolic", "max": 129, "colour": "#aaaa44", "label": "Elevated" },
    { "ifField": "systolic", "max": 139, "colour": "#ff7733", "label": "Stage 1" },
    { "ifField": "systolic", "max": 999, "colour": "#ff3333", "label": "Stage 2" }
  ]
}
```

Each rule takes one of these matchers:
- `min`, `max` — numeric bounds (both inclusive). Both optional but at
  least one must be present.
- `eq` — exact equality (stringified).

Rules iterate top-to-bottom; the first rule whose field exists and
satisfies the matcher wins. `colour` and `label` are rendered by the
card.

### `meta.view.display.trendArrow`

Show an ↑ / ↓ / → arrow next to the headline, comparing the current
entry's value to the most recent earlier entry on the same key.

```json
"display": { "template": "{kg:round(1)}", "unit": "kg", "trendArrow": { "field": "kg" } }
```

Arrow colours:
- ↑ up — red (`#ff7755`)
- ↓ down — green (`#55cc77`)
- → flat — muted

Note the reverse: for weight, "up" is usually bad; for a rating card
you might want the opposite. Card authors can future-invert via a
`trendArrow.invert: true` flag (not implemented yet).

---

## The `list-card` renderer — persistent-items roster

`meta.view.component = "list-card"` renders the whole `data` array as a
scrolling list. Unlike `generic-card` (which shows one dated entry),
list-card shows every row on every day. Rows persist until explicitly
deleted. Use for:

- Symptoms you're currently tracking
- Appointments (upcoming list)
- Allergies, ongoing conditions
- Anything that's "currently true" rather than "logged today"

### Meta config

```json
"view": {
  "enabled": true,
  "component": "list-card",
  "display": {
    "primaryField":     "symptom",
    "secondaryTemplate": "{severity|} {location|}",
    "emptyMessage":     "No symptoms — tap Edit to add one.",
    "maxCharPreview":   60
  }
},
"writeable": {
  "fromWebapp": true,
  "inputs": [
    { "key": "symptom",  "type": "text",     "required": true, "maxLength": 120 },
    { "key": "severity", "type": "rating",   "min": 1, "max": 5 },
    { "key": "note",     "type": "textarea", "maxLength": 500 }
  ]
}
```

### UI

- **Normal view:** plain list. Tapping a row expands it inline to show
  the full primary text + secondary fields.
- **Edit mode:** tap ✏️ Edit in the header. Each row becomes editable
  inline (the primary field as a text input). Every row has a red ➖
  button — tap it to mark-for-delete (row shows struck-through); tap
  again to restore. `➕ Add` appends a new blank row. `Cancel` discards,
  `Done` saves the whole array.
- **Mobile:** same UX. Tap targets sized for finger use.

### Data shape

Array of objects, each object has the fields declared in
`writeable.inputs`. No `date` field needed — the `added` ISO timestamp
is set automatically per row on create and isn't shown in the form.

```json
"data": [
  { "symptom": "Chronic shoulder pain", "severity": 3, "note": "left side",
    "added": "2026-02-10T08:00:00Z" },
  { "symptom": "Morning brain fog", "severity": 2, "note": "high-carb days",
    "added": "2026-03-05T09:15:00Z" }
]
```

### Differences from `generic-card`

| Dimension | generic-card | list-card |
|------|-------------|-----------|
| Scope | one entry (today's or latest) | all entries (full roster) |
| `fallbackToLatest` | used — fallback display on Today | ignored |
| `maxReadingsPerDay` | enforces upsert / append cap | N/A |
| Row add pattern | one `meta.writeable.inputs` form per entry | same form, repeatable |
| Row delete | manual in chat / file edit | inline ➖ in edit mode |

---

## The `combination-card` renderer — one card, many sources

A **combination card** is a read-only window over other cards' data. It
owns no data of its own — its `data` block stays `[]` — and instead
projects the current day's row from each of several source manifests
into one tile.

When it's useful:

- Apple-Health-style summaries ("Sleep" composed of sleep-hours + mood,
  "Activity" composed of steps + active-minutes + workouts).
- Morning dashboards pulling the three metrics you actually check each
  day into one tile.
- Any time two or three cards carry fragments of the same concept and
  you want them shown together.

### Minimum shape

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "sleep",
    "label": "Sleep",
    "emoji": "😴",
    "view": {
      "enabled": true,
      "component": "combination-card",
      "layout": "stack",
      "combines": [
        { "sourceId": "sleep-hours", "role": "primary", "accessor": "hours", "unit": "h" },
        { "sourceId": "mood", "role": "secondary", "accessor": "mood" }
      ]
    }
  },
  "description": "Read-only composite of sleep-hours + mood.",
  "data": []
}
```

Edits happen on the source cards, not here. The combo re-fetches when
`manifest-data-changed` fires, so changes show up immediately.

### `layout`

Picks the visual treatment.

| value | what it renders | MVP | Notes |
|-------|-----------------|-----|-------|
| `stack` | Vertical label / value rows. Primary rows render large, secondary smaller, annotation muted. | ✓ | Default. |
| `rings` | Concentric progress rings (planned). | planned | Reserved name; renders as `stack` until the ring layout ships. |
| `chart` | Reuses `line-chart` inside the combo shell (planned). | planned | Reserved name; renders as `stack` until the chart layout ships. |

Unknown layout values fall back to `stack` so typos don't break the
card.

### `combines[]`

An ordered array — the order is the render order. Each entry:

| field | required | meaning |
|-------|----------|---------|
| `sourceId` | yes | Must match a loaded manifest's `meta.id`. If absent, renderer shows a placeholder — not an error. |
| `role` | yes | `primary` \| `secondary` \| `annotation`. Drives visual weight in `stack`. `ring-segment` and `bar-series` are reserved for future layouts. |
| `label` | no | Overrides the source's `meta.label` for this view. |
| `accessor` | no | Path into the day's row. Dotted paths supported (`stats.avg`). Default: first non-`date` scalar on the row. |
| `unit` | no | Short string rendered next to the value (e.g. `h`, `kcal`). |
| `emojiMap` | no | Stringified-value → emoji, for enum sources (`{ "1": "😩", "4": "🙂" }`). |

Multiple entries can point at the same source — e.g. Sleep combo pulls
both `mood` and `wakeUps` from the mood card via two separate
`combines[]` entries.

### Row resolution

For each `combines[]` entry, the renderer resolves the viewed date to
one of:

| state | meaning | how it renders |
|-------|---------|----------------|
| `ok` | Source exists, row for that date exists, accessor yields a value. | Normal row. |
| `no-source` | `sourceId` is not a loaded manifest. | Muted placeholder. |
| `no-entry` | Source loaded but has no row for the viewed date. | Muted placeholder. |
| `no-accessor-match` | Row exists but the accessor path yields `undefined`/`null`. | Muted placeholder. |

Non-`ok` states never throw — partial data just renders muted.

### Editing donor data from the combo

If a source declares `writeable.fromWebapp: true` with `inputs[]`, the
combo shows an edit pencil next to the **first row for that source**.
Clicking opens an inline form with the donor's **full** `inputs[]`
array (not just the fields the combo references) and writes back to
the donor's manifest. The combo refreshes on save.

Rules:

- One pencil per source, not per combines row. The Mood source might
  drive three rows in the Sleep combo (mood, wakeUps, notes) — you
  still see one pencil.
- Donor's `writeable.todayAllowed` / `pastAllowed` / `futureAllowed`
  are respected verbatim. If the donor denies past-dated edits, the
  pencil hides on past dates.
- Ingest-only donors (`writeable.fromWebapp: false`) never show a
  pencil. Good for atomic cards populated by Health Auto Export.

### Pairing with absorbed cards

A combo usually absorbs one or more atomic cards. To avoid seeing the
same value twice on Today (once in the combo, once in the atomic
card), set the absorbed card's `meta.enabled: false`. The card stays
in Settings (reactive-enable later if you want) and is still editable
via the combo.

### Worked example

A Sleep composite that wraps `sleep-hours` + `mood`:

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "sleep",
    "label": "Sleep",
    "emoji": "😴",
    "order": 25,
    "view": {
      "enabled": true,
      "component": "combination-card",
      "layout": "stack",
      "combines": [
        {
          "sourceId": "sleep-hours",
          "role": "primary",
          "label": "Asleep",
          "accessor": "hours",
          "unit": "h"
        },
        {
          "sourceId": "mood",
          "role": "secondary",
          "label": "Mood",
          "accessor": "mood",
          "emojiMap": { "1":"😩","2":"😴","3":"😐","4":"🙂","5":"😄" }
        },
        {
          "sourceId": "mood",
          "role": "annotation",
          "label": "Wake-ups",
          "accessor": "wakeUps"
        }
      ]
    }
  },
  "description": "Composite Sleep card. Read-only view over sleep-hours + mood.",
  "data": []
}
```

Drop that alongside working `sleep-hours.json` + `mood.json` files and
you'll see one Sleep tile showing hours + mood + wake-ups, with a
pencil next to the Mood row (if mood is writeable).

An Activity combo can be built the same way over `steps` +
`active-minutes` + `workouts`.

---

## The `data` block

Card-specific. The convention for most cards is an array of dated entries:

```json
"data": [
  { "date": "2026-04-20", "kg": 85.5 },
  { "date": "2026-04-21", "kg": 86.0 }
]
```

For cards that hold a single document (like `markdown-doc`), it's an object:

```json
"data": { "markdown": "## Heading\n\nContent..." }
```

The registry imposes no schema on `data` — each renderer interprets it.

---

## Settings

The Settings page lists every card discovered in `$HEALTH_HOME/data/` with a
master enable/disable toggle. Toggling flips `meta.enabled` inside the card's
file — nothing else.

- **Hide a card temporarily:** toggle off in Settings (or edit the file).
- **Remove a card permanently:** delete the file.
- **Add a card:** drop a valid manifest file into `$HEALTH_HOME/data/`.

There is **no install flow, no wizard, no catalog**. If the file is there,
the card shows up.

## Reordering cards

There are three ways to change the order cards appear on Today / Trends /
Calendar / Reports:

1. **Drag in the UI.** Tap the ⚙️ icon in the top nav and pick
   "⋮⋮ Reorder cards". Each card gets a drag handle; drag to reorder, tap
   "Done" to save. Keyboard users: Tab to a drag handle and press ↑ or ↓
   to move that card. Changes persist immediately.
2. **Ask the chat agent.** *"Move the mood card above peptides."*
3. **Edit the file directly.** Card order comes from `meta.order` (lower
   value = earlier). Sparse convention: 100, 200, 300, … so you can
   insert between two cards by picking a value in the gap (e.g. 150).

Order is single and canonical — reordering on Today affects Trends,
Calendar, and Reports too. Per-view ordering isn't implemented.

### Agent / script interface

Reorder programmatically by POSTing to `/api/manifests/reorder`:

```http
POST /api/manifests/reorder
Content-Type: application/json

{ "order": ["weight", "bp", "mood", "peptides"] }
```

Writes sparse-numbered `meta.order` to each listed card. Unlisted cards
keep their existing order. Any unknown id causes the whole operation to
fail with no writes. See [`CHAT-AGENT.md`](CHAT-AGENT.md) for the full
agent API surface.

---

## Schema version

The `$schema` field identifies the manifest format. The only currently
supported value is `klebb.datafile.v1`. Files without `$schema` are
silently skipped (legacy data may still live in the same directory). Files
with an unsupported `$schema` are logged as errors but don't crash the
server.

Future breaking changes will bump the version; old manifests will be
migrated by a script in the repo.
