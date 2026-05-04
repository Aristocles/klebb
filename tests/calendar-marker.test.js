// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/calendar-marker.test.js
// Pure-function tests for the calendar marker resolver used by the
// Calendar view to pick a per-day glyph from a manifest's
// meta.calendar.marker config.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { extractDatedRows, resolveMarker } =
  require(path.join(__dirname, '..', 'public', 'js', 'lib', 'calendar-marker.js'));

describe('extractDatedRows', () => {
  test('empty / null input returns empty map', () => {
    assert.equal(extractDatedRows(null).size, 0);
    assert.equal(extractDatedRows(undefined).size, 0);
    assert.equal(extractDatedRows([]).size, 0);
    assert.equal(extractDatedRows({}).size, 0);
  });

  test('array of dated rows', () => {
    const m = extractDatedRows([
      { date: '2026-04-20', kg: 85 },
      { date: '2026-04-21', kg: 86 },
    ]);
    assert.equal(m.size, 2);
    assert.deepEqual(m.get('2026-04-20'), { date: '2026-04-20', kg: 85 });
  });

  test('array ignores rows with non-ISO date', () => {
    const m = extractDatedRows([
      { date: 'yesterday', kg: 1 },
      { kg: 2 },
      { date: '2026-04-20', kg: 3 },
    ]);
    assert.equal(m.size, 1);
    assert.ok(m.has('2026-04-20'));
  });

  test('array collisions — later entry wins', () => {
    const m = extractDatedRows([
      { date: '2026-04-20', kg: 85 },
      { date: '2026-04-20', kg: 86 },
    ]);
    assert.equal(m.get('2026-04-20').kg, 86);
  });

  test('date-keyed object', () => {
    const m = extractDatedRows({
      '2026-04-20': { mood: 4 },
      '2026-04-21': { mood: 3 },
      'not-a-date': { mood: 1 },
    });
    assert.equal(m.size, 2);
    assert.equal(m.get('2026-04-20').mood, 4);
  });

  test('items[].doses[] — only taken doses count', () => {
    const m = extractDatedRows({
      items: [{
        name: 'x',
        doses: [
          { scheduledDate: '2026-04-20', takenAt: '2026-04-20T08:00:00Z' },
          { scheduledDate: '2026-04-21', takenAt: null },
          { scheduledDate: '2026-04-22', takenAt: '2026-04-22T09:00:00Z' },
        ],
      }],
    });
    assert.equal(m.size, 2);
    assert.ok(m.has('2026-04-20'));
    assert.ok(m.has('2026-04-22'));
    assert.ok(!m.has('2026-04-21'));
  });

  test('items[].doses[] — latest takenAt wins on same day', () => {
    const m = extractDatedRows({
      items: [{
        name: 'x',
        doses: [
          { scheduledDate: '2026-04-20', takenAt: '2026-04-20T08:00:00Z', note: 'morning' },
          { scheduledDate: '2026-04-20', takenAt: '2026-04-20T20:00:00Z', note: 'evening' },
        ],
      }],
    });
    assert.equal(m.get('2026-04-20').note, 'evening');
  });
});

