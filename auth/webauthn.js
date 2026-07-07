// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const PATHS = require('../config/paths');
const ENV = require('../config/env');
const invites = require('./invites');

// Config — all env-driven; see config/env.js for defaults.
const RP_NAME = ENV.WEBAUTHN_RP_NAME;
const RP_ID = ENV.WEBAUTHN_RP_ID;
const ORIGIN = ENV.WEBAUTHN_ORIGIN;
const CREDENTIALS_FILE = PATHS.WEBAUTHN_CREDENTIALS_FILE;
const SESSIONS_FILE = PATHS.WEBAUTHN_SESSIONS_FILE;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Pending challenges (in-memory, short-lived)
const pendingChallenges = new Map();

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return { users: {} };
  }
}

// Atomic write: tmp file + rename, mode 0600. The store is rewritten on every
// login (counter bump), so a bare writeFileSync races concurrent writers and a
// crash mid-write truncates it. Mirrors auth/invites.js:_writeConfig.
function saveCredentials(data) {
  try { fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true }); } catch {}
  const tmp = CREDENTIALS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_FILE);
}

// Total credentials across all users. The last-credential guard uses this:
// emptying the store flips isSetup() back to false, which re-opens the
// instance to bootstrap registration by any visitor.
function countCredentials(data) {
  const users = (data && data.users) || {};
  return Object.keys(users).reduce(
    (n, u) => n + ((users[u].credentials || []).length),
    0
  );
}

// A user-supplied passkey nickname. Trimmed, capped, control chars stripped;
// empty becomes null. Free text (unlike the label): display-only, never used
// as a key, so it can hold spaces and mixed case like "Work laptop".
function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const clean = Array.from(raw)
    .filter(ch => { const c = ch.codePointAt(0); return c >= 32 && c !== 127; })
    .join("").trim().slice(0, 60);
  return clean || null;
}

// Public (non-sensitive) view of one user's credentials for the management
// UI. Never leaks publicKey or counter. currentCredentialId (from the caller's
// session) flags which entry is the device making the request.
function listCredentialsForUser(userId, currentCredentialId = null) {
  const creds = loadCredentials();
  const list = (creds.users[userId]?.credentials) || [];
  return list.map(c => ({
    id: c.id,
    nickname: c.nickname || null,
    deviceType: c.deviceType || 'unknown',
    registeredAt: c.registeredAt || null,
    lastUsedAt: c.lastUsedAt || null,
    isCurrentDevice: !!currentCredentialId && c.id === currentCredentialId,
  }));
}

// Delete one credential by id from a given user. Refuses to remove the last
// remaining credential across the whole store (see countCredentials). Returns
// { ok, reason?, deletedId? }; on success also invalidates sessions bound to
// that credential so a removed device is logged out.
function deleteCredentialForUser(userId, credentialId) {
  const creds = loadCredentials();
  const list = creds.users[userId]?.credentials;
  if (!list) return { ok: false, reason: 'not-found' };
  const idx = list.findIndex(c => c.id === credentialId);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  if (countCredentials(creds) <= 1) return { ok: false, reason: 'last-credential' };

  list.splice(idx, 1);
  if (list.length === 0) delete creds.users[userId];
  saveCredentials(creds);
  invalidateSessionsForCredential(credentialId);
  return { ok: true, deletedId: credentialId };
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function isSetup() {
  const creds = loadCredentials();
  return Object.keys(creds.users).length > 0;
}

// Whether a fresh instance may be claimed by the first visitor with no invite
// code. True for self-hosted (the operator reads the printed /register URL
// from the logs). False on Klebb Cloud: a public <name>.klebb.app subdomain
// must not be claimable by whoever finds the URL first, so the control plane
// mints an invite and emails the link instead.
function openBootstrapAllowed() {
  return !ENV.KLEBB_CLOUD;
}

function createSession(userId, credentialId) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = {
    created: Date.now(),
    lastSeen: Date.now(),
    userId: userId || null,
    credentialId: credentialId || null,
  };
  saveSessions(sessions);
  return token;
}

// Returns the session record (touching lastSeen) if the token is valid and
// unexpired, else null. validateSession is the boolean wrapper.
function readSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() - session.created > SESSION_MAX_AGE) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  session.lastSeen = Date.now();
  saveSessions(sessions);
  return session;
}

