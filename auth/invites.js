// auth/invites.js
// Manages single-use invite codes stored in $HEALTH_HOME/config.json.
//
// Schema:
//   {
//     "auth": {
//       "invites": [
//         { "code": "chuck-8xk2f9", "label": "chuck", "expiresAt": "2026-04-22T00:00:00Z", "used": false, "createdAt": "..." }
//       ],
//       "authEvents": "$HEALTH_HOME/sessions/auth-events.log"
//     }
//   }
//
// CLI scripts at scripts/invite.js / scripts/revoke.js / scripts/list.js operate
// on this file directly.
//
// The web server queries via consumeInvite(code) at /register verification time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('../config/paths');

function _readConfig() {
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function _writeConfig(cfg) {
  try { fs.mkdirSync(path.dirname(PATHS.CONFIG_PATH), { recursive: true }); } catch {}
  const tmp = PATHS.CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PATHS.CONFIG_PATH);
}

function generateCode(label) {
  const random = crypto.randomBytes(4).toString('hex');
  const safeLabel = String(label || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'user';
  return `${safeLabel}-${random}`;
}

function createInvite({ label, expiresInDays = 3 }) {
  const cfg = _readConfig();
  cfg.auth = cfg.auth || {};
  cfg.auth.invites = cfg.auth.invites || [];
  const now = Date.now();
  const entry = {
    code: generateCode(label),
    label: label || 'user',
    expiresAt: new Date(now + expiresInDays * 86400000).toISOString(),
    used: false,
    createdAt: new Date(now).toISOString(),
  };
  cfg.auth.invites.push(entry);
  _writeConfig(cfg);
  return entry;
}

function listInvites() {
  const cfg = _readConfig();
  return (cfg.auth && cfg.auth.invites) || [];
}

// Returns the invite record if valid + unused + unexpired; null otherwise.
function validateInvite(code) {
  if (!code) return null;
  const invites = listInvites();
  const hit = invites.find(i => i.code === code);
  if (!hit) return null;
  if (hit.used) return null;
  if (hit.expiresAt && new Date(hit.expiresAt).getTime() < Date.now()) return null;
  return hit;
}

// Mark an invite as used. No-op if already used.
function consumeInvite(code) {
  const cfg = _readConfig();
  cfg.auth = cfg.auth || {};
  cfg.auth.invites = cfg.auth.invites || [];
  const idx = cfg.auth.invites.findIndex(i => i.code === code);
  if (idx < 0) return null;
  if (cfg.auth.invites[idx].used) return cfg.auth.invites[idx];
  cfg.auth.invites[idx].used = true;
  cfg.auth.invites[idx].usedAt = new Date().toISOString();
  _writeConfig(cfg);
  return cfg.auth.invites[idx];
}

function removeInvite(code) {
  const cfg = _readConfig();
  cfg.auth = cfg.auth || {};
  const before = (cfg.auth.invites || []).length;
  cfg.auth.invites = (cfg.auth.invites || []).filter(i => i.code !== code);
  _writeConfig(cfg);
  return (cfg.auth.invites.length < before);
}

// Returns true if the webapp instance requires an invite even for
// already-authenticated users (i.e. no self-service "add device").
// Defaults to true (require invite codes for new registrations).
function requireInviteForRegistration() {
  const cfg = _readConfig();
  const v = cfg.auth && cfg.auth.requireInviteForRegistration;
  return v === undefined ? true : !!v;
}

function recordAuthEvent(event) {
  try {
    const dir = PATHS.SESSIONS_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'auth-events.log');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(file, line);
  } catch {}
}

module.exports = {
  generateCode,
  createInvite,
  listInvites,
  validateInvite,
  consumeInvite,
  removeInvite,
  requireInviteForRegistration,
  recordAuthEvent,
};
