// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/manifest-path.test.js
// Unit tests for manifests/path.js: the equality-only path language used
// by the row-level chat tools. Pure module, no I/O, no fixtures on disk.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parsePath,
  resolvePath,
  BadPath,
  NoMatch,
  Ambiguous,
  WrongType,
} = require('../manifests/path');

// Minimal manifest-shaped fixture used across resolution tests.
const FIXTURE = {
  items: [
    { name: 'BPC-157', doses: [
      { scheduledDate: '2026-03-25', takenAt: '2026-03-25T03:25:00Z' },
      { scheduledDate: '2026-03-26', takenAt: '2026-03-26T10:50:00Z' },
    ]},
    { name: 'TB-500', doses: [
      { scheduledDate: '2026-03-27', takenAt: '2026-03-27T11:56:00Z' },
    ]},
    { name: 'Klow Stack', doses: [] },
  ],
  groups: [
    { id: 'repair-stack', label: 'Repair Stack' },
  ],
  flags: { active: true, archived: false },
  notes: 'plain string',
};

describe('parsePath: empty + trivial', () => {
  test('empty string returns empty segment list', () => {
    assert.deepEqual(parsePath(''), []);
  });

  test('single segment, no filter', () => {
    assert.deepEqual(parsePath('items'), [{ name: 'items', filter: null }]);
  });

  test('underscore-prefixed identifier', () => {
    assert.deepEqual(parsePath('_archive'), [{ name: '_archive', filter: null }]);
  });

  test('hyphenated identifier mid-name', () => {
    assert.deepEqual(parsePath('repair-stack'), [{ name: 'repair-stack', filter: null }]);
  });

  test('digits inside identifier', () => {
    assert.deepEqual(parsePath('items2'), [{ name: 'items2', filter: null }]);
  });

  test('chained segments', () => {
    assert.deepEqual(parsePath('a.b.c'), [
      { name: 'a', filter: null },
      { name: 'b', filter: null },
      { name: 'c', filter: null },
    ]);
  });
});

describe('parsePath: filters', () => {
  test('double-quoted string literal', () => {
    assert.deepEqual(parsePath('items[name="BPC-157"]'), [
      { name: 'items', filter: { by: 'name', value: 'BPC-157' } },
    ]);
  });

  test('single-quoted string literal', () => {
    assert.deepEqual(parsePath("items[name='BPC-157']"), [
      { name: 'items', filter: { by: 'name', value: 'BPC-157' } },
    ]);
  });

  test('escaped quote inside double-quoted literal', () => {
    assert.deepEqual(parsePath('items[name="say \\"hi\\""]'), [
      { name: 'items', filter: { by: 'name', value: 'say "hi"' } },
    ]);
  });

  test('integer literal', () => {
    assert.deepEqual(parsePath('items[index=3]'), [
      { name: 'items', filter: { by: 'index', value: 3 } },
    ]);
  });

  test('negative integer literal', () => {
    assert.deepEqual(parsePath('items[score=-5]'), [
      { name: 'items', filter: { by: 'score', value: -5 } },
    ]);
  });

  test('decimal number literal', () => {
    assert.deepEqual(parsePath('items[ratio=1.5]'), [
      { name: 'items', filter: { by: 'ratio', value: 1.5 } },
    ]);
  });

  test('true literal', () => {
    assert.deepEqual(parsePath('items[active=true]'), [
      { name: 'items', filter: { by: 'active', value: true } },
    ]);
  });

  test('false literal', () => {
    assert.deepEqual(parsePath('items[active=false]'), [
      { name: 'items', filter: { by: 'active', value: false } },
    ]);
  });

  test('chain with filter on intermediate segment', () => {
    assert.deepEqual(parsePath('items[name="BPC-157"].doses'), [
      { name: 'items', filter: { by: 'name', value: 'BPC-157' } },
      { name: 'doses', filter: null },
    ]);
  });

  test('chain with filters on multiple segments', () => {
    assert.deepEqual(
      parsePath('items[name="BPC-157"].doses[scheduledDate="2026-03-25"]'),
      [
        { name: 'items', filter: { by: 'name', value: 'BPC-157' } },
        { name: 'doses', filter: { by: 'scheduledDate', value: '2026-03-25' } },
      ],
    );
  });

  test('literal containing a closing bracket character is fine inside quotes', () => {
    assert.deepEqual(parsePath('items[name="]"]'), [
      { name: 'items', filter: { by: 'name', value: ']' } },
    ]);
  });

  test('literal containing a dot is fine inside quotes', () => {
    assert.deepEqual(parsePath('items[name="a.b.c"]'), [
      { name: 'items', filter: { by: 'name', value: 'a.b.c' } },
    ]);
  });
});

