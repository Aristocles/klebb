# Recipes

Patterns for building common card types. Each recipe is a complete,
copy-pasteable manifest file you can drop into `$HEALTH_HOME/data/` as a
starting point.

For the full manifest spec, see [`CARDS.md`](CARDS.md) and
[`../MANIFEST-SCHEMA.md`](../MANIFEST-SCHEMA.md).

---

## Recipe 1 — Single-number metric with trend arrow

For tracking a daily numeric value where you care about the trend from
yesterday (weight, steps, HRV, resting heart rate).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "weight",
    "label": "Weight",
    "emoji": "⚖️",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{kg:round(1)}",
        "unit": "kg",
        "trendArrow": { "field": "kg" }
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "kg", "type": "number", "label": "Weight (kg)",
          "min": 0, "max": 500, "step": 0.1, "required": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `display.template: "{kg:round(1)}"` — 1-decimal rounding
- `display.unit: "kg"` — small grey suffix
- `display.trendArrow.field: "kg"` — ↑/↓/→ vs previous entry
- `maxReadingsPerDay: 1` — new entry replaces today's old one

**Variations:**
- For **steps** use `"step": 1`, large `"max": 100000`, no rounding.
- For **HRV** add `"source"` text input (Oura, Whoop, Apple Watch).

---

## Recipe 2 — Two-number metric with colour-coded thresholds