describe('resolveMarker', () => {
  describe('static string', () => {
    test('string spec returns string', () => {
      assert.equal(resolveMarker('💊', {}), '💊');
    });

    test('empty string falls back', () => {
      assert.equal(resolveMarker('', { fallback: '•' }), '•');
    });

    test('null / undefined spec falls back', () => {
      assert.equal(resolveMarker(null, { fallback: '⚖️' }), '⚖️');
      assert.equal(resolveMarker(undefined, { fallback: '⚖️' }), '⚖️');
    });

    test('no fallback — default to bullet', () => {
      assert.equal(resolveMarker(null, {}), '•');
    });
  });

  describe('field-emoji', () => {
    const spec = {
      type: 'field-emoji',
      field: 'mood',
      emojiMap: { '1': '😩', '2': '😴', '3': '😐', '4': '🙂', '5': '😄' },
      fallback: '🙂',
    };

    test('resolves numeric value', () => {
      const r = resolveMarker(spec, { row: { mood: 4 } });
      assert.equal(r, '🙂');
    });

    test('resolves string value', () => {
      const r = resolveMarker(spec, { row: { mood: '5' } });
      assert.equal(r, '😄');
    });

    test('missing field returns spec.fallback', () => {
      const r = resolveMarker(spec, { row: { wakeUps: 1 } });
      assert.equal(r, '🙂');
    });

    test('unmapped value returns spec.fallback', () => {
      const r = resolveMarker(spec, { row: { mood: 99 } });
      assert.equal(r, '🙂');
    });

    test('no emojiMap returns fallback', () => {
      const r = resolveMarker(
        { type: 'field-emoji', field: 'mood', fallback: 'X' },
        { row: { mood: 4 } }
      );
      assert.equal(r, 'X');
    });

    test('dotted-path field', () => {
      const r = resolveMarker(
        { type: 'field-emoji', field: 'stats.mood', emojiMap: { '4': '🙂' } },
        { row: { stats: { mood: 4 } } }
      );
      assert.equal(r, '🙂');
    });
  });

  describe('trend-arrow', () => {
    const spec = {
      type: 'trend-arrow',
      field: 'kg',
      up: '⬆️',
      down: '⬇️',
      flat: '➡️',
      fallback: '•',
    };

    const rows = [
      { date: '2026-04-18', kg: 85.0 },
      { date: '2026-04-19', kg: 85.5 },
      { date: '2026-04-20', kg: 85.5 },
      { date: '2026-04-21', kg: 85.0 },
    ];

    test('up arrow when value increased', () => {
      const r = resolveMarker(spec, {
        date: '2026-04-19', row: rows[1], sortedRows: rows,
      });
      assert.equal(r, '⬆️');
    });

    test('flat arrow when value unchanged', () => {
      const r = resolveMarker(spec, {
        date: '2026-04-20', row: rows[2], sortedRows: rows,
      });
      assert.equal(r, '➡️');
    });

    test('down arrow when value decreased', () => {
      const r = resolveMarker(spec, {
        date: '2026-04-21', row: rows[3], sortedRows: rows,
      });
      assert.equal(r, '⬇️');
    });

    test('first entry (no previous) returns fallback', () => {
      const r = resolveMarker(spec, {
        date: '2026-04-18', row: rows[0], sortedRows: rows,
      });
      assert.equal(r, '•');
    });

    test('skips rows missing the field', () => {
      const withGaps = [
        { date: '2026-04-18', kg: 85.0 },
        { date: '2026-04-19' },             // gap
        { date: '2026-04-20', kg: 84.0 },    // should compare to 85.0, not the gap
      ];
      const r = resolveMarker(spec, {
        date: '2026-04-20', row: withGaps[2], sortedRows: withGaps,
      });
      assert.equal(r, '⬇️');
    });

    test('non-numeric current value returns fallback', () => {
      const r = resolveMarker(spec, {
        date: '2026-04-20', row: { date: '2026-04-20', kg: 'heavy' }, sortedRows: rows,
      });
      assert.equal(r, '•');
    });

    test('uses default arrows when none specified', () => {
      const minimal = { type: 'trend-arrow', field: 'kg' };
      const r = resolveMarker(minimal, {
        date: '2026-04-19', row: rows[1], sortedRows: rows,
      });
      assert.equal(r, '⬆️');
    });
  });

  describe('threshold', () => {
    const spec = {
      type: 'threshold',
      field: 'systolic',
      rules: [
        { max: 119, emoji: '🟢' },
        { max: 129, emoji: '🟡' },
        { max: 139, emoji: '🟠' },
        { max: 999, emoji: '🔴' },
      ],
      fallback: '•',
    };

    test('first-matching rule wins', () => {
      assert.equal(resolveMarker(spec, { row: { systolic: 110 } }), '🟢');
      assert.equal(resolveMarker(spec, { row: { systolic: 125 } }), '🟡');
      assert.equal(resolveMarker(spec, { row: { systolic: 135 } }), '🟠');
      assert.equal(resolveMarker(spec, { row: { systolic: 160 } }), '🔴');
    });

    test('min bound matches', () => {
      const rising = {
        type: 'threshold',
        field: 'hr',
        rules: [{ min: 100, emoji: '⚡' }],
        fallback: '•',
      };
      assert.equal(resolveMarker(rising, { row: { hr: 120 } }), '⚡');
      assert.equal(resolveMarker(rising, { row: { hr: 80 } }), '•');
    });

    test('eq matcher for categorical values', () => {
      const cat = {
        type: 'threshold',
        field: 'phase',
        rules: [
          { eq: 'loading',     emoji: '🔁' },
          { eq: 'maintenance', emoji: '✅' },
          { eq: 'rest',        emoji: '💤' },
        ],
        fallback: '•',
      };
      assert.equal(resolveMarker(cat, { row: { phase: 'loading' } }), '🔁');
      assert.equal(resolveMarker(cat, { row: { phase: 'rest' } }), '💤');
      assert.equal(resolveMarker(cat, { row: { phase: 'other' } }), '•');
    });

    test('missing field returns fallback', () => {
      assert.equal(resolveMarker(spec, { row: { diastolic: 80 } }), '•');
    });

    test('no matching rule returns fallback', () => {
      const narrow = {
        type: 'threshold',
        field: 'kg',
        rules: [{ min: 60, max: 70, emoji: '✅' }],
        fallback: '❌',
      };
      assert.equal(resolveMarker(narrow, { row: { kg: 90 } }), '❌');
    });

    test('missing rules array returns fallback', () => {
      const bad = { type: 'threshold', field: 'kg', fallback: '•' };
      assert.equal(resolveMarker(bad, { row: { kg: 80 } }), '•');
    });

    test('legacy `bands` key is accepted as an alias for `rules` (see #70)', () => {
      const legacy = {
        type: 'threshold',
        field: 'systolic',
        bands: [
          { max: 119, emoji: '🟢' },
          { max: 129, emoji: '🟡' },
          { max: 139, emoji: '🟠' },
          { max: 999, emoji: '🔴' },
        ],
        fallback: '•',
      };
      assert.equal(resolveMarker(legacy, { row: { systolic: 110 } }), '🟢');
      assert.equal(resolveMarker(legacy, { row: { systolic: 135 } }), '🟠');
      assert.equal(resolveMarker(legacy, { row: { systolic: 160 } }), '🔴');
    });

    test('`rules` wins over `bands` when both are present', () => {
      const both = {
        type: 'threshold',
        field: 'kg',
        rules: [{ max: 100, emoji: '✅' }],
        bands: [{ max: 100, emoji: '❌' }],
        fallback: '•',
      };
      assert.equal(resolveMarker(both, { row: { kg: 80 } }), '✅');
    });
  });

  describe('template', () => {
    // Fake renderTemplate — just concatenates values so we can prove
    // the injection path works without pulling in the real engine.
    const fakeRender = (tpl, row) => tpl.replace(/\{(\w+)\}/g, (_, k) => row[k] ?? '');

    test('renders a template string against the row', () => {
      const spec = { type: 'template', template: '{m}', fallback: '?' };
      const r = resolveMarker(spec, {
        row: { m: '🔥' }, renderTemplate: fakeRender,
      });
      assert.equal(r, '🔥');
    });

    test('reuses display.emojiMap when renderTemplate supports :emoji', () => {
      // Use the real renderTemplate to prove the end-to-end integration.
      const realPath = require('path').join(
        __dirname, '..', 'public', 'js', 'lib', 'display-template.js'
      );
      const { renderTemplate } = require(realPath);
      const spec = { type: 'template', template: '{mood:emoji}', fallback: '🙂' };
      const display = { emojiMap: { mood: { '1': '😩', '4': '🙂', '5': '😄' } } };
      assert.equal(
        resolveMarker(spec, { row: { mood: 5 }, display, renderTemplate }),
        '😄'
      );
    });

    test('blank render result returns fallback', () => {
      const spec = { type: 'template', template: '{missing}', fallback: '•' };
      const r = resolveMarker(spec, {
        row: { other: 1 }, renderTemplate: fakeRender,
      });
      assert.equal(r, '•');
    });

    test('no renderTemplate injected → fallback', () => {
      const spec = { type: 'template', template: '{m}', fallback: '•' };
      assert.equal(resolveMarker(spec, { row: { m: 'x' } }), '•');
    });

    test('missing template returns fallback', () => {
      const spec = { type: 'template', fallback: '•' };
      assert.equal(resolveMarker(spec, { row: { m: 'x' }, renderTemplate: fakeRender }), '•');
    });
  });

  describe('unknown type', () => {
    test('falls back rather than throwing', () => {
      const r = resolveMarker(
        { type: 'not-a-thing', fallback: 'X' },
        { row: {} }
      );
      assert.equal(r, 'X');
    });
  });
});
