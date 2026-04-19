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
Keep responses concise. You're in a small chat widget, not a full conversation.
Use simple formatting: bullet lists with - dashes, **bold** for emphasis. No headers (#). No tables.
Use Australian English. Be direct and helpful.`;

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
