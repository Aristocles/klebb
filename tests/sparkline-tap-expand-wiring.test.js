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
    // Isolate exactly the headerless branch: from `if (this.headerless) {` to
    // its matching close brace, so the assertion can't bleed into the normal
    // render() branch (which legitimately contains card-header). Brace-matched
    // rather than a fixed char window, so it's robust to line endings.
    const start = BASE.indexOf('if (this.headerless)');
    const open = BASE.indexOf('{', start);
    let depth = 0, end = open;
    for (let i = open; i < BASE.length; i += 1) {
      if (BASE[i] === '{') depth += 1;
      else if (BASE[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const branch = BASE.slice(open, end + 1);
    assert.ok(/card-body/.test(branch), 'headerless branch renders the card body');
    assert.ok(!/card-header/.test(branch), 'headerless branch renders no card-header');
  });
  test('clickable header carries aria-expanded', () => {
    assert.ok(/aria-expanded=\$\{this\._canExpand \? String\(this\.expanded\)/.test(BASE));
  });
  test('header indicator stands down when a subclass owns the expand control', () => {
    assert.ok(/get _ownsExpandControl\(\)/.test(BASE), 'base declares the _ownsExpandControl hook');
    assert.ok(/return false;/.test(BASE.slice(BASE.indexOf('get _ownsExpandControl()'))),
      'defaults to false so existing cards keep the header indicator');
    assert.ok(/this\._canExpand && !this\._ownsExpandControl \? html`[\s\S]{0,160}expand-indicator/.test(BASE),
      'the header chevron renders only when the subclass has not placed its own');
  });
});

describe('generic-card: tap-to-expand wiring', () => {
  test('overrides _canExpand to allow expand when a sparkline is showable', () => {
    assert.ok(/get _canExpand\(\)/.test(GEN), 'generic-card overrides _canExpand');
    assert.ok(/super\._canExpand/.test(GEN), 'still honours the generic expanded config');
    assert.ok(/_config\.showSparkline/.test(GEN), 'gates on showSparkline');
    assert.ok(/s\.length >= 2 \? s : null/.test(GEN), 'requires >= 2 points to be expandable');
    assert.ok(/return this\._sparkSeries\(\) !== null/.test(GEN),
      'the expand gate reads the same series resolver the render does');
  });

  // #572: the chevron moved out of the header to sit beside the sparkline.
  test('places its own chevron beside the sparkline, not in the header', () => {
    assert.ok(/get _ownsExpandControl\(\)[\s\S]{0,120}_showsSparklineRow\(\)/.test(GEN),
      'claims the expand control exactly when the sparkline row draws');
    const spark = GEN.slice(GEN.indexOf('<div class="gen-spark">'));
    const btn = spark.indexOf('class="spark-expand');
    const glyph = spark.indexOf('<eh-sparkline');
    assert.ok(btn !== -1, 'a spark-expand control exists');
    assert.ok(glyph !== -1, 'the sparkline is in that row');
    assert.ok(btn < glyph, 'the chevron precedes the sparkline in the row');
  });
  test('the chevron is a real button: keyboard-reachable, labelled, aria-expanded', () => {
    const btn = GEN.slice(GEN.indexOf('class="spark-expand'), GEN.indexOf('<eh-sparkline'));
    assert.ok(/aria-expanded=\$\{String\(this\.expanded\)\}/.test(btn), 'exposes aria-expanded');
    assert.ok(/aria-label=/.test(btn), 'carries an accessible label');
    assert.ok(/@click=\$\{this\._toggleExpand\}/.test(btn), 'toggles expand on click');
    assert.ok(/<button/.test(GEN.slice(GEN.indexOf('<div class="gen-spark">'), GEN.indexOf('<eh-sparkline'))),
      'is a <button>, not a clickable span');
  });
  test('the sparkline itself stays non-interactive (its aria-label is the name)', () => {
    const row = GEN.slice(GEN.indexOf('<div class="gen-spark">'), GEN.indexOf('</div>', GEN.indexOf('<eh-sparkline')));
    assert.ok(!/<button[^>]*>\s*<eh-sparkline/.test(row), 'sparkline is not wrapped in a button');
    assert.ok(!/<eh-sparkline[^>]*@click/.test(row), 'no click handler on the sparkline');
  });
  test('the row does not draw for multi-entry, an open form, or an empty day', () => {
    const fn = GEN.slice(GEN.indexOf('_showsSparklineRow()'), GEN.indexOf('get _ownsExpandControl()'));
    assert.ok(/_maxReadingsPerDay\(\) > 1/.test(fn), 'multi-entry list has no sparkline row');
    assert.ok(/this\._editing/.test(fn), 'an open edit form replaces the headline block');
    assert.ok(/_currentEntry\(\) === null/.test(fn), 'no value for the day means no row');
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
