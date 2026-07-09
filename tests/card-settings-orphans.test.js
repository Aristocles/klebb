// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/card-settings-orphans.test.js
// Static coverage for the "Unreferenced data" section in the card settings
// modal. The Lit component can't be exercised in Node (esm.sh imports), so
// this layer guards the wiring: the orphans endpoint is fetched, the section
// renders only when the report is non-empty, and it links into chat rather
// than offering destructive actions.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'components', 'eh-card-settings-modal.js'),
  'utf8',
);

describe('card settings modal: unreferenced-data section', () => {
  test('fetches the orphans endpoint on connect', () => {
    assert.match(SRC, /\/orphans/);
    assert.match(SRC, /_fetchOrphans\(\)/);
  });

  test('renders a section only when orphans exist', () => {
    assert.match(SRC, /_renderOrphans/);
    assert.match(SRC, /Unreferenced data/);
    assert.match(SRC, /this\._orphans\.length === 0\) return ''/);
  });

  test('reassures that the data is safe and routes fixes through chat', () => {
    assert.match(SRC, /The data is safe/);
    assert.match(SRC, /_klebbiusLink\('Ask Klebbius', 'unreferenced data fields'\)/);
  });
});
