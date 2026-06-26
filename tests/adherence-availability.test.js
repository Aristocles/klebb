// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/adherence-availability.test.js
// Unit tests for the adherence-sparkline availability proxy (#456): the
// predicate that gates the "Show adherence sparkline" toggle in the
// checklist + schedule settings panels, plus the data-shape resolver.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasAdherenceSignal, adherenceItems } from '../public/js/lib/adherence-series.esm.js';
import { adherenceSparklineDescriptor } from '../public/js/lib/card-settings.js';

describe('adherenceItems', () => {
  test('unwraps the three accepted data shapes', () => {
    assert.deepEqual(adherenceItems([{ name: 'a' }]), [{ name: 'a' }]);
    assert.deepEqual(adherenceItems({ items: [{ name: 'b' }] }), [{ name: 'b' }]);
    assert.deepEqual(adherenceItems({ current: [{ name: 'c' }] }), [{ name: 'c' }]);
  });
  test('returns [] for null/garbage', () => {
    assert.deepEqual(adherenceItems(null), []);
    assert.deepEqual(adherenceItems({}), []);
    assert.deepEqual(adherenceItems(42), []);
  });
});

describe('hasAdherenceSignal', () => {
  test('false on empty / non-array', () => {
    assert.equal(hasAdherenceSignal([]), false);
    assert.equal(hasAdherenceSignal(null), false);
  });
  test('true when an item carries a schedule, cycles, or frequency', () => {
    assert.equal(hasAdherenceSignal([{ name: 'x', schedule: { time_of_day: 'morning' } }]), true);
    assert.equal(hasAdherenceSignal([{ name: 'x', cycles: [{}] }]), true);
    assert.equal(hasAdherenceSignal([{ name: 'x', frequency: 'daily' }]), true);
  });
  test('true once >=2 distinct check-off dates exist (takenDates)', () => {
    assert.equal(hasAdherenceSignal([{ name: 'x', takenDates: ['2026-06-01', '2026-06-02'] }]), true);
  });
  test('true once >=2 distinct dosed dates exist (doses across items)', () => {
    const items = [
      { name: 'a', doses: [{ scheduledDate: '2026-06-01', takenAt: 't' }] },
      { name: 'b', doses: [{ scheduledDate: '2026-06-02', takenAt: 't' }] },
    ];
    assert.equal(hasAdherenceSignal(items), true);
  });
  test('false for a single untracked, unscheduled check-off', () => {
    assert.equal(hasAdherenceSignal([{ name: 'x', takenDates: ['2026-06-01'] }]), false);
    // a dose with no takenAt is not signal
    assert.equal(hasAdherenceSignal([{ name: 'x', doses: [{ scheduledDate: '2026-06-01' }] }]), false);
  });
});

describe('adherenceSparklineDescriptor', () => {
  const d = adherenceSparklineDescriptor(hasAdherenceSignal, adherenceItems);
  test('targets meta.view.showSparkline and needs data', () => {
    assert.equal(d.path, 'view.showSparkline');
    assert.equal(d.kind, 'toggle');
    assert.equal(d.needsData, true);
  });
  test('availableWhen drives off the injected predicate + data shape', () => {
    assert.equal(d.availableWhen({ data: { items: [{ schedule: {} }] } }), true);
    assert.equal(d.availableWhen({ data: { items: [{ name: 'lonely' }] } }), false);
    assert.equal(d.availableWhen({ data: null }), false);
  });
});
