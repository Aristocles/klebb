// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/sandbox.js
// Spin up an ephemeral HEALTH_HOME + a test server for each test suite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Create a temp HEALTH_HOME with skeleton directories and optional seed files.
function createSandbox({ seed = {}, credentials = null, sessions = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', '_archive'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'auto-export', 'sleep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'auto-export', 'workouts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'auto-export', 'vitals'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'auto-export', 'activity'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(root, 'inbox', '_failed'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports', '_archive'), { recursive: true });

  // Write seed manifest files
  for (const [filename, content] of Object.entries(seed)) {
    const dst = path.join(root, 'data', filename);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }

  // Optionally seed credentials + sessions so auth-gated tests work
  if (credentials) {
    fs.writeFileSync(path.join(root, 'credentials', 'webauthn.json'), JSON.stringify(credentials, null, 2));
  }
  if (sessions) {
    fs.writeFileSync(path.join(root, 'sessions', 'webauthn.json'), JSON.stringify(sessions, null, 2));
  }

  return root;
}

function cleanupSandbox(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// Ask the OS for a port nobody is using, then close it and hand the number to
// the child. A plain random pick had no collision check and no retry: with the
// suite count this repo now runs in parallel, two sandboxes drawing the same
// number is a coin-flip over a full run (birthday collision over a 20k range),
// and the loser's server dies of EADDRINUSE before it prints anything, so the
// failure surfaces as a bare "server exited with code 1" in whichever suite
// drew second. That looks like a logic bug in whatever changed most recently
// and is not one.
//
// There is still a small window between closing the probe and the child
// binding, so the caller retries once on a bind failure. Not a general fix for
// TOCTOU, but it turns a routine flake into a vanishing one.
function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

// Spawn the server on a free port against the given sandbox.
// Resolves with { baseUrl, kill, port }. `kill()` must be called in afterEach.
// Retries once if it loses the port race (see reserveEphemeralPort).
async function spawnServer(sandboxRoot, extraEnv = {}) {
  try {
    return await _spawnServerOnce(sandboxRoot, extraEnv);
  } catch (e) {
    if (!e || !e.addrInUse) throw e;
    return _spawnServerOnce(sandboxRoot, extraEnv);
  }
}

async function _spawnServerOnce(sandboxRoot, extraEnv = {}) {
  const port = await reserveEphemeralPort();
  const env = {
    ...process.env,
    HEALTH_HOME: sandboxRoot,
    PORT: String(port),
    HOST: '127.0.0.1',
    // Match the URL the test harness will actually hit, so Origin
    // allowlist checks pass.
    HEALTH_ORIGIN: `http://127.0.0.1:${port}`,
    HEALTH_RP_ID: '127.0.0.1',
    // Disable external calls in tests
    CHAT_ENDPOINT_URL: 'http://127.0.0.1:1/v1/chat/completions',  // will fail; tests that touch chat override this
    CHAT_API_KEY: 'test-token',
    FISH_AUDIO_API_KEY: '',          // disables voice
    FISH_AUDIO_DEFAULT_VOICE: '',
    KLEBB_SKIP_HOME_ENV: '1',   // prevent ~/.env leaking real keys into test
    HEALTH_HOME_WARNED: '1',
    SESSION_SECRET: 'test-secret-' + crypto.randomBytes(8).toString('hex'),
    ...extraEnv,
  };

  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });

  // Wait for "Health dashboard running" on stdout (or a small delay).
  // stderr is captured too: a bind failure prints there, and reporting only
  // stdout made an EADDRINUSE death look like a silent exit with no reason.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in 5s')), 5000);
    let buf = '';
    let errBuf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      if (buf.includes('Health dashboard running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', chunk => { errBuf += chunk.toString(); });
    proc.on('exit', code => {
      clearTimeout(timeout);
      const why = (errBuf || buf).slice(-400);
      const err = new Error(`server exited with code ${code}: ${why}`);
      // Let the caller distinguish "lost a port race" from "the server is
      // broken", so only the former is retried.
      err.addrInUse = /EADDRINUSE/.test(errBuf);
      reject(err);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    proc,
    kill: () => new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 2000);
    }),
  };
}

// Simple JSON request helper. Returns { status, headers, body, json }.
function req(baseUrl, pathname, { method = 'GET', body = null, headers = {}, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { 'Cookie': cookie } : {}),
        ...headers,
      },
    };
    const r = http.request(url, opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => { r.destroy(new Error('request timeout')); });
    if (body !== null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// Build a Cookie header string for a session token.
function sessionCookie(token) {
  return `klebb_session=${token}`;
}

// Generate a fake registered-user state so the server isSetup() returns true
// and sessions are valid. Returns { credentials, sessions, token }.
function fakeAuthState(label = 'testuser') {
  const token = crypto.randomBytes(32).toString('hex');
  const credentialId = 'fake-' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  return {
    credentialId,
    credentials: {
      users: {
        [label]: {
          credentials: [
            {
              id: credentialId,
              publicKey: 'fake',
              counter: 0,
              deviceType: 'test',
              nickname: null,
              registeredAt: now,
              lastUsedAt: now,
            },
          ],
        },
      },
    },
    sessions: {
      [token]: {
        created: Date.now(),
        lastSeen: Date.now(),
        userId: label,
        credentialId,
      },
    },
    token,
    cookie: sessionCookie(token),
  };
}

module.exports = {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  sessionCookie,
  fakeAuthState,
  REPO_ROOT,
};
