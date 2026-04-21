# Cards — how the dashboard works

Klebb is a **file-driven** health dashboard. Every card you see on the
dashboard is a JSON file in `$HEALTH_HOME/data/`. There's no database, no
catalog, no "install" step — if the file exists and is a valid manifest, the
card appears. If you delete the file, the card is gone.

This doc is for **users and card authors**. If you're writing a chat-agent
integration, see [`CHAT-AGENT.md`](./CHAT-AGENT.md).

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

### `meta.view` — the Today view config

```json
"view": {
  "enabled": true,
  "component": "generic-card",
  "dateContext": "viewedDate",
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
  - `schedule-card` — medication/supplement schedule grid
  - `checklist-card` — daily checklist
  - `markdown-doc` — static markdown content
  - `line-chart`, `schedule-timeline`, `table-list`, `adherence-report`,
    `greeting-banner`
- `dateContext` (`"viewedDate"` | `"latest"`, default `"viewedDate"`):
  - `viewedDate` — show the entry matching the date currently on screen
  - `latest` — show the most recent entry regardless of date
- `slot` (`"top"` | `null`): if `"top"`, the card spans the full row
- `order` (int): view-specific ordering override; falls back to `meta.order`
- `display` (object): see the **generic-card** section below

### `meta.trends` — the Trends view config

Same shape as `meta.view`. Typical use: `component: "line-chart"` with `xKey`
and `yKey` pointing into the data rows.

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

---

## Example cards

See the `data.example/` directory in the repo for reference manifests:
- `weight.example.json` — metric card with a line-chart trend
- `bp.example.json` — two-number metric (systolic/diastolic)
- `mood.example.json` — emoji-picker mood card
- `notes.example.json` — freeform daily notes
- `medication-schedule.example.json` — schedule-card for peptides/meds
- `greeting.example.json` — greeting banner
- `welcome.example.json` — welcome card using `markdown-doc`

Copy any of these into your `$HEALTH_HOME/data/` directory and rename to
drop the `.example`.

---

## Schema version

The `$schema` field identifies the manifest format. The only currently
supported value is `klebb.datafile.v1`. Files without `$schema` are
silently skipped (legacy data may still live in the same directory). Files
with an unsupported `$schema` are logged as errors but don't crash the
server.

Future breaking changes will bump the version; old manifests will be
migrated by a script in the repo.
