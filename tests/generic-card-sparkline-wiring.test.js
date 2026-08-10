// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/generic-card-sparkline-wiring.test.js
// Source-level coverage for wiring eh-sparkline into generic-card (#445).
// The component can't run under Node (esm.sh Lit import), so this pins the
// load-bearing facts: the imports, the default-off + Today-only + >=2-points
// guards, and that the trend arrow is suppressed when the sparkline shows.
// The interactive behaviour is owned by the e2e storyboard.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'components', 'eh-generic-card.js'),
  'utf8',
);

describe('generic-card sparkline wiring', () => {
  test('imports numericSeries and the eh-sparkline element', () => {
    assert.ok(/import\s*\{[^}]*\bnumericSeries\b[^}]*\}\s*from\s*'\.\.\/lib\/display-template\.esm\.js'/.test(SRC),
      'numericSeries imported from display-template.esm.js');
    assert.ok(/import\s*'\.\/eh-sparkline\.js'/.test(SRC), 'eh-sparkline.js side-effect import present');
  });

  test('gated on showSparkline AND Today (not past/future dates)', () => {
    assert.ok(/this\._config\.showSparkline\s*&&\s*isToday/.test(SRC),
      'sparkline computation guarded by _config.showSparkline && isToday');
  });

  test('requires at least 2 points before assigning sparkValues', () => {
    assert.ok(/s\.length\s*>=\s*2/.test(SRC), 'series length >= 2 guard present');
  });

  test('mounts <eh-sparkline> only when sparkValues is set', () => {
    assert.ok(/\$\{sparkValues\s*\?\s*html`[^`]*<eh-sparkline[^`]*\.values=\$\{sparkValues\}/.test(SRC),
      'eh-sparkline mounted conditionally on sparkValues with .values bound');
  });

  test('trend arrow is suppressed when the sparkline shows (no double signal)', () => {
    assert.ok(/showTrendArrow\s*=\s*trend\s*&&\s*!sparkValues/.test(SRC),
      'showTrendArrow excludes the case where a sparkline is shown');
    // the arrow span must render off showTrendArrow, not raw trend
    assert.ok(/\$\{showTrendArrow\s*\?\s*html`/.test(SRC), 'arrow renders off showTrendArrow');
  });

  test('field resolver prefers trendArrow.field, then template token, then heuristic', () => {
    assert.ok(/_sparklineField\(display\)/.test(SRC), '_sparklineField method present');
    assert.ok(/display\.trendArrow\.field/.test(SRC), 'resolver checks trendArrow.field first');
    assert.ok(/template[\s\S]{0,80}match\(/.test(SRC), 'resolver falls back to a template token match');
  });

  test('default-off: the series resolver is the only way a sparkline appears', () => {
    // One resolver owns the decision, and every path out of it that isn't
    // "flag on, Today, resolvable field, >= 2 points" returns null. The
    // render and the expand gate both read it, so neither can draw a
    // sparkline the other doesn't know about.
    const fn = SRC.slice(SRC.indexOf('_sparkSeries()'), SRC.indexOf('get _canExpand()'));
    assert.ok(/if \(!\(this\._config\.showSparkline && isToday\)\) return null;/.test(fn),
      'off by default: no flag (or not Today) returns null');
    assert.ok(/if \(!field\) return null;/.test(fn), 'no resolvable numeric field returns null');
    assert.ok(/const sparkValues = this\._sparkSeries\(\);/.test(SRC),
      'the render takes its values from the resolver, not its own copy of the gate');
  });
});
