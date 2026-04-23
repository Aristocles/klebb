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

function saveCredentials(data) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { created: Date.now(), lastSeen: Date.now(), userId: userId || null };
  saveSessions(sessions);
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return false;
  if (Date.now() - session.created > SESSION_MAX_AGE) {
    delete sessions[token];
    saveSessions(sessions);
    return false;
  }
  session.lastSeen = Date.now();
  saveSessions(sessions);
  return true;
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
  // If no credentials registered yet, allow everything (setup mode)
  if (!isSetup()) return true;
  // Server-to-server: Bearer token from AGENT_API_TOKEN env
  const agentToken = process.env.AGENT_API_TOKEN;
  if (agentToken) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && auth.slice(7).trim() === agentToken) {
      return true;
    }
  }
  return validateSession(getSessionToken(req));
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
    '/favicon.ico',
  ];
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

  // GET /auth/status — check if setup + authenticated
  if (pathname === '/auth/status') {
    const setup = isSetup();
    const authenticated = validateSession(getSessionToken(req));
    return sendJSON(res, { setup, authenticated });
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
    if (!isSetup()) return sendJSON(res, { available: true, reason: 'bootstrap' });
    if (validateSession(getSessionToken(req)) && !invites.requireInviteForRegistration()) {
      return sendJSON(res, { available: true, reason: 'add-device' });
    }
    return sendJSON(res, { available: false, reason: 'closed' });
  }

  // POST /auth/register/options — generate registration options
  // Body may include: { code?: string, label?: string }
  // Registration is gated by:
  //   (a) a valid unused invite code, OR
  //   (b) no credentials exist yet (bootstrap first user), OR
  //   (c) already authenticated AND requireInviteForRegistration === false (legacy)
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
    // Path B: bootstrap — no credentials exist yet; first registration wins
    else if (!isSetup()) {
      if (!label) label = 'user';
    }
    // Path C: authenticated + legacy mode — adding device to existing account
    else if (validateSession(getSessionToken(req))) {
      if (invites.requireInviteForRegistration()) {
        return sendJSON(res, { error: 'Invite required' }, 403);
      }
      // Use the existing primary label if present; fall back to 'user'.
      if (!label) label = Object.keys(loadCredentials().users || {})[0] || 'user';
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
        creds.users[userId].credentials.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64'),
          counter: credential.counter,
          deviceType: body.authenticatorAttachment || 'unknown',
          registeredAt: new Date().toISOString(),
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

        const token = createSession(userId);
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
        // Update counter
        credential.counter = verification.authenticationInfo.newCounter;
        saveCredentials(creds);
        pendingChallenges.delete('__login');
        invites.recordAuthEvent({ kind: 'login.success', label: matchedUser });

        const token = createSession(matchedUser);
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
  isPublicPath,
  handleAuthRoutes,
  isSetup,
};