For vital signs where the value falls into clinical bands (blood pressure,
cholesterol ratios, fasting glucose).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "bp",
    "label": "Blood Pressure",
    "emoji": "💓",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{systolic}/{diastolic}",
        "unit": "mmHg",
        "thresholds": [
          { "ifField": "systolic", "max": 119, "colour": "#44ff88", "label": "Optimal" },
          { "ifField": "systolic", "max": 129, "colour": "#aaaa44", "label": "Elevated" },
          { "ifField": "systolic", "max": 139, "colour": "#ff7733", "label": "Stage 1" },
          { "ifField": "systolic",              "colour": "#ff3333", "label": "Stage 2" }
        ]
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 3,
      "inputs": [
        { "key": "systolic",  "type": "number", "label": "Systolic",  "required": true },
        { "key": "diastolic", "type": "number", "label": "Diastolic", "required": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- Template uses both fields: `{systolic}/{diastolic}`
- `thresholds` evaluated top-to-bottom, first match wins
- `maxReadingsPerDay: 3` — typical BP protocol is morning/afternoon/evening
- Paints a coloured side-bar on the card + a pill label

**Variations:**
- Invert for "lower is worse" (e.g. SpO₂): use `min` instead of `max`.
- For single-metric thresholds (sleep hours), keep the same pattern with
  one field.


---

## Recipe 3 — Emoji-picker rating (mood-like, one-tap)

For subjective 1-to-N ratings where an emoji row communicates faster than
numbers.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "mood",
    "label": "Mood",
    "emoji": "🙂",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{mood:emoji}",
        "emojiMap": {
          "mood": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" }
        }
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "mood", "type": "emoji-picker", "label": "Mood",
          "emojis": ["😩", "😴", "😐", "🙂", "😄"],
          "emitIndex": true, "required": true, "autoSubmit": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `emitIndex: true` — stores 1-5 instead of the emoji itself (so the data
  is sortable/chartable)
- `autoSubmit: true` — tapping the emoji submits immediately (no Save click)
- `emojiMap` lets the template re-render the stored index as the picked emoji

**Variations:**
- Swap emojis to your taste: `["💀", "😞", "😐", "😊", "🤩"]`
- Add secondary inputs (mood + wake-ups + notes) — keep `autoSubmit: false`
  on the primary so the form doesn't close prematurely


---

## Recipe 4 — 1-to-5 rating buttons

For ratings where you want explicit numeric buttons (not emojis). Useful
for stress, energy, or any dimension you'll chart over time.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "stress",
    "label": "Stress",
    "emoji": "😤",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{rating}",
        "unit": "/ 5",
        "thresholds": [
          { "ifField": "rating", "eq": 1, "colour": "#44ff88", "label": "Calm" },
          { "ifField": "rating", "eq": 5, "colour": "#ff3333", "label": "Frazzled" }
        ]
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "rating", "type": "rating", "label": "Stress",
          "min": 1, "max": 5, "required": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `type: "rating"` renders a row of 1..5 buttons
- `min`/`max` set the range (default 1-5, can use e.g. 1-10)
- `eq` thresholds colour the pill per exact value


---

## Recipe 5 — Categorical tracker with colour map

For values that fall into discrete categories where each category has a
meaningful colour (Bristol stool, pain level, urine colour).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "bristol-stool",
    "label": "Bristol Stool",
    "emoji": "💩",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "Type {type}",
        "thresholds": [
          { "ifField": "type", "eq": "1", "colour": "#884422", "label": "Constipated" },
          { "ifField": "type", "eq": "4", "colour": "#44ff88", "label": "Ideal" },
          { "ifField": "type", "eq": "7", "colour": "#ff3333", "label": "Liquid" }
        ]
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 5,
      "inputs": [
        {
          "key": "type",
          "type": "select",
          "label": "Type",
          "required": true,
          "options": [
            { "value": "1", "label": "1 — Separate hard lumps" },
            { "value": "4", "label": "4 — Smooth soft sausage (ideal)" },
            { "value": "7", "label": "7 — Watery" }
          ]
        }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `type: "select"` with `{value, label}` pairs → dropdown
- Thresholds use `eq` (not `min/max`) for exact-match categorical colouring
- `maxReadingsPerDay > 1` since this is often multi-per-day


---

## Recipe 6 — Yes/no daily checkbox

For habit tracking: did I meditate, did I train, did I take my
supplements.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "workouts",
    "label": "Workout Today",
    "emoji": "🏋️",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{trained?✅ Trained:❌ Rest}",
        "secondary": "{notes|}"
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "trained", "type": "checkbox", "label": "Trained today?" },
        { "key": "notes", "type": "textarea", "label": "Notes", "rows": 2 }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- Template uses the ternary operator: `{trained?yes:no}` renders the
  `yes` text when truthy, `no` text when falsy
- `type: "checkbox"` → on/off toggle


---

## Recipe 7 — Textarea with truncated display

For freeform journal-style entries where you want a preview on Today
and the full text available via the edit form.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "notes",
    "label": "Daily Notes",
    "emoji": "📝",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{note:truncate(80)|(no note today)}"
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "note", "type": "textarea", "label": "Note",
          "rows": 4, "placeholder": "How's the day?" }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `{note:truncate(80)}` cuts the string at 80 chars and adds `…`
- `|(no note today)` pipe-default covers the empty case

**Variations:**
- For longer preview use `truncate(160)` and consider `display.secondary`
  for tags or metadata on a second line.


---

## Recipe 8 — Multi-reading-per-day

For metrics with natural multiple-measurement patterns (BP taken 3x/day,
mood dips tracked throughout the day, pain-rating spot checks).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "bp",
    "label": "Blood Pressure",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": { "template": "{systolic}/{diastolic}", "unit": "mmHg" }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 3,
      "inputs": [
        { "key": "systolic",  "type": "number", "required": true },
        { "key": "diastolic", "type": "number", "required": true },
        { "key": "time",      "type": "time",   "label": "Time taken" }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `maxReadingsPerDay: 3` — keep the 3 most recent same-day entries; older
  ones drop off
- Add a `time` input so multiple same-day readings have a clock time
  associated with them (the generic card shows the latest one)

**How the cap works:** when you save, new entries are appended. If the
count for that date exceeds `max`, the OLDEST same-date entry is dropped
(FIFO-per-day). Entries from other dates are untouched.

---

## Recipe 9 — Time-of-day tracker

For when you care WHAT TIME you did something, not just whether (first
coffee, last meal, when I took the melatonin).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "first-coffee",
    "label": "First Coffee",
    "emoji": "☕",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": { "template": "{time|not yet today}" }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "time", "type": "time", "label": "Time of first cup",
          "required": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `type: "time"` renders a native time picker (HH:MM, 24h)
- Stored as a string (e.g. `"07:30"`) in the entry

---

## Recipe 10 — Colour tracker

For visual assessments (urine colour for hydration, bruise colour over
time, skin redness).

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "urine-colour",
    "label": "Hydration (colour)",
    "emoji": "🩴",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{colour|—}",
        "secondary": "{note|}"
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 3,
      "inputs": [
        { "key": "colour", "type": "colour", "label": "Colour (pale = good)" },
        { "key": "note",   "type": "text",   "label": "Note",
          "placeholder": "e.g. post-coffee, post-run" }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `type: "colour"` (or `"color"`) renders a native colour picker
- Stored as a hex string (`"#ffeecc"`)

---

## Recipe 11 — Calendar marker that reflects the day's value

For cards where you want the **month-grid calendar** to show more than
just "had data". Two common patterns:

### 11a — Field-driven emoji (mood, energy, stress)

Add a `calendar` block to any card whose data has a categorical field.
The marker resolver reads that field on the day's row and looks it up
in an emoji map.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "mood",
    "label": "Mood",
    "emoji": "🙂",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{mood:emoji}",
        "emojiMap": { "mood": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" } }
      }
    },
    "calendar": {
      "enabled":   true,
      "component": "day-marker",
      "marker": {
        "type":     "field-emoji",
        "field":    "mood",
        "emojiMap": { "1": "😩", "2": "😴", "3": "😐", "4": "🙂", "5": "😄" },
        "fallback": "🙂"
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "mood", "type": "emoji-picker", "label": "Mood",
          "emojis": ["😩", "😴", "😐", "🙂", "😄"],
          "emitIndex": true, "required": true, "autoSubmit": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `marker.field` — which field on the day's row to read (`mood` here).
- `marker.emojiMap` — stringified-value to emoji. The view's own
  `display.emojiMap` isn't reused; keep them in sync if you want the
  calendar and the Today card to agree.
- `marker.fallback` — glyph when the field is missing or unmapped.

**Variations:**
- Energy 1-5: sub in different emoji (`😴`/`😌`/`🙂`/`💪`/`🔥`).
- Sleep quality: map `poor`/`ok`/`great` strings to `🌧️`/`⛅`/`☀️`.

### 11b — Trend arrow (weight, HRV, RHR)

For numeric metrics where you care about direction of change between
consecutive entries. The resolver compares today's value to the most
recent earlier entry's value at the same field.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "weight",
    "label": "Weight",
    "emoji": "⚖️",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": { "template": "{kg:round(1)}", "unit": "kg", "trendArrow": { "field": "kg" } }
    },
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
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "kg", "type": "number", "label": "Weight (kg)",
          "min": 0, "max": 500, "step": 0.1, "required": true }
      ]
    }
  },
  "data": []
}
```

**Key bits:**
- `marker.field` — numeric field to compare. Dotted paths work for
  nested shapes (`readings.kg`).
- `up`/`down`/`flat` are optional; defaults are `⬆️`/`⬇️`/`➡️`.
- `fallback` shows on the very first entry (no previous) or when the
  current / previous value isn't numeric.

**Variations:**
- Invert semantics: for sleep hours, "up" is good — swap glyph colours
  by picking different emoji (`💤`/`😵`/`➡️`).
- Apply to HRV, steps, resting heart rate, grip strength — any
  numeric daily reading.

### 11c — Threshold bands (BP, body temp, SpO₂)

When the value falls into **clinical bands** you care about, paint the
calendar cell with the matching band colour. First rule to match wins,
so order rules narrow-to-wide just like `display.thresholds`.

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

**Key bits:**
- Each rule is `{ min?, max?, emoji }` (numeric band; either bound
  optional), `{ eq, emoji }` (exact string match), or `{ emoji }` on
  its own (catch-all — matches anything not caught by the rules above;
  put it last).
- Rules are evaluated top-to-bottom; first match wins. Cascade
  narrowest-first.
- `fallback` shows when no rule matches or the field is missing.

**Variations:**
- Body temp with fever bands: `🧊` / `🟢` / `🟡` / `🔥`.
- SpO₂: invert with `min` — `{ min: 95, emoji: '🟢' }`,
  `{ min: 90, emoji: '🟡' }`, `{ max: 89, emoji: '🔴' }`.
- Phase tracking with `eq`: `{ eq: 'loading', emoji: '🔁' }`,
  `{ eq: 'rest', emoji: '💤' }`.

### 11d — Template (reuse the Today card's emojiMap)

If you already wrote an `emojiMap` under `view.display` for the Today
card, the `template` type lets the calendar read the **same map** —
no duplication. Change the map in `display` and the calendar follows.

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

**Key bits:**
- `marker.template` uses the same syntax as `display.template` —
  `{key}`, `{key:emoji}`, `{key:round(N)}`, `{key|default}`, and so on.
- `{key:emoji}` resolves against `display.emojiMap[key]` — same lookup
  the Today card uses.
- `fallback` shows when the template renders empty.

**When to prefer template over field-emoji:**
- You already have an `emojiMap` in `display` and don't want two
  copies to keep in sync.
- You want to combine multiple fields, e.g. `"{wakeUps?😴:✅}"`.

### Keeping it simple: static marker

If you don't want per-day dynamics, the original shape still works:

```json
"calendar": { "enabled": true, "component": "day-marker", "marker": "💊" }
```

Every day the card has data gets the same glyph. `marker` can also be
omitted, in which case the card's `meta.emoji` is used.


---

## Recipe 12 — Morning dashboard combination card

**Goal.** One tile on Today that surfaces three metrics you actually
check each morning — last night's sleep, today's mood, and steps so
far. Read-only; edits happen on the underlying cards.

**Prerequisites.** You already have `sleep-hours`, `mood`, and
`steps` cards. If not, build them first with Recipes 1, 3, 1.

**File.** `$HEALTH_HOME/data/morning.json`:

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "morning",
    "label": "Morning",
    "emoji": "☀️",
    "order": 10,
    "view": {
      "enabled": true,
      "component": "combination-card",
      "layout": "stack",
      "combines": [
        { "sourceId": "sleep-hours", "role": "primary",   "label": "Asleep", "accessor": "hours", "unit": "h" },
        { "sourceId": "mood",        "role": "secondary", "label": "Mood",   "accessor": "mood",
          "emojiMap": { "1":"😩","2":"😴","3":"😐","4":"🙂","5":"😄" } },
        { "sourceId": "steps",       "role": "annotation","label": "Steps",  "accessor": "count" }
      ]
    }
  },
  "description": "Read-only morning summary over sleep-hours, mood, steps.",
  "data": []
}
```

