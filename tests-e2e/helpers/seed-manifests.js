// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/helpers/seed-manifests.js
// Seed manifest content for the E2E sandbox. Minimal on purpose — just
// enough for the smoke test. Specs that need richer fixtures can seed
// extra cards via API calls in their own setup.
//
// Dates are anchored to "today" (local-date at setup time) so past-date
// navigation tests behave consistently regardless of which day the
// suite runs. `todayISO` + `shiftDays` are also exported for specs.

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDays(isoDate, delta) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function weight(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'weight',
      label: 'Weight',
      emoji: '⚖️',
      order: 200,
      category: 'body',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: { template: '{kg:round(1)}', unit: 'kg' },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        // Weight varies slowly; pre-fill the add form with the most
        // recent prior entry so the operator usually needs just a
        // small tweak. See #217.
        prefillFromLatest: true,
        inputs: [
          { key: 'kg', type: 'number', required: true, min: 20, max: 500, step: 0.1 },
        ],
      },
      chat: {
        starterPrompts: [
          { text: 'What is my weight trend over the last month?', kind: 'data' },
          { text: 'Switch the weight card to kilograms display', kind: 'tweak' },
        ],
      },
    },
    description: 'Body weight log for E2E sandbox.',
    // Rows at today-4 and today-2 intentionally leave a gap at today-3
    // so specs that assert "no entry for this date" have a concrete
    // past date to navigate to where the prefillFromLatest resolver
    // still has a prior row to work with (today-4).
    data: [
      { date: shiftDays(today, -4), kg: 81.3 },
      { date: shiftDays(today, -2), kg: 81.2 },
      { date: shiftDays(today, -1), kg: 81.0 },
      { date: today,                kg: 80.9 },
    ],
  };
}

function mood(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      emoji: '🙂',
      order: 100,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: {
          template: '{mood}',
          emojiMap: { 1: '😩', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' },
        },
      },
      // Daily mood prompt: fires once a day on first load if today has
      // no entry. See #193 Part C.
      prompt: { enabled: true, mode: 'modal', whenMissing: true },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        // Either mood OR note is required (see #193 Part B). Neither
        // input carries required: true; the requireAny list gates the
        // Save button at the form level.
        requireAny: ['mood', 'note'],
        inputs: [
          { key: 'mood', type: 'rating', min: 1, max: 5 },
          { key: 'note', type: 'textarea' },
        ],
      },
    },
    description: 'Subjective daily mood log for E2E sandbox.',
    data: [
      { date: shiftDays(today, -3), mood: 2 },
      { date: shiftDays(today, -2), mood: 3 },
      { date: shiftDays(today, -1), mood: 4 },
      { date: today,                mood: 5 },
    ],
  };
}

function peptides(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'peptides',
      label: 'Schedule',
      emoji: '💉',
      order: 200,
      category: 'supplements',
      view: { enabled: true, component: 'schedule-card', dateContext: 'exact-date' },
    },
    description: 'Peptide schedule for E2E coverage (nested-cycle shape).',
    data: {
      items: [
        {
          id: 'semax',
          name: 'Semax',
          short_name: 'Semax',
          dose_mg: 1,
          dose_units: 'mcg',
          route: 'subQ',
          schedule: {
            type: 'daily_straight',
            days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            duration_days: 20,
          },
          cycle: {
            on_days: 20,
            off_days: 10,
            cycles: [
              {
                cycle_number: 1,
                start_date: shiftDays(today, -2),
                end_date: shiftDays(today, 17),
              },
            ],
          },
        },
      ],
    },
  };
}

// Seed the HAE "discovered metrics" ledger with one unknown metric and
// no supported ones. This reproduces the operator's steady-state on
// klebbtest after every catalogue-supported HAE metric has a subscriber
// — the exact condition that used to suppress the discovery card
// entirely (#192). Specs can use this to assert the footer-only
// rendering path.
function discoveredMetrics() {
  return {
    // Three unsupported metrics. None are in the HAE catalogue, so
    // they surface in the discovery card's footer. Multiple entries
    // make the "Dismiss all" spec (see #218) meaningful.
    e2e_unsupported_metric: {
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      dismissed: false,
    },
    e2e_unsupported_beta: {
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      dismissed: false,
    },
    e2e_unsupported_gamma: {
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      dismissed: false,
    },
  };
}

