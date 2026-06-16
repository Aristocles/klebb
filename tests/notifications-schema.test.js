// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-schema.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNotifications } = require('../manifests/notifications-schema');

const VALID_ITEM = {
  id: 'evening-log',
  label: 'Evening mood log',
  title: 'Mood',
  body: 'How are you feeling?',
  trigger: { type: 'daily', time: '20:00' },
};

test.describe('validateNotifications: lenient mode (load-time)', () => {
  test('returns undefined for null/undefined input', () => {
    assert.equal(validateNotifications(null), undefined);
    assert.equal(validateNotifications(undefined), undefined);
  });

  test('drops bad items silently and returns the cleaned block', () => {
    const out = validateNotifications({
      enabled: true,
      items: [
        VALID_ITEM,
        { id: '!!bad-id', label: 'x', title: 'x', body: 'x', trigger: { type: 'daily', time: '08:00' } },
        { id: 'no-trigger', label: 'x', title: 'x', body: 'x' },
      ],
    });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].id, 'evening-log');
  });

  test('caps items[] at 10 silently', () => {
    const items = [];
    for (let i = 0; i < 15; i++) {
      items.push({ ...VALID_ITEM, id: `item-${i}` });
    }
    const out = validateNotifications({ items });
    assert.equal(out.items.length, 10);
  });

  test('treats unknown trigger types as malformed (drops)', () => {
    const out = validateNotifications({
      items: [
        { ...VALID_ITEM, trigger: { type: 'interval', every_days: 7, time: '08:00' } },
      ],
    });
    assert.equal(out.items.length, 0);
  });

  test('normalises defaults: privacy=private, default=on, items[] always present', () => {
    const out = validateNotifications({ items: [VALID_ITEM] });
    assert.equal(out.enabled, true);
    assert.equal(out.items[0].privacy, 'private');
    assert.equal(out.items[0].default, 'on');
  });

  test('respects enabled:false', () => {
    const out = validateNotifications({ enabled: false, items: [VALID_ITEM] });
    assert.equal(out.enabled, false);
  });
});

test.describe('validateNotifications: strict mode (create / PATCH)', () => {
  function expectFail(input, msgRe) {
    assert.throws(
      () => validateNotifications(input, { strict: true }),
      e => msgRe.test(e.message),
    );
  }

  test('rejects non-object', () => {
    expectFail([], /must be an object/);
    expectFail('x', /must be an object/);
  });

  test('rejects items.length > 10', () => {
    const items = [];
    for (let i = 0; i < 11; i++) items.push({ ...VALID_ITEM, id: `item-${i}` });
    expectFail({ items }, /exceeds the cap/);
  });

  test('rejects malformed id', () => {
    expectFail({ items: [{ ...VALID_ITEM, id: 'BAD' }] }, /item.id missing or invalid/);
    expectFail({ items: [{ ...VALID_ITEM, id: '-startswithdash' }] }, /item.id missing or invalid/);
  });

  test('rejects duplicate ids', () => {
    expectFail({
      items: [VALID_ITEM, { ...VALID_ITEM }],
    }, /duplicate item.id/);
  });

  test('rejects missing required strings', () => {
    expectFail({ items: [{ ...VALID_ITEM, label: '' }] }, /label must be/);
    expectFail({ items: [{ ...VALID_ITEM, title: undefined }] }, /title must be/);
    expectFail({ items: [{ ...VALID_ITEM, body: 123 }] }, /body must be/);
  });

  test('rejects oversize strings', () => {
    expectFail({ items: [{ ...VALID_ITEM, title: 'x'.repeat(31) }] }, /title must be/);
    expectFail({ items: [{ ...VALID_ITEM, body: 'x'.repeat(81) }] }, /body must be/);
    expectFail({ items: [{ ...VALID_ITEM, label: 'x'.repeat(81) }] }, /label must be/);
  });

  test('rejects bad trigger types and times', () => {
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'interval', time: '08:00' } }] }, /trigger.type/);
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'daily', time: '8:00' } }] }, /trigger.time/);
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'daily', time: '24:00' } }] }, /trigger.time/);
  });

  test('rejects weekly without days[] or with bad day strings', () => {
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'weekly', time: '20:00' } }] }, /days/);
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'weekly', time: '20:00', days: [] } }] }, /days/);
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'weekly', time: '20:00', days: ['mon', 'mon'] } }] }, /days/);
    expectFail({ items: [{ ...VALID_ITEM, trigger: { type: 'weekly', time: '20:00', days: ['monday'] } }] }, /days/);
  });

  test('rejects malformed action', () => {
    expectFail({ items: [{ ...VALID_ITEM, action: { type: 'navigate' } }] }, /action.type/);
    expectFail({ items: [{ ...VALID_ITEM, action: { type: 'open-card', intent: 'log-now' } }] }, /action.intent/);
    expectFail({ items: [{ ...VALID_ITEM, action: { type: 'open-card', card: 'BAD!' } }] }, /action.card/);
  });

  test('rejects bad privacy / default values', () => {
    expectFail({ items: [{ ...VALID_ITEM, privacy: 'opaque' }] }, /privacy must be/);
    expectFail({ items: [{ ...VALID_ITEM, default: 'maybe' }] }, /default must be/);
  });

  test('accepts the canonical happy path', () => {
    const out = validateNotifications({
      enabled: true,
      items: [
        VALID_ITEM,
        {
          id: 'mw-mood',
          label: 'Mon/Wed/Fri',
          title: 'Mood',
          body: 'How are you feeling?',
          trigger: { type: 'weekly', time: '08:00', days: ['mon', 'wed', 'fri'] },
          privacy: 'public',
          default: 'off',
        },
      ],
    }, { strict: true });
    assert.equal(out.items.length, 2);
    assert.equal(out.items[1].privacy, 'public');
    assert.equal(out.items[1].default, 'off');
    assert.deepEqual(out.items[1].trigger.days, ['mon', 'wed', 'fri']);
  });
});