describe('parsePath: errors', () => {
  function bad(input) {
    try { parsePath(input); }
    catch (e) {
      assert.equal(e.code, 'BAD_PATH');
      assert.ok(e instanceof BadPath, 'expected BadPath instance');
      assert.equal(typeof e.position, 'number');
      return e;
    }
    assert.fail(`expected BadPath for input ${JSON.stringify(input)}`);
  }

  test('null path', () => bad(null));
  test('non-string path', () => bad(123));
  test('lone dot', () => bad('.'));
  test('leading dot', () => bad('.items'));
  test('trailing dot', () => bad('items.'));
  test('double dot', () => bad('items..doses'));
  test('open bracket no close', () => bad('items[name="x"'));
  test('close bracket without open', () => bad('items]'));
  test('filter without equals', () => bad('items[name]'));
  test('filter without value', () => bad('items[name=]'));
  test('unterminated string', () => bad('items[name="hello'));
  test('bare identifier as literal value', () => bad('items[name=foo]'));
  test('digit-leading identifier', () => bad('1items'));
  test('garbage trailing chars', () => bad('items&'));
  test('empty filter brackets', () => bad('items[]'));
  test('hint included for filter-without-equals', () => {
    const e = bad('items[name]');
    assert.ok(typeof e.hint === 'string' && e.hint.length > 0);
  });
});

describe('resolvePath: trivial', () => {
  test('empty segment list returns root', () => {
    const r = resolvePath(FIXTURE, []);
    assert.equal(r.value, FIXTURE);
    assert.equal(r.container, null);
    assert.equal(r.key, null);
  });

  test('single segment property', () => {
    const r = resolvePath(FIXTURE, parsePath('items'));
    assert.equal(r.value, FIXTURE.items);
    assert.equal(r.container, FIXTURE);
    assert.equal(r.key, 'items');
  });

  test('nested object property', () => {
    const r = resolvePath(FIXTURE, parsePath('flags.active'));
    assert.equal(r.value, true);
    assert.equal(r.container, FIXTURE.flags);
    assert.equal(r.key, 'active');
  });
});

describe('resolvePath: filters', () => {
  test('match unique row by string key', () => {
    const r = resolvePath(FIXTURE, parsePath('items[name="BPC-157"]'));
    assert.equal(r.value, FIXTURE.items[0]);
    assert.equal(r.container, FIXTURE.items);
    assert.equal(r.key, 0);
  });

  test('match into row, then descend further', () => {
    const r = resolvePath(FIXTURE, parsePath('items[name="BPC-157"].doses'));
    assert.equal(r.value, FIXTURE.items[0].doses);
    assert.equal(r.container, FIXTURE.items[0]);
    assert.equal(r.key, 'doses');
  });

  test('chained filter to leaf row', () => {
    const r = resolvePath(
      FIXTURE,
      parsePath('items[name="BPC-157"].doses[scheduledDate="2026-03-26"]'),
    );
    assert.equal(r.value, FIXTURE.items[0].doses[1]);
    assert.equal(r.container, FIXTURE.items[0].doses);
    assert.equal(r.key, 1);
  });

  test('index= filter on array', () => {
    const r = resolvePath(FIXTURE, parsePath('items[index=2]'));
    assert.equal(r.value, FIXTURE.items[2]);
    assert.equal(r.key, 2);
  });

  test('index out of range -> NO_MATCH', () => {
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('items[index=99]')),
      e => e.code === 'NO_MATCH',
    );
  });

  test('negative index -> NO_MATCH (not supported)', () => {
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('items[index=-1]')),
      e => e.code === 'NO_MATCH',
    );
  });

  test('filter on empty array -> NO_MATCH', () => {
    const r = resolvePath(FIXTURE, parsePath('items[name="Klow Stack"].doses'));
    assert.equal(r.value, FIXTURE.items[2].doses);
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('items[name="Klow Stack"].doses[scheduledDate="anything"]')),
      e => e.code === 'NO_MATCH',
    );
  });

  test('boolean filter matches', () => {
    const data = { rows: [{flag: true, n: 1}, {flag: false, n: 2}] };
    const r = resolvePath(data, parsePath('rows[flag=true]'));
    assert.deepEqual(r.value, {flag: true, n: 1});
  });

  test('numeric filter does NOT match string-encoded number', () => {
    const data = { rows: [{n: 1}, {n: '1'}] };
    // filter literal 1 (number) only matches the numeric row
    const r = resolvePath(data, parsePath('rows[n=1]'));
    assert.deepEqual(r.value, {n: 1});
  });
});

