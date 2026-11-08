// SPDX-License-Identifier: AGPL-3.0-only
// Shared browser read behavior without rendering components or contacting a server.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_FILE = path.join(__dirname, '..', 'public', 'js', 'lib', 'manifest-reads.js');
let moduleSequence = 0;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function fixture(t, fetchImpl) {
  let now = Date.UTC(2026, 0, 1);
  const calls = [];
  const browser = new EventTarget();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
  Object.defineProperty(globalThis, 'CustomEvent', {
    value: class extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.detail = options.detail;
      }
    },
    configurable: true,
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
    else delete globalThis.CustomEvent;
  });
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return fetchImpl(String(url), options, calls.length);
  });
  // Each import owns its caches and event listeners. A data URL lets the
  // browser ES module run inside the CommonJS test suite without a bundler.
  const errorSource = fs.readFileSync(path.join(path.dirname(MODULE_FILE), 'save-error.js'), 'utf8');
  const errorURL = `data:text/javascript;base64,${Buffer.from(errorSource).toString('base64')}`;
  const source = fs.readFileSync(MODULE_FILE, 'utf8')
    .replace("'./save-error.js'", JSON.stringify(errorURL));
  const moduleURL = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// Test instance ${++moduleSequence}\n`,
  ).toString('base64')}`;
  const reads = await import(moduleURL);
  return {
    reads,
    calls,
    browser,
    advance(ms) { now += ms; },
    get now() { return now; },
  };
}

async function settledTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

const history = [{ date: '2026-01-01', value: 1 }];

describe('shared manifest reads', { concurrency: false }, () => {
  test('ordinary history shares inflight work and remains fresh for 20 seconds', async t => {
    const gate = deferred();
    const f = await fixture(t, async () => {
      if (f.calls.length === 1) await gate.promise;
      return response({ data: history });
    });
    const first = f.reads.fetchManifestData('fixture');
    const second = f.reads.fetchManifestData('fixture');
    await settledTurn();
    assert.equal(f.calls.length, 1);
    gate.resolve();
    assert.deepEqual(await first, history);
    assert.deepEqual(await second, history);
    f.advance(19_999);
    assert.deepEqual(await f.reads.fetchManifestData('fixture'), history);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await f.reads.fetchManifestData('fixture');
    assert.equal(f.calls.length, 2);
  });

  test('a disconnected first subscriber cannot discard a shared confirmed read', async t => {
    const gate = deferred();
    const f = await fixture(t, async () => {
      await gate.promise;
      return response({ data: history });
    });
    const abandoned = f.reads.fetchManifestData('fixture', () => false);
    const mounted = f.reads.fetchManifestData('fixture', () => true);
    gate.resolve();
    await abandoned;
    assert.deepEqual(await mounted, history);
    assert.deepEqual(f.reads.peekManifestData('fixture'), history);
    await f.reads.fetchManifestData('fixture');
    assert.equal(f.calls.length, 1);
  });

  test('metadata shares work, expires and can be explicitly invalidated', async t => {
    const gate = deferred();
    const meta = { label: 'Fixture metadata' };
    const f = await fixture(t, async () => {
      if (f.calls.length === 1) await gate.promise;
      return response({ meta });
    });
    const a = f.reads.fetchManifestMeta('fixture');
    const b = f.reads.fetchManifestMeta('fixture');
    await settledTurn();
    assert.equal(f.calls.length, 1);
    gate.resolve();
    assert.deepEqual(await a, meta);
    assert.deepEqual(await b, meta);
    assert.equal(f.calls[0].url, '/api/manifests/fixture');
    f.advance(20_000);
    await f.reads.fetchManifestMeta('fixture');
    assert.equal(f.calls.length, 2);
    f.reads.invalidateManifestMeta('fixture');
    await f.reads.fetchManifestMeta('fixture');
    assert.equal(f.calls.length, 3);
  });

  test('missing metadata returns null', async t => {
    const f = await fixture(t, async () => response({}));
    assert.equal(await f.reads.fetchManifestMeta('fixture'), null);
  });

  test('an acknowledged write fences an older GET and snapshots the submitted data', async t => {
    const oldReadGate = deferred();
    const writeGate = deferred();
    const next = [{ date: '2026-01-01', value: 2 }];
    const submitted = structuredClone(next);
    const f = await fixture(t, async (url, options) => {
      if (options.method === 'POST') {
        await writeGate.promise;
        return response({ ok: true });
      }
      await oldReadGate.promise;
      return response({ data: history });
    });
    const oldRead = f.reads.fetchManifestData('fixture');
    await settledTurn();
    const saving = f.reads.saveManifestData('fixture', next);
    const follower = f.reads.fetchManifestData('fixture');
    next[0].value = 9;
    assert.equal(f.reads.hasPendingManifestWrite('fixture'), true);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    await assert.rejects(f.reads.saveManifestData('fixture', []), /progress|wait/i);
    writeGate.resolve();
    await saving;
    assert.deepEqual(await follower, submitted);
    oldReadGate.resolve();
    assert.deepEqual(await oldRead, submitted);
    assert.deepEqual(f.reads.peekManifestData('fixture'), submitted);
    assert.deepEqual(await f.reads.fetchManifestData('fixture'), submitted);
    assert.deepEqual(JSON.parse(f.calls.find(call => call.options.method === 'POST').options.body).data, submitted);
    assert.equal(f.calls.length, 2);
  });

  test('write events fire after pending cleanup and preserve the confirmed cache', async t => {
    const f = await fixture(t, async () => response({ ok: true }));
    let eventDetail;
    f.browser.addEventListener('manifest-data-changed', event => {
      eventDetail = event.detail;
      assert.equal(f.reads.hasPendingManifestWrite('fixture'), false);
      assert.deepEqual(f.reads.peekManifestData('fixture'), history);
    });
    await f.reads.saveManifestData('fixture', history);
    assert.deepEqual(eventDetail, { cardId: 'fixture', cacheUpdated: true });
    assert.deepEqual(await f.reads.fetchManifestData('fixture'), history);
    assert.equal(f.calls.length, 1);
  });

  test('a failed write is not replayed and never publishes its candidate', async t => {
    const f = await fixture(t, async (url, options) => {
      return options.method === 'POST'
        ? response({ error: 'Temporary failure' }, 429, { 'Retry-After': '1' })
        : response({ data: history });
    });
    await f.reads.fetchManifestData('fixture');
    let failureEvents = 0;
    let successEvents = 0;
    f.browser.addEventListener('manifest-data-save-failed', event => {
      failureEvents++;
      assert.equal(event.detail.cardId, 'fixture');
      assert.equal(f.reads.hasPendingManifestWrite('fixture'), false);
    });
    f.browser.addEventListener('manifest-data-changed', () => { successEvents++; });
    await assert.rejects(f.reads.saveManifestData('fixture', [{ value: 8 }]), /Temporary failure|429/);
    f.advance(120_000);
    await settledTurn();
    assert.equal(failureEvents, 1);
    assert.equal(successEvents, 0);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
    assert.notDeepEqual(f.reads.peekManifestData('fixture'), [{ value: 8 }]);
    assert.deepEqual(await f.reads.fetchManifestData('fixture'), history);
  });

  test('a success status without acknowledgement cannot confirm a write', async t => {
    const f = await fixture(t, async () => response({}));
    await assert.rejects(f.reads.saveManifestData('fixture', history), /confirm/i);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    assert.equal(f.reads.hasPendingManifestWrite('fixture'), false);
  });

  test('external change invalidates once before readers run and they share the replacement GET', async t => {
    const gate = deferred();
    const f = await fixture(t, async () => {
      if (f.calls.length > 1) await gate.promise;
      return response({ data: history });
    });
    await f.reads.fetchManifestData('fixture');
    const revision = f.reads.manifestCacheRevision('fixture');
    const readers = [];
    f.browser.addEventListener('manifest-data-changed', () => {
      readers.push(f.reads.fetchManifestData('fixture'));
    });
    f.browser.addEventListener('manifest-data-changed', () => {
      readers.push(f.reads.fetchManifestData('fixture'));
    });
    f.browser.dispatchEvent(new CustomEvent('manifest-data-changed', { detail: { cardId: 'fixture' } }));
    await settledTurn();
    assert.equal(f.reads.manifestCacheRevision('fixture'), revision + 1);
    assert.equal(f.calls.length, 2);
    gate.resolve();
    await Promise.all(readers);
  });

  test('an external change during a save prevents candidate publication and readers wait for fresh history', async t => {
    const gate = deferred();
    const candidate = [{ date: '2026-01-01', value: 2 }];
    const currentServerData = [{ date: '2026-01-01', value: 3 }];
    let serverData = history;
    const f = await fixture(t, async (url, options) => {
      if (options.method === 'POST') {
        await gate.promise;
        return response({ ok: true });
      }
      return response({ data: serverData });
    });
    await f.reads.fetchManifestData('fixture');
    const confirmations = [];
    f.browser.addEventListener('manifest-data-changed', event => {
      if (!Object.hasOwn(event.detail, 'cacheUpdated')) return;
      confirmations.push({
        detail: event.detail,
        pending: f.reads.hasPendingManifestWrite('fixture'),
        data: f.reads.peekManifestData('fixture'),
      });
    });

    const saving = f.reads.saveManifestData('fixture', candidate);
    serverData = currentServerData;
    f.browser.dispatchEvent(new CustomEvent('manifest-data-changed', { detail: { cardId: 'fixture' } }));
    assert.equal(f.reads.hasPendingManifestWrite('fixture'), true);
    await assert.rejects(f.reads.saveManifestData('fixture', []), /progress|wait/i);
    const waitingReader = f.reads.fetchManifestData('fixture');
    await settledTurn();
    assert.equal(f.calls.filter(call => call.options.method !== 'POST').length, 1);

    gate.resolve();
    await saving;
    assert.equal(confirmations.length, 1);
    assert.deepEqual(confirmations[0].detail, { cardId: 'fixture', cacheUpdated: false });
    assert.equal(confirmations[0].pending, false);
    assert.notDeepEqual(confirmations[0].data, candidate);
    assert.deepEqual(await waitingReader, currentServerData);
    assert.deepEqual(f.reads.peekManifestData('fixture'), currentServerData);
    assert.deepEqual(await f.reads.fetchManifestData('fixture'), currentServerData);
    assert.equal(f.calls.filter(call => call.options.method !== 'POST').length, 2);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  });

  test('a card scope change clears confirmed history and metadata without losing a pending write', async t => {
    const gate = deferred();
    const f = await fixture(t, async (url, options) => {
      if (options.method === 'POST') {
        await gate.promise;
        return response({ ok: true });
      }
      return response(url.endsWith('/data') ? { data: history } : { meta: { label: 'Fixture' } });
    });
    await f.reads.fetchManifestData('fixture');
    await f.reads.fetchManifestMeta('fixture');
    const saving = f.reads.saveManifestData('other', history);
    f.browser.dispatchEvent(new CustomEvent('klebb-cards-changed'));
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    assert.equal(f.reads.hasPendingManifestWrite('other'), true);
    await f.reads.fetchManifestMeta('fixture');
    assert.equal(f.calls.filter(call => call.url === '/api/manifests/fixture').length, 2);
    gate.resolve();
    await saving;
    assert.equal(f.reads.peekManifestData('other'), undefined);
  });

  test('ordinary reads reject a projection and remove previous ordinary data', async t => {
    let projection = false;
    const f = await fixture(t, async () => response(projection ? {
      data: history,
      projection: { state: 'saved', revision: `sha256:${'a'.repeat(64)}` },
    } : { data: history }));
    await f.reads.fetchManifestData('fixture');
    projection = true;
    f.advance(20_000);
    const revision = f.reads.manifestCacheRevision('fixture');
    await assert.rejects(f.reads.fetchManifestData('fixture'), /source|projection|refresh/i);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    assert.equal(f.reads.manifestCacheRevision('fixture'), revision);
    await assert.rejects(f.reads.fetchManifestData('fixture'), /source|projection|refresh/i);
    assert.equal(f.reads.manifestCacheRevision('fixture'), revision);
    assert.equal(f.calls.length, 3);
  });

  test('selected projections are uncached, validated and never enter ordinary history', async t => {
    let valid = true;
    const f = await fixture(t, async () => response({
      data: history,
      projection: { state: 'saved', revision: valid ? `sha256:${'a'.repeat(64)}` : 'invalid' },
    }));
    await f.reads.fetchSelectedManifestData('fixture');
    await f.reads.fetchSelectedManifestData('fixture');
    assert.equal(f.calls.length, 2);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    valid = false;
    await assert.rejects(f.reads.fetchSelectedManifestData('fixture'), /unavailable|projection/i);
  });

  test('switching to a selected projection fences a pending ordinary write snapshot', async t => {
    const gate = deferred();
    const f = await fixture(t, async (url, options) => {
      if (options.method === 'POST') {
        await gate.promise;
        return response({ ok: true });
      }
      return response({
        data: history,
        projection: { state: 'saved', revision: `sha256:${'a'.repeat(64)}` },
      });
    });
    const saving = f.reads.saveManifestData('fixture', [{ value: 9 }]);
    await f.reads.fetchSelectedManifestData('fixture');
    gate.resolve();
    await saving;
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
  });

  test('transient read failure retains confirmed ordinary history but 401 and 404 discard it', async t => {
    let status = 200;
    const f = await fixture(t, async () => response({ data: history }, status));
    await f.reads.fetchManifestData('fixture');
    f.advance(20_000);
    status = 503;
    await assert.rejects(f.reads.fetchManifestData('fixture'), /503/);
    assert.deepEqual(f.reads.peekManifestData('fixture'), history);
    status = 401;
    await assert.rejects(f.reads.fetchManifestData('fixture'), /401/);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    status = 200;
    await f.reads.fetchManifestData('fixture');
    f.advance(20_000);
    status = 404;
    await assert.rejects(f.reads.fetchManifestData('fixture'), /404/);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
  });

  for (const name of ['TypeError', 'AbortError']) {
    test(`an interrupted JSON body (${name}) retains confirmed history and allows recovery`, async t => {
      let failure = null;
      const recoveredData = [{ date: '2026-01-01', value: 2 }];
      const f = await fixture(t, async () => failure
        ? new Response(new ReadableStream({
          start(controller) { controller.error(failure); },
        }), { headers: { 'Content-Type': 'application/json' } })
        : response({ data: f.calls.length === 1 ? history : recoveredData }));
      await f.reads.fetchManifestData('fixture');
      f.advance(20_000);
      failure = name === 'TypeError'
        ? new TypeError('Response body interrupted')
        : new DOMException('Response body interrupted', 'AbortError');
      await assert.rejects(f.reads.fetchManifestData('fixture'), error =>
        error.name === name && error.transient === true);
      assert.deepEqual(f.reads.peekManifestData('fixture'), history);
      failure = null;
      assert.deepEqual(await f.reads.fetchManifestData('fixture'), recoveredData);
      assert.deepEqual(f.reads.peekManifestData('fixture'), recoveredData);
      assert.equal(f.calls.length, 3);
    });
  }

  test('malformed JSON clears confirmed history instead of treating it as a transient refresh failure', async t => {
    let malformed = false;
    const f = await fixture(t, async () => malformed
      ? new Response('{invalid JSON', { headers: { 'Content-Type': 'application/json' } })
      : response({ data: history }));
    await f.reads.fetchManifestData('fixture');
    f.advance(20_000);
    malformed = true;
    await assert.rejects(f.reads.fetchManifestData('fixture'), error =>
      error instanceof SyntaxError && error.transient !== true);
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
    assert.equal(f.calls.length, 2);
  });

  test('compatible auxiliary GETs share work while different credentials stay separate', async t => {
    const gate = deferred();
    const f = await fixture(t, async () => {
      await gate.promise;
      return response({ items: ['fixture'] });
    });
    const sameA = f.reads.readJSON('/api/manifests', { credentials: 'same-origin' });
    const sameB = f.reads.readJSON('/api/manifests');
    const different = f.reads.readJSON('/api/manifests', { credentials: 'omit' });
    await settledTurn();
    assert.equal(f.calls.length, 2);
    gate.resolve();
    await Promise.all([sameA, sameB, different]);
    await f.reads.readJSON('/api/manifests', { credentials: 'same-origin' });
    assert.equal(f.calls.length, 2);
    f.reads.invalidateRead('/api/manifests');
    await f.reads.readJSON('/api/manifests', { credentials: 'same-origin' });
    assert.equal(f.calls.length, 3);
    await assert.rejects(
      async () => f.reads.readJSON('/api/manifests', { method: 'POST', body: '{}' }),
      /GET|read/i,
    );
    assert.equal(f.calls.length, 3);
  });

  test('a caller-specific auxiliary TTL expires without changing the GET request', async t => {
    const f = await fixture(t, async () => response({ available: true }));
    await f.reads.readJSON('/api/short-lived', { ttl: 500 });
    f.advance(499);
    await f.reads.readJSON('/api/short-lived', { ttl: 500 });
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await f.reads.readJSON('/api/short-lived', { ttl: 500 });
    assert.equal(f.calls.length, 2);
    assert.equal(Object.hasOwn(f.calls[0].options, 'ttl'), false);
  });

  test('auxiliary helper cannot cache a selected data response as ordinary history', async t => {
    const f = await fixture(t, async () => response({
      data: history,
      projection: { state: 'saved', revision: `sha256:${'a'.repeat(64)}` },
    }));
    await assert.rejects(
      f.reads.readJSON('/api/manifests/fixture/data'),
      /manifest|data|projection|source/i,
    );
    assert.equal(f.reads.peekManifestData('fixture'), undefined);
  });

  test('429 retains confirmed history and blocks GETs across URLs until Retry-After', async t => {
    let throttled = false;
    const f = await fixture(t, async () => throttled
      ? response({ error: 'Temporary throttle' }, 429, { 'Retry-After': '120' })
      : response({ data: history }));
    await f.reads.fetchManifestData('fixture');
    f.advance(20_000);
    throttled = true;
    await assert.rejects(f.reads.fetchManifestData('fixture'), error =>
      error instanceof f.reads.ReadCooldownError && error.status === 429
        && error.blocked === false && error.retryAt >= f.now + 120_000);
    assert.deepEqual(f.reads.peekManifestData('fixture'), history);
    await assert.rejects(f.reads.readJSON('/api/unseen'), error =>
      error instanceof f.reads.ReadCooldownError && error.blocked === true);
    await assert.rejects(f.reads.fetchManifestMeta('other'), error =>
      error instanceof f.reads.ReadCooldownError && error.blocked === true);
    assert.equal(f.calls.length, 2);
    f.advance(119_999);
    await assert.rejects(f.reads.readJSON('/api/unseen'), f.reads.ReadCooldownError);
    assert.equal(f.calls.length, 2);
    f.advance(1);
    throttled = false;
    await f.reads.readJSON('/api/unseen');
    assert.equal(f.calls.length, 3);
  });

  test('HTTP-date and very long Retry-After values are never shortened', async t => {
    let retryAfter;
    const f = await fixture(t, async () =>
      response({}, 429, { 'Retry-After': retryAfter }));
    retryAfter = new Date(f.now + 90_000).toUTCString();
    await assert.rejects(f.reads.readJSON('/api/date'), error => error.retryAt >= f.now + 90_000);
    f.advance(90_000);
    retryAfter = '3000000';
    const expected = f.now + 3_000_000_000;
    await assert.rejects(f.reads.readJSON('/api/long'), error => error.retryAt >= expected);
    f.advance(2_147_483_648);
    await assert.rejects(f.reads.readJSON('/api/still-blocked'), f.reads.ReadCooldownError);
    assert.equal(f.calls.length, 2);
  });

  test('overlapping 429 responses cannot shorten an already announced cooldown', async t => {
    const long = deferred();
    const short = deferred();
    const f = await fixture(t, async url => {
      await (url.endsWith('/long') ? long.promise : short.promise);
      return response({}, 429, { 'Retry-After': url.endsWith('/long') ? '120' : '1' });
    });
    const a = f.reads.readJSON('/api/long');
    const b = f.reads.readJSON('/api/short');
    const aRejected = assert.rejects(a, f.reads.ReadCooldownError);
    const bRejected = assert.rejects(b, f.reads.ReadCooldownError);
    long.resolve();
    await aRejected;
    short.resolve();
    await bRejected;
    f.advance(2_000);
    await assert.rejects(f.reads.readJSON('/api/new'), error => error.retryAt >= f.now + 118_000);
    assert.equal(f.calls.length, 2);
  });

  test('expired recovery deadlines run asynchronously and can be cancelled before their queued callback', async t => {
    const f = await fixture(t, async () => response({}));
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    let retries = 0;
    for (const offset of [0, -1_000]) {
      let cancel;
      cancel = f.reads.scheduleReadRetry(f.now + offset, () => {
        assert.equal(typeof cancel, 'function');
        retries++;
      });
      assert.equal(retries, offset === 0 ? 0 : 1);
      assert.equal(timers.at(-1).delay, 0);
      timers.at(-1).callback();
    }
    assert.equal(retries, 2);
    const cancel = f.reads.scheduleReadRetry(f.now, () => { retries++; });
    assert.equal(retries, 2);
    cancel();
    timers.at(-1).callback();
    assert.equal(retries, 2);
  });

  test('recovery timers chunk a long deadline and cancellation prevents callbacks', async t => {
    const f = await fixture(t, async () => response({}));
    const timers = [];
    const cleared = new Set();
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => { cleared.add(timer); });
    let retries = 0;
    const cancel = f.reads.scheduleReadRetry(f.now + 3_000_000_000, () => { retries++; });
    assert.equal(typeof cancel, 'function');
    assert.equal(timers[0].delay, 2_147_483_647);
    f.advance(timers[0].delay);
    timers[0].callback();
    assert.equal(retries, 0);
    assert.equal(timers[1].delay, 852_516_353);
    f.advance(timers[1].delay);
    timers[1].callback();
    assert.equal(retries, 1);
    cancel();

    const cancelSecond = f.reads.scheduleReadRetry(f.now + 60_000, () => { retries++; });
    const cancelledTimer = timers.at(-1);
    cancelSecond();
    assert.equal(cleared.has(cancelledTimer), true);
    f.advance(60_000);
    // A callback already queued when it is cancelled must also be harmless.
    cancelledTimer.callback();
    assert.equal(retries, 1);
  });
});
