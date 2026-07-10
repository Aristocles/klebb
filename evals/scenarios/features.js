// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/scenarios/features.js — feature-surface journeys (#501): trends,
// reports/adherence, combination cards, notifications, schedules, multi-card
// reads, confirmed deletion and targeted row edits.
//
// These lean on the cardShape assertion (see evals/lib/assert.js): they check
// not just THAT a card changed but the SHAPE it ended up in, using the same
// path grammar the chat tools use. Everything the model writes lands in the
// datastore, so the runner's snapshot fetches each card's data block; a
// data-only edit is visible to the differ and to cardShape.

// Keyed 'kg' with an input declaring it, matching how the shipped weight
// template is authored. A bare 'value' key with no declared input leaves the
// model to guess the row key (it picks 'kg' from the unit), which is a real
// authoring ambiguity but not what these scenarios are testing.
const SEED_WEIGHT = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-weight', label: 'Weight', emoji: '⚖️', category: 'body',
    view: { component: 'generic-card', display: { template: '{kg}', unit: 'kg' } },
    writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true, inputs: [{ key: 'kg', type: 'number', min: 20, max: 500, step: 0.1 }] },
  },
  data: [{ date: '2026-07-01', kg: 82.4 }, { date: '2026-07-05', kg: 81.9 }],
};

const SEED_WATER = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-water', label: 'Water intake', emoji: '💧', category: 'body',
    view: { component: 'generic-card', unit: 'ml', display: { template: '{ml}', unit: 'ml' } },
    writeable: { fromWebapp: true, inputs: [{ key: 'ml', type: 'number', min: 0, max: 10000 }] },
  },
  data: [{ date: '2026-07-08', ml: 1750 }, { date: '2026-07-09', ml: 2000 }],
};

const SEED_SLEEP = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-sleep', label: 'Sleep Hours', emoji: '😴', category: 'recovery',
    view: { component: 'generic-card', unit: 'h', display: { template: '{hours}', unit: 'h' } },
    writeable: { fromWebapp: true, inputs: [{ key: 'hours', type: 'number', min: 0, max: 24, step: 0.1 }] },
  },
  data: [{ date: '2026-07-08', hours: 7.5 }, { date: '2026-07-09', hours: 8.1 }],
};

const SEED_RHR = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-rhr', label: 'Resting HR', emoji: '❤️', category: 'recovery',
    view: { component: 'generic-card', unit: 'bpm', display: { template: '{bpm}', unit: 'bpm' } },
    writeable: { fromWebapp: true, inputs: [{ key: 'bpm', type: 'number', min: 20, max: 200 }] },
  },
  data: [{ date: '2026-07-08', bpm: 54 }, { date: '2026-07-09', bpm: 52 }],
};

// A checklist card with one scheduled item, so an adherence report has
// something to summarise.
const SEED_CHECKLIST = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'eval-supps', label: 'Supplements', emoji: '💊', category: 'medication',
    view: { component: 'checklist-card' },
    writeable: { fromWebapp: true, pastAllowed: true, todayAllowed: true },
  },
  data: { items: [{ name: 'Vitamin D3', schedule: { type: 'daily' } }] },
};

const WRITE_TOOLS = ['create_manifest', 'delete_manifest', 'patch_manifest', 'write_manifest_data', 'append_row', 'update_row', 'remove_row', 'hide_card', 'show_card'];

