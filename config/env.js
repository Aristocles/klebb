// config/env.js
// Non-path environment variables: chat gateway, auth, branding, server port.
// All defaults preserve existing behaviour for Eddy's instance.
//
// Required for new deployments:
//   SESSION_SECRET   — random hex string (any length, min 32 chars recommended)
//                      Generated automatically if unset (logged at boot); persisted via file
//                      so sessions survive restarts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Lazy import to avoid circular dep if paths.js ever grows env reads
let _paths = null;
function paths() {
  if (!_paths) _paths = require('./paths.js');
  return _paths;
}

// --- Server ---
const PORT = parseInt(process.env.PORT || process.env.HEALTH_PORT || '10002', 10);
const HOST = process.env.HOST || '0.0.0.0';

// --- Branding ---
const INSTANCE_NAME = process.env.HEALTH_INSTANCE_NAME || 'EddzHealth';

// --- Chat gateway ---
// Defaults preserve Eddy's existing (hardcoded) Axis config so current users keep working.
const CHAT_GATEWAY_HOST = process.env.CHAT_GATEWAY_HOST || 'localhost';
const CHAT_GATEWAY_PORT = parseInt(process.env.CHAT_GATEWAY_PORT || '18789', 10);
// NOTE: This placeholder token matches the one originally hardcoded in server.js.
// It is preserved here ONLY to avoid breaking the live instance during M1.
// To be replaced with systemd-provided CHAT_GATEWAY_TOKEN in M8 and rotated.
const CHAT_GATEWAY_TOKEN = process.env.CHAT_GATEWAY_TOKEN || '***REMOVED-TOKEN***';
const CHAT_GATEWAY_MODEL = process.env.CHAT_GATEWAY_MODEL || 'your-model-id-here';
const CHAT_GATEWAY_TLS = process.env.CHAT_GATEWAY_TLS !== 'false'; // default true for legacy :18789 (self-signed)
const CHAT_AGENT_NAME = process.env.CHAT_AGENT_NAME || 'Axis';
const CHAT_AGENT_EMOJI = process.env.CHAT_AGENT_EMOJI || '⚡';

// --- WebAuthn ---
// Legacy defaults preserve Eddy's existing passkey (RP_ID=axis.vorignet.com).
const WEBAUTHN_RP_NAME = process.env.HEALTH_RP_NAME || process.env.WEBAUTHN_RP_NAME || INSTANCE_NAME;
const WEBAUTHN_RP_ID = process.env.HEALTH_RP_ID || process.env.WEBAUTHN_RP_ID || 'axis.vorignet.com';
const WEBAUTHN_ORIGIN = process.env.HEALTH_ORIGIN || process.env.WEBAUTHN_ORIGIN || 'https://eddzhealth.axis.vorignet.com';

// --- Session secret ---
// Used for optional signed tokens / CSRF / cookie verification.
// Not strictly required for the current server-side session model (random token in file),
// but reserved for future use; also persisted so bootstrap is idempotent.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }
  // Persist a generated secret under $HEALTH_HOME/sessions/secret.key
  const { SESSIONS_DIR } = paths();
  const secretFile = path.join(SESSIONS_DIR, 'secret.key');
  try {
    if (fs.existsSync(secretFile)) {
      const v = fs.readFileSync(secretFile, 'utf8').trim();
      if (v.length >= 16) return v;
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('[env] Generated SESSION_SECRET; persisted at', secretFile);
    return generated;
  } catch (e) {
    const fallback = crypto.randomBytes(32).toString('hex');
    console.warn('[env] Could not persist SESSION_SECRET (', e.message, '); using ephemeral');
    return fallback;
  }
}
let _sessionSecret = null;
function getSessionSecret() {
  if (!_sessionSecret) _sessionSecret = resolveSessionSecret();
  return _sessionSecret;
}

// --- Feature flags ---
const DEBUG_LOG = process.env.HEALTH_DEBUG === '1';

