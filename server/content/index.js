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
      // Optional gallery presentation hints.
      emoji: typeof parsed.meta.emoji === 'string' ? parsed.meta.emoji : (t.emoji || null),
      featured: t.featured === true,
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

// Derive a unique manifest id from a base, avoiding collisions with the
// ids already taken. "weight" -> "weight", then "weight-2", "weight-3"…
function uniqueId(base, takenIds) {
  const taken = new Set(takenIds || []);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// Recursively replace {{string:KEY}} placeholders in a manifest with the
// resolved values. Only string leaves are touched. An unresolved
// placeholder (no value supplied) collapses to '' so the result is always
// a clean manifest, never a literal {{...}} left in the data.
function fillPlaceholders(node, values) {
  if (typeof node === 'string') {
    return node.replace(/\{\{string:([a-z0-9_]+)\}\}/gi, (_, key) => {
      const v = values[key];
      return (v === undefined || v === null) ? '' : String(v);
    });
  }
  if (Array.isArray(node)) return node.map(n => fillPlaceholders(n, values));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = fillPlaceholders(node[k], values);
    return out;
  }
  return node;
}

// Turn a template manifest into a ready-to-create manifest:
//   - resolve {{string:id|label|unit|…}} from meta.template.defaults,
//     overriding the id with a unique one derived from the template id;
//   - strip the meta.template block (authoring metadata, never shipped on
//     a real card).
// `takenIds` is the set of manifest ids already in use, for dedup.
// Returns { id, manifest } or throws if the template has no meta.template.
function instantiateTemplate(templateManifest, takenIds = []) {
  const tmpl = templateManifest && templateManifest.meta && templateManifest.meta.template;
  if (!tmpl || !tmpl.id) {
    throw new Error('not a template: missing meta.template.id');
  }
  const defaults = (tmpl.defaults && typeof tmpl.defaults === 'object') ? tmpl.defaults : {};
  const id = uniqueId(tmpl.id, takenIds);
  // Values for placeholder substitution: defaults provide label/unit/etc.,
  // and the deduped id always wins for the `id` placeholder.
  const values = { ...defaults, id, label: defaults.label || tmpl.title };

  // Deep clone, fill, then drop the authoring block.
  const filled = fillPlaceholders(JSON.parse(JSON.stringify(templateManifest)), values);
  if (filled.meta) delete filled.meta.template;
  // Hard-guarantee the id even if the template didn't placeholder it.
  filled.meta.id = id;

  return { id, manifest: filled };
}

module.exports = { listTemplates, listPrompts, instantiateTemplate, fillPlaceholders, uniqueId };