describe('resolvePath: error codes', () => {
  test('NO_MATCH on missing property', () => {
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('does_not_exist')),
      e => e.code === 'NO_MATCH' && e instanceof NoMatch,
    );
  });

  test('NO_MATCH on filter that finds nothing', () => {
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('items[name="NOPE"]')),
      e => e.code === 'NO_MATCH',
    );
  });

  test('AMBIGUOUS when multiple rows match', () => {
    const data = { rows: [{tag: 'a', n: 1}, {tag: 'a', n: 2}] };
    assert.throws(
      () => resolvePath(data, parsePath('rows[tag="a"]')),
      e => e.code === 'AMBIGUOUS' && e instanceof Ambiguous && e.count === 2,
    );
  });

  test('AMBIGUOUS suppressed when allowMultiple:true', () => {
    const data = { rows: [{tag: 'a', n: 1}, {tag: 'a', n: 2}, {tag: 'b', n: 3}] };
    const r = resolvePath(data, parsePath('rows[tag="a"]'), { allowMultiple: true });
    assert.equal(r.matches.length, 2);
    assert.deepEqual(r.matches[0].value, {tag: 'a', n: 1});
    assert.deepEqual(r.matches[1].value, {tag: 'a', n: 2});
    assert.equal(r.matches[0].key, 0);
    assert.equal(r.matches[1].key, 1);
    assert.equal(r.matches[0].container, data.rows);
  });

  test('WRONG_TYPE: filter on non-array', () => {
    const data = { obj: { a: 1, b: 2 } };
    assert.throws(
      () => resolvePath(data, parsePath('obj[a=1]')),
      e => e.code === 'WRONG_TYPE' && e instanceof WrongType,
    );
  });

  test('WRONG_TYPE: descending into a primitive', () => {
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('notes.subfield')),
      e => e.code === 'WRONG_TYPE',
    );
  });

  test('NO_MATCH: traverse through null', () => {
    const data = { a: null };
    assert.throws(
      () => resolvePath(data, parsePath('a.b')),
      e => e.code === 'NO_MATCH',
    );
  });

  test('WRONG_TYPE: trying to access a property of an array directly', () => {
    // items is an array; bare 'items.length' is not allowed (use [index=N])
    assert.throws(
      () => resolvePath(FIXTURE, parsePath('items.length')),
      e => e.code === 'WRONG_TYPE',
    );
  });
});

describe('resolvePath: container/key let callers mutate via parent', () => {
  test('caller can replace a row through the returned handle', () => {
    const data = { rows: [{name: 'a', n: 1}, {name: 'b', n: 2}] };
    const r = resolvePath(data, parsePath('rows[name="b"]'));
    r.container[r.key] = { name: 'b', n: 99 };
    assert.deepEqual(data.rows[1], { name: 'b', n: 99 });
  });

  test('caller can splice a row out via the returned handle', () => {
    const data = { rows: [{name: 'a'}, {name: 'b'}, {name: 'c'}] };
    const r = resolvePath(data, parsePath('rows[name="b"]'));
    r.container.splice(r.key, 1);
    assert.deepEqual(data.rows.map(x => x.name), ['a', 'c']);
  });

  test('caller can append onto an array reached via path', () => {
    const data = { rows: [{name: 'a'}] };
    const r = resolvePath(data, parsePath('rows'));
    r.value.push({name: 'b'});
    assert.equal(data.rows.length, 2);
  });
});

describe('index= edge cases', () => {
  test('string-valued index= falls through to normal property match', () => {
    const data = { rows: [{ index: 'foo' }, { index: 'bar' }] };
    const r = resolvePath(data, parsePath('rows[index="foo"]'));
    assert.deepEqual(r.value, { index: 'foo' });
  });

  test('index=0 returns the first element', () => {
    const r = resolvePath(FIXTURE, parsePath('items[index=0]'));
    assert.equal(r.value, FIXTURE.items[0]);
  });
});
