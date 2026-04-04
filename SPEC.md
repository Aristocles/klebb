# Ed's Health Dashboard — Build Spec

## Overview
Build a health dashboard webapp served on port 10002. Dark theme, responsive, built with Lit (web components) + Tailwind CSS. No build step — use CDN imports.

## Tech Stack
- **Server:** Node.js HTTP server (no Express needed, keep it simple)
- **Frontend:** Lit web components + Tailwind CSS via CDN
- **Charts:** Chart.js (CDN) for trends
- **No build step.** ES modules loaded directly in browser.

## Server
Single Node.js file (`server.js`) that:
1. Serves static files from `public/`
2. Provides API endpoints to read health data from the data directory
3. Listens on port 10002, binds to 0.0.0.0

### API Endpoints
All read from DATA_DIR = `$HOME/axis/workspace/.private/health/data`

- `GET /api/config` — returns `data/config.json`
- `GET /api/supplements` — returns `data/supplements.json`
- `GET /api/weight` — returns `data/weight.json`
- `GET /api/bloods` — returns `data/bloods.json`
- `GET /api/appointments` — returns `data/appointments.json`
- `GET /api/goals` — returns `data/goals.json`
- `GET /api/info/:date` — returns `data/info/YYYY-MM-DD.json` (404 if not found)
- `GET /api/info` — lists all dates that have info files
- `GET /api/sleep/:date` — returns `data/auto-export/sleep/YYYY-MM-DD.json`
- `GET /api/workouts/:date` — returns `data/auto-export/workouts/YYYY-MM-DD.json`
- `GET /api/vitals/:date` — returns `data/auto-export/vitals/YYYY-MM-DD.json`
- `GET /api/activity/:date` — returns `data/auto-export/activity/YYYY-MM-DD.json`
- `GET /api/sleep/range/:start/:end` — returns sleep data for date range
- `GET /api/workouts/range/:start/:end` — returns workout data for date range
- `GET /api/vitals/range/:start/:end` — returns vitals data for date range
- `GET /api/activity/range/:start/:end` — returns activity data for date range
- `GET /api/weight/range/:start/:end` — returns weight entries within range

Range endpoints return `{ "YYYY-MM-DD": <file contents>, ... }` for each date that has data.

### Existing Report
The existing health debrief report at `/report/debrief-2026-03-12` should still be accessible. Serve `data/../DEBRIEF-2026-03-12.md` rendered as HTML at that URL, or the info link system can reference it.

## Frontend Structure

```
public/
├── index.html          # Shell with nav and router
├── css/
│   └── app.css         # Custom styles (Tailwind via CDN handles most)
├── js/
│   ├── app.js          # Main app, router
│   ├── api.js          # API client helper
│   └── components/
│       ├── today-view.js       # Today dashboard
│       ├── calendar-view.js    # Month calendar
│       ├── trends-view.js      # Charts/trends
│       ├── day-detail.js       # Day detail panel/overlay
│       ├── sleep-card.js       # Sleep summary card
│       ├── activity-card.js    # Steps/distance/energy card
│       ├── workout-card.js     # Workout display with intensity
│       ├── weight-card.js      # Weight + sparkline
│       ├── supplements-card.js # Today's supplement schedule
│       ├── goals-card.js       # Goal progress bars
│       ├── weekly-rings.js     # Dual progress rings (cardio/strength)
│       ├── calendar-cell.js    # Single day cell in calendar
│       ├── info-panel.js       # Info link detail overlay
│       └── widget-view.js      # Compact widget for /widget
```

## Design

### Theme
- Background: `#0f0f1a` (very dark blue-black)
- Card background: `#1a1a2e` 
- Card border: `#2a2a4a`
- Text primary: `#e0e0e0`
- Text secondary: `#8888aa`
- Accent teal: `#00d4aa`
- Accent amber: `#ffaa00`
- Accent red: `#ff4444`
- Accent green: `#44ff88`
- Sleep good bg: rgba(68, 255, 136, 0.1)
- Sleep okay bg: rgba(255, 170, 0, 0.1)
- Sleep poor bg: rgba(255, 68, 68, 0.1)

### Cards
Rounded corners (12px), subtle border, slight box-shadow. Padding 16-20px.

### Typography
System font stack: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif

## Views

### 1. Today View (default at `/`)
Grid of cards. On mobile: single column. On desktop: 2-3 column grid.

