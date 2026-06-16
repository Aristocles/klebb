// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/time-of-day-renderer-coverage.test.js
// Static coverage check: each renderer that surfaces time-of-day must
// import the shared chipsFor helper and emit the canonical .tod-chip
// markup. Lit components can't be exercised in Node (esm.sh imports),
// so this layer guards against accidental drift like a duplicated
// emoji map or a dropped chip render. The DOM-level assertion lives
// in the e2e suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = path.join(__dirname, '..', 'public', 'js', 'components');

const RENDERERS = [
  'eh-schedule-card.js',
  'eh-checklist-card.js',
  'eh-schedule-timeline.js',
  'eh-adherence-report.js',
];

describe('time-of-day chip renderer coverage', () => {
  for (const file of RENDERERS) {
    describe(file, () => {
      const src = fs.readFileSync(path.join(COMPONENTS, file), 'utf8');

      test('imports chipsFor from the shared ESM helper', () => {
        assert.match(
          src,
          /import\s*\{[^}]*chipsFor[^}]*\}\s*from\s*['"]\.\.\/lib\/time-of-day\.esm\.js['"]/,
          'chip projection must come from public/js/lib/time-of-day.esm.js',
        );
      });

      test('does not duplicate the emoji map', () => {
        assert.doesNotMatch(src, /['"]morning['"]\s*:\s*['"]☀️['"]/, 'inline emoji map duplicates time-of-day.esm.js');
        assert.doesNotMatch(src, /['"]midday['"]\s*:\s*['"]🌤️['"]/, 'inline emoji map duplicates time-of-day.esm.js');
      });

      test('emits the canonical .tod-chip markup with aria-label and title', () => {
        assert.match(src, /class="tod-chip"/, 'renderer must emit a .tod-chip element');
        assert.match(src, /aria-label=\$\{c\.label\}/, 'chip must expose label as aria-label');
        assert.match(src, /title=\$\{c\.label\}/, 'chip must expose label as title');
      });

      test('reads time_of_day off the schedule item', () => {
        // Renderers alias the import as todChipsFor; both call shapes
        // count.
        assert.match(
          src,
          /(?:tod)?[Cc]hipsFor\([^)]*\.schedule\?\.time_of_day\)/,
          'renderer must source chips from item.schedule.time_of_day',
        );
      });
    });
  }
});
