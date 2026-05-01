// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// config/env.js
// Non-path environment variables: chat gateway, auth, branding, server port.
//
// Required env vars:
//   SESSION_SECRET   — random hex string (min 16 chars). Generated and
//                      persisted under $HEALTH_HOME/sessions/secret.key if
//                      absent.
//
// Optional env vars: see README.md for the full list; each has a sensible
// default for a local-dev instance. Public/production deploys should
// explicitly set HEALTH_ORIGIN, HEALTH_RP_ID, CHAT_API_KEY, and
// AGENT_API_TOKEN.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Lazy import to avoid circular dep if paths.js ever grows env reads
let _paths = null;
function paths() {
  if (!_paths) _paths = require('./paths.js');
  return _paths;
}

// --- Server ---
const PORT = parseInt(process.env.PORT || process.env.HEALTH_PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// --- Timezone ---
// Node honours process.env.TZ natively for every Date construction. We
// surface it here only so the boot banner can log the active zone and
// tests have something to assert against. Default is UTC.
const TZ = process.env.TZ || 'UTC';

// --- Branding ---
const INSTANCE_NAME = process.env.HEALTH_INSTANCE_NAME || 'Klebb';

// --- Chat endpoint (optional — chat widget disabled if CHAT_API_KEY unset) ---
//
// Klebb speaks the OpenAI chat-completions shape. Point it at any endpoint
// that accepts that shape: a self-hosted gateway (e.g. LiteLLM), a
// cloud provider's OpenAI-compat endpoint (Groq, Together, etc.),
// or a local runtime (Ollama, vLLM, llama.cpp).
//
// Canonical env:
//   CHAT_ENDPOINT_URL  full URL to /v1/chat/completions (or wherever the
//                      endpoint lives). Scheme decides http vs https.
//   CHAT_API_KEY       bearer token sent as Authorization: Bearer <key>.
//   CHAT_MODEL         model name the endpoint expects; passed through
//                      untouched in the request body.
//
// Legacy (still accepted for existing deploys; new installs should use the
// canonical names): CHAT_GATEWAY_HOST, CHAT_GATEWAY_PORT, CHAT_GATEWAY_TLS,
// CHAT_GATEWAY_TOKEN, CHAT_GATEWAY_MODEL.
function resolveChatEndpointUrl() {
  if (process.env.CHAT_ENDPOINT_URL) return process.env.CHAT_ENDPOINT_URL;
  const host = process.env.CHAT_GATEWAY_HOST;
  if (!host) return '';
  const port = process.env.CHAT_GATEWAY_PORT || '8787';
  const tls = process.env.CHAT_GATEWAY_TLS !== undefined
    ? process.env.CHAT_GATEWAY_TLS !== 'false'
    : (host !== 'localhost' && host !== '127.0.0.1');
  const scheme = tls ? 'https' : 'http';
  return `${scheme}://${host}:${port}/v1/chat/completions`;
}
const CHAT_ENDPOINT_URL = resolveChatEndpointUrl();
const CHAT_API_KEY = process.env.CHAT_API_KEY || process.env.CHAT_GATEWAY_TOKEN || '';
const CHAT_MODEL = process.env.CHAT_MODEL || process.env.CHAT_GATEWAY_MODEL || '';
if (!process.env.CHAT_ENDPOINT_URL && (process.env.CHAT_GATEWAY_HOST || process.env.CHAT_GATEWAY_TOKEN)) {
  console.warn(
    '[env] CHAT_GATEWAY_* env vars are deprecated. ' +
    'Migrate to CHAT_ENDPOINT_URL + CHAT_API_KEY + CHAT_MODEL.'
  );
}
const CHAT_AGENT_NAME = process.env.CHAT_AGENT_NAME || 'Chat';
const CHAT_AGENT_EMOJI = process.env.CHAT_AGENT_EMOJI || '💬';

// --- WebAuthn ---
// Defaults to localhost so a fresh local-dev install just works. Production
// deploys MUST set HEALTH_RP_ID and HEALTH_ORIGIN to match their public
// domain, or WebAuthn will refuse to register.
const WEBAUTHN_RP_NAME = process.env.HEALTH_RP_NAME || process.env.WEBAUTHN_RP_NAME || INSTANCE_NAME;
const WEBAUTHN_RP_ID = process.env.HEALTH_RP_ID || process.env.WEBAUTHN_RP_ID || 'localhost';
const WEBAUTHN_ORIGIN = process.env.HEALTH_ORIGIN || process.env.WEBAUTHN_ORIGIN || `http://localhost:${PORT}`;

// --- Session secret ---
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }
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
//
// Default prompt is generic and references whatever cards the registry
// currently has. Set HEALTH_SYSTEM_PROMPT (or point HEALTH_SYSTEM_PROMPT_FILE
// at a file) to fully override.

const DEFAULT_HEALTH_SYSTEM_PROMPT = `You are ${CHAT_AGENT_NAME}, a health assistant embedded in the ${INSTANCE_NAME} dashboard.

Every card on the user's dashboard corresponds to a JSON manifest file in their data directory. Before answering questions, discover what cards exist and read the relevant data from those files.

## Data format

Each card file is a v2 manifest:
\`\`\`
{
  "$schema": "klebb.datafile.v1",
  "meta": { id, label, view, trends, writeable, ... },
  "description": "instructions for chat agents about this file's data shape",
  "data": <array or object; shape varies per card>
}
\`\`\`

The data layout is card-specific — rely on each manifest's \`meta\` and \`description\` fields, not hardcoded knowledge.

## HTTP API (when configured as an external agent)

- \`GET /api/manifests\` → list all cards
- \`GET /api/manifests/:id\` → full manifest (meta + data)
- \`GET /api/manifests/:id/data\` → just the data block
- \`POST /api/manifests/:id/data\` with \`{ data: [...] }\` → replace data
- \`GET /api/views/today\` / \`/trends\` / \`/reports\` / \`/calendar\` → cards enabled for that view

All requests require \`Authorization: Bearer <AGENT_API_TOKEN>\` when that env var is set.

## Workflow

1. Identify which card(s) answer the user's question.
2. Fetch / read the manifest. Respect \`meta.description\` for data-shape conventions.
3. Compute the answer.
4. Reply concisely.

## Date handling

Use the system clock for "today". Don't infer the date from training data.

## Formatting

Simple markdown: bullet lists with - dashes, **bold** for emphasis. No headers, no tables. Direct and helpful.`;

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
  TZ,
  INSTANCE_NAME,
  CHAT_ENDPOINT_URL,
  CHAT_API_KEY,
  CHAT_MODEL,
  CHAT_AGENT_NAME,
  CHAT_AGENT_EMOJI,
  WEBAUTHN_RP_NAME,
  WEBAUTHN_RP_ID,
  WEBAUTHN_ORIGIN,
  getSessionSecret,
  DEBUG_LOG,
  HEALTH_SYSTEM_PROMPT,
};
