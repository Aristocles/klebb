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
// repo root, in POSIX form, (b) a one-line summary used in the
// system-prompt catalogue, and (c) a `kind` ('doc' | 'source') so the
// catalogue can group documentation separately from renderer source.
// Add to this list as new docs are added; renderer source must be
// added manually (no globbing) so each new exposure is a deliberate
// choice.
//
// `.claude/`, BRIEF-FOR-CC.md, CLAUDE.md, data/, credentials/,
// sessions/, .env, anything under server.js / chat/ / manifests/ etc.
// are NOT listed and cannot be read through this tool, by design.
const DOC_INDEX = [
  // --- Documentation ---
  { kind: 'doc', path: 'README.md',                    summary: 'Quickstart, architecture overview, env vars, Docker section.' },
  { kind: 'doc', path: 'MANIFEST-SCHEMA.md',           summary: 'Full klebb.datafile.v1 reference. The authoritative schema doc.' },
  { kind: 'doc', path: 'CHANGELOG.md',                 summary: 'Per-release changelog; useful for "when did X land" questions.' },
  { kind: 'doc', path: 'CONTRIBUTING.md',              summary: 'Repo workflow, commit conventions, branch naming.' },
  { kind: 'doc', path: 'CONTRIBUTING-PROMPTS.md',      summary: 'Authoring starter prompts for the chat widget.' },
  { kind: 'doc', path: 'CONTRIBUTING-TEMPLATES.md',    summary: 'Authoring .klebb.json templates that ship under templates/.' },
  { kind: 'doc', path: 'SECURITY.md',                  summary: 'Threat model, reporting, secrets handling.' },
  { kind: 'doc', path: 'docs/CARDS.md',                summary: 'Card authoring guide. Includes the Renderer behaviour reference (reads/writes/ignores per renderer).' },
  { kind: 'doc', path: 'docs/RECIPES.md',              summary: 'Copy-pasteable manifest examples by card type.' },
  { kind: 'doc', path: 'docs/CHAT-AGENT.md',           summary: 'Chat widget + gateway integration; AGENT_API_TOKEN write contract.' },
  { kind: 'doc', path: 'docs/HEALTH-AUTO-EXPORT.md',   summary: 'iPhone Health Auto Export ingest: catalogue, row shapes, setup.' },
  { kind: 'doc', path: 'docs/DEPLOY.md',               summary: 'Single-user and multi-user deploy guide; systemd + Docker.' },
  { kind: 'doc', path: 'docs/DEMO.md',                 summary: 'Running a public Klebb demo (KLEBB_DEMO=1, hourly reset cron, image-tag gotchas).' },
  { kind: 'doc', path: 'docs/TESTING.md',              summary: 'Three test layers, bug-fix workflow rubric.' },
  { kind: 'doc', path: 'docs/VOICE.md',                summary: 'Voice chat (Fish Audio) configuration and usage.' },
  { kind: 'doc', path: 'docs/CI.md',                   summary: 'GitHub Actions CI overview; what runs and when.' },

  // --- Renderer source ---
  // Reach for these only when the docs in CARDS.md / MANIFEST-SCHEMA.md
  // don't cover the specific behaviour you need to verify, or when the
  // user is asking for a code-level explanation. Each summary states
  // the renderer's most-asked contract fact (consults
  // meta.writeable.inputs vs hardcodes the write shape, primarily) so
  // the agent can usually answer without reading the file.
  { kind: 'source', path: 'public/js/components/eh-base-card.js',
    summary: 'Base class for every card renderer. Owns the shell (header, expand/collapse, loading, error), data fetch + 20s cache, .card / .data / .date / .config / .writeable props passed down to subclass renderCard().' },
  { kind: 'source', path: 'public/js/components/eh-input-form.js',
    summary: 'Manifest-driven form. Reads meta.writeable.inputs; renders one widget per input type (number, stepper, text, textarea, select, emoji-picker, colour, checkbox, date, time, rating). Used by generic-card, list-card, combination-card edit, prompt-modal modal mode.' },
  { kind: 'source', path: 'public/js/components/eh-generic-card.js',
    summary: 'generic-card renderer. ROUTES WRITES THROUGH meta.writeable.inputs. Reads display.template/secondary/unit/emojiMap/emptyHeadline/thresholds, fallbackToLatest, maxReadingsPerDay, prefillFromLatest, requireAny.' },
  { kind: 'source', path: 'public/js/components/eh-list-card.js',
    summary: 'list-card renderer (permanent roster, NOT per-day). ROUTES WRITES THROUGH meta.writeable.inputs (both add and per-row edit). Reads display.primaryField/secondaryTemplate/emptyMessage. Auto-stamps `added: ISO8601` on row creation.' },
  { kind: 'source', path: 'public/js/components/eh-schedule-card.js',
    summary: 'schedule-card renderer. Default ✓ check-off HARDCODES `{scheduledDate, takenAt, offSchedule?}` to data.items[].doses[]. With meta.view.checkOffForm set (currentDoseFields + previousDoseFields), ✓ instead opens an inline form sourced from meta.writeable.inputs and merges previous-dose fields onto the most recent prior taken dose (retroactive review). Re-tapping ✓ on a logged date pre-fills the form for editing. The viewed date\'s logged values surface as a muted summary line on the item (chips-multi `none` is filtered). Reads data.items[].{schedule, cycles[], doses[]} and view.colorMap.' },
  { kind: 'source', path: 'public/js/components/eh-checklist-card.js',
    summary: 'checklist-card renderer. HARDCODES the daily-tick write to either item.doses[].push({scheduledDate, takenAt}) or item.takenDates[].push(date); DOES NOT consult meta.writeable.inputs. Accepts data shapes items[], {items}, or {current}.' },
  { kind: 'source', path: 'public/js/components/eh-combination-card.js',
    summary: 'combination-card renderer (read-only window). Reads meta.view.combines[] and fetches each donor sourceId. Edit pencil opens an eh-input-form built from the DONOR card\'s meta.writeable.inputs (not its own). Combination card\'s own data must stay [].' },
  { kind: 'source', path: 'public/js/components/eh-prompt-modal.js',
    summary: 'prompt-modal — daily "log this now" full-screen modal. mode:"modal" routes through meta.writeable.inputs (same shape as eh-input-form). mode:"checklist" hardcodes per-item dose / takenDates writes. Once-per-day localStorage gate (klebb-prompt-shown-{cardId}-{YYYY-MM-DD}).' },
  { kind: 'source', path: 'public/js/components/eh-schedule-timeline.js',
    summary: 'schedule-timeline renderer (read-only). Dot-grid per-cycle adherence. Dot states: solid accent (taken), solid red (missed), hollow grey (rest), solid amber (off-schedule), accent ring (today), dim hollow (future). One row per cycle (NOT per item).' },
  { kind: 'source', path: 'public/js/components/eh-cc-suggestion-card.js',
    summary: 'cc-suggestion-card — pinned suggestion surface. Fires when ≥3 enabled atomic cards share a meta.category. Read-only; "Ask klebbius" seeds a chat prompt that negotiates a combination-card manifest. Server-side clustering in meta/cc-suggestions.js.' },
  { kind: 'source', path: 'public/js/components/eh-hae-discovery-card.js',
    summary: 'hae-discovery-card — pinned card surfacing HAE metrics not yet subscribed. Reads /api/health-auto-export/discoveries. Per-metric "Build a card" seeds a chat prompt; "Dismiss" persists a Settings-restorable hide.' },
  { kind: 'source', path: 'public/js/components/eh-welcome-card.js',
    summary: 'welcome-card — onboarding card on a fresh install. Auto-hidden by registry.createManifest on first user-card creation; can be restored from Settings.' },
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
// summary; the agent uses this to pick which doc to fetch. Two
// subsections: Documentation (always reach for this first) and
// Renderer source (only when the docs leave a gap, or for code-level
// questions).
function describeDocsCatalogue() {
  const docs = DOC_INDEX.filter(d => d.kind !== 'source');
  const sources = DOC_INDEX.filter(d => d.kind === 'source');
  const lines = [
    '## Available docs',
    '',
    'Klebb ships its docs alongside the app. Call `read_doc(path)` to',
    'fetch the full text of any of the following at inference time.',
    'You always get the same version as the running app, so use this',
    'instead of guessing from training data when the user asks about',
    'schema, renderer contracts, or workflows.',
    '',
    '### Documentation',
    '',
    'Reach for these FIRST. They are the authoritative answer for',
    'schema, renderer contracts, and workflows.',
    '',
  ];
  for (const d of docs) {
    lines.push(`- \`${d.path}\` — ${d.summary}`);
  }
  if (sources.length > 0) {
    lines.push('');
    lines.push('### Renderer source');
    lines.push('');
    lines.push('The Lit components that drive each card on the dashboard.');
    lines.push('Reach for these ONLY when the docs above leave a gap on a');
    lines.push('specific behaviour you need to verify, or when the user');
    lines.push('is asking for a code-level explanation. Each summary');
    lines.push('states the renderer\'s most-asked contract fact, so you');
    lines.push('can usually answer without fetching the file.');
    lines.push('');
    for (const d of sources) {
      lines.push(`- \`${d.path}\` — ${d.summary}`);
    }
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
