// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/catalogue.js
//
// The server-owned catalogue of supported iPhone Health Auto Export metrics.
// Each entry is a pure recipe: how to turn one HAE payload entry into one
// normalised row, and how rows for the same date should be combined when
// several samples arrive.
//
// Shape:
//   <metricKey>: {
//     category:   'sleep' | 'recovery' | 'activity' | 'vitals' | 'body' | 'mindfulness'
//     from?:      'metrics' | 'workouts'          // default 'metrics'
//     aggregate:  'last-per-date' | 'sum-per-date' | 'mean-per-date'
//               | 'max-per-date'  | 'boolean-any-per-date'
//               | 'workouts-merge-per-date'
//     row(entry): object | null   // null = drop this entry
//   }
//
// `metricKey` matches the value users put in `meta.ingest.metric` inside
// their manifest. For metrics sourced from `data.metrics[]`, it also
// matches the HAE `name` field. For workouts (sourced from `data.workouts`),
// the key is the pseudo-name `"workouts"`.
//
// Rules:
//   - row() is pure: no side effects, no I/O.
//   - row() returns null to drop malformed entries (missing date, NaN qty).
//   - Every successful row MUST include `date` as 'YYYY-MM-DD'.
//   - Aggregation is applied by the dispatcher after mapping. Catalogue
//     entries do not pre-aggregate.

const {
  toDate, numeric, round,
  readQty, toKcal, toKm, toM, toKg, passQty,
  extractHHMM,
} = require('./helpers');

