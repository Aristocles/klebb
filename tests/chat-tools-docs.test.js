// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tools-docs.test.js
//
// Covers the read_doc chat tool: TOOL_DEFS membership, the docs
// module's allowlist + traversal protections, and the system-prompt
// catalogue block.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const {
  DOC_INDEX, listDocs, readDoc, describeDocsCatalogue,
} = require('../chat/docs');
const { TOOL_DEFS, dispatchToolCall } = require('../chat/tools');

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

describe('chat/docs: index integrity', () => {
  test('every allowlisted doc actually exists on disk', () => {
    for (const entry of DOC_INDEX) {
      const abs = path.resolve(REPO_ROOT, entry.path);
      assert.ok(
        fs.existsSync(abs),
        `DOC_INDEX entry ${entry.path} does not exist on disk`,
      );
    }
  });

  test('every entry carries a non-empty summary', () => {
    for (const entry of DOC_INDEX) {
      assert.ok(entry.summary && entry.summary.length > 5,
        `DOC_INDEX entry ${entry.path} missing summary`);
    }
  });

  test('listDocs returns a copy, not the live array', () => {
    const a = listDocs();
    const b = listDocs();
    assert.notStrictEqual(a, b);
    assert.deepEqual(a, b);
  });
});

describe('chat/docs.readDoc: success path', () => {
  test('reads README.md and returns content + path', () => {
    const res = readDoc('README.md');
    assert.equal(res.path, 'README.md');
    assert.ok(typeof res.content === 'string');
    assert.ok(res.content.length > 0);
    assert.equal(res.error, undefined);
  });

  test('reads docs/CARDS.md (subdir path) without traversal', () => {
    const res = readDoc('docs/CARDS.md');
    assert.equal(res.path, 'docs/CARDS.md');
    assert.ok(res.content.length > 0);
  });

  test('accepts backslash-style paths by normalising to POSIX', () => {
    const res = readDoc('docs\\CARDS.md');
    assert.equal(res.path, 'docs/CARDS.md');
    assert.ok(res.content.length > 0);
  });
});

describe('chat/docs.readDoc: rejection path', () => {
  test('rejects unknown allowlist entries', () => {
    const res = readDoc('docs/SOMETHING-MADE-UP.md');
    assert.match(res.error, /unknown doc/);
  });

  test('rejects relative traversal (../package.json)', () => {
    const res = readDoc('../package.json');
    assert.match(res.error, /unknown doc/);
  });

  test('rejects normalised traversal (docs/../config/env.js)', () => {
    const res = readDoc('docs/../config/env.js');
    assert.match(res.error, /unknown doc/);
  });

  test('rejects absolute paths', () => {
    const res = readDoc('/etc/passwd');
    assert.match(res.error, /unknown doc/);
  });

  test('rejects gitignored hygiene-risk files even if they exist', () => {
    // CLAUDE.md and BRIEF-FOR-CC.md are gitignored operator-only files;
    // they must not be reachable through this tool.
    const a = readDoc('CLAUDE.md');
    const b = readDoc('BRIEF-FOR-CC.md');
    assert.match(a.error, /unknown doc/);
    assert.match(b.error, /unknown doc/);
  });

  test('rejects empty / non-string input', () => {
    assert.match(readDoc('').error, /required/);
    assert.match(readDoc(null).error, /required/);
    assert.match(readDoc(undefined).error, /required/);
    assert.match(readDoc(42).error, /required/);
  });
});

describe('chat/docs.describeDocsCatalogue', () => {
  test('emits a markdown catalogue with every allowlisted path', () => {
    const out = describeDocsCatalogue();
    assert.match(out, /## Available docs/);
    assert.match(out, /read_doc/);
    for (const entry of DOC_INDEX) {
      assert.ok(out.includes('`' + entry.path + '`'),
        `catalogue missing ${entry.path}`);
    }
  });
});

describe('chat tools: read_doc', () => {
  test('TOOL_DEFS includes read_doc with the expected schema shape', () => {
    const def = TOOL_DEFS.find(t => t.function?.name === 'read_doc');
    assert.ok(def, 'read_doc not registered');
    assert.equal(def.type, 'function');
    assert.deepEqual(def.function.parameters.required, ['path']);
    assert.equal(def.function.parameters.properties.path.type, 'string');
    assert.equal(def.function.parameters.additionalProperties, false);
  });

  test('dispatchToolCall(read_doc) returns stringified content for a real doc', () => {
    const out = dispatchToolCall(makeToolCall('read_doc', { path: 'README.md' }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.path, 'README.md');
    assert.ok(parsed.content.length > 0);
  });

  test('dispatchToolCall(read_doc) returns {error} for unknown path', () => {
    const out = dispatchToolCall(makeToolCall('read_doc', { path: 'docs/nope.md' }));
    const parsed = JSON.parse(out);
    assert.match(parsed.error, /unknown doc/);
  });

  test('dispatchToolCall(read_doc) rejects path traversal at the tool layer too', () => {
    const out = dispatchToolCall(makeToolCall('read_doc', { path: '../package.json' }));
    const parsed = JSON.parse(out);
    assert.match(parsed.error, /unknown doc/);
  });
});