**What you get.**

- A single "Morning" tile on Today with three rows: a large sleep
  headline, a medium mood emoji, a muted step count.
- If `mood.meta.writeable.fromWebapp` is `true`, an edit pencil next
  to the Mood row opens a form over `mood.json`. `sleep-hours` and
  `steps` stay read-only (typical when they're populated by Health
  Auto Export, see `docs/HEALTH-AUTO-EXPORT.md`).
- Empty states: if any source has no row for the viewed date, its
  row renders muted with a "no entry" hint instead of breaking the
  layout.

**Tips.**

- Set the absorbed source's `meta.enabled: false` (via Settings or
  klebbius) to avoid the mood card showing twice on Today.
- Multiple `combines[]` entries can point at the same source — e.g.
  pull both `mood` and `wakeUps` off the mood card as two rows.
- Accessor is dotted-path aware: `accessor: "stats.avg"` reads
  nested scalars.

See `docs/CARDS.md` → "The `combination-card` renderer" for the full
field reference, including how the pencil inherits donor date rules
and why only one pencil per donor renders.

---

## Recipe 13 — Schedule-card with per-dose metadata + retroactive review

For an injectable peptide cycle where you want to log WHERE you injected
each time, AND rate how the previous site is reacting (bruise, welt,
etch) when you log the new dose. Requires the `chips` and `chips-multi`
input types.