module.exports = {
  // --- Sleep / recovery ---------------------------------------------------

  sleep_analysis: {
    category: 'sleep',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date || entry.sleepStart);
      const hours = numeric(entry.totalSleep ?? entry.asleep ?? entry.inBed ?? entry.qty);
      if (!date || hours === null) return null;
      const row = { date, hours: round(hours, 3) };
      // Stage breakdown: preserve whichever fields HAE provides. Absent
      // fields are omitted entirely rather than set to 0/null so display
      // templates can distinguish "no REM data for this night" from
      // "0 REM hours". Values are hours.
      const stages = ['asleep', 'inBed', 'deep', 'rem', 'core', 'awake'];
      for (const key of stages) {
        const v = numeric(entry[key]);
        if (v !== null) row[key] = round(v, 3);
      }
      // Bedtime and wake as local wall-clock HH:MM. Every timestamp HAE sends
      // for a night was previously thrown away: toDate() keeps only the leading
      // calendar date, so "asleep at 23:40, awake at 06:12" survived as a date
      // and a duration. Same treatment workouts already give `start`.
      const bedTime = extractHHMM(entry.sleepStart || entry.inBedStart);
      const wakeTime = extractHHMM(entry.sleepEnd || entry.inBedEnd);
      if (bedTime) row.bedTime = bedTime;
      if (wakeTime) row.wakeTime = wakeTime;
      if (entry.source) row.source = entry.source;
      return row;
    },
  },

  heart_rate_variability: {
    category: 'recovery',
    aggregate: 'mean-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const ms = numeric(entry.qty);
      if (!date || ms === null) return null;
      return { date, ms: round(ms, 1) };
    },
  },

  resting_heart_rate: {
    category: 'recovery',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const bpm = numeric(entry.qty);
      if (!date || bpm === null) return null;
      return { date, bpm: round(bpm, 0) };
    },
  },

  walking_heart_rate_average: {
    category: 'activity',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const bpm = numeric(entry.qty);
      if (!date || bpm === null) return null;
      return { date, bpm: round(bpm, 1) };
    },
  },

  blood_oxygen_saturation: {
    category: 'vitals',
    aggregate: 'mean-per-date',
    row(entry) {
      const date = toDate(entry.date);
      // HAE sends SpO2 as a fraction (0.97) or percent (97) depending on
      // version. Normalise to percent.
      let pct = numeric(entry.qty);
      if (pct === null || !date) return null;
      if (pct <= 1) pct = pct * 100;
      return { date, pct: round(pct, 1) };
    },
  },

  // --- Activity / movement ------------------------------------------------

  step_count: {
    category: 'activity',
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const count = numeric(entry.qty);
      if (!date || count === null) return null;
      return { date, count };
    },
  },

  apple_exercise_time: {
    category: 'activity',
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const minutes = numeric(entry.qty);
      if (!date || minutes === null) return null;
      // Deliberately NOT rounded here. sum-per-date rounds the total (see
      // aggregate() in ingest.js), so rounding each sample first quantises every
      // one toward zero before they are added. Apple Health emits sub-minute
      // granules, so a real day of 47 samples at 0.4 min stored as 0 instead of
      // 19, and 47 at 0.75 stored as 47 instead of 35. step_count already relies
      // on the aggregate for its integerisation, which is why it never had this.
      return { date, minutes };
    },
  },

  // --- Mindfulness --------------------------------------------------------

  mindful_minutes: {
    category: 'mindfulness',
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const minutes = numeric(entry.qty);
      if (!date || minutes === null) return null;
      // Unrounded for the same reason as apple_exercise_time: the sum is what
      // gets rounded, and short sessions are exactly where pre-rounding loses
      // the most. A few 40-second breathing sessions summed to zero.
      return { date, minutes };
    },
  },

  // --- Body composition ---------------------------------------------------

  body_mass: {
    category: 'body',
    aggregate: 'last-per-date',
    // The one catalogue entry that reads the metric wrapper. Weight is the only
    // dimensioned metric here with no usable magnitude heuristic: 176 lb and
    // 176 kg are both plausible human weights, so a US user's 176.4 lb was
    // stored as `kg: 176.4` and the card read 176 kg. Normalise instead of
    // renaming the field, because `kg` is referenced by the shipped template,
    // display templates, trends.field, describe.js and every live card.
    row(entry, wrapper = {}) {
      const date = toDate(entry.date);
      const raw = numeric(entry.qty);
      if (!date || raw === null) return null;
      return { date, kg: round(toKg(raw, wrapper.units || null), 1) };
    },
  },

  body_fat_percentage: {
    category: 'body',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      // HAE sends body fat as a fraction (0.18) in some versions, percent
      // (18) in others. Normalise to percent.
      let pct = numeric(entry.qty);
      if (pct === null || !date) return null;
      if (pct <= 1) pct = pct * 100;
      return { date, pct: round(pct, 1) };
    },
  },

  // --- Blood pressure (two separate entries; compose via a CC if wanted) --

  blood_pressure_systolic: {
    category: 'vitals',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const systolic = numeric(entry.qty);
      if (!date || systolic === null) return null;
      return { date, systolic: round(systolic, 0) };
    },
  },

  blood_pressure_diastolic: {
    category: 'vitals',
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const diastolic = numeric(entry.qty);
      if (!date || diastolic === null) return null;
      return { date, diastolic: round(diastolic, 0) };
    },
  },

  // --- Workouts (from data.workouts[], not data.metrics[]) ----------------

  workouts: {
    category: 'activity',
    from: 'workouts',
    aggregate: 'workouts-merge-per-date',
    row(entry) {
      const date = toDate(entry.start || entry.date);
      if (!date) return null;
      const row = { date, trained: true };
      if (entry.name) row.type = entry.name;

      // Duration: HAE always emits this as bare seconds (per the v2 wiki
      // schema). Convert to whole minutes; drop if missing or non-finite.
      const durationSec = numeric(entry.duration);
      if (durationSec !== null && durationSec > 0) {
        row.durationMin = round(durationSec / 60, 0);
      }

      // Distance: `{qty, units: "mi"|"km"}`. Only emit when truthy — a
      // strength session reports distance:null and we don't want a 0 km
      // chip on the card.
      const distanceKm = readQty(entry.distance, toKm);
      if (distanceKm !== null && distanceKm > 0) {
        row.distanceKm = round(distanceKm, 2);
      }

      // Calories: prefer activeEnergyBurned (excludes BMR). Units may be
      // "kcal" or "kJ" depending on the iPhone's unit preference.
      const kcal = readQty(entry.activeEnergyBurned, toKcal);
      if (kcal !== null && kcal > 0) {
        row.calories = round(kcal, 0);
      }

      // Heart rate: prefer the flat avgHeartRate/maxHeartRate fields, fall
      // back to the nested heartRate.{avg,max} shape some payloads use.
      const avgHr = readQty(entry.avgHeartRate, passQty)
        ?? readQty(entry.heartRate?.avg, passQty);
      if (avgHr !== null && avgHr > 0) {
        row.avgHr = round(avgHr, 0);
      }
      const maxHr = readQty(entry.maxHeartRate, passQty)
        ?? readQty(entry.heartRate?.max, passQty);
      if (maxHr !== null && maxHr > 0) {
        row.maxHr = round(maxHr, 0);
      }

      // Elevation: v2 uses `elevationUp` (m or ft); v1 used a wrapped
      // `elevation.ascent`. Only `up` is interesting for a daily summary.
      const elevationM = readQty(entry.elevationUp, toM)
        ?? readQty(entry.elevation?.ascent !== undefined
          ? { qty: entry.elevation.ascent, units: entry.elevation.units }
          : null, toM);
      if (elevationM !== null && elevationM > 0) {
        row.elevationM = round(elevationM, 0);
      }

      const startTime = extractHHMM(entry.start);
      if (startTime) row.startTime = startTime;

      return row;
    },
  },
};