Cards (in order):
1. **Sleep Card** — Last night's total, stage breakdown as horizontal stacked bar (core=light blue, REM=purple, deep=dark blue, awake=red). Bed→wake times. Click for full detail.
2. **Weekly Rings** — Dual concentric rings. Outer=cardio (teal), inner=strength (orange). Shows "X/Y" inside each. Gold glow (#ffd700 shadow) when target exceeded, shows 🏆. Streak counter below: "🔥3 day streak"
3. **Activity Card** — Today's steps, distance (km), active calories. From auto-export activity data.
4. **Workout Card** — Latest workout today (if any). Shows name, duration, HR, intensity icon (🧊/🔥/🌋). If multiple workouts, show combined intensity.
5. **Weight Card** — Current weight + mini sparkline of last 30 days. Shows change from previous entry.
6. **Supplements Card** — List of supplements due today based on schedule. Mounjaro shows on Mondays with 💉. Exclude "as needed" items from the daily list. Show each with its emoji/icon.
7. **Goals Card** — Progress bars for active goals (weight, protein, water targets).
8. **Upcoming Card** — Next appointment, next blood test follow-up, any pending reminders.

### 2. Calendar View (`/calendar`)
Month grid showing Mon-Sun. Navigation arrows + "Today" button + month/year display.

Each day cell:
- **Background colour** based on sleep quality:
  - Green tint if totalSleep >= config.sleep.quality_thresholds.good (7.5h)
  - Amber tint if >= okay (6h)  
  - Red tint if < okay
  - No tint if no sleep data
- **Date number** in top-left
- **Icons row:**
  - 😴 if sleep data exists
  - Workout intensity icon (🧊/🔥/🌋) — calculate from ALL workouts that day, additive
  - ℹ️ if info file exists for that date
  - 💉 on Mondays (Mounjaro day)
- **Mini weekly ring** on Monday cells showing cardio/strength progress for that week
- Click any day → opens day-detail overlay/panel

### 3. Day Detail (`/day/:date` or overlay)
Shows everything for a specific date:
- Full sleep breakdown (if data)
- All workouts with details
- Activity summary (steps, distance, energy)
- Vitals (HR, HRV, respiratory rate)
- Supplements scheduled
- Info items (reports, blood results, etc.)
- Weight if logged
- Notes/symptoms if any

### 4. Trends View (`/trends`)
Chart.js line/bar charts. Each chart has timeframe selector: 30d / 90d / 1y / All.
- Weight trend (line)
- Sleep duration (stacked area: core + REM + deep)
- Resting heart rate (line)
- HRV (line)
- Steps per day (bar with 7-day moving average line)
- Exercise frequency (workouts per week, bar)

### 5. Widget View (`/widget`)
Compact, no navigation chrome. Just essential cards:
- Sleep score (background colour)
- Steps today
- Weekly rings (mini)
- Next appointment
Query param support: `/widget?show=sleep,steps,rings`

## Workout Intensity Calculation

```javascript
function calculateDayIntensity(workouts, config) {
  // Sum all workout durations and energy
  let totalMinutes = workouts.reduce((s, w) => s + (w.durationMin || 0), 0);
  let maxHR = Math.max(...workouts.map(w => w.avgHeartRate || 0));
  
  // Additive: light + moderate = at least moderate
  if (totalMinutes >= config.workout_intensity.beast_above_minutes || maxHR > 140) return '🌋';
  if (totalMinutes >= config.workout_intensity.moderate_max_minutes || maxHR > 110) return '🔥';  
  if (totalMinutes > 0) return '🧊';
  return null;
}
```

## Workout Category Classification

```javascript
function classifyWorkout(workoutName, config) {
  if (config.workout_categories.cardio.includes(workoutName)) return 'cardio';
  if (config.workout_categories.strength.includes(workoutName)) return 'strength';
  return 'other'; // count toward both rings? or just strength
}
```

## Weekly Ring Calculation

Week runs Monday to Sunday (matching Mounjaro day).

```javascript
function getWeekProgress(weekWorkouts, config) {
  let cardio = 0, strength = 0;
  for (const day of weekWorkouts) {
    for (const w of day.workouts) {
      const cat = classifyWorkout(w.name, config);
      if (cat === 'cardio') cardio++;
      else strength++;
    }
  }
  return {
    cardio: { done: cardio, target: config.goals.cardio_per_week },
    strength: { done: strength, target: config.goals.strength_per_week },
  };
}
```

## Supplement Schedule Logic

From `supplements.json`, determine what's due on a given date:
- `frequency: "daily"` → every day
- `frequency: "weekly"` + check if it's the right day
- `frequency: "every X days"` → calculate from startDate
- `frequency: "as needed"` → do NOT show in daily schedule

Mounjaro: show 💉 on Mondays (config.mounjaro.day).

## Streak Calculation

Count consecutive days (backwards from today) where at least one workout occurred.

## Data Directory

All data read from: `/home/minecraft/axis/workspace/.private/health/data/`

Structure:
```
data/
├── config.json
├── supplements.json
├── weight.json
├── bloods.json
├── appointments.json
├── goals.json
├── info/
│   └── YYYY-MM-DD.json
└── auto-export/
    ├── sleep/YYYY-MM-DD.json
    ├── workouts/YYYY-MM-DD.json
    ├── vitals/YYYY-MM-DD.json
    └── activity/YYYY-MM-DD.json
```

## Systemd Service

Will replace existing ed-health-report.service (or create new) to serve on port 10002.

## Important Notes
- All times are in Australia/Sydney timezone (AEDT/AEST)
- No authentication needed (LAN only)
- No database — just JSON files on disk
- Keep it simple and fast. No unnecessary abstractions.
- Test that it actually works by loading it in a browser at http://localhost:10002
