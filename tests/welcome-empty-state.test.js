// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/welcome-empty-state.test.js
// Static coverage for the first-run empty state in eh-welcome-card. The Lit
// component can't be exercised in Node (esm.sh imports), so this layer guards
// the teaching copy and the primary CTA wiring against drift. The server-side
// seed + auto-hide behaviour is covered separately in welcome-card.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'components', 'eh-welcome-card.js'),
  'utf8',
);

describe('welcome-card first-run empty state', () => {
  test('teaches that cards come from a dropped JSON file', () => {
    assert.match(SRC, /drop a/i);
    assert.match(SRC, /\.json/);
    assert.match(SRC, /data folder/i);
  });

  test('teaches that Klebbius can make a card', () => {
    assert.match(SRC, /ask\s+Klebbius/i);
  });

  test('renders a primary "Add your first card" CTA', () => {
    assert.match(SRC, /Add your first card/);
  });

  test('CTA seeds the chat via klebb-paste-into-chat with a starter prompt', () => {
    assert.match(SRC, /klebb-paste-into-chat/);
    assert.match(SRC, /Help me create my first card/);
  });

  test('CTA also dispatches the forward-compat gallery event', () => {
    assert.match(SRC, /klebb-open-card-gallery/);
  });
});
