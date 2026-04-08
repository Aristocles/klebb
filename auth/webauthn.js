const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// Config
const RP_NAME = 'EddzHealth';
const RP_ID = 'axis.vorignet.com';
const ORIGIN = 'https://eddzhealth.axis.vorignet.com';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'webauthn-credentials.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'webauthn-sessions.json');
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

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { created: Date.now(), lastSeen: Date.now() };
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
  const match = cookie.match(/vorhealth_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `vorhealth_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'vorhealth_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// Auth middleware: returns true if request is authenticated (or route is public)
function isAuthenticated(req) {
  // If no credentials registered yet, allow everything (setup mode)
  if (!isSetup()) return true;
  return validateSession(getSessionToken(req));
}

// Public paths that don't need auth
function isPublicPath(pathname) {
  const publicPaths = [
    '/auth/',
    '/login',
    '/setup',
    '/api/',
  ];
  return publicPaths.some(p => pathname.startsWith(p));
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

  // POST /auth/register/options — generate registration options
  if (pathname === '/auth/register/options' && req.method === 'POST') {
    // Only allow registration if no credentials exist yet (first setup)
    // or if already authenticated (adding another device)
    if (isSetup() && !validateSession(getSessionToken(req))) {
      return sendJSON(res, { error: 'Unauthorized' }, 401);
    }

    const creds = loadCredentials();
    const userId = 'eddy'; // single user app
    const existingCreds = creds.users[userId]?.credentials || [];

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: 'Eddy',
      userDisplayName: 'Eddy',
      attestationType: 'none',
      excludeCredentials: existingCreds.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    pendingChallenges.set(userId, options.challenge);
    setTimeout(() => pendingChallenges.delete(userId), 120000); // 2 min expiry

    return sendJSON(res, options);
  }

  // POST /auth/register/verify — verify registration
  if (pathname === '/auth/register/verify' && req.method === 'POST') {
    if (isSetup() && !validateSession(getSessionToken(req))) {
      return sendJSON(res, { error: 'Unauthorized' }, 401);
    }

    const body = JSON.parse(await readBody(req));
    const userId = 'eddy';
    const challenge = pendingChallenges.get(userId);

    if (!challenge) {
      return sendJSON(res, { error: 'Challenge expired' }, 400);
    }

    try {
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;
        const creds = loadCredentials();
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
        pendingChallenges.delete(userId);

        const token = createSession();
        setSessionCookie(res, token);
        return sendJSON(res, { verified: true });
      }

      return sendJSON(res, { error: 'Verification failed' }, 400);
    } catch (e) {
      console.error('Registration verification error:', e.message);
      return sendJSON(res, { error: e.message }, 400);
    }
  }

  // POST /auth/login/options — generate authentication options
  if (pathname === '/auth/login/options' && req.method === 'POST') {
    const creds = loadCredentials();
    const userId = 'eddy';
    const userCreds = creds.users[userId]?.credentials || [];

    if (userCreds.length === 0) {
      return sendJSON(res, { error: 'No credentials registered' }, 400);
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: userCreds.map(c => ({
        id: c.id,
        type: 'public-key',
      })),
      userVerification: 'preferred',
    });

    pendingChallenges.set(userId + '_login', options.challenge);
    setTimeout(() => pendingChallenges.delete(userId + '_login'), 120000);

    return sendJSON(res, options);
  }

  // POST /auth/login/verify — verify authentication
  if (pathname === '/auth/login/verify' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const userId = 'eddy';
    const challenge = pendingChallenges.get(userId + '_login');

    if (!challenge) {
      return sendJSON(res, { error: 'Challenge expired' }, 400);
    }

    const creds = loadCredentials();
    const userCreds = creds.users[userId]?.credentials || [];
    const credential = userCreds.find(c => c.id === body.id);

    if (!credential) {
      return sendJSON(res, { error: 'Unknown credential' }, 400);
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge,
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
        pendingChallenges.delete(userId + '_login');

        const token = createSession();
        setSessionCookie(res, token);
        return sendJSON(res, { verified: true });
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
