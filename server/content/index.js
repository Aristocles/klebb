// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// server/content/index.js
// Reads templates/ and prompts/ from disk on each request and returns them
// as JSON. No in-memory cache: directories are small, content changes rarely,
// and the cost of staleness (a contributor adds a template, doesn't see it)
// outweighs the cost of a couple of disk reads per hit.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

function listTemplates({ log = console.warn } = {}) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') log('[content] templates dir read failed:', e.message);
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.klebb.json')) continue;
    const full = path.join(TEMPLATES_DIR, ent.name);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      log(`[content] templates/${ent.name}: read failed: ${e.message}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log(`[content] templates/${ent.name}: parse failed: ${e.message}`);
      continue;
    }
    const t = parsed && parsed.meta && parsed.meta.template;
    if (!t || !t.id || !t.title || !t.summary || !t.category || !Array.isArray(t.tags)) {
      log(`[content] templates/${ent.name}: missing or incomplete meta.template`);
      continue;
    }
    out.push({
      id: t.id,
      title: t.title,
      summary: t.summary,
      category: t.category,
      tags: t.tags,
      manifest: parsed,
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

// Parse YAML frontmatter + body. Matches the tolerant parser used in tests.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const body = raw.slice(m[0].length);
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
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

function listPrompts({ log = console.warn } = {}) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(PROMPTS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') log('[content] prompts dir read failed:', e.message);
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.md')) continue;
    const full = path.join(PROMPTS_DIR, ent.name);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      log(`[content] prompts/${ent.name}: read failed: ${e.message}`);
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      log(`[content] prompts/${ent.name}: missing frontmatter`);
      continue;
    }
    const { frontmatter, body } = parsed;
    if (!frontmatter.title || !frontmatter.summary || !Array.isArray(frontmatter.tags)) {
      log(`[content] prompts/${ent.name}: frontmatter missing title/summary/tags`);
      continue;
    }
    out.push({
      id: ent.name.replace(/\.md$/, ''),
      title: frontmatter.title,
      summary: frontmatter.summary,
      tags: frontmatter.tags,
      body: body.trim(),
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

module.exports = { listTemplates, listPrompts };
