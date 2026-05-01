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
