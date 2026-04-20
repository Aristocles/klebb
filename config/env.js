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
const OPENCLAW_HOST = process.env.OPENCLAW_HOST || 'localhost';
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '18789', 10);
// NOTE: This placeholder token matches the one originally hardcoded in server.js.
// It is preserved here ONLY to avoid breaking the live instance during M1.
// To be replaced with systemd-provided OPENCLAW_TOKEN in M8 and rotated.
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '782159633d98b7c2f67e77fcb1ff87b30884e7275d81e5f9';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'amazon-bedrock/global.anthropic.claude-sonnet-4-6';
const OPENCLAW_TLS = process.env.OPENCLAW_TLS !== 'false'; // default true for legacy :18789 (self-signed)
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
// --- Health data paths (as seen by the chat AGENT, which may run in a different
//     container/user than the webapp). These are used in the system prompt so
//     the agent knows where to find data files.
//
//     Eddy's instance: agent is Axis, running on this host. Data lives at
//       ~/axis/workspace/.private/health/data/ from his view.
//     Chuck's instance: agent is Onyx, running inside a container. Data lives
//       at ~/workspace/health/ from her view (bind-mounted from the host at
//       /home/minecraft/onyx/workspace/health/).
//
//     Each webapp instance sets HEALTH_AGENT_DATA_PATH in its systemd env file.
const HEALTH_AGENT_DATA_PATH = process.env.HEALTH_AGENT_DATA_PATH || '~/axis/workspace/.private/health/data';
const HEALTH_AGENT_REPORTS_PATH = process.env.HEALTH_AGENT_REPORTS_PATH || '~/axis/workspace/.private/health';

// Default prompt. Uses HEALTH_AGENT_DATA_PATH so the agent looks in the
// right place depending on which instance is serving the chat.
const DEFAULT_HEALTH_SYSTEM_PROMPT = `You are ${CHAT_AGENT_NAME}, a health assistant embedded in the ${INSTANCE_NAME} dashboard.

You have direct filesystem access to the user's health data. ALWAYS read the source files before answering — never guess from memory or prior knowledge.

## Data location (READ these, don't assume)

Primary data dir: \`${HEALTH_AGENT_DATA_PATH}/\`

Each data file is a v2 manifest with this shape:
\`\`\`
{
  "$schema": "eddzhealth.datafile.v1",
  "meta": { id, label, view, trends, calendar, reports, writeable, ... },
  "description": "instructions for AI writers about this file's schema",
  "data": <actual values — array or object, shape varies per card>
}
\`\`\`

Key files you may find in the data dir (not all always present — list the dir first to see what's there):
- \`peptides.json\` — scheduled items. data = { items: [...], groups: [...] }.
  Each item has: name, schedule { frequency, on_days, off_days, dayOfWeek, ... },
  cycles: [{type: 'on'|'off', start, end}], doses: [{scheduledDate, takenAt}],
  inventory, notes. To check what was taken on YYYY-MM-DD, scan each item's
  doses[] for entries where scheduledDate matches AND takenAt is truthy.
  To check what's SCHEDULED for YYYY-MM-DD, evaluate each item's schedule
  against the day (day-of-week for on_off, weekly dayOfWeek, etc) within
  its active cycle.
- \`supplements.json\` — data = { current: [...], past: [...] }.
- \`weight.json\` — data = [{date, kg, note}, ...] sorted by date.
- \`bp.json\` — data = [{date, time?, systolic, diastolic, hr?, notes?}].
- \`mood.json\` — data keyed by date: { 'YYYY-MM-DD': { mood, notes, time, wakeUps } }.
- \`notes.json\` — freeform daily notes keyed by date.
- \`appointments.json\` — data = [{date, type, location, status, note}].
- \`bloods.json\` — data = [{date, tests, results, ...}].
- \`goals.json\` — data = [{id, description, metric, target, unit}].
- \`greeting.json\` — rotating motivational messages.

Some instances may have auto-export data (one JSON per date) under:
- \`${HEALTH_AGENT_DATA_PATH}/auto-export/sleep/YYYY-MM-DD.json\`
- \`${HEALTH_AGENT_DATA_PATH}/auto-export/workouts/YYYY-MM-DD.json\`
- \`${HEALTH_AGENT_DATA_PATH}/auto-export/vitals/YYYY-MM-DD.json\`
- \`${HEALTH_AGENT_DATA_PATH}/auto-export/activity/YYYY-MM-DD.json\`

Reports (markdown): \`${HEALTH_AGENT_REPORTS_PATH}/\` contains PROFILE.md, DEBRIEF-*.md, bloods-*.md, etc. Longer-form context.

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

const HEALTH_SYSTEM_PROMPT = (() => {
  const file = process.env.HEALTH_SYSTEM_PROMPT_FILE;
  if (file) {
    try { return require('fs').readFileSync(file, 'utf8'); } catch {}
  }
  return process.env.HEALTH_SYSTEM_PROMPT || DEFAULT_HEALTH_SYSTEM_PROMPT;
})();

module.exports = {
  PORT,
  HOST,
  INSTANCE_NAME,
  OPENCLAW_HOST,
  OPENCLAW_PORT,
  OPENCLAW_TOKEN,
  OPENCLAW_MODEL,
  OPENCLAW_TLS,
  CHAT_AGENT_NAME,
  CHAT_AGENT_EMOJI,
  WEBAUTHN_RP_NAME,
  WEBAUTHN_RP_ID,
  WEBAUTHN_ORIGIN,
  getSessionSecret,
  DEBUG_LOG,
  HEALTH_SYSTEM_PROMPT,
};