// Minimal HRV + Resting HR atomic pair for the recovery-overview
// combination card to compose. Plain numeric rows anchored to today.
function hrv(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'hrv',
      label: 'HRV',
      emoji: '💓',
      order: 540,
      category: 'recovery',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: { template: '{ms:round(0)} ms' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'HRV atomic card for E2E recovery-overview fixture.',
    data: [
      { date: shiftDays(today, -2), ms: 48 },
      { date: shiftDays(today, -1), ms: 52 },
      { date: today,                ms: 55 },
    ],
  };
}

function restingHr(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'resting-heart-rate',
      label: 'Resting HR',
      emoji: '❤️',
      order: 545,
      category: 'recovery',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: { template: '{bpm} bpm' },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Resting HR atomic card for E2E recovery-overview fixture.',
    data: [
      { date: shiftDays(today, -2), bpm: 68 },
      { date: shiftDays(today, -1), bpm: 66 },
      { date: today,                bpm: 65 },
    ],
  };
}

function recoveryOverview(layout) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'recovery-overview',
      label: 'Recovery Overview',
      emoji: '🔋',
      order: 530,
      category: 'recovery',
      view: {
        enabled: true,
        component: 'combination-card',
        layout,
        combines: [
          { sourceId: 'hrv',                role: 'primary',   label: 'HRV',        unit: 'ms' },
          { sourceId: 'resting-heart-rate', role: 'secondary', label: 'Resting HR', unit: 'bpm' },
        ],
      },
    },
    description: 'Recovery Overview combination card for E2E layout-switch coverage.',
    data: [],
  };
}

function water(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'water-intake',
      label: 'Water',
      emoji: '💧',
      order: 250,
      category: 'lifestyle',
      view: {
        enabled: true,
        component: 'generic-card',
        dateContext: 'latest',
        display: { template: '{glasses} glasses' },
      },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        inputs: [
          {
            key: 'glasses',
            type: 'stepper',
            min: 0,
            max: 20,
            step: 1,
            default: 0,
            label: 'Glasses of water today',
            required: true,
          },
        ],
      },
    },
    description: 'Daily water intake in glasses. Stepper input — tap +/- to count up.',
    // No historic data so specs that exercise the add flow start clean.
    data: [],
  };
}

function workouts(today) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'workouts',
      label: 'Workouts',
      emoji: '🏋️',
      order: 420,
      category: 'activity',
      ingest: { source: 'hae', metric: 'workouts' },
      view: {
        enabled: true,
        component: 'generic-card',
        // No dateContext:latest — we want the card to honour viewed
        // date so non-workout days show the empty state, not the last
        // trained day's leftovers. See #215.
        display: {
          template: '{trained:check} {type}',
          emptyHeadline: 'No workout today',
        },
      },
      writeable: { fromWebapp: false },
    },
    description: 'Workout data ingested from Health Auto Export. One row per date. Fields: date, trained (boolean), type (workout type string).',
    data: [
      { date: today, trained: true, type: 'Functional Strength Training' },
    ],
  };
}

function seedManifests() {
  const today = todayISO();
  return {
    'weight.json': weight(today),
    'mood.json': mood(today),
    'peptides.json': peptides(today),
    'hrv.json': hrv(today),
    'resting-heart-rate.json': restingHr(today),
    'recovery-overview.json': recoveryOverview('stack'),
    'water-intake.json': water(today),
    'workouts.json': workouts(today),
    'auto-export/discovered.json': discoveredMetrics(),
  };
}

module.exports = { seedManifests, todayISO, shiftDays, recoveryOverview };
