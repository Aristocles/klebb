// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/line-chart-doc-drift.test.js
// Guards against the line-chart config drift returning: the docs + chat prompt
// must describe the config the renderer actually reads (xAxis/series/title/
// yAxisLabel), not the stale xKey/yKey/unit shape. Also asserts a config-shaped
// line-chart manifest passes the structural validator.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const registry = require('../manifests/registry');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

// The exact keys eh-line-chart.js reads, lifted so the test pins the contract.
const RENDERER_READS = ['xAxis', 'series', 'title', 'yAxisLabel'];
const RENDERER_IGNORES = ['xKey', 'yKey'];

describe('line-chart config: renderer is the source of truth', () => {
  test('eh-line-chart.js reads xAxis/series, not xKey/yKey', () => {
    const src = read('public/js/components/eh-line-chart.js');
    for (const k of RENDERER_READS) {
      assert.ok(src.includes(`cfg.${k}`) || src.includes(`.${k}`), `renderer should reference ${k}`);
    }
    for (const k of RENDERER_IGNORES) {
      assert.ok(!src.includes(k), `renderer must not reference the stale ${k}`);
    }
  });
});

describe('line-chart config: docs match the renderer', () => {
  test('docs/CARDS.md no longer documents xKey/yKey/unit for line-chart', () => {
    const cards = read('docs/CARDS.md');
    assert.ok(!/\bxKey\b/.test(cards), 'CARDS.md must not mention xKey');
    assert.ok(!/\byKey\b/.test(cards), 'CARDS.md must not mention yKey');
    // The corrected config keys must appear.
    assert.ok(cards.includes('xAxis'), 'CARDS.md documents xAxis');
    assert.ok(/series/.test(cards), 'CARDS.md documents series');
  });

  test('config/env.js system prompt describes xAxis/series for line-chart', () => {
    const env = read('config/env.js');
    const line = env.split('\n').find(l => l.includes('line-chart') && l.includes('time-series chart'));
    assert.ok(line, 'found the line-chart prompt line');
    assert.ok(line.includes('xAxis'), 'prompt line mentions xAxis');
    assert.ok(line.includes('series'), 'prompt line mentions series');
  });

  test('chat docs catalogue lists eh-line-chart.js with the correct contract', () => {
    const docs = read('chat/docs.js');
    assert.ok(docs.includes('eh-line-chart.js'), 'DOC_INDEX includes the line-chart renderer');
    assert.ok(/Does NOT read xKey\/yKey/.test(docs), 'catalogue summary states the xKey/yKey correction');
  });
});

describe('line-chart config: a renderer-shaped manifest validates', () => {
  test('xAxis + series line-chart manifest passes the structural validator', () => {
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'bp-trend',
        label: 'Blood Pressure Trend',
        trends: {
          enabled: true,
          component: 'line-chart',
          xAxis: 'date',
          series: [
            { field: 'systolic', label: 'Systolic' },
            { field: 'diastolic', label: 'Diastolic' },
          ],
          yAxisLabel: 'mmHg',
        },
      },
      data: [{ date: '2026-06-20', systolic: 120, diastolic: 80 }],
    };
    assert.doesNotThrow(() => registry.validateManifestShape(JSON.parse(JSON.stringify(manifest)), { strictId: true }));
  });
});