test.describe('validateNotifications: schedule_due trigger', () => {
  const VALID_SCHED_DUE = {
    id: 'morning-jab',
    label: 'Morning injection',
    title: 'Injection',
    body: 'Time for {schedule_due}{missed_earlier}',
    trigger: {
      type: 'schedule_due',
      card: 'peptide-cycle',
      time_of_day: 'morning',
      time: '08:00',
    },
  };

  test('strict accepts a well-formed schedule_due item', () => {
    const out = validateNotifications({ items: [VALID_SCHED_DUE] }, { strict: true });
    assert.equal(out.items.length, 1);
    assert.deepEqual(out.items[0].trigger, {
      type: 'schedule_due',
      card: 'peptide-cycle',
      time_of_day: 'morning',
      time: '08:00',
    });
  });

  test('strict rejects missing trigger.card', () => {
    const bad = { ...VALID_SCHED_DUE, trigger: { type: 'schedule_due', time_of_day: 'morning', time: '08:00' } };
    assert.throws(
      () => validateNotifications({ items: [bad] }, { strict: true }),
      /trigger.card/,
    );
  });

  test('strict rejects malformed trigger.card pattern', () => {
    const bad = { ...VALID_SCHED_DUE, trigger: { ...VALID_SCHED_DUE.trigger, card: 'BAD!' } };
    assert.throws(
      () => validateNotifications({ items: [bad] }, { strict: true }),
      /trigger.card/,
    );
  });

  test('strict rejects unknown time_of_day token', () => {
    const bad = { ...VALID_SCHED_DUE, trigger: { ...VALID_SCHED_DUE.trigger, time_of_day: 'dawn' } };
    assert.throws(
      () => validateNotifications({ items: [bad] }, { strict: true }),
      /time_of_day/,
    );
  });

  test('strict rejects time_of_day as an array (single token only on the trigger)', () => {
    const bad = { ...VALID_SCHED_DUE, trigger: { ...VALID_SCHED_DUE.trigger, time_of_day: ['morning', 'evening'] } };
    assert.throws(
      () => validateNotifications({ items: [bad] }, { strict: true }),
      /time_of_day/,
    );
  });

  test('strict rejects bad trigger.time alongside schedule_due', () => {
    const bad = { ...VALID_SCHED_DUE, trigger: { ...VALID_SCHED_DUE.trigger, time: '8:00' } };
    assert.throws(
      () => validateNotifications({ items: [bad] }, { strict: true }),
      /trigger.time/,
    );
  });

  test('lenient drops schedule_due item with bad time_of_day', () => {
    const out = validateNotifications({
      items: [
        { ...VALID_SCHED_DUE, trigger: { ...VALID_SCHED_DUE.trigger, time_of_day: 'lunchtime' } },
      ],
    });
    assert.equal(out.items.length, 0);
  });
});