function validateSession(token) {
  return !!readSession(token);
}

// The current request's session record ({ userId, credentialId }), or null.
function getSessionRecord(req) {
  return readSession(getSessionToken(req));
}

// Drop any sessions bound to a credential id. Called when a credential is
// deleted so the removed authenticator's live sessions die with it.
function invalidateSessionsForCredential(credentialId) {
  const sessions = loadSessions();
  let changed = false;
  for (const token of Object.keys(sessions)) {
    if (sessions[token].credentialId === credentialId) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/klebb_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function setSessionCookie(res, token) {
  // Secure flag is critical for modern browsers when the origin is HTTPS.
  // HttpOnly blocks JS access. SameSite=Lax is the sensible default for
  // a single-origin app (strict would break registration redirects).
  const secureFlag = (process.env.WEBAUTHN_ORIGIN || ENV.WEBAUTHN_ORIGIN || '').startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `klebb_session=${token}; Path=/; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
}

function clearSessionCookie(res) {
  const secureFlag = (process.env.WEBAUTHN_ORIGIN || ENV.WEBAUTHN_ORIGIN || '').startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `klebb_session=; Path=/; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=0`);
}

// Auth middleware: returns true if request is authenticated (or route is public)
function isAuthenticated(req) {
  if (isAgentRequest(req)) return true;
  // In demo mode, only a real session counts. The bootstrap "no creds yet"
  // shortcut would otherwise let unauthenticated visitors past the gate.
  if (ENV.KLEBB_DEMO) return validateSession(getSessionToken(req));
  // If no credentials registered yet, allow everything (setup mode)
  if (!isSetup()) return true;
  return validateSession(getSessionToken(req));
}

// Constant-time bearer comparison: a plain === leaks match length/prefix
// through timing. Hash both sides first so unequal lengths never throw and
// the comparison cost is input-independent.
function bearerMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// True if the request carries a valid AGENT_API_TOKEN bearer. Used to
// relax webapp-only gates (e.g. past/future-date restrictions on writes)
// for legitimate server-to-server writers.
function isAgentRequest(req) {
  const agentToken = process.env.AGENT_API_TOKEN;
  if (!agentToken) return false;
  const auth = req.headers['authorization'];
  return !!(auth && auth.startsWith('Bearer ') && bearerMatches(auth.slice(7).trim(), agentToken));
}

// Public paths that don't need auth
function isPublicPath(pathname) {
  // Public paths don't require auth. /api is NOT public — see isAuthenticated
  // for the full gate (session or AGENT_API_TOKEN bearer).
  const publicPaths = [
    '/auth/',
    '/login',
    '/setup',
    '/register',
    '/css/',
    '/js/',
    '/icons/',
    '/manifest.json',
    '/sw.js',
    '/favicon.ico',
    '/api/instance',
  ];
  // Exact-path public files. Kept separate from the prefix list so adding
  // an entry here cannot accidentally open a directory window.
  const publicExact = ['/lib/schedule.mjs'];
  if (publicExact.includes(pathname)) return true;
  return publicPaths.some(p => pathname === p || pathname.startsWith(p));
}

async function handleAuthRoutes(req, res, pathname) {
  const sendJSON = (res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const readBody = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });

  // Demo mode: serve the demo-login route, then 410 every other auth route.
  // Status still answers (the front end uses it to gate redirects).
  if (ENV.KLEBB_DEMO) {
    if (pathname === '/auth/demo-login' && req.method === 'POST') {
      const token = createSession(ENV.DEMO_USER_ID);
      setSessionCookie(res, token);
      return sendJSON(res, { ok: true, label: ENV.DEMO_USER_ID });
    }
    if (pathname === '/auth/status') {
      const authenticated = validateSession(getSessionToken(req));
      return sendJSON(res, { setup: true, authenticated, demo: true });
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) {
        const sessions = loadSessions();
        delete sessions[token];
        saveSessions(sessions);
      }
      clearSessionCookie(res);
      return sendJSON(res, { ok: true });
    }
    if (pathname.startsWith('/auth/')) {
      return sendJSON(res, { error: 'Disabled in demo mode' }, 410);
    }
  }

  // GET /auth/status — check if setup + authenticated. cloud lets the login
  // page tailor its lost-passkey recovery hint (hosted instances recover via
  // their provider account; self-hosted via a locally minted invite).
  if (pathname === '/auth/status') {
    const setup = isSetup();
    const authenticated = validateSession(getSessionToken(req));
    return sendJSON(res, { setup, authenticated, cloud: ENV.KLEBB_CLOUD });
  }

  // GET /auth/register/available?code=X — tell the client whether /register
  // is usable right now (bootstrap OR valid invite OR legacy-add-device).
  // Returns { available: true/false, reason, label? }
  if (pathname === '/auth/register/available' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    if (code) {
      const inv = invites.validateInvite(code);
      if (inv) return sendJSON(res, { available: true, reason: 'invite', label: inv.label });
      return sendJSON(res, { available: false, reason: 'invalid-invite' });
    }
    if (!isSetup() && openBootstrapAllowed()) return sendJSON(res, { available: true, reason: 'bootstrap' });
    // An authenticated session can always add a passkey to its own account.
    // requireInviteForRegistration gates UNAUTHENTICATED registration only; a
    // live session with a fresh biometric is the strongest actor in the system.
    if (validateSession(getSessionToken(req))) {
      return sendJSON(res, { available: true, reason: 'add-device' });
    }
    // A not-yet-set-up Cloud instance is awaiting its emailed claim link.
    if (!isSetup()) return sendJSON(res, { available: false, reason: 'awaiting-invite' });
    return sendJSON(res, { available: false, reason: 'closed' });
  }

  // POST /auth/register/options — generate registration options
  // Body may include: { code?: string, label?: string }
  // Registration is gated by:
  //   (a) a valid unused invite code, OR
  //   (b) no credentials exist yet (bootstrap first user), OR
  //   (c) already authenticated — adding a passkey to your own account.
  //       Allowed regardless of requireInviteForRegistration: that flag
  //       gates unauthenticated registration, not self-service add-device.
  if (pathname === '/auth/register/options' && req.method === 'POST') {
    const rawBody = await readBody(req);
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}

    let label = (body.label || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    let usedInvite = null;

    // Path A: invite code supplied
    if (body.code) {
      const inv = invites.validateInvite(body.code);
      if (!inv) {
        invites.recordAuthEvent({ kind: 'register.invalid-code', code: body.code, ip: req.socket?.remoteAddress });
        return sendJSON(res, { error: 'Invalid or expired invite' }, 403);
      }
      label = inv.label;
      usedInvite = inv;
    }
    // Path B: bootstrap — no credentials exist yet; first registration wins.
    // Disabled on Cloud: an empty instance there must be claimed via an
    // emailed invite (Path A), not by the first visitor.
    else if (!isSetup() && openBootstrapAllowed()) {
      if (!label) label = 'user';
    }
    // Path C: authenticated — adding a passkey to your own account. Bind to
    // the session's own userId so a device is added under the caller's label,
    // not whichever label happens to be first in the store.
    else if (getSessionRecord(req)) {
      const session = getSessionRecord(req);
      label = session.userId || Object.keys(loadCredentials().users || {})[0] || 'user';
    }
    else {
      // No code, no session, already set up → reject
      return sendJSON(res, { error: 'Registration closed' }, 403);
    }

    const creds = loadCredentials();
    const existingCreds = creds.users[label]?.credentials || [];

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: label,
      userDisplayName: label,
      attestationType: 'none',
      excludeCredentials: existingCreds.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',   // stricter: require biometric every time
      },
    });

    pendingChallenges.set(label, {
      challenge: options.challenge,
      code: body.code || null,
      label,
      expires: Date.now() + 120000,
    });
    setTimeout(() => pendingChallenges.delete(label), 120000);

    return sendJSON(res, options);
  }

  // POST /auth/register/verify — verify registration
  // Body must include: { label?: string, code?: string, ...attestationResponse }
  if (pathname === '/auth/register/verify' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const label = body.label && String(body.label).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    // Determine pending challenge — look up by label if provided, else use first entry
    let key = label;
    if (!key) {
      // Fallback: legacy client that didn't send label; if there's only one pending challenge use that.
      const keys = Array.from(pendingChallenges.keys());
      if (keys.length === 1) key = keys[0];
    }
    const pending = key ? pendingChallenges.get(key) : null;
    if (!pending) {
      return sendJSON(res, { error: 'Challenge expired' }, 400);
    }

    try {
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: pending.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;
        const creds = loadCredentials();
        const userId = pending.label || label || 'user';
        if (!creds.users[userId]) {
          creds.users[userId] = { credentials: [] };
        }
        const nickname = sanitizeNickname(body.nickname);
        const now = new Date().toISOString();
        creds.users[userId].credentials.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64'),
          counter: credential.counter,
          deviceType: body.authenticatorAttachment || 'unknown',
          nickname: nickname || null,
          registeredAt: now,
          lastUsedAt: now,
        });
        saveCredentials(creds);
        pendingChallenges.delete(key);

        // Consume the invite if one was used
        if (pending.code) {
          invites.consumeInvite(pending.code);
          invites.recordAuthEvent({ kind: 'register.success', label: userId, code: pending.code });
        } else {
          invites.recordAuthEvent({ kind: 'register.success', label: userId, bootstrap: true });
        }

        const token = createSession(userId, credential.id);
        setSessionCookie(res, token);
        return sendJSON(res, { verified: true, label: userId });
      }

      return sendJSON(res, { error: 'Verification failed' }, 400);
    } catch (e) {
      console.error('Registration verification error:', e.message);
      return sendJSON(res, { error: e.message }, 400);
    }
  }

  // POST /auth/login/options — generate authentication options across all registered users
  if (pathname === '/auth/login/options' && req.method === 'POST') {
    const creds = loadCredentials();
    // Flatten all credentials so any registered device can log in
    const allCreds = [];
    for (const userId of Object.keys(creds.users || {})) {
      for (const c of creds.users[userId].credentials || []) {
        allCreds.push(c);
      }
    }

    if (allCreds.length === 0) {
      return sendJSON(res, { error: 'No credentials registered' }, 400);
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: allCreds.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      userVerification: 'required',   // stricter: biometric required every time
    });

    pendingChallenges.set('__login', { challenge: options.challenge, expires: Date.now() + 120000 });
    setTimeout(() => pendingChallenges.delete('__login'), 120000);

    return sendJSON(res, options);
  }

  // POST /auth/login/verify — verify authentication
  if (pathname === '/auth/login/verify' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const pending = pendingChallenges.get('__login');

    if (!pending) {
      return sendJSON(res, { error: 'Challenge expired' }, 400);
    }

    // Find the credential across all users
    const creds = loadCredentials();
    let matchedUser = null;
    let credential = null;
    for (const userId of Object.keys(creds.users || {})) {
      const hit = (creds.users[userId].credentials || []).find(c => c.id === body.id);
      if (hit) { matchedUser = userId; credential = hit; break; }
    }

    if (!credential) {
      invites.recordAuthEvent({ kind: 'login.unknown-credential', id: body.id, ip: req.socket?.remoteAddress });
      return sendJSON(res, { error: 'Unknown credential' }, 400);
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: pending.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey, 'base64'),
          counter: credential.counter,
        },
      });

      if (verification.verified) {
        // Update counter + last-used stamp
        credential.counter = verification.authenticationInfo.newCounter;
        credential.lastUsedAt = new Date().toISOString();
        saveCredentials(creds);
        pendingChallenges.delete('__login');
        invites.recordAuthEvent({ kind: 'login.success', label: matchedUser });

        const token = createSession(matchedUser, credential.id);
        setSessionCookie(res, token);
        return sendJSON(res, { verified: true, label: matchedUser });
      }

      return sendJSON(res, { error: 'Verification failed' }, 400);
    } catch (e) {
      console.error('Auth verification error:', e.message);
      return sendJSON(res, { error: e.message }, 400);
    }
  }

  // POST /auth/logout
  if (pathname === '/auth/logout' && req.method === 'POST') {
    const token = getSessionToken(req);
    if (token) {
      const sessions = loadSessions();
      delete sessions[token];
      saveSessions(sessions);
    }
    clearSessionCookie(res);
    return sendJSON(res, { ok: true });
  }

  return null; // not an auth route
}

module.exports = {
  isAuthenticated,
  isAgentRequest,
  bearerMatches,
  isPublicPath,
  handleAuthRoutes,
  isSetup,
  loadCredentials,
  saveCredentials,
  countCredentials,
  sanitizeNickname,
  listCredentialsForUser,
  deleteCredentialForUser,
  getSessionRecord,
};