The two new pieces are `meta.view.checkOffForm` (which fields go on the
new dose, which on the previous dose) and chip inputs for the actual
options. See `docs/CARDS.md` "Schedule-card per-dose metadata" for the
full reference.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "peptide-cycle",
    "label": "Peptide Cycle",
    "emoji": "💉",
    "order": 320,
    "view": {
      "enabled": true,
      "component": "schedule-card",
      "checkOffForm": {
        "currentDoseFields":  ["site_side", "site_region", "site_position"],
        "previousDoseFields": ["reactions"],
        "previousDosePrompt": "How does the last injection site look?",
        "currentDosePrompt":  "This injection"
      }
    },
    "writeable": {
      "fromWebapp": true,
      "todayAllowed": true,
      "pastAllowed": true,
      "futureAllowed": false,
      "inputs": [
        { "key": "site_side",     "label": "Side",     "type": "chips",
          "options": ["left", "right", "centre"] },
        { "key": "site_region",   "label": "Region",   "type": "chips",
          "options": ["belly", "flank", "thigh", "delt", "glute", "tricep"] },
        { "key": "site_position", "label": "Position", "type": "chips",
          "options": ["upper", "middle", "lower"] },
        { "key": "reactions",     "label": "Reactions", "type": "chips-multi",
          "options": ["bruised", "red", "swollen", "itchy", "tender", "welt", "lump"] }
      ]
    }
  },
  "description": "Injectable peptide cycle with per-dose injection-site logging and retroactive reaction review on the previous dose.",
  "data": {
    "items": [
      {
        "name": "BPC-157",
        "dose_mg": 0.25, "dose_units": "mg", "route": "subcutaneous",
        "schedule": { "type": "daily", "times_per_day": 1, "start_date": "2026-06-01", "cycle_weeks": 6 },
        "doses": []
      }
    ]
  }
}
```

What you see on the dashboard: tap the ✓ on a scheduled item, the row
expands inline with a "Last: 3d ago · right belly upper" context line,
the reaction chips for the previous site, and the side/region/position
chips for the new dose. Submit writes the new dose with site fields
stamped on, AND merges the reaction chips you ticked onto the previous
dose entry.

Stored shape per dose:

```json
{
  "scheduledDate": "2026-06-08",
  "takenAt": "2026-06-08T09:14:00Z",
  "site_side": "left",
  "site_region": "thigh",
  "site_position": "upper"
}
```

Plus, on the previous taken dose, whatever was already there + the
reactions array:

```json
{
  "scheduledDate": "2026-06-05",
  "takenAt": "2026-06-05T09:30:00Z",
  "site_side": "right",
  "site_region": "belly",
  "site_position": "upper",
  "reactions": ["bruised", "itchy"]
}
```

Schedule-cards without `meta.view.checkOffForm` keep the original
one-tap check-off — the form-driven path is opt-in.

---

## Recipe 14: schedule-card with time-of-day chips and `schedule_due` reminders

For a peptide / injectable / scheduled-medication card where you
want each item labelled with a slot (morning, midday, evening,
night) and a Web Push reminder that only fires when something is
actually due in that slot today. Quiet on rest days, off-cycle
days, and after every dose for the slot has been logged.

The two new pieces are `schedule.time_of_day` on each item (a join
key plus a render hint for the emoji chip) and `meta.notifications`
items with `trigger.type: "schedule_due"`. See `docs/CARDS.md`
"Schedule-aware notifications" for the full firing semantics
including carry-forward of earlier-slot misses.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "peptide-cycle",
    "label": "Peptide Cycle",
    "emoji": "💉",
    "order": 320,
    "view": { "enabled": true, "component": "schedule-card" },
    "reports": {
      "enabled": true,
      "component": "adherence-report",
      "showCompliance": true
    },
    "notifications": {
      "enabled": true,
      "items": [
        {
          "id": "morning-jabs",
          "label": "Morning peptides",
          "title": "Peptides",
          "body": "Time for {schedule_due}{missed_earlier}",
          "trigger": {
            "type": "schedule_due",
            "card": "peptide-cycle",
            "time_of_day": "morning",
            "time": "08:00"
          },
          "action": { "type": "open-card", "card": "peptide-cycle", "intent": "log" }
        },
        {
          "id": "evening-jabs",
          "label": "Evening peptides",
          "title": "Peptides",
          "body": "Time for {schedule_due}{missed_earlier}",
          "trigger": {
            "type": "schedule_due",
            "card": "peptide-cycle",
            "time_of_day": "evening",
            "time": "20:00"
          },
          "action": { "type": "open-card", "card": "peptide-cycle", "intent": "log" }
        }
      ]
    }
  },
  "description": "Peptide cycle with time-of-day chips and schedule-aware morning + evening reminders.",
  "data": {
    "items": [
      {
        "name": "BPC-157", "short_name": "BPC",
        "dose_mg": 0.25, "dose_units": "mg", "route": "subcutaneous",
        "schedule": {
          "type": "weekly", "on_days": ["Mon","Wed","Fri"],
          "time_of_day": ["morning","evening"]
        },
        "doses": []
      },
      {
        "name": "Insulin", "short_name": "insulin",
        "dose_mg": 4, "dose_units": "U", "route": "subcutaneous",
        "schedule": { "type": "daily", "time_of_day": "morning" },
        "doses": []
      },
      {
        "name": "Ozempic",
        "schedule": {
          "type": "weekly", "on_days": ["Sun"],
          "time_of_day": "evening"
        },
        "doses": []
      }
    ]
  }
}
```

