// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/display-template.test.js
// Pure-function tests for the manifest display-template engine.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { renderTemplate, getValue, lookupEmoji, applyRound } =
  require(path.join(__dirname, '..', 'public', 'js', 'lib', 'display-template.js'));

describe('display-template', () => {
  describe('renderTemplate', () => {
    test('simple substitution', () => {
      assert.equal(renderTemplate('weight: {kg}kg', { kg: 85 }), 'weight: 85kg');
    });

    test('multiple keys', () => {
      assert.equal(
        renderTemplate('{systolic}/{diastolic}', { systolic: 120, diastolic: 80 }),
        '120/80'
      );
    });

    test('missing key → empty string', () => {
      assert.equal(renderTemplate('a {missing} b', {}), 'a  b');
    });

    test('null value → empty string', () => {
      assert.equal(renderTemplate('{x}', { x: null }), '');
    });

    test('pipe default when missing', () => {
      assert.equal(renderTemplate('{mood|unknown}', {}), 'unknown');
      assert.equal(renderTemplate('{mood|unknown}', { mood: 'great' }), 'great');
    });

    test('ternary operator', () => {
      const t = '{notes?yes:no}';
      assert.equal(renderTemplate(t, { notes: 'something' }), 'yes');
      assert.equal(renderTemplate(t, { notes: '' }), 'no');
      assert.equal(renderTemplate(t, {}), 'no');
    });

    test('round modifier', () => {
      assert.equal(renderTemplate('{kg:round(1)}', { kg: 85.456 }), '85.5');
      assert.equal(renderTemplate('{kg:round(0)}', { kg: 85.7 }), '86');
      assert.equal(renderTemplate('{kg:round(2)}', { kg: 85.123456 }), '85.12');
    });

    test('emoji modifier with map lookup', () => {
      const display = {
        emojiMap: {
          mood: { '1': '😩', '2': '😴', '3': '😐', '4': '🙂', '5': '😄' },
        },
      };
      assert.equal(renderTemplate('{mood:emoji}', { mood: 4 }, display), '🙂');
      assert.equal(renderTemplate('{mood:emoji}', { mood: 1 }, display), '😩');
    });

    test('emoji modifier falls back to raw value if no map match', () => {
      const display = { emojiMap: { mood: { '1': '😩' } } };
      assert.equal(renderTemplate('{mood:emoji}', { mood: 99 }, display), '99');
    });

    test('emoji modifier with no display config falls back', () => {
      assert.equal(renderTemplate('{mood:emoji}', { mood: 4 }), '4');
    });

    // Mood-style manifests declare a flat emojiMap
    // ({"1": "😩", ...}) rather than a field-keyed one. The calendar
    // marker and rating input already honour both shapes; the
    // template :emoji modifier should too, so a single source of
    // truth (display.emojiMap) drives the card headline, the
    // calendar markers, and the rating input buttons.
    test('emoji modifier — flat emojiMap shape is also supported', () => {
      const display = {
        emojiMap: { '1': '😩', '2': '😔', '3': '😐', '4': '🙂', '5': '😄' },
      };
      assert.equal(renderTemplate('{mood:emoji}', { mood: 4 }, display), '🙂');
      assert.equal(renderTemplate('{mood:emoji}', { mood: 1 }, display), '😩');
      assert.equal(renderTemplate('{mood:emoji}', { mood: 5 }, display), '😄');
    });

    test('emoji modifier — keyed shape still wins over flat when both resolve', () => {
      // If a card has BOTH a keyed entry for its field AND flat
      // top-level entries, the keyed one takes precedence.
      const display = {
        emojiMap: {
          '1': 'WRONG-FLAT',
          mood: { '1': '😩' },
        },
      };
      assert.equal(renderTemplate('{mood:emoji}', { mood: 1 }, display), '😩');
    });

    test('emoji modifier — flat shape falls back to raw value on miss', () => {
      const display = { emojiMap: { '1': '😩' } };
      assert.equal(renderTemplate('{mood:emoji}', { mood: 99 }, display), '99');
    });

    test('dotted-path access', () => {
      assert.equal(
        renderTemplate('{sleep.deepMinutes}', { sleep: { deepMinutes: 85 } }),
        '85'
      );
    });

    test('emoji + round work independently, ternary handles presence', () => {
      const display = { emojiMap: { mood: { '4': '🙂' } } };
      const t = '{kg:round(1)}kg · {mood:emoji} · {notes?📝:}';
      assert.equal(
        renderTemplate(t, { kg: 85.432, mood: 4, notes: 'felt good' }, display),
        '85.4kg · 🙂 · 📝'
      );
      assert.equal(
        renderTemplate(t, { kg: 86.0, mood: 4, notes: '' }, display),
        '86.0kg · 🙂 · '
      );
    });

    test('non-string template returns empty', () => {
      assert.equal(renderTemplate(null, {}), '');
      assert.equal(renderTemplate(undefined, {}), '');
      assert.equal(renderTemplate(42, {}), '');
    });

    test('truncate modifier cuts long strings + adds ellipsis', () => {
      const long = 'This is a very very very very long note that should be truncated';
      assert.equal(renderTemplate('{note:truncate(20)}', { note: long }), 'This is a very very …');
    });

    test('truncate modifier is a no-op on short strings', () => {
      assert.equal(renderTemplate('{note:truncate(50)}', { note: 'short' }), 'short');
    });

    test('truncate modifier + pipe-default', () => {
      assert.equal(renderTemplate('{note:truncate(10)|empty}', { note: '' }), 'empty');
      assert.equal(renderTemplate('{note:truncate(10)|empty}', {}), 'empty');
    });

    test('literal braces with unresolvable key render empty', () => {
      assert.equal(renderTemplate('{xxx}', { yyy: 1 }), '');
    });

    // #312: render decimal hours as H:MM on cards that surface
    // durations (sleep, in-bed, awake). The on-disk shape stays
    // decimal; this is purely a display-layer modifier.
    describe(':hm modifier (#312)', () => {
      test('integer hours render as H:00', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: 8 }), '8:00');
      });

      test('typical decimal hours render as H:MM', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: 8.17 }), '8:10');
        assert.equal(renderTemplate('{hours:hm}', { hours: 0.92 }), '0:55');
      });

      test('carry boundary: 0.999 hours rounds up to 1:00, not 0:60', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: 0.999 }), '1:00');
      });

      test('null / missing falls back to pipe default or empty', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: null }), '');
        assert.equal(renderTemplate('{hours:hm}', {}), '');
        assert.equal(renderTemplate('{hours:hm|--}', {}), '--');
      });

      test('non-numeric falls back to pipe default or stringified value', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: 'oops' }), 'oops');
        assert.equal(renderTemplate('{hours:hm|--}', { hours: 'oops' }), '--');
      });

      test('negative clamps at 0:00', () => {
        assert.equal(renderTemplate('{hours:hm}', { hours: -1 }), '0:00');
      });
    });

    // #215: booleans used to stringify to "true" / "false" which looked
    // silly on cards like workouts ("{trained} · {type}" → "true · ...").
    // The :check modifier renders a tick when truthy, empty string
    // otherwise, and the ternary shorthand continues to be the flexible
    // escape hatch.
    describe('boolean handling (#215)', () => {
      test(':check modifier — true renders ✅', () => {
        assert.equal(renderTemplate('{trained:check}', { trained: true }), '✅');
      });

      test(':check modifier — false renders empty', () => {
        assert.equal(renderTemplate('{trained:check}', { trained: false }), '');
      });

      test(':check modifier — missing renders empty', () => {
        assert.equal(renderTemplate('{trained:check}', {}), '');
      });

      test(':check modifier — truthy non-bool (string) also renders ✅', () => {
        // Any truthy value is treated as "yes, this happened". Keeps the
        // modifier useful when a manifest upgrades from bool to a richer
        // field without breaking the display.
        assert.equal(renderTemplate('{type:check}', { type: 'Strength' }), '✅');
      });

      test(':check modifier — 0 renders empty (falsy)', () => {
        assert.equal(renderTemplate('{count:check}', { count: 0 }), '');
      });

      test('ternary still works as the flexible bool shorthand', () => {
        assert.equal(
          renderTemplate('{trained?Trained:Rest}', { trained: true }),
          'Trained'
        );
        assert.equal(
          renderTemplate('{trained?Trained:Rest}', { trained: false }),
          'Rest'
        );
      });
    });
  });

  describe('getValue', () => {
    test('flat key', () => {
      assert.equal(getValue({ a: 1 }, 'a'), 1);
    });
    test('dotted path', () => {
      assert.equal(getValue({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
    });
    test('missing path', () => {
      assert.equal(getValue({ a: {} }, 'a.b.c'), undefined);
    });
    test('null midway', () => {
      assert.equal(getValue({ a: null }, 'a.b'), undefined);
    });
  });

  describe('lookupEmoji', () => {
    test('returns emoji for matching value', () => {
      const d = { emojiMap: { mood: { '1': '😩' } } };
      assert.equal(lookupEmoji(d, 'mood', 1), '😩');
      assert.equal(lookupEmoji(d, 'mood', '1'), '😩');
    });
    test('returns null when no map', () => {
      assert.equal(lookupEmoji({}, 'mood', 1), null);
      assert.equal(lookupEmoji(null, 'mood', 1), null);
    });
    test('returns null when no match', () => {
      const d = { emojiMap: { mood: { '1': '😩' } } };
      assert.equal(lookupEmoji(d, 'mood', 99), null);
    });
  });

  describe('applyRound', () => {
    test('normal round', () => {
      assert.equal(applyRound(85.456, 1), '85.5');
    });
    test('zero decimals', () => {
      assert.equal(applyRound(85.5, 0), '86');
    });
    test('non-number input returned unchanged', () => {
      assert.equal(applyRound('abc', 1), 'abc');
    });
  });
});
