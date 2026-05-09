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
//     from?:      'metrics' | 'workouts'          // default 'metrics'
//     aggregate:  'last-per-date' | 'sum-per-date' | 'mean-per-date'
//               | 'max-per-date'  | 'boolean-any-per-date'
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

const { toDate, numeric } = require('./helpers');

module.exports = {
  // --- Sleep / recovery ---------------------------------------------------

  sleep_analysis: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date || entry.sleepStart);
      const hours = numeric(entry.totalSleep ?? entry.asleep ?? entry.inBed ?? entry.qty);
      if (!date || hours === null) return null;
      const row = { date, hours };
      // Stage breakdown: preserve whichever fields HAE provides. Absent
      // fields are omitted entirely rather than set to 0/null so display
      // templates can distinguish "no REM data for this night" from
      // "0 REM hours". Values are hours.
      const stages = ['asleep', 'inBed', 'deep', 'rem', 'core', 'awake'];
      for (const key of stages) {
        const v = numeric(entry[key]);
        if (v !== null) row[key] = v;
      }
      if (entry.source) row.source = entry.source;
      return row;
    },
  },

  heart_rate_variability: {
    aggregate: 'mean-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const ms = numeric(entry.qty);
      if (!date || ms === null) return null;
      return { date, ms };
    },
  },

  resting_heart_rate: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const bpm = numeric(entry.qty);
      if (!date || bpm === null) return null;
      return { date, bpm };
    },
  },

  walking_heart_rate_average: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const bpm = numeric(entry.qty);
      if (!date || bpm === null) return null;
      return { date, bpm };
    },
  },

  blood_oxygen_saturation: {
    aggregate: 'mean-per-date',
    row(entry) {
      const date = toDate(entry.date);
      // HAE sends SpO2 as a fraction (0.97) or percent (97) depending on
      // version. Normalise to percent.
      let pct = numeric(entry.qty);
      if (pct === null || !date) return null;
      if (pct <= 1) pct = pct * 100;
      return { date, pct };
    },
  },

  // --- Activity / movement ------------------------------------------------

  step_count: {
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const count = numeric(entry.qty);
      if (!date || count === null) return null;
      return { date, count };
    },
  },

  apple_exercise_time: {
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const minutes = numeric(entry.qty);
      if (!date || minutes === null) return null;
      return { date, minutes };
    },
  },

  // --- Mindfulness --------------------------------------------------------

  mindful_minutes: {
    aggregate: 'sum-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const minutes = numeric(entry.qty);
      if (!date || minutes === null) return null;
      return { date, minutes };
    },
  },

  // --- Body composition ---------------------------------------------------

  body_mass: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const kg = numeric(entry.qty);
      if (!date || kg === null) return null;
      return { date, kg };
    },
  },

  body_fat_percentage: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      // HAE sends body fat as a fraction (0.18) in some versions, percent
      // (18) in others. Normalise to percent.
      let pct = numeric(entry.qty);
      if (pct === null || !date) return null;
      if (pct <= 1) pct = pct * 100;
      return { date, pct };
    },
  },

  // --- Blood pressure (two separate entries; compose via a CC if wanted) --

  blood_pressure_systolic: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const systolic = numeric(entry.qty);
      if (!date || systolic === null) return null;
      return { date, systolic };
    },
  },

  blood_pressure_diastolic: {
    aggregate: 'last-per-date',
    row(entry) {
      const date = toDate(entry.date);
      const diastolic = numeric(entry.qty);
      if (!date || diastolic === null) return null;
      return { date, diastolic };
    },
  },

  // --- Workouts (from data.workouts[], not data.metrics[]) ----------------

  workouts: {
    from: 'workouts',
    aggregate: 'boolean-any-per-date',
    row(entry) {
      const date = toDate(entry.start || entry.date);
      if (!date) return null;
      const row = { date, trained: true };
      if (entry.name) row.type = entry.name;
      return row;
    },
  },
};
