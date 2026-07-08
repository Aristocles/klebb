// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-427-template-good-direction.test.js
// Every shipped trendArrow carries an explicit goodDirection (#427).
// Without one the arrow falls back to the historical weight default
// (up=red / down=green), which reads colour-backwards on more-is-better
// metrics like sleep hours and steps. New templates must decide, not
// inherit the default by omission.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GOOD = new Set(['up', 'down', 'neutral']);

// templates/*.klebb.json carry {{placeholders}}; none sit inside the
// trendArrow block, so a coarse strip is enough to parse.
function stripPlaceholders(raw) {
  return raw.replace(/\{\{[^}]*\}\}/g, 'x');
}

function trendArrowsIn(dir, suffix) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(suffix))) {
    const parsed = JSON.parse(stripPlaceholders(fs.readFileSync(path.join(dir, f), 'utf8')));
    const ta = parsed.meta?.view?.display?.trendArrow;
    if (ta) out.push({ file: f, trendArrow: ta });
  }
  return out;
}

describe('#427: shipped trendArrows declare goodDirection explicitly', () => {
  test('every template trendArrow has a valid goodDirection', () => {
    const arrows = trendArrowsIn(path.join(ROOT, 'templates'), '.klebb.json');
    assert.ok(arrows.length >= 10, `expected >= 10 trendArrow templates, found ${arrows.length}`);
    for (const { file, trendArrow } of arrows) {
      assert.ok(GOOD.has(trendArrow.goodDirection),
        `${file}: trendArrow must declare goodDirection (up/down/neutral)`);
    }
  });

  test('every demo fixture trendArrow has a valid goodDirection or is the weight default', () => {
    const arrows = trendArrowsIn(path.join(ROOT, 'demo', 'fixtures'), '.json');
    for (const { file, trendArrow } of arrows) {
      // weight is the one metric the historical default is FOR; it may
      // stay bare so the default path keeps real-world coverage.
      if (file === 'weight.json') continue;
      assert.ok(GOOD.has(trendArrow.goodDirection),
        `${file}: trendArrow must declare goodDirection (up/down/neutral)`);
      assert.ok(!('lowerIsBetter' in trendArrow),
        `${file}: use goodDirection, not the legacy lowerIsBetter alias`);
    }
  });
});
