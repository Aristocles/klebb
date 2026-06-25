// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/sparkline-tap-expand-wiring.test.js
// Source-level coverage for tap-to-expand (#448): a sparkline generic-card
// expands to a lazily-loaded full trend chart. Components can't run under Node
// (esm.sh Lit), so this pins the wiring: the base headerless mode + aria, and
// generic-card's _canExpand gate + headerless eh-line-chart in renderExpanded.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', f), 'utf8');
const BASE = read('eh-base-card.js');
const GEN = read('eh-generic-card.js');
const CHART_BASE = read('eh-chart-base.js');

describe('base card: headerless mode + aria-expanded', () => {
  test('declares a headerless property defaulting false', () => {
    assert.ok(/headerless:\s*\{\s*type:\s*Boolean\s*\}/.test(BASE));
    assert.ok(/this\.headerless = false/.test(BASE));
  });
  test('headerless render skips the header (body only)', () => {
    assert.ok(/if \(this\.headerless\)/.test(BASE), 'render branches on headerless');
    // the headerless branch must not include the card-header markup
    const branch = BASE.slice(BASE.indexOf('if (this.headerless)'), BASE.indexOf('if (this.headerless)') + 400);
    assert.ok(!/card-header/.test(branch), 'headerless branch renders no card-header');
    assert.ok(/card-body/.test(branch), 'headerless branch renders the card body');
  });
  test('clickable header carries aria-expanded', () => {
    assert.ok(/aria-expanded=\$\{this\._canExpand \? String\(this\.expanded\)/.test(BASE));
  });
});

describe('generic-card: tap-to-expand wiring', () => {
  test('overrides _canExpand to allow expand when a sparkline is showable', () => {
    assert.ok(/get _canExpand\(\)/.test(GEN), 'generic-card overrides _canExpand');
    assert.ok(/super\._canExpand/.test(GEN), 'still honours the generic expanded config');
    assert.ok(/_config\.showSparkline/.test(GEN), 'gates on showSparkline');
    assert.ok(/numericSeries\([\s\S]*?\)\.length >= 2/.test(GEN), 'requires >= 2 points to be expandable');
  });
  test('renderExpanded mounts a headerless eh-line-chart with a synthesised series', () => {
    assert.ok(/renderExpanded\(\)/.test(GEN));
    assert.ok(/<eh-line-chart headerless/.test(GEN), 'mounts eh-line-chart headerless');
    assert.ok(/component:\s*'line-chart'/.test(GEN), 'synthesises a line-chart viewConfig');
    assert.ok(/series:\s*\[\{\s*field/.test(GEN), 'binds the resolved field as the series');
  });
  test('imports eh-line-chart for the expanded view', () => {
    assert.ok(/import\s*'\.\/eh-line-chart\.js'/.test(GEN));
  });
});

describe('lazy ECharts contract preserved', () => {
  test('ECharts is a dynamic import inside loadECharts, not a static import', () => {
    assert.ok(/_echartsPromise = import\('https:\/\/esm\.sh\/echarts/.test(CHART_BASE),
      'ECharts loaded via dynamic import()');
    // no top-level static import of echarts anywhere in chart-base
    assert.ok(!/^import .*echarts/m.test(CHART_BASE), 'no static echarts import');
  });
});
