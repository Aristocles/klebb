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
      "dateContext": "viewedDate",
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

## Next steps

- For the full manifest spec (every field, every input type, every
  template modifier), see [`../MANIFEST-SCHEMA.md`](../MANIFEST-SCHEMA.md).
- For architectural background, see [`CARDS.md`](CARDS.md).
- To hand-off card authoring to your chat agent, see
  [`CHAT-AGENT.md`](CHAT-AGENT.md).

Drop cards into `$HEALTH_HOME/data/`. Klebbius (or any configured agent)
can read the same docs and help you compose new ones.
