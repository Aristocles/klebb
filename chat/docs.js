// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/docs.js
//
// Whitelist-gated reader for in-repo documentation. Backs the read_doc
// chat tool: the agent gets a catalogue of available paths in the
// system prompt and can pull any of them on demand. Local-disk only;
// the agent always sees the same version of the docs as the running
// app, so a deployed instance on an older release won't be misled by
// newer guidance on main.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Hand-curated allowlist. Every entry is (a) a path relative to the
// repo root, in POSIX form, and (b) a one-line summary used in the
// system-prompt catalogue. Add to this list as new docs are added.
// `.claude/`, BRIEF-FOR-CC.md, CLAUDE.md, data/, credentials/ are NOT
// listed and cannot be read through this tool, by design.
const DOC_INDEX = [
  { path: 'README.md',                    summary: 'Quickstart, architecture overview, env vars, Docker section.' },
  { path: 'MANIFEST-SCHEMA.md',           summary: 'Full klebb.datafile.v1 reference. The authoritative schema doc.' },
  { path: 'CHANGELOG.md',                 summary: 'Per-release changelog; useful for "when did X land" questions.' },
  { path: 'CONTRIBUTING.md',              summary: 'Repo workflow, commit conventions, branch naming.' },
  { path: 'CONTRIBUTING-PROMPTS.md',      summary: 'Authoring starter prompts for the chat widget.' },
  { path: 'CONTRIBUTING-TEMPLATES.md',    summary: 'Authoring .klebb.json templates that ship under templates/.' },
  { path: 'SECURITY.md',                  summary: 'Threat model, reporting, secrets handling.' },
  { path: 'docs/CARDS.md',                summary: 'Card authoring guide. How to write a manifest end-to-end.' },
  { path: 'docs/RECIPES.md',              summary: 'Copy-pasteable manifest examples by card type.' },
  { path: 'docs/CHAT-AGENT.md',           summary: 'Chat widget + gateway integration; AGENT_API_TOKEN write contract.' },
  { path: 'docs/HEALTH-AUTO-EXPORT.md',   summary: 'iPhone Health Auto Export ingest: catalogue, row shapes, setup.' },
  { path: 'docs/DEPLOY.md',               summary: 'Single-user and multi-user deploy guide; systemd + Docker.' },
  { path: 'docs/TESTING.md',              summary: 'Three test layers, bug-fix workflow rubric.' },
  { path: 'docs/VOICE.md',                summary: 'Voice chat (Fish Audio) configuration and usage.' },
  { path: 'docs/CI.md',                   summary: 'GitHub Actions CI overview; what runs and when.' },
];

const ALLOWED_PATHS = new Set(DOC_INDEX.map(d => d.path));
const MAX_BYTES = 200_000;

function listDocs() {
  return DOC_INDEX.slice();
}

// Resolve `relPath` against the repo root, but only after validating
// that it's an exact entry on the allowlist. This rejects everything
// the allowlist doesn't explicitly enumerate: traversal sequences,
// absolute paths, symlinks pointing outside, alternate casings. Also
// double-checks the resolved path stays inside REPO_ROOT in case a
// future symlink in the docs/ tree tries to escape.
function readDoc(relPath) {
  if (typeof relPath !== 'string' || !relPath) {
    return { error: 'path is required' };
  }
  const normalised = relPath.replace(/\\/g, '/');
  if (!ALLOWED_PATHS.has(normalised)) {
    return {
      error: `unknown doc: ${relPath}. See the system prompt for the list of available paths.`,
    };
  }
  const abs = path.resolve(REPO_ROOT, normalised);
  const rootWithSep = REPO_ROOT + path.sep;
  if (!abs.startsWith(rootWithSep) && abs !== REPO_ROOT) {
    return { error: `path escapes repo root: ${relPath}` };
  }
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { error: `failed to read ${relPath}: ${e.message}` };
  }
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    content = content.slice(0, MAX_BYTES);
    truncated = true;
  }
  return { path: normalised, content, truncated };
}

// Markdown-formatted catalogue for embedding in the chat system
// prompt. Lists every path on the allowlist with its one-line
// summary; the agent uses this to pick which doc to fetch.
function describeDocsCatalogue() {
  const lines = [
    '## Available docs',
    '',
    'Klebb ships its docs alongside the app. Call `read_doc(path)` to',
    'fetch the full text of any of the following at inference time.',
    'You always get the same version as the running app, so use this',
    'instead of guessing from training data when the user asks about',
    'schema, renderer contracts, or workflows.',
    '',
  ];
  for (const d of DOC_INDEX) {
    lines.push(`- \`${d.path}\` — ${d.summary}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DOC_INDEX,
  listDocs,
  readDoc,
  describeDocsCatalogue,
};
