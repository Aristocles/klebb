# EddzHealth Data File Manifest — v1

All structured data in `$HEALTH_HOME/data/*.json` follows this single schema. The app is a generic renderer; each file declares how it wants to appear across the different views.

## Top-level structure

```jsonc
{
  "$schema": "eddzhealth.datafile.v1",
  "meta": { /* rendering manifest — required */ },
  "description": "Human-readable instructions for AI writers (optional but recommended)",
  "schema": { /* optional JSON Schema for the data block */ },
  "data": [ /* records, object, or anything the renderer component understands */ ]
}
```

### Required fields

- `$schema` — must be exactly `"eddzhealth.datafile.v1"`. Unknown versions are logged + skipped.
- `meta.id` — unique identifier (lowercase, alphanumeric + hyphens, matches the filename stem)
- `meta.label` — human display name

Everything else is optional; omitting a view section means the card is not rendered in that view.

## `meta`

```jsonc
"meta": {
  "id": "bp",
  "label": "Blood Pressure",
  "emoji": "💓",
  "category": "vitals",               // optional grouping hint; future use
  "order": 10,                         // optional sort hint within a view (lower = first)

  "view":     { /* DateView / Today */ },
  "trends":   { /* Trends page */ },
  "calendar": { /* Calendar month-view markers */ },
  "reports":  { /* Reports page */ },
  "dayDetail":{ /* Expanded detail when card is tapped */ },

  "writeable": {
    "fromWebapp": true,
    "pastAllowed": true,
    "todayAllowed": true,
    "futureAllowed": false
  }
}
```

### View sections — common properties

Each of `view`, `trends`, `calendar`, `reports`, `dayDetail` can contain:

- `enabled` — boolean (default `false`). If missing or false, nothing renders for that view.
- `component` — string, name of a built-in renderer. See the renderer catalogue below.
- `order` — integer, display order within the view (lower first).
- `dateContext` — one of `"exact-date"` | `"latest"` | `"week-of"` | `"rolling-30d"` | `"rolling-90d"` | `"rolling-365d"` | `"night-before"` | `"month-of"`.
- `slot` — optional string (for `view` only). Reserved slots: `"top"` (greeting/banner), `"bottom"`.
- Component-specific fields — see renderer catalogue.

### `writeable`

Controls whether the webapp offers input/edit controls for this card.

- `fromWebapp` — if false, the card is read-only in the UI regardless of date.
- `pastAllowed`, `todayAllowed`, `futureAllowed` — per-date-mode gates. Notes-type cards often set all three to true; measurement cards typically allow past + today only.

## Data block

Free-form — the chosen renderer determines the expected shape. Common patterns:

- **Array of entries** (measurement cards): `[ { date, ... }, ... ]`
- **Object keyed by date** (notes, mood): `{ "YYYY-MM-DD": { ... } }`
- **Items with schedule + doses** (medication schedule, any recurring protocol):
  ```jsonc
  {
    "groups": [ { "id": "...", "label": "...", "items": ["a","b"] } ],
    "items": [
      {
        "name": "prednisolone",
        "schedule": { /* see schedule.md */ },
        "cycles": [ { "type": "on", "start": "2026-04-10", "end": "2026-05-10" } ],
        "doses": [ { "scheduledDate": "2026-04-10", "takenAt": "2026-04-10T08:15:00+10:00" } ]
      }
    ]
  }
  ```

## Schedule rules

Used by any card with recurring items (medication schedule, workouts, habits). Support:

- `frequency: "daily"` — every day in cycle
- `frequency: "weekly"` + `dayOfWeek: "saturday"`
- `frequency: "every_n_days"` + `nDays: 3` + `startDate: "YYYY-MM-DD"`
- `frequency: "on_off"` + `on_days: ["Mon","Tue","Wed","Thu","Fri"]` + `off_days: ["Sat","Sun"]`
- `frequency: "phased"` with `loading: { duration_weeks, days[] }` + `maintenance: { days[] }`
- `times_per_day` — optional, for within-day repetition (e.g. 4 for QID eye drops)

Cycles envelope the schedule:
```jsonc
"cycles": [
  { "type": "on",  "start": "2026-04-01", "end": "2026-06-01" },
  { "type": "off", "start": "2026-06-02", "end": "2026-07-31" }
]
```

For ongoing protocols with no end date, omit `end` (treated as "until further notice").

## Reserved paths

Server ignores these when scanning `data/` for manifest files:

- `data/_virtual/` — composite/derived cards (no `data` block; `source:` declares what they aggregate)
- `data/_archive/` — disabled files kept for restore
- `data/_meta/` — app-internal state (e.g. per-file `lastRotatedDate` stamps)
- Anything starting with `.` (dotfiles)
- Anything not ending in `.json`

## Legacy non-manifest files

Some existing files don't (yet) follow the manifest schema. During migration they're wrapped into manifest form and archived. The server also supports reading a few legacy shapes transparently so nothing breaks mid-migration.

See `MIGRATION.md` for the v1→v2 data transformation rules.

## Error handling

- Missing `$schema` → file skipped, warning logged, not rendered anywhere.
- Unknown `$schema` version → file skipped, warning logged.
- Unknown `component` name → card shows small inline error placeholder + console warning.
- Corrupt JSON → file skipped, warning logged. Never crashes the server.

## Example: minimal manifest

```jsonc
{
  "$schema": "eddzhealth.datafile.v1",
  "meta": {
    "id": "weight",
    "label": "Weight",
    "emoji": "⚖️",
    "view": {
      "enabled": true,
      "component": "metric-card-with-sparkline",
      "dateContext": "latest"
    },
    "trends": { "enabled": true, "component": "line-chart" },
    "writeable": { "fromWebapp": true, "pastAllowed": true, "todayAllowed": true, "futureAllowed": false }
  },
  "description": "Body weight log. Append new entries as { date, kg, notes? }.",
  "data": [
    { "date": "2026-04-01", "kg": 91.2 },
    { "date": "2026-04-14", "kg": 90.8 }
  ]
}
```

## Versioning

Breaking schema changes bump to `v2`. Files continue to be loaded by their declared version so old and new can coexist during migration. A migration helper script per transition lives at `scripts/migrate-vN-to-vN+1.js`.
