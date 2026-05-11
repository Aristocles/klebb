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
        inputs: [
          { key: 'kg', type: 'number', required: true, min: 20, max: 500, step: 0.1 },
        ],
      },
    },
    description: 'Body weight log for E2E sandbox.',
    data: [
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
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        inputs: [
          { key: 'mood', type: 'rating', min: 1, max: 5, required: true },
          { key: 'note', type: 'textarea', required: false },
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
    // Not in the HAE catalogue → classified as "unsupported", surfaces
    // in the discovery card's footer rather than the main list.
    e2e_unsupported_metric: {
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      dismissed: false,
    },
  };
}

function seedManifests() {
  const today = todayISO();
  return {
    'weight.json': weight(today),
    'mood.json': mood(today),
    'peptides.json': peptides(today),
    'auto-export/discovered.json': discoveredMetrics(),
  };
}

module.exports = { seedManifests, todayISO, shiftDays };
