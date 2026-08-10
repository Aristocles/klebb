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

// How many times to redraw a port after losing the race. Each attempt asks the
// OS for a fresh number, so the chance of losing N times running is the
// per-attempt chance to the Nth power: a handful of attempts takes an
// occasional flake to negligible without masking a genuinely broken server,
// because only EADDRINUSE is retried.
const PORT_RACE_ATTEMPTS = 5;

// Spawn the server on a free port against the given sandbox.
// Resolves with { baseUrl, kill, port }. `kill()` must be called in afterEach.
//
// Retries on EADDRINUSE only (see reserveEphemeralPort for the race). It used to
// retry exactly once, which left a real residual failure rate: a full run drops
// one or two spawnServer files, a different pair each time, and every subtest in
// the dropped file reports as passing. That reads as a regression in whatever
// changed most recently and never is one, which makes it expensive in attention
// rather than in CI minutes.
//
// The window itself cannot be closed from here without production changes: the
// probe socket must be released before the child can bind it, and passing a
// listening handle down would mean teaching server.js about a test harness.
// Reproduced directly on this platform: 24 concurrent processes that probe,
// close, wait 300 ms, then bind were handed a duplicate port. So the fix is to
// make losing cheap and repeatable instead of pretending it cannot happen.
async function spawnServer(sandboxRoot, extraEnv = {}) {
  let last = null;
  for (let attempt = 0; attempt < PORT_RACE_ATTEMPTS; attempt++) {
    try {
      return await _spawnServerOnce(sandboxRoot, extraEnv);
    } catch (e) {
      // A broken server must fail on the first attempt, loudly, rather than
      // being retried four more times and reported as a port problem.
      if (!e || !e.addrInUse) throw e;
      last = e;
    }
  }
  last.message = `${last.message} (after ${PORT_RACE_ATTEMPTS} port-race retries)`;
  throw last;
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
  //
  // 30s, not 5s. node --test runs one process per file across every core, and
  // each spawnServer boots a whole server (datastore open, manifest discovery,
  // first-boot seeding) while ~90 other files compete for the same CPUs. 5s was
  // comfortable for one server and marginal for a full run. A generous ceiling
  // costs nothing when the server does start, and the exit handler below still
  // fails fast when it genuinely cannot.
  //
  // This timeout is NOT the cause of the "a random file aborts with every
  // subtest passing" flake, despite an earlier note here saying so. Raising it
  // reduced that symptom without curing it, which was the clue. Two real causes
  // were found and fixed separately: the port TOCTOU above, and three tests
  // sleeping a fixed duration while waiting for an event (use waitFor). A
  // residual case is a native process kill, which no timeout can prevent; run
  // `npm run test:diag` to see a dead child's actual exit code, because the
  // default reporter discards it.
  const STARTUP_TIMEOUT_MS = Number(process.env.KLEBB_TEST_STARTUP_TIMEOUT_MS) || 30000;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`server did not start in ${STARTUP_TIMEOUT_MS}ms`)),
      STARTUP_TIMEOUT_MS);
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
    // A spawn that never starts (a bad executable path, EPERM from a security
    // product) emits 'error' and never 'exit'. Without this listener that is an
    // unhandled 'error' event, and the visible symptom is the startup timeout
    // above followed by a stack pointing at the harness rather than at the real
    // cause, which is a slow and misleading way to learn the binary is missing.
    proc.on('error', e => {
      clearTimeout(timeout);
      reject(new Error(`server process failed to spawn: ${e.message}`));
    });
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
      // Clear the escalation timer when the child exits promptly, which is the
      // normal case. Leaving it pending held a ref'd handle for a further two
      // seconds after every suite that spawns a server, and there are dozens of
      // those: measured at roughly 2s of wall clock each.
      const escalate = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 2000);
      proc.once('exit', () => {
        clearTimeout(escalate);
        resolve();
      });
      try { proc.kill('SIGTERM'); } catch {}
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

// Wait until `check()` returns truthy, polling. Returns its value.
//
// Use this instead of `await new Promise(r => setTimeout(r, 400))` whenever a
// test is waiting for something to HAPPEN (an fs.watch reload, a child process
// exiting, a debounce firing). A fixed sleep encodes a guess about how fast the
// machine is: node --test runs one process per file across every core, so a
// duration that is generous when the file runs alone can be too short under a
// full run. That produces a test which passes standalone, fails intermittently
// in the suite, and looks like a regression in whatever changed last.
//
// The default ceiling is deliberately far longer than any real wait, because a
// long ceiling costs nothing when the condition is met promptly and the throw
// below still fails the test when it genuinely never happens.
async function waitFor(check, { timeoutMs = 15000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = {
  createSandbox,
  cleanupSandbox,
  spawnServer,
  req,
  sessionCookie,
  fakeAuthState,
  waitFor,
  REPO_ROOT,
};
