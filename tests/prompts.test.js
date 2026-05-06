// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/prompts.test.js
// Validates every prompts/*.md carries complete frontmatter. Prompts are
// user-facing content that will be pasted into the chat agent's input; a
// missing title or summary would leave the gallery with blank rows.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// Minimal YAML frontmatter parser: top-level keys only, array values via
// [a, b, c] syntax. Good enough for our controlled prompt files.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const body = raw.slice(m[0].length);
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/i);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function listPrompts() {
  if (!fs.existsSync(PROMPTS_DIR)) return [];
  return fs.readdirSync(PROMPTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(PROMPTS_DIR, f));
}

describe('prompts/ directory', () => {
  test('exists and contains at least 6 prompts', () => {
    const files = listPrompts();
    assert.ok(files.length >= 6, `expected >= 6 prompts, found ${files.length}`);
  });

  test('includes the onboarding meta-prompt', () => {
    const files = listPrompts().map(f => path.basename(f));
    assert.ok(
      files.includes('new-to-klebb.md'),
      'new-to-klebb.md is required as the conversational onboarding prompt',
    );
  });
});

const files = listPrompts();
for (const file of files) {
  const name = path.basename(file);
  describe(`prompt: ${name}`, () => {
    const raw = fs.readFileSync(file, 'utf8');

    test('has valid YAML frontmatter', () => {
      const parsed = parseFrontmatter(raw);
      assert.ok(parsed, `missing frontmatter block in ${name}`);
    });

    test('frontmatter has required fields', () => {
      const { frontmatter } = parseFrontmatter(raw);
      assert.ok(typeof frontmatter.title === 'string' && frontmatter.title.length > 0,
        'title required');
      assert.ok(typeof frontmatter.summary === 'string' && frontmatter.summary.length > 0,
        'summary required');
      assert.ok(Array.isArray(frontmatter.tags),
        'tags required (even if empty list)');
    });

    test('body is non-empty prose', () => {
      const { body } = parseFrontmatter(raw);
      assert.ok(body.trim().length > 50,
        `${name} body is suspiciously short (<50 chars)`);
    });
  });
}
