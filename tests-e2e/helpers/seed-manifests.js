// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/helpers/seed-manifests.js
// Seed manifest content for the E2E sandbox. Minimal on purpose — just
// enough for the smoke test. Specs that need richer fixtures can seed
// extra cards via API calls in their own setup.

function weight() {
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
      { date: '2026-05-08', kg: 81.2 },
      { date: '2026-05-09', kg: 81.0 },
      { date: '2026-05-10', kg: 80.9 },
    ],
  };
}

function mood() {
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
      { date: '2026-05-08', mood: 3 },
      { date: '2026-05-09', mood: 4 },
      { date: '2026-05-10', mood: 5 },
    ],
  };
}

function seedManifests() {
  return {
    'weight.json': weight(),
    'mood.json': mood(),
  };
}

module.exports = { seedManifests };