module.exports = [
  {
    name: 'include-card-in-trends',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Include my Weight card in the Trends view as a line chart.',
        viewedCardId: 'eval-weight',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          cardShape: {
            'eval-weight': {
              'meta.trends.enabled': { equals: true },
              'meta.trends.component': { oneOf: ['line-chart'] },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'trend-question-is-read-only',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Is my weight trending up or down over the last week?',
        expect: {
          tools: { forbidden: WRITE_TOOLS },
          state: { noChanges: true },
        },
      },
    ],
  },
  {
    name: 'enable-adherence-report',
    seeds: [SEED_CHECKLIST],
    turns: [
      {
        say: 'Add an adherence report to my Supplements card so I can see how well I am keeping up.',
        viewedCardId: 'eval-supps',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-supps'] },
          cardShape: {
            'eval-supps': {
              'meta.reports.enabled': { equals: true },
              'meta.reports.component': { oneOf: ['adherence-report'] },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'create-combination-card',
    seeds: [SEED_SLEEP, SEED_RHR],
    turns: [
      {
        say: 'Make a single combined card that shows my Sleep Hours and Resting HR together.',
        expect: {
          tools: { required: ['create_manifest'], forbidden: ['delete_manifest'], noErrors: true },
          state: { noDeletes: true },
          // The CC id is model-chosen; $created resolves to the one card
          // created this turn. combines[] with sourceId is the schema the
          // describe-cc-schema block exists to enforce (models used to
          // hallucinate view.slots[]/view.sources[]).
          cardShape: {
            $created: {
              'meta.view.component': { equals: 'combination-card' },
              'meta.view.combines': { type: 'array', minLength: 2 },
              'meta.view.combines[index=0].sourceId': { exists: true },
              'meta.view.combines[index=1].sourceId': { exists: true },
            },
          },
          chips: { present: true },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'set-then-remove-notification',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Remind me to log my weight every morning at 8am.',
        viewedCardId: 'eval-weight',
        expect: {
          tools: { required: ['set_notification'], forbidden: ['delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          cardShape: {
            'eval-weight': {
              'meta.notifications.items': { type: 'array', minLength: 1 },
              'meta.notifications.items[index=0].trigger.type': { oneOf: ['daily'] },
            },
          },
          registryClean: true,
        },
      },
      {
        // Pre-confirm in the utterance so the confirm-once gate on
        // remove_notification doesn't turn this into a clarifying question.
        say: 'Actually, remove that weight reminder. Yes, I am sure, go ahead.',
        expect: {
          tools: { required: ['remove_notification'], forbidden: ['delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          cardShape: {
            'eval-weight': {
              'meta.notifications.items': { length: 0 },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'create-weekly-schedule-card',
    turns: [
      {
        say: 'Create a medication schedule card called Metformin that I take every Monday, Wednesday and Friday.',
        expect: {
          tools: { required: ['create_manifest'], forbidden: ['delete_manifest'], noErrors: true },
          state: { noDeletes: true },
          // Canonical schedule vocabulary: type must be one of the real enum
          // and days go in on_days[]. The schedule lives on data.items[], not
          // meta.schedule (the create_manifest tool description warns models
          // off the latter); asserting the item path pins that.
          cardShape: {
            $created: {
              'meta.view.component': { oneOf: ['schedule-card', 'checklist-card'] },
              'data.items': { type: 'array', minLength: 1 },
              'data.items[index=0].schedule.type': { oneOf: ['weekly', 'on_off'] },
              'data.items[index=0].schedule.on_days': { type: 'array', minLength: 1 },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'multi-card-read-then-update-one',
    seeds: [SEED_WEIGHT, SEED_WATER],
    turns: [
      {
        say: 'Have a look at my water intake this week, then log my weight today as 80 kg.',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          // The read touches water; only weight may change.
          state: { modifiedOnly: ['eval-weight'] },
          cardShape: {
            'eval-weight': {
              'data[date="2026-07-10"].kg': { equals: 80 },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'delete-only-after-confirmation',
    seeds: [SEED_WEIGHT],
    cleanupIds: ['eval-weight'],
    turns: [
      {
        say: 'Delete my Weight card.',
        expect: {
          // First turn must not delete: confirm first.
          tools: { forbidden: ['delete_manifest'] },
          state: { noDeletes: true },
        },
      },
      {
        say: 'Yes, delete it.',
        expect: {
          tools: { required: ['delete_manifest'], noErrors: true },
          state: { deleted: ['eval-weight'] },
        },
      },
    ],
  },
  {
    name: 'correct-a-specific-historical-row',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        // Correcting one dated entry. update_row is the intended tool, but a
        // full-block rewrite that lands the same state is equally valid — so
        // the hard property is the OUTCOME: the 5th became 82.1 and the 1st
        // is untouched. (evals discover, tests pin: if a real run shows the
        // wrong row moving, that becomes a server-side hardening issue.)
        say: 'My weight on the 5th of July was actually 82.1, please correct it.',
        expect: {
          tools: { forbidden: ['create_manifest', 'delete_manifest'], noErrors: true },
          state: { modifiedOnly: ['eval-weight'] },
          cardShape: {
            'eval-weight': {
              'data[date="2026-07-05"].kg': { equals: 82.1 },
              'data[date="2026-07-01"].kg': { equals: 82.4 },
            },
          },
          registryClean: true,
        },
      },
    ],
  },
  {
    name: 'hide-then-show-card',
    seeds: [SEED_WEIGHT],
    turns: [
      {
        say: 'Hide my Weight card for now, I do not want to see it on the dashboard.',
        viewedCardId: 'eval-weight',
        expect: {
          tools: { forbidden: ['delete_manifest'], noErrors: true },
          state: { noDeletes: true },
          cardShape: {
            'eval-weight': { 'meta.enabled': { equals: false } },
          },
          registryClean: true,
        },
      },
      {
        say: 'Actually bring the Weight card back.',
        expect: {
          tools: { forbidden: ['delete_manifest'], noErrors: true },
          state: { noDeletes: true },
          cardShape: {
            // Visible again = not disabled. show_card writes enabled:true;
            // a patch that removes the key (default-enabled) also counts, so
            // assert the negative rather than a specific true.
            'eval-weight': { 'meta.enabled': { oneOf: [true] } },
          },
          registryClean: true,
        },
      },
    ],
  },
];
