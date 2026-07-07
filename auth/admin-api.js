// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// auth/admin-api.js
//
// The Klebb Cloud control-plane API. klebb.app calls these server-to-server
// with the per-instance KLEBB_ADMIN_TOKEN bearer to help a customer's own
// instance. Scope is deliberately narrow (least privilege):
//   - GET  /api/admin/health       — readiness + effective config snapshot
//   - GET  /api/admin/credentials  — list passkeys (read-only)
//   - POST /api/admin/invites      — mint a register invite; returns the
//                                     /register?code= URL to email
// There is NO delete here. Removing a passkey stays in-app only, so a
// compromised control plane can enrol a visible new device but can never
// lock the customer out.

const ENV = require('../config/env');
const invites = require('./invites');
const webauthn = require('./webauthn');

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// True if the request carries the admin bearer token. Returns false when the
// token is unconfigured, so the admin surface is off by default (self-host).
function isAdminRequest(req) {
  const token = ENV.KLEBB_ADMIN_TOKEN;
  if (!token) return false;
  const auth = req.headers['authorization'];
  return !!(auth && auth.startsWith('Bearer ') && webauthn.bearerMatches(auth.slice(7).trim(), token));
}

// The instance's own canonical origin (e.g. https://alice.klebb.app). Register
// links MUST land here, not on klebb.app: a passkey is bound to this RP_ID, so
// a link to any other origin would produce an unusable credential.
function instanceOrigin() {
  return ENV.WEBAUTHN_ORIGIN;
}

// Handle an /api/admin/* route. Returns true if it handled the request.
// The caller only invokes this for /api/admin/ paths; every route here is
// gated by isAdminRequest first (401 when the token is missing/wrong/unset).
async function handleAdminRoutes(req, res, pathname) {
  const sendJSON = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (!isAdminRequest(req)) {
    sendJSON({ error: 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/admin/health — readiness snapshot for the provisioner. Lets the
  // control plane confirm an instance is up, in the hardened-bootstrap
  // posture, and bound to the subdomain it thinks it is (a wrong RP_ID
  // silently produces unusable passkeys) before it emails a register link.
  if (pathname === '/api/admin/health' && req.method === 'GET') {
    const creds = webauthn.loadCredentials();
    sendJSON({
      ok: true,
      setup: webauthn.isSetup(),
      cloud: !!ENV.KLEBB_CLOUD,
      rpId: ENV.WEBAUTHN_RP_ID,
      origin: ENV.WEBAUTHN_ORIGIN,
      credentialCount: webauthn.countCredentials(creds),
    });
    return true;
  }

  // GET /api/admin/credentials — list every passkey across all labels.
  // Read-only, non-sensitive fields only (reuses the in-app view logic).
  if (pathname === '/api/admin/credentials' && req.method === 'GET') {
    const creds = webauthn.loadCredentials();
    const out = [];
    for (const userId of Object.keys(creds.users || {})) {
      for (const c of webauthn.listCredentialsForUser(userId)) {
        out.push({ label: userId, ...c, isCurrentDevice: undefined });
      }
    }
    sendJSON({ credentials: out });
    return true;
  }

  // POST /api/admin/invites — mint a single-use register invite and return
  // the URL to email. Body: { label?, expiresInDays? }. Does NOT send email;
  // the control plane does that.
  if (pathname === '/api/admin/invites' && req.method === 'POST') {
    let body = {};
    try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch {}
    // The label becomes the credential-store userId at registration; shape
    // it at the boundary (same charset/length rule as registration itself).
    // expiresInDays is clamped: zero/negative would mint dead invites,
    // enormous values would leave codes brute-forceable for months.
    const label = String(body.label || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'user';
    const expiresInDays = Math.min(30, Math.max(1,
      Number.isFinite(body.expiresInDays) ? Math.trunc(body.expiresInDays) : 3));
    const invite = invites.createInvite({ label, expiresInDays });
    invites.recordAuthEvent({ kind: 'admin.invite.created', label: invite.label, code: invite.code });
    sendJSON({
      code: invite.code,
      label: invite.label,
      expiresAt: invite.expiresAt,
      registerUrl: `${instanceOrigin()}/register?code=${encodeURIComponent(invite.code)}`,
    }, 201);
    return true;
  }

  sendJSON({ error: 'Not found' }, 404);
  return true;
}

module.exports = { handleAdminRoutes, isAdminRequest, instanceOrigin };
