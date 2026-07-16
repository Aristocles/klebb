// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/scenarios/happy.js — simulated user journeys that must work.

const SEED_WEIGHT = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-weight', label: 'Weight', emoji: '⚖️', category: 'body',
    view: { component: 'generic-card', unit: 'kg' },
    writeable: { fromWebapp: true },
  },
  data: [{ date: '2026-07-01', value: 82.4 }, { date: '2026-07-05', value: 81.9 }],
};

module.exports = [
  {
    name: 'create-simple-card',
    // Post-deploy smoke subset (#503): one create, one chip chain, one log,
    // two adversarial. Exercises every seam that a deploy or model swap can
    // break: tool loop, chip round-trip, data write, refusal properties.
    smoke: true,
    turns: [
      {
        say: 'Create a card to track my daily water intake in litres. Call it Water.',
        expect: {
          http: { status: 200 },
          tools: { required: ['create_manifest'], forbidden: ['delete_manifest'], noErrors: true },
          state: { noDeletes: true },
          registryClean: true,
          chips: { present: true, maxCount: 4 },
        },
      },
    ],
  },
  {
    name: 'chip-click-chain',
    smoke: true,
    turns: [
      {
        say: 'Make me a card for tracking my morning resting heart rate in bpm, call it Resting HR.',
        expect: {
          tools: { required: ['create_manifest'], noErrors: true },
          registryClean: true,
          chips: { present: true },
        },
      },
      {
        chip: 0,
        expect: {
          http: { status: 200 },
          tools: { forbidden: ['delete_manifest', 'create_manifest'] },
          state: { noCreates: true, noDeletes: true },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'log-data-into-seeded-card',
    smoke: true,
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Log my weight today: 81.5 kg.',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'viewed-card-vague-edit',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Change the unit to pounds.',
        viewedCardId: 'eval-weight',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'add-trend-to-card',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Add a downward-is-good trend arrow to my Weight card.',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'question-no-mutation',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'What was my weight trend over the last week?',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest', 'patch_manifest', 'write_manifest_data', 'append_row', 'update_row', 'remove_row'] },
          state: { noChanges: true },
          reply: { match: ['8[12]'] },
        },
      },
    ],
  },
  {
    name: 'multi-turn-create-then-refine',
    turns: [
      {
        say: 'Create a card for tracking hours slept each night. Call it Sleep Hours.',
        expect: {
          tools: { required: ['create_manifest'], noErrors: true },
          registryClean: true,
        },
      },
      {
        say: 'Actually, also give it a target of 8 hours a night.',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { noCreates: true, noDeletes: true },
          registryClean: true,
        },
      },
    ],
  },
];
