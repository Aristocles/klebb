// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/sparkline.test.js
// Unit tests for the pure sparkline maths. The eh-sparkline component
// itself imports Lit from a CDN and needs a DOM, so it is not loadable
// under Node; these cover the scaling/path/summary logic it delegates.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { MIN_POINTS, buildSparklinePath, referenceY, summarise } =
  require('../public/js/lib/sparkline.js');

const opts = { width: 64, height: 22, pad: 2 };

function pairs(points) {
  return points === '' ? [] : points.trim().split(/\s+/);
}

describe('buildSparklinePath', () => {
  test('N >= 2 values produce a points string with N coordinate pairs', () => {
    const built = buildSparklinePath([1, 2, 3, 4], opts);
    assert.equal(built.count, 4);
    const p = pairs(built.points);
    assert.equal(p.length, 4);
    for (const pair of p) {
      const [x, y] = pair.split(',').map(Number);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
  });

  test('fewer than two finite points renders nothing', () => {
    assert.equal(buildSparklinePath([5], opts).points, '');
    assert.equal(buildSparklinePath([], opts).points, '');
    assert.equal(buildSparklinePath([null, 5, null], opts).points, '');
    assert.equal(buildSparklinePath(undefined, opts).count, 0);
  });

  test('MIN_POINTS is 2', () => {
    assert.equal(MIN_POINTS, 2);
  });

  test('flat series does not divide-by-zero', () => {
    const built = buildSparklinePath([7, 7, 7], opts);
    assert.equal(built.count, 3);
    for (const pair of pairs(built.points)) {
      const [x, y] = pair.split(',').map(Number);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(!Number.isNaN(y));
    }
  });

  test('nulls are skipped but later points stay positioned', () => {
    const built = buildSparklinePath([1, null, 3, 4], opts);
    assert.equal(built.count, 3);
    const xs = pairs(built.points).map(p => Number(p.split(',')[0]));
    // First point pinned left, last point pinned right; the gap leaves
    // a wider x-step where the null was dropped.
    assert.equal(xs[0], 2);
    assert.equal(xs[xs.length - 1], 62);
    assert.ok(xs[1] > xs[0] + (xs[xs.length - 1] - xs[0]) / 3);
  });

  test('y is inverted: larger values sit higher (smaller y)', () => {
    const built = buildSparklinePath([0, 10], opts);
    const [, y0] = pairs(built.points)[0].split(',').map(Number);
    const [, y1] = pairs(built.points)[1].split(',').map(Number);
    assert.ok(y1 < y0, 'the higher value should have the smaller y');
  });

  test('lastPoint is the final coordinate', () => {
    const built = buildSparklinePath([1, 2, 3], opts);
    const last = pairs(built.points).at(-1).split(',').map(Number);
    assert.equal(built.lastPoint.x, last[0]);
    assert.equal(built.lastPoint.y, last[1]);
  });
});

describe('referenceY', () => {
  test('null/unset reference returns null', () => {
    assert.equal(referenceY([1, 2, 3], null, opts), null);
    assert.equal(referenceY([1, 2, 3], undefined, opts), null);
  });

  test('a set baseline scales into the same viewBox', () => {
    const y = referenceY([0, 10], 5, opts);
    assert.ok(Number.isFinite(y));
    assert.ok(y > 2 && y < 20);
  });

  test('no trend (fewer than two points) has no reference', () => {
    assert.equal(referenceY([5], 5, opts), null);
  });
});

describe('summarise', () => {
  test('reports downward direction and the latest value', () => {
    const s = summarise([90, 85, 81.2]);
    assert.equal(s.direction, 'down');
    assert.equal(s.latest, 81.2);
    assert.equal(s.label, 'trend down, latest 81.2');
  });

  test('reports upward direction', () => {
    assert.equal(summarise([1, 2, 3]).direction, 'up');
  });

  test('equal last two points read as flat', () => {
    assert.equal(summarise([3, 5, 5]).direction, 'flat');
  });

  test('nulls are skipped when finding the latest value', () => {
    const s = summarise([1, 2, null]);
    assert.equal(s.latest, 2);
    assert.equal(s.direction, 'up');
  });

  test('empty input is safe', () => {
    const s = summarise([]);
    assert.equal(s.latest, null);
    assert.equal(s.label, 'no data');
  });
});
