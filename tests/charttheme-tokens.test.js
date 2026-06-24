// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/charttheme-tokens.test.js
//
// Regression seed for #425: chartTheme() read CSS custom properties
// (--accent-amber/-red/-green) that were never defined in app.css, so the
// amber/red/green chart colours always fell through to their hex fallbacks
// and ignored the active theme. It must read the real --warning/--danger/
// --success tokens instead. chartTheme() needs a DOM (getComputedStyle on
// document.documentElement), so this asserts at the source level.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const chartBase = fs.readFileSync(
  path.join(REPO_ROOT, 'public/js/components/eh-chart-base.js'),
  'utf8',
);
const appCss = fs.readFileSync(
  path.join(REPO_ROOT, 'public/css/app.css'),
  'utf8',
);

describe('chartTheme reads real theme tokens', () => {
  test('references --warning/--danger/--success', () => {
    for (const token of ['--warning', '--danger', '--success']) {
      assert.ok(
        chartBase.includes(`get('${token}')`),
        `eh-chart-base.js should read ${token}`,
      );
    }
  });

  test('no longer references the non-existent --accent-* tokens', () => {
    for (const token of ['--accent-amber', '--accent-red', '--accent-green']) {
      assert.ok(
        !chartBase.includes(token),
        `eh-chart-base.js should not reference ${token} (never defined in app.css)`,
      );
    }
  });

  test('every token chartTheme reads is defined in app.css', () => {
    const tokens = [...chartBase.matchAll(/get\('(--[\w-]+)'\)/g)].map(m => m[1]);
    assert.ok(tokens.length > 0, 'expected chartTheme to read at least one token');
    for (const token of [...new Set(tokens)]) {
      assert.ok(
        appCss.includes(`${token}:`),
        `${token} is read by chartTheme but not defined in app.css`,
      );
    }
  });
});