**Key bits:**
- `schedule.time_of_day` accepts a single token or an array of
  tokens drawn from `morning | midday | evening | night`. The chip
  next to the row reflects every token (☀️ / 🌤️ / 🌙 / 💤); BPC
  above gets two chips because it's logged morning AND evening.
- One `schedule_due` trigger per slot. The trigger's `time_of_day`
  is a single token; arrays only make sense on the items
  themselves.
- `body: "Time for {schedule_due}{missed_earlier}"` renders cleanly
  whether or not anything was missed earlier in the day. The
  `{missed_earlier}` placeholder carries its own
  `". Also missed earlier: "` prefix when non-empty, empty string
  otherwise.
- Items already taken today are excluded by the filter, so a
  reminder never fires for a dose the user already logged.

**Variations:**
- Add `meta.view.checkOffForm` (see Recipe 13) to combine
  per-dose metadata with the `schedule_due` reminders. The two
  features compose: the form captures site / reactions data, and
  the trigger drives the buzz.
- For a daily-only card, drop the weekly trigger and keep just the
  `morning` one. For a four-times-a-day antibiotic course, declare
  four triggers (`morning`, `midday`, `evening`, `night`); the
  carry-forward logic will fold any missed earlier slots into the
  next fire.

---

## Recipe 15: vitamin / supplement checklist with morning + evening reminders

