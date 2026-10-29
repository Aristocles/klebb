// SPDX-License-Identifier: AGPL-3.0-only
// Controlled synthetic inputs and real scoped HAE token/server setup for #803.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSandbox, cleanupSandbox, spawnServer, req, fakeAuthState } = require('./sandbox');
const C = require('./hae-history-durability-cold-readback.cjs');
const PRODUCT = path.resolve(__dirname, '..', '..');
const BASE = '/api/health-auto-export';
const TOKEN = `${BASE}/token`;
const PRELOAD = path.join(__dirname, 'hae-history-durability-preload.cjs');

// Embedded original six-file bank bytes; no private preparation path is imported.
const ORIGINAL_BANK = {
  "core07-storage-failure.payload.json": {
    "sha256": "sha256:7c06ffb09afda6de6fd81049a8082d32ee3ce31717658bfda409b3a356e39beb",
    "wire": "{\n  \"data\": {\n    \"metrics\": [\n      {\n        \"name\": \"body_mass\",\n        \"units\": \"lb\",\n        \"data\": [\n          {\n            \"date\": \"2026-01-10\",\n            \"qty\": 176.4\n          }\n        ]\n      },\n      {\n        \"name\": \"synthetic_history_only_metric\",\n        \"units\": \"count\",\n        \"data\": [\n          {\n            \"date\": \"2026-01-10\",\n            \"qty\": 2.25\n          }\n        ]\n      }\n    ]\n  }\n}\n"
  },
  "core07-storage-failure.expectations.json": {
    "sha256": "sha256:2d15e2dd00418d716effe0c8c6324012fb51d5ca6492f4d3da828bb207052e19",
    "wire": "{\n  \"status\": \"prepared-fixture-not-acceptance-evidence\",\n  \"issue\": \"https://github.com/Aristocles/klebb/issues/763\",\n  \"dependencies\": [\n    \"CORE-02\",\n    \"AND-01/G0 native feasibility\"\n  ],\n  \"synthetic\": true,\n  \"initialState\": {\n    \"historyForFixture\": [],\n    \"weightCardRows\": [\n      {\n        \"date\": \"2026-01-10\",\n        \"kg\": 75\n      }\n    ],\n    \"historyOnlyMetricHasCard\": false\n  },\n  \"fault\": {\n    \"boundary\": \"recognised history persistence before any fixture write\",\n    \"kind\": \"retryable-storage-write-failure\",\n    \"injectionImplementation\": \"to be selected in the eligible regression harness\"\n  },\n  \"expectedFailedAttempt\": {\n    \"successfulSaveResponse\": false,\n    \"retryableStorageFailure\": true,\n    \"historyForFixture\": [],\n    \"weightCardRows\": [\n      {\n        \"date\": \"2026-01-10\",\n        \"kg\": 75\n      }\n    ],\n    \"exactHttpStatusAndFields\": \"define compatibly in CORE-07 before implementing the API assertion\"\n  },\n  \"expectedSamePayloadRetryAfterRecovery\": {\n    \"successfulSaveResponse\": true,\n    \"durablyPreservedRecognisedSamples\": 2,\n    \"durablyPreservedMetricNames\": [\n      \"body_mass\",\n      \"synthetic_history_only_metric\"\n    ],\n    \"weightCardRows\": [\n      {\n        \"date\": \"2026-01-10\",\n        \"kg\": 80\n      }\n    ],\n    \"historyOnlyMetricHasCard\": false,\n    \"readbackMethod\": \"independent durable database handle, including a restart/reopen boundary\"\n  },\n  \"additionalRequiredScenarios\": [\n    {\n      \"name\": \"lost-success-response\",\n      \"given\": \"history is committed but the client does not receive the response\",\n      \"retryExpectation\": \"same recognised samples remain recoverable without double-counting displayed values; existing HAE duplicate/push semantics remain explicit\",\n      \"nativeHaeObservationRequired\": true\n    },\n    {\n      \"name\": \"late-retry\",\n      \"given\": \"storage recovers after a delayed retry/backfill opportunity\",\n      \"retryExpectation\": \"recognised undisplayed history is saved and existing latest-push/replay rules are preserved\",\n      \"nativeHaeObservationRequired\": true\n    },\n    {\n      \"name\": \"saved-history-projection-failure\",\n      \"given\": \"raw history commits but card projection fails\",\n      \"expectation\": \"response distinguishes saved history from failed card projection and retained history supports recovery\",\n      \"exactResponseFieldsPending\": true\n    }\n  ],\n  \"baselineObservationSource\": \"current-iphone-audit.md; no storage-failure experiment was run during fixture preparation\",\n  \"completionClaim\": false\n}\n"
  },
  "core09-aba-sleep.payload.json": {
    "sha256": "sha256:94481a2e0179c1dd812f9d623064b67fed01244892ab94528f78569d72081ea9",
    "wire": "{\n  \"data\": {\n    \"metrics\": [\n      {\n        \"name\": \"sleep_analysis\",\n        \"units\": \"hr\",\n        \"data\": [\n          {\n            \"date\": \"2026-01-10\",\n            \"totalSleep\": 7\n          },\n          {\n            \"date\": \"2026-01-10\",\n            \"totalSleep\": 8\n          },\n          {\n            \"date\": \"2026-01-10\",\n            \"totalSleep\": 7\n          }\n        ]\n      }\n    ]\n  }\n}\n"
  },
  "core09-aba-sleep.expectations.json": {
    "sha256": "sha256:538aa6a3b073072eda20c793d6afbb8c06ff05f1d8fa7db19ca22ffcc48fc0a2",
    "wire": "{\n  \"status\": \"prepared-fixture-not-acceptance-evidence\",\n  \"issue\": \"https://github.com/Aristocles/klebb/issues/765\",\n  \"dependencies\": [\n    \"CORE-07\",\n    \"CORE-02\",\n    \"AND-01/G0 native feasibility\"\n  ],\n  \"synthetic\": true,\n  \"metric\": \"sleep_analysis\",\n  \"expectedPreservedOccurrences\": [\n    {\n      \"wrapperIndex\": 0,\n      \"sampleIndex\": 0,\n      \"contentLabel\": \"A\",\n      \"totalSleep\": 7\n    },\n    {\n      \"wrapperIndex\": 0,\n      \"sampleIndex\": 1,\n      \"contentLabel\": \"B\",\n      \"totalSleep\": 8\n    },\n    {\n      \"wrapperIndex\": 0,\n      \"sampleIndex\": 2,\n      \"contentLabel\": \"A\",\n      \"totalSleep\": 7\n    }\n  ],\n  \"expectedOccurrenceCount\": 3,\n  \"expectedDistinctSampleContentCount\": 2,\n  \"expectedLiveRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"hours\": 7\n    }\n  ],\n  \"expectedReplayRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"hours\": 7\n    }\n  ],\n  \"expectedPortableRoundTripRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"hours\": 7\n    }\n  ],\n  \"independentExpectationReason\": \"The final occurrence for this date is A with 7 hours; repeated content is not permission to move that occurrence before B.\",\n  \"recordedPriorProbe\": {\n    \"source\": \"iphone-replay-edge-results.json\",\n    \"liveHours\": 7,\n    \"replayHours\": 8,\n    \"rerunDuringPreparation\": false\n  },\n  \"legacyConstraint\": \"If a historical compacted capture cannot establish exact order, preserve known-valid existing rows and report ambiguity rather than rebuilding from assumed ordering.\",\n  \"schemaImplementationSpecified\": false,\n  \"completionClaim\": false\n}\n"
  },
  "core09-mixed-weight-wrappers.payload.json": {
    "sha256": "sha256:02fd146faf92a39b321bff014fc8595922672c3caecee966d97937469faa5a8a",
    "wire": "{\n  \"data\": {\n    \"metrics\": [\n      {\n        \"name\": \"body_mass\",\n        \"units\": \"lb\",\n        \"data\": [\n          {\n            \"date\": \"2026-01-10\",\n            \"qty\": 176.4\n          }\n        ]\n      },\n      {\n        \"name\": \"body_mass\",\n        \"units\": \"kg\",\n        \"data\": [\n          {\n            \"date\": \"2026-01-10\",\n            \"qty\": 90\n          }\n        ]\n      }\n    ]\n  }\n}\n"
  },
  "core09-mixed-weight-wrappers.expectations.json": {
    "sha256": "sha256:e8487e0839a0772180f1c64ef37d74066e20184eae51d410804d6203a42b208b",
    "wire": "{\n  \"status\": \"prepared-fixture-not-acceptance-evidence\",\n  \"issue\": \"https://github.com/Aristocles/klebb/issues/765\",\n  \"dependencies\": [\n    \"CORE-07\",\n    \"CORE-02\",\n    \"AND-01/G0 native feasibility\"\n  ],\n  \"synthetic\": true,\n  \"metric\": \"body_mass\",\n  \"expectedPreservedWrappers\": [\n    {\n      \"wrapperIndex\": 0,\n      \"units\": \"lb\",\n      \"sampleIndex\": 0,\n      \"qty\": 176.4\n    },\n    {\n      \"wrapperIndex\": 1,\n      \"units\": \"kg\",\n      \"sampleIndex\": 0,\n      \"qty\": 90\n    }\n  ],\n  \"expectedWrapperCount\": 2,\n  \"expectedOccurrenceCount\": 2,\n  \"compatibilityRule\": \"Preserve the existing live first-matching-wrapper selection; retain both wrappers as source history.\",\n  \"independentConversion\": {\n    \"firstWrapperPounds\": 176.4,\n    \"kilogramsPerPound\": 0.45359237,\n    \"unroundedKilograms\": 80.013694068,\n    \"cardDecimalPlaces\": 1,\n    \"expectedCardKilograms\": 80\n  },\n  \"expectedLiveRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"kg\": 80\n    }\n  ],\n  \"expectedReplayRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"kg\": 80\n    }\n  ],\n  \"expectedPortableRoundTripRows\": [\n    {\n      \"date\": \"2026-01-10\",\n      \"kg\": 80\n    }\n  ],\n  \"recordedPriorProbe\": {\n    \"source\": \"iphone-replay-edge-results.json\",\n    \"liveKilograms\": 80,\n    \"replayKilograms\": 40.8,\n    \"rerunDuringPreparation\": false\n  },\n  \"semanticChangeConstraint\": \"Selecting the second wrapper as 90 kg would change the live contract and needs an explicit versioned semantic change and preview; it is not the compatibility expectation here.\",\n  \"legacyConstraint\": \"Protect known-valid card rows where old capture cannot establish exact wrapper metadata/order; require uncertainty reporting or source reexport.\",\n  \"schemaImplementationSpecified\": false,\n  \"completionClaim\": false\n}\n"
  }
};
const bank = name => ORIGINAL_BANK[name].wire;
const STORAGE_WIRE = bank('core07-storage-failure.payload.json');
const MIXED_WIRE = bank('core09-mixed-weight-wrappers.payload.json');
const SINGLE_WIRE = '{"data":{"metrics":[{"name":"body_mass","units":"lb","data":[{"date":"2026-01-10","qty":176.4}]}]}}';
const EXPECTED_SAMPLES = [
  { metric: 'body_mass', metric_meta: '{"units":"lb"}', doc: '{"date":"2026-01-10","qty":176.4}',
    sample_date: '2026-01-10', hashHex: '27140aab3cbd57df74cc560b78c00cca',
    dup_count: 1, push_ord: 0, first_push: 1, last_push: 1 },
  { metric: 'synthetic_history_only_metric', metric_meta: '{"units":"count"}',
    doc: '{"date":"2026-01-10","qty":2.25}', sample_date: '2026-01-10',
    hashHex: 'cb1ee8930bab91e2c508e1a5a0033ea3', dup_count: 1, push_ord: 1, first_push: 1, last_push: 1 },
];
const SEED = {
  'weight.json': { $schema: 'klebb.datafile.v1',
    meta: { id: 'weight', label: 'Weight', order: 520,
      ingest: { source: 'hae', metric: 'body_mass' },
      view: { enabled: true, component: 'generic-card' }, writeable: { fromWebapp: false } },
    data: [{ date: '2026-01-10', kg: 75 }] },
  'legacy.json': { $schema: 'klebb.datafile.v1',
    meta: { id: 'legacy', label: 'Independent legacy marker', order: 521,
      view: { enabled: true, component: 'generic-card' }, writeable: { fromWebapp: false } },
    data: [{ date: '2026-01-09', value: 'independent-legacy-marker' }] },
};
function publish(file, value) {
  const fd = fs.openSync(`${file}.next`, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
  fs.renameSync(`${file}.next`, file);
}
function environment(home) {
  return { HEALTH_HOME: home, HEALTH_DB_DIR: path.join(home, 'db'),
    HEALTH_DB_FILE: path.join(home, 'db', 'klebb.db'), HEALTH_DATA_DIR: path.join(home, 'data'),
    HEALTH_CONFIG_PATH: path.join(home, 'config.json'),
    HEALTH_AUTO_EXPORT_DIR: path.join(home, 'data', 'auto-export'),
    HEALTH_CREDENTIALS_DIR: path.join(home, 'credentials'), HEALTH_SESSIONS_DIR: path.join(home, 'sessions'),
    HEALTH_AUTO_EXPORT_TOKEN: '', KLEBB_SKIP_HOME_ENV: '1', HEALTH_HOME_WARNED: '1' };
}
async function controlChild(home, command, kind = 'none') {
  C.owned(home);
  const child = spawn(process.execPath, [__filename, command, home, kind],
    { cwd: PRODUCT, env: { ...process.env, ...environment(home), NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', timedOut = false;
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { err += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        reject(new Error(`owned fixture control failed: ${command} code=${code} signal=${signal} timeout=${timedOut}\n${err}`));
      } else {
        const result = JSON.parse(out.trim().split(/\r?\n/).at(-1));
        assert.equal(result.ok, true);
        resolve(result);
      }
    });
  });
}
async function fixture(t, { fault = 'none', issueToken = true } = {}) {
  for (const original of Object.values(ORIGINAL_BANK)) assert.equal(C.digest(Buffer.from(original.wire)), original.sha256);
  const auth = fakeAuthState('synthetic-hae-owner');
  const home = createSandbox({ seed: SEED, credentials: auth.credentials, sessions: auth.sessions });
  C.owned(home);
  const control = path.join(home, '.hae-history-durability');
  fs.mkdirSync(control, { mode: 0o700 });
  const data = { home, control, auth, server: null, token: null, revision: 0 };
  const extra = { ...environment(home), HAE_DURABILITY_CONTROL: control,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${PRELOAD.replaceAll('\\', '/')}"`.trim() };
  data.arm = mode => {
    assert.ok(['observe', 'full', 'busy', 'before-commit', 'after-commit'].includes(mode));
    assert.ok(++data.revision <= 16);
    publish(path.join(control, `arm-${String(data.revision).padStart(4, '0')}.json`),
      { revision: data.revision, mode });
  };
  data.events = () => fs.readdirSync(control)
    .filter(name => new RegExp(`^event-${String(data.revision).padStart(4, '0')}-\\d+-\\d{4}\\.json$`).test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(control, name), 'utf8')))
    .sort((a, b) => a.sequence - b.sequence);
  data.release = () => {
    for (const name of fs.readdirSync(control).filter(name => /^holder-ready-\d+\.json$/.test(name))) {
      const revision = Number(name.match(/\d+/)[0]);
      const release = path.join(control, `holder-release-${revision}.json`);
      if (!fs.existsSync(release)) publish(release, { releaseOwnedLock: true });
    }
  };
  data.stop = async () => {
    data.release();
    if (!data.server) return;
    const old = data.server;
    data.server = null;
    await old.kill();
    await old.closed;
  };
  data.start = async () => {
    assert.equal(data.server, null);
    const server = await spawnServer(home, extra);
    server.closed = new Promise(resolve => server.proc.once('close', (code, signal) => resolve({ code, signal })));
    data.server = server;
    // The real authenticated token read is a boot-complete barrier; it does not ingest.
    const r = await req(server.baseUrl, TOKEN, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    if (data.token) assert.equal(r.json.token, data.token);
    return server;
  };
  data.makeToken = async () => {
    const r = await req(data.server.baseUrl, TOKEN, { method: 'POST', cookie: auth.cookie });
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    data.token = r.json.token;
  };
  data.post = (wire = STORAGE_WIRE, token = data.token) => req(data.server.baseUrl, BASE,
    { method: 'POST', body: wire, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  data.card = async id => {
    const r = await req(data.server.baseUrl, `/api/manifests/${id}/data`, { cookie: auth.cookie });
    assert.equal(r.status, 200);
    return r.json.data;
  };
  data.cold = () => C.coldRead(home);
  data.removeFault = async () => {
    await data.stop();
    await controlChild(home, 'remove-fault', fault);
    data.arm('observe');
    await data.start();
  };
  data.replay = async () => {
    await data.stop();
    return controlChild(home, 'replay');
  };
  data.close = async () => {
    await data.stop();
    C.owned(home);
    cleanupSandbox(home);
  };
  t.after(() => data.close());
  await data.start();
  if (issueToken) await data.makeToken();
  await data.stop();
  await controlChild(home, 'seed', fault);
  data.arm('observe');
  await data.start();
  assert.deepEqual(await data.card('weight'), SEED['weight.json'].data);
  assert.deepEqual(await data.card('legacy'), SEED['legacy.json'].data);
  assert.equal(C.samples(data.cold()).length, 0);
  return data;
}
function assertStorageFailure(response) {
  assert.equal(response.status, 503);
  assert.equal(response.body, '{"error":"history storage unavailable","retryable":true}');
  assert.deepEqual(response.json, { error: 'history storage unavailable', retryable: true });
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(response.headers['retry-after'], undefined);
}
function assertWriter(events) {
  const begin = events.find(e => e.kind === 'history-before-begin');
  assert.ok(begin);
  assert.equal(begin.journalMode, 'wal');
  assert.equal(begin.synchronous, 2);
  assert.equal(begin.busyTimeout, 5000);
  assert.equal(begin.sql.toUpperCase(), 'BEGIN IMMEDIATE');
  return begin.handle;
}
function assertCommitted(events) {
  const handle = assertWriter(events);
  const commit = events.find(e => e.kind === 'history-commit' && e.handle === handle);
  const response = events.find(e => e.kind === 'response-head');
  assert.ok(commit && response && commit.sequence < response.sequence);
  assert.equal(commit.nativeTransactionActive, false);
  assert.equal(commit.earlier.pushWrites, 1);
  return commit;
}
async function postOversize(data) {
  const url = new URL(BASE, data.server.baseUrl), bytes = 100 * 1024 * 1024 + 1;
  let request;
  const reply = new Promise((resolve, reject) => {
    request = http.request(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}`, 'Content-Length': bytes } },
    response => {
      let body = '';
      response.on('data', b => { body += b; });
      response.on('end', () => resolve({ status: response.statusCode, body, json: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('request timeout')));
  });
  const chunk = Buffer.alloc(64 * 1024, 32);
  for (let sent = 0; sent < bytes;) {
    const length = Math.min(chunk.length, bytes - sent);
    if (!request.write(chunk.subarray(0, length))) await once(request, 'drain');
    sent += length;
  }
  request.end();
  return reply;
}
async function main() {
  const [command, home, kind] = process.argv.slice(2);
  C.owned(home);
  if (command === 'replay') {
    const registry = require('../../manifests/registry');
    const samples = require('../../health-auto-export/samples');
    try {
      await registry.init();
      const result = require('../../health-auto-export/replay').replayFromArchive(registry, 'weight', { force: true });
      assert.equal(result.skipped, false);
      assert.equal(result.rowsWritten, 1);
      console.log(JSON.stringify({ ok: true, rowsWritten: 1 }));
    } finally { registry.stopWatch(); registry.closeStore(); samples.close(); }
    return;
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    if (command === 'seed') {
      db.exec(`
        CREATE TABLE hae_pushes (
          push_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          received_at TEXT NOT NULL, source_file TEXT UNIQUE
        );
        CREATE TABLE hae_samples (
          hash BLOB PRIMARY KEY, metric TEXT NOT NULL, metric_meta TEXT, sample_date TEXT,
          doc TEXT NOT NULL, dup_count INTEGER NOT NULL, push_ord INTEGER NOT NULL,
          first_push INTEGER NOT NULL, last_push INTEGER NOT NULL
        );
        CREATE INDEX idx_hae_samples_metric ON hae_samples (metric, sample_date);
        CREATE INDEX idx_hae_samples_last_push ON hae_samples (last_push, push_ord);
        CREATE INDEX idx_hae_samples_first_push ON hae_samples (first_push);
      `);
      if (kind === 'full') db.exec(`
        CREATE TABLE synthetic_hae_capacity (payload BLOB NOT NULL);
        CREATE TRIGGER synthetic_hae_full AFTER INSERT ON hae_samples
        WHEN NEW.metric = 'synthetic_history_only_metric'
        BEGIN INSERT INTO synthetic_hae_capacity VALUES(zeroblob(1048576)); END;
      `);
      if (kind === 'projection') db.exec(`
        CREATE TRIGGER synthetic_hae_projection BEFORE INSERT ON rows
        WHEN NEW.card_id = 'weight'
        BEGIN SELECT RAISE(ABORT,'synthetic projection refusal'); END;
      `);
    } else if (command === 'remove-fault') {
      if (kind === 'full') db.exec('DROP TRIGGER synthetic_hae_full; DROP TABLE synthetic_hae_capacity');
      if (kind === 'projection') db.exec('DROP TRIGGER synthetic_hae_projection');
    } else throw new Error('unknown owned fixture command');
    db.exec('COMMIT');
    console.log(JSON.stringify({ ok: true }));
  } finally { db.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { fixture, STORAGE_WIRE, MIXED_WIRE, SINGLE_WIRE, EXPECTED_SAMPLES,
  ORIGINAL_BANK, SEED, BASE, TOKEN, C, req, assertStorageFailure, assertWriter, assertCommitted, postOversize };