// --- Health system prompt (used by chat proxy) ---
// Default prompt kept for Eddy's instance. Chuck's instance overrides via env file.
const DEFAULT_HEALTH_SYSTEM_PROMPT = `You are ${CHAT_AGENT_NAME}, a health assistant embedded in the ${INSTANCE_NAME} dashboard.

You have direct filesystem access to the user's health data. ALWAYS read the source files before answering — never guess from memory or prior knowledge.

## Data location (READ these, don't assume)

Primary data dir: \`~/axis/workspace/.private/health/data/\`

Each data file is a v2 manifest with this shape:
\`\`\`
{
  "$schema": "eddzhealth.datafile.v1",
  "meta": { id, label, view, trends, calendar, reports, writeable, ... },
  "description": "instructions for AI writers about this file's schema",
  "data": <actual values — array or object, shape varies per card>
}
\`\`\`

Key files you'll actually read:
- \`peptides.json\` — scheduled items. data = { items: [...], groups: [...] }.
  Each item has: name, schedule { frequency, on_days, off_days, dayOfWeek, ... },
  cycles: [{type: 'on'|'off', start, end}], doses: [{scheduledDate, takenAt}],
  inventory, notes. To check what was taken on YYYY-MM-DD, scan each item's
  doses[] for entries where scheduledDate matches AND takenAt is truthy.
  To check what's SCHEDULED for YYYY-MM-DD, evaluate each item's schedule
  against the day (day-of-week for on_off, weekly dayOfWeek, etc) within
  its active cycle.
- \`supplements.json\` — data = { current: [...], past: [...] } per-supplement fields.
- \`weight.json\` — data = [{date, kg, note}, ...] sorted by date.
- \`bp.json\` (if present) — data = [{date, time?, systolic, diastolic, hr?, notes?}].
- \`mood.json\` — data keyed by date: { 'YYYY-MM-DD': { mood, notes, time, wakeUps } }.
- \`notes.json\` — freeform daily notes keyed by date: { 'YYYY-MM-DD': { text, updated } }.
- \`appointments.json\` — data = [{date, type, location, status, note}].
- \`bloods.json\` — data = [{date, tests, results, ...}].
- \`goals.json\` — data = [{id, description, metric, target, unit}].
- \`greeting.json\` — rotating motivational messages (not usually relevant).

Legacy NOTE: \`injection-log.json\` was merged into \`peptides.json\` in April 2026
migration. If you read peptides.items[].doses[] you have the full history.
The legacy file may still exist in \`data/_archive/migration-2026-04-19/\` but is
frozen.

Auto-export (Apple Health) data — one JSON file per date:
- \`data/auto-export/sleep/YYYY-MM-DD.json\`
- \`data/auto-export/workouts/YYYY-MM-DD.json\`
- \`data/auto-export/vitals/YYYY-MM-DD.json\`
- \`data/auto-export/activity/YYYY-MM-DD.json\`

Reports (markdown): \`~/axis/workspace/.private/health/DEBRIEF-*.md\`, \`PROFILE.md\`,
\`bloods-report-*.md\`. Longer-form context.

## Workflow

1. Read the user's message and figure out which file(s) answer it.
2. Actually read those files with your filesystem tools (Read / Grep / ls).
3. Parse the v2 manifest — the answer is under \`data.*\` (not at the top level).
4. Compute the answer (today's doses, today's supplements, etc).
5. Reply concisely.

## Date handling

Today's date for context: use the system clock via \`date +%Y-%m-%d\` or equivalent
if you need to query 'today'. Don't assume from training data.

## Formatting

Simple markdown: bullet lists with - dashes, **bold** for emphasis. No headers (#),
no tables. Australian English. Direct and helpful.`;

const HEALTH_SYSTEM_PROMPT = process.env.HEALTH_SYSTEM_PROMPT || DEFAULT_HEALTH_SYSTEM_PROMPT;

module.exports = {
  PORT,
  HOST,
  INSTANCE_NAME,
  CHAT_GATEWAY_HOST,
  CHAT_GATEWAY_PORT,
  CHAT_GATEWAY_TOKEN,
  CHAT_GATEWAY_MODEL,
  CHAT_GATEWAY_TLS,
  CHAT_AGENT_NAME,
  CHAT_AGENT_EMOJI,
  WEBAUTHN_RP_NAME,
  WEBAUTHN_RP_ID,
  WEBAUTHN_ORIGIN,
  getSessionSecret,
  DEBUG_LOG,
  HEALTH_SYSTEM_PROMPT,
};