Same `time_of_day` chip and `schedule_due` trigger machinery as
Recipe 14, but on a `checklist-card` instead of a `schedule-card`:
the shared helper means the chip and the filter behave identically.

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "supplements",
    "label": "Supplements",
    "emoji": "💊",
    "order": 310,
    "view": { "enabled": true, "component": "checklist-card" },
    "calendar": {
      "enabled": true,
      "component": "day-marker",
      "marker": "💊"
    },
    "prompt": {
      "enabled": true,
      "mode": "checklist",
      "whenMissing": true
    },
    "notifications": {
      "enabled": true,
      "items": [
        {
          "id": "morning-stack",
          "label": "Morning supplements",
          "title": "Supplements",
          "body": "Time for {schedule_due}{missed_earlier}",
          "trigger": {
            "type": "schedule_due",
            "card": "supplements",
            "time_of_day": "morning",
            "time": "07:30"
          },
          "action": { "type": "open-card", "card": "supplements", "intent": "log" }
        },
        {
          "id": "evening-stack",
          "label": "Evening supplements",
          "title": "Supplements",
          "body": "Time for {schedule_due}{missed_earlier}",
          "trigger": {
            "type": "schedule_due",
            "card": "supplements",
            "time_of_day": "evening",
            "time": "21:00"
          },
          "action": { "type": "open-card", "card": "supplements", "intent": "log" }
        }
      ]
    }
  },
  "description": "Daily supplement checklist with time-of-day chips and slot-aware reminders.",
  "data": {
    "items": [
      {
        "name": "Vitamin D3", "short_name": "D3",
        "schedule": { "type": "daily", "time_of_day": "morning" },
        "doses": []
      },
      {
        "name": "Creatine",
        "schedule": { "type": "daily", "time_of_day": "morning" },
        "doses": []
      },
      {
        "name": "Magnesium glycinate", "short_name": "magnesium",
        "schedule": { "type": "daily", "time_of_day": "evening" },
        "doses": []
      },
      {
        "name": "Fish oil",
        "schedule": { "type": "daily", "time_of_day": ["morning","evening"] },
        "doses": []
      }
    ]
  }
}
```

**Key bits:**
- `checklist-card` accepts the same `data.items[].schedule` shape
  as `schedule-card`, so `time_of_day` works identically on both
  renderers: chip rendered via the shared helper, items filtered
  by the same join.
- `prompt.mode: "checklist"` plays nicely with `schedule_due`:
  the prompt fires the in-app modal when the user opens the
  dashboard with un-logged items, and the push trigger fires when
  the app isn't open. Both stop nagging once today's slot is fully
  logged.
- An item with `time_of_day: ["morning","evening"]` (fish oil
  above) appears under both reminders. Each slot has its own
  scheduled dose; logging the morning one doesn't satisfy the
  evening one.

**Variations:**
- Skip notifications for a stack you'll never forget by dropping
  `meta.notifications` entirely; the chip still renders.
- For a weekly supplement add `on_days: ["Mon"]` to the item's
  schedule; the trigger filter checks weekday too, so the reminder
  stays quiet on the off days.

---

## Recipe 16: restore an exported instance

Not a card this time: bringing a whole instance back from a portable
export (`npm run export`, see [`DEPLOY.md`](DEPLOY.md)). The import CLI
does the work; your job is to read what it tells you.

If the export arrived zipped (a Cloud "export my data" download),
unpack it somewhere outside the new instance's `$HEALTH_HOME`; a tree
written by `npm run export` is already in this shape:

```bash
unzip klebb-export.zip -d /tmp/restore
```

Dry-run first. This is the default: it validates the tree end to end,
checks the target, and prints every finding and the plan without
writing a byte:

```bash
npm run import -- /tmp/restore --target /path/to/new-home
```

Read the findings. Warnings (a hand-edited file, an uninventoried
extra) are informational and don't block; refusals (a missing
`klebb-export.json`, a duplicate card id, a credentials file inside
`data/`) mean the tree is torn or tampered with, and the fix is to
re-export from the source, not to hand-patch the tree. When it prints
`Tree validates`, apply:

```bash
npm run import -- /tmp/restore --apply --target /path/to/new-home
```

A verified import ends like this, with the counts matching the plan the
dry run printed:

```
verified: 12 card(s), 340 HAE push(es), 3 report(s)
status: ok
```

Start the server on the new home and every card comes back with its
history, HAE pushes included. Passkeys don't travel (an export never
contains credentials), so register a fresh one on the new instance.

One rule: **imports only ever write into a fresh instance.** A target
with any card beyond the seeded welcome one, or any HAE history, is
refused with the reasons listed. That is deliberate: there is no merge,
and a restore that could half-overwrite live data would be worse than
one that asks you for an empty home. Full tree contract in
[`EXPORT-FORMAT.md`](EXPORT-FORMAT.md).

### Restoring only part of the archive

Three flags narrow what comes back. Card ids for `--cards`, tree paths
for `--reports` exactly as the plan prints them, and `--no-history` to
leave the Apple Health pushes behind:

```bash
npm run import -- /tmp/restore --target /path/to/new-home \
  --cards weight,sleep --reports reports/bloods.md --no-history
