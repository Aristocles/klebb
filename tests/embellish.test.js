// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/embellish.test.js
// Coverage for chat/embellish.js — the post-create/edit chip picker.
// The picker is pure, so no sandbox needed. We lock the RNG to make
// ordering deterministic and check each renderer's eligibility shape.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { pickEmbellishments, CATALOG, MAX_OFFERS } = require('../chat/embellish');

// Deterministic RNG: pops from a queue so each shuffle step is predictable.
// Pass `[0, 0, 0, ...]` to mean "never swap" -> catalog order is preserved.
function scriptedRng(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

const noSwapRng = () => scriptedRng([0]);

describe('pickEmbellishments', () => {
  test('returns null for a manifest that is null or has no meta', () => {
    assert.strictEqual(pickEmbellishments(null), null);
    assert.strictEqual(pickEmbellishments({}), null);
  });

  test('returns null when every eligible embellishment is already set', () => {
    // Fully-kitted generic-card: emoji, category, calendar, thresholds,
    // trendArrow, trends, prompt, plus inputs -> adherence/timeline not
    // applicable (wrong renderer) so everything that COULD apply is set.
    const manifest = {
      meta: {
        id: 'weight',
        label: 'Weight',
        emoji: '⚖️',
        category: 'vitals',
        view: {
          enabled: true,
          component: 'generic-card',
          display: {
            thresholds: [{ ifField: 'kg', max: 80, colour: '#0f0' }],
            trendArrow: { field: 'kg' },
          },
        },
        calendar: { enabled: true, component: 'day-marker' },
        trends: { enabled: true, component: 'line-chart' },
        prompt: { enabled: true, mode: 'modal' },
        writeable: { inputs: [{ key: 'kg', type: 'number' }] },
      },
    };
    assert.strictEqual(pickEmbellishments(manifest, { rng: noSwapRng() }), null);
  });

  test('create flow intro differs from edit flow intro', () => {
    const bareManifest = {
      meta: { id: 'x', label: 'X', view: { enabled: true, component: 'generic-card' } },
    };
    const createResult = pickEmbellishments(bareManifest, { rng: noSwapRng(), flow: 'create' });
    const editResult = pickEmbellishments(bareManifest, { rng: noSwapRng(), flow: 'edit' });
    assert.ok(createResult);
    assert.ok(editResult);
    assert.notStrictEqual(createResult.text, editResult.text);
  });

  test('caps at MAX_OFFERS (3) even when more are eligible', () => {
    const manifest = {
      meta: {
        id: 'bp',
        label: 'Blood Pressure',
        view: { enabled: true, component: 'generic-card' },
        writeable: { inputs: [{ key: 'systolic', type: 'number' }] },
      },
    };
    const result = pickEmbellishments(manifest, { rng: noSwapRng() });
    assert.ok(result);
    assert.ok(result.embellishments.length <= MAX_OFFERS);
    assert.strictEqual(result.embellishments.length, MAX_OFFERS);
  });

  test('generic-card offers thresholds, trendArrow, trends (line-chart), plus universal options', () => {
    const manifest = {
      meta: {
        id: 'weight',
        label: 'Weight',
        view: { enabled: true, component: 'generic-card' },
        writeable: { inputs: [{ key: 'kg', type: 'number' }] },
      },
    };
    // Use an RNG that never swaps so we see everything eligible in catalog order,
    // then slice to MAX_OFFERS independently per test.
    const allEligible = CATALOG.filter(e => e.eligible(manifest.meta)).map(e => e.id);
    assert.ok(allEligible.includes('add-thresholds'));
    assert.ok(allEligible.includes('add-trend-arrow'));
    assert.ok(allEligible.includes('add-trends-line'));
    assert.ok(allEligible.includes('add-emoji'));
    assert.ok(allEligible.includes('add-category'));
    assert.ok(allEligible.includes('add-calendar'));
    assert.ok(allEligible.includes('add-daily-prompt'));
    // timeline + adherence belong to schedule-style renderers, not here
    assert.ok(!allEligible.includes('add-trends-timeline'));
    assert.ok(!allEligible.includes('add-adherence-report'));
  });

  test('schedule-card offers adherence-report and schedule-timeline, NOT thresholds', () => {
    const manifest = {
      meta: {
        id: 'peptides',
        label: 'Peptides',
        view: { enabled: true, component: 'schedule-card' },
      },
    };
    const ids = CATALOG.filter(e => e.eligible(manifest.meta)).map(e => e.id);
    assert.ok(ids.includes('add-adherence-report'));
    assert.ok(ids.includes('add-trends-timeline'));
    assert.ok(!ids.includes('add-thresholds'));
    assert.ok(!ids.includes('add-trend-arrow'));
    assert.ok(!ids.includes('add-trends-line'));
  });

  test('checklist-card behaves like schedule-card for renderer-gated options', () => {
    const manifest = {
      meta: {
        id: 'checklist',
        label: 'Checklist',
        view: { enabled: true, component: 'checklist-card' },
      },
    };
    const ids = CATALOG.filter(e => e.eligible(manifest.meta)).map(e => e.id);
    assert.ok(ids.includes('add-adherence-report'));
    assert.ok(ids.includes('add-trends-timeline'));
  });

  test('line-chart offers trends opt-in but not thresholds', () => {
    const manifest = {
      meta: {
        id: 'hrv',
        label: 'HRV',
        view: { enabled: true, component: 'line-chart' },
      },
    };
    const ids = CATALOG.filter(e => e.eligible(manifest.meta)).map(e => e.id);
    assert.ok(ids.includes('add-trends-line'));
    assert.ok(!ids.includes('add-thresholds'));
    assert.ok(!ids.includes('add-trend-arrow'));
  });

  test('list-card and markdown-doc only surface universal options', () => {
    for (const component of ['list-card', 'markdown-doc']) {
      const manifest = {
        meta: {
          id: 'thing',
          label: 'Thing',
          view: { enabled: true, component },
        },
      };
      const ids = CATALOG.filter(e => e.eligible(manifest.meta)).map(e => e.id);
      assert.deepStrictEqual(
        ids.sort(),
        ['add-calendar', 'add-category', 'add-emoji'].sort(),
        `${component} should only surface universal options`,
      );
    }
  });

  test('daily-prompt only eligible when writeable.inputs is non-empty', () => {
    const noInputs = {
      meta: {
        id: 'doc',
        label: 'Doc',
        view: { enabled: true, component: 'markdown-doc' },
      },
    };
    const withInputs = {
      meta: {
        id: 'weight',
        label: 'Weight',
        view: { enabled: true, component: 'generic-card' },
        writeable: { inputs: [{ key: 'kg', type: 'number' }] },
      },
    };
    const noInputIds = CATALOG.filter(e => e.eligible(noInputs.meta)).map(e => e.id);
    const withInputIds = CATALOG.filter(e => e.eligible(withInputs.meta)).map(e => e.id);
    assert.ok(!noInputIds.includes('add-daily-prompt'));
    assert.ok(withInputIds.includes('add-daily-prompt'));
  });

  test('prompt strings interpolate the card label', () => {
    const manifest = {
      meta: {
        id: 'mood',
        label: 'My Mood',
        view: { enabled: true, component: 'generic-card' },
      },
    };
    const result = pickEmbellishments(manifest, { rng: noSwapRng() });
    assert.ok(result.embellishments.every(e => e.prompt.includes('My Mood')));
  });

  test('offers carry id, label, prompt shape required by the client chips', () => {
    const manifest = {
      meta: {
        id: 'x',
        label: 'X',
        view: { enabled: true, component: 'generic-card' },
      },
    };
    const result = pickEmbellishments(manifest, { rng: noSwapRng() });
    for (const e of result.embellishments) {
      assert.strictEqual(typeof e.id, 'string');
      assert.strictEqual(typeof e.label, 'string');
      assert.strictEqual(typeof e.prompt, 'string');
    }
  });
});
