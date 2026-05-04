// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.parser.test.js
// Unit tests for the HAE ingest parser/fan-out. No filesystem, no registry.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  TYPES, FAN_OUT, TEMPLATES,
  validatePayload, planWrites, upsertRow,
} = require(path.join(__dirname, '..', 'health-auto-export', 'ingest.js'));

describe('health-auto-export ingest parser', () => {
  describe('validatePayload', () => {
    test('accepts a well-formed sleep payload', () => {
      const v = validatePayload('sleep', { date: '2026-05-01', metrics: { hours: 7.5 } });
      assert.equal(v.ok, true);
      assert.equal(v.payload.date, '2026-05-01');
      assert.deepEqual(v.payload.metrics, { hours: 7.5 });
    });

    test('rejects unsupported type', () => {
      const v = validatePayload('bananas', { date: '2026-05-01', metrics: {} });
      assert.equal(v.ok, false);
      assert.match(v.error, /unsupported type/);
    });

    test('rejects non-object body', () => {
      assert.equal(validatePayload('sleep', null).ok, false);
      assert.equal(validatePayload('sleep', 'hello').ok, false);
      assert.equal(validatePayload('sleep', [1, 2]).ok, false);
    });

    test('rejects bad date', () => {
      assert.equal(validatePayload('sleep', { date: '5/1/26', metrics: {} }).ok, false);
      assert.equal(validatePayload('sleep', { metrics: {} }).ok, false);
    });

    test('rejects missing/non-object metrics', () => {
      assert.equal(validatePayload('sleep', { date: '2026-05-01' }).ok, false);
      assert.equal(validatePayload('sleep', { date: '2026-05-01', metrics: [] }).ok, false);
      assert.equal(validatePayload('sleep', { date: '2026-05-01', metrics: 'x' }).ok, false);
    });
  });

  describe('planWrites (sleep)', () => {
    const D = '2026-05-01';

    test('hours metric fans out to sleep-hours', () => {
      const writes = planWrites('sleep', { date: D, metrics: { hours: 7.5 } });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].targetId, 'sleep-hours');
      assert.deepEqual(writes[0].row, { date: D, hours: 7.5 });
    });

    test('stages metric fans out to sleep-stages with only present fields', () => {
      const writes = planWrites('sleep', {
        date: D,
        metrics: { stages: { core: 4.2, rem: 1.3, deep: 1.5 } },
      });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].targetId, 'sleep-stages');
      assert.deepEqual(writes[0].row, { date: D, core: 4.2, rem: 1.3, deep: 1.5 });
    });

    test('stages with zero recognised fields produces no write', () => {
      const writes = planWrites('sleep', { date: D, metrics: { stages: { nap: 1 } } });
      assert.equal(writes.length, 0);
    });

    test('bedTime + wakeTime both target sleep-bed-wake', () => {
      const writes = planWrites('sleep', {
        date: D,
        metrics: { bedTime: '23:12', wakeTime: '07:05' },
      });
      assert.equal(writes.length, 2);
      assert.ok(writes.every(w => w.targetId === 'sleep-bed-wake'));
      assert.equal(writes[0].row.bedTime, '23:12');
      assert.equal(writes[1].row.wakeTime, '07:05');
    });

    test('empty-string time fields are dropped', () => {
      const writes = planWrites('sleep', {
        date: D,
        metrics: { bedTime: '   ', wakeTime: '07:05' },
      });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].row.wakeTime, '07:05');
      assert.equal('bedTime' in writes[0].row, false);
    });

    test('unknown metric keys are silently ignored', () => {
      const writes = planWrites('sleep', {
        date: D,
        metrics: { hours: 7, nonsense: 'ignored', x: { y: 1 } },
      });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].targetId, 'sleep-hours');
    });

    test('coerces numeric strings', () => {
      const writes = planWrites('sleep', { date: D, metrics: { hours: '7.25' } });
      assert.equal(writes[0].row.hours, 7.25);
    });

    test('non-numeric hours produces no write', () => {
      const writes = planWrites('sleep', { date: D, metrics: { hours: 'many' } });
      assert.equal(writes.length, 0);
    });
  });

  describe('planWrites (activity)', () => {
    const D = '2026-05-01';

    test('steps + activeEnergy + exerciseMinutes + standHours all fan out', () => {
      const writes = planWrites('activity', {
        date: D,
        metrics: {
          steps: 8421,
          activeEnergy: 540,
          exerciseMinutes: 42,
          standHours: 11,
        },
      });
      const byTarget = Object.fromEntries(writes.map(w => [w.targetId, w.row]));
      assert.equal(writes.length, 4);
      assert.equal(byTarget.steps.count, 8421);
      assert.equal(byTarget['active-energy'].kcal, 540);
      assert.equal(byTarget['exercise-minutes'].minutes, 42);
      assert.equal(byTarget['stand-hours'].hours, 11);
    });

    test('sparse payload produces sparse writes', () => {
      const writes = planWrites('activity', { date: D, metrics: { steps: 500 } });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].targetId, 'steps');
    });
  });

  describe('upsertRow', () => {
    test('inserts first row', () => {
      const out = upsertRow([], { date: '2026-05-01', count: 1000 });
      assert.deepEqual(out, [{ date: '2026-05-01', count: 1000 }]);
    });

    test('upserts same-date row, preserves others', () => {
      const existing = [
        { date: '2026-04-30', count: 900 },
        { date: '2026-05-01', count: 1000 },
        { date: '2026-05-02', count: 1200 },
      ];
      const out = upsertRow(existing, { date: '2026-05-01', count: 1500 });
      assert.equal(out.length, 3);
      assert.equal(out.find(r => r.date === '2026-05-01').count, 1500);
      assert.equal(out.find(r => r.date === '2026-04-30').count, 900);
      assert.equal(out.find(r => r.date === '2026-05-02').count, 1200);
    });

    test('merges with prior row on same date (partial writes)', () => {
      const existing = [{ date: '2026-05-01', bedTime: '23:00' }];
      const out = upsertRow(existing, { date: '2026-05-01', wakeTime: '07:00' });
      assert.deepEqual(out[0], { date: '2026-05-01', bedTime: '23:00', wakeTime: '07:00' });
    });

    test('keeps result sorted ascending by date', () => {
      const out = upsertRow(
        [{ date: '2026-05-03', v: 3 }, { date: '2026-05-01', v: 1 }],
        { date: '2026-05-02', v: 2 }
      );
      assert.deepEqual(out.map(r => r.date), ['2026-05-01', '2026-05-02', '2026-05-03']);
    });

    test('non-array prior data is treated as empty', () => {
      const out = upsertRow(null, { date: '2026-05-01', v: 1 });
      assert.deepEqual(out, [{ date: '2026-05-01', v: 1 }]);
    });
  });

  describe('TEMPLATES', () => {
    test('every fan-out targetId has a template', () => {
      for (const type of TYPES) {
        for (const key of Object.keys(FAN_OUT[type])) {
          const out = FAN_OUT[type][key]('2026-05-01', type === 'sleep' && key === 'stages' ? { core: 1 } : (key.endsWith('Time') ? '07:00' : 5));
          if (out) {
            assert.ok(TEMPLATES[out.targetId], `missing template for target ${out.targetId}`);
            assert.equal(TEMPLATES[out.targetId].$schema, 'klebb.datafile.v1');
            assert.equal(TEMPLATES[out.targetId].meta.id, out.targetId);
          }
        }
      }
    });
  });
});