```

The dry run prints what the selection resolved to and then the filtered
plan, with each narrowed line saying what it left behind:

```
selection: 2 card(s), 1 report item(s), history off
plan:
  cards (2 of 12):
    weight  data/weight.json  data: embedded
    sleep   data/sleep.json  data: embedded
  HAE pushes to import: 0 of 340
  reports to copy: 1 of 3
  config: write
```

A family no flag names is restored whole, so `--no-history` on its own
means everything except the push history. To take nothing from a family,
pass it empty: `--reports ''`. A selection naming something the archive
does not hold (a card id that is not in it, a report path outside the
tree) is refused before anything is written, with the offending
reference named; correct it and re-run. Add `--apply` when the filtered
plan reads right.

Ingested reports bring their archived original with them: selecting
`reports/bloods.md` also restores `reports/originals/bloods.pdf` if the
archive has it, so a restored report keeps the document it was read
from.

This is still a replace, not a merge. The target must be fresh, and what
you leave out is simply absent afterwards; there is no second import
that tops it up later.

---

## Recipe 17: move an instance with the Data tab

The same move as Recipe 16 without touching a shell: everything happens
in **Settings > Data** on the two instances.

On instance A (the one you are leaving), open Settings > Data and hit
**Download export**. The browser saves a zip named
`<instance>-export-<stamp>.zip`: every card with its history, HAE
pushes, reports and display config. Keep it somewhere you can reach from
the machine you'll drive instance B with; nothing sensitive is inside
(exports never carry credentials or sessions), but it is your health
data, so treat it accordingly.

On instance B (freshly provisioned, nothing logged yet), open
Settings > Data, choose the zip under **Import**, and watch the upload
bar. The wizard then shows what the archive holds: how many cards (and
how many with data), HAE pushes and reports, plus any warnings the
validator raised. Read that against what you expect from A. A fresh B
applies with a single button.

The preview is also where you choose what comes back. Cards, reports and
the Apple Health history are listed as checkboxes with everything ticked,
so the default is the whole archive; untick anything you would rather not
restore and the line above Apply keeps count ("Restoring 3 of 12 cards").
Ticking a card that Apple Health feeds pins the history on and says why:
such a card holds no rows of its own, so it would arrive empty without
them.

If B already holds data, the wizard stops behind a red panel instead:
an import replaces **everything** on the instance, so it makes you type
REPLACE before Apply arms. The panel spells out what B holds right now
(cards, reports, pushes), because a partial selection does not make the
wipe partial: whatever you leave unticked is deleted along with the rest,
not preserved. There is no merge; if you have data on both sides worth
keeping, export B first.

Apply hands the import to the instance and follows it: the wizard shows
the stage it is on, then reports the counts it verified (cards, HAE
pushes, reports). They should match what the preview said it would
restore. Hit **Reload the app** and B is A, history and all. If the
import fails part-way, the wizard lists the findings and offers
**Roll back** (B goes back to exactly what it held before) or **Start
over**.

Two things do not travel, by design: passkeys (register a fresh one on
B; they are bound to the instance) and chat history. Data freshness
timestamps reset to the import time, so anything cadence-driven starts
its clock at the move.

---

## Next steps

- For the full manifest spec (every field, every input type, every
  template modifier), see [`../MANIFEST-SCHEMA.md`](../MANIFEST-SCHEMA.md).
- For architectural background, see [`CARDS.md`](CARDS.md).
- To hand-off card authoring to your chat agent, see
  [`CHAT-AGENT.md`](CHAT-AGENT.md).

Drop cards into `$HEALTH_HOME/data/`. Klebbius (or any configured agent)
can read the same docs and help you compose new ones.
