// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/combination-card.view.test.js
// Integration: a combination-card manifest loads through the registry
// and /api/views/view surfaces combines[] verbatim to the client.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('./helpers/sandbox');

describe('combination-card view integration', () => {
  let sandbox, server;

  const sleepHoursManifest = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours',
      label: 'Sleep hours',
      view: { enabled: true, component: 'generic-card', display: { template: '{hours}' } },
    },
    data: [{ date: '2026-05-04', hours: 8.1 }],
  };

  const moodManifest = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      view: { enabled: true, component: 'generic-card', display: { template: '{mood}' } },
    },
    data: [{ date: '2026-05-04', mood: 4, wakeUps: 1 }],
  };

  const sleepComboManifest = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep',
      label: 'Sleep',
      emoji: '😴',
      order: 25,
      view: {
        enabled: true,
        component: 'combination-card',
        layout: 'stack',
        combines: [
          { sourceId: 'sleep-hours', role: 'primary', label: 'Asleep', accessor: 'hours', unit: 'h' },
          { sourceId: 'mood', role: 'secondary', label: 'Mood', accessor: 'mood',
            emojiMap: { '1':'😩','4':'🙂' } },
        ],
      },
    },
    data: [],
  };

  before(async () => {
    sandbox = createSandbox({
      seed: {
        'sleep-hours.json': sleepHoursManifest,
        'mood.json': moodManifest,
        'sleep.json': sleepComboManifest,
      },
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /api/views/view includes the combination card with combines[] intact', async () => {
    const res = await req(server.baseUrl, '/api/views/view');
    assert.equal(res.status, 200);
    const cards = res.json.cards;
    assert.ok(Array.isArray(cards));
    const combo = cards.find(c => c.id === 'sleep');
    assert.ok(combo, 'sleep combo card present in view');
    assert.equal(combo.viewConfig.component, 'combination-card');
    assert.equal(combo.viewConfig.layout, 'stack');
    assert.ok(Array.isArray(combo.viewConfig.combines));
    assert.equal(combo.viewConfig.combines.length, 2);
    assert.equal(combo.viewConfig.combines[0].sourceId, 'sleep-hours');
    assert.equal(combo.viewConfig.combines[0].accessor, 'hours');
    assert.equal(combo.viewConfig.combines[1].emojiMap['4'], '🙂');
  });

  test('GET /api/manifests/:id/data returns empty data for the combo', async () => {
    const res = await req(server.baseUrl, '/api/manifests/sleep/data');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, []);
  });

  test('source manifests are independently readable by the renderer', async () => {
    const sleep = await req(server.baseUrl, '/api/manifests/sleep-hours/data');
    const mood = await req(server.baseUrl, '/api/manifests/mood/data');
    assert.equal(sleep.status, 200);
    assert.equal(mood.status, 200);
    assert.equal(sleep.json.data[0].hours, 8.1);
    assert.equal(mood.json.data[0].mood, 4);
  });

  test('combo card appears ordered by meta.order', async () => {
    // order=25 on sleep combo; sleep-hours+mood have no order (default 1000),
    // so combo should render first among the three.
    const res = await req(server.baseUrl, '/api/views/view');
    const ids = res.json.cards.map(c => c.id);
    assert.equal(ids[0], 'sleep');
  });
});

// --- Writeable donor rows (issue #104) ---
// The renderer uses POST /api/manifests/:donorId/data to save edits made
// via the combo's inline form. This suite checks the server contract
// that save relies on, end-to-end.
describe('combination-card writeable donor save path', () => {
  let sandbox, server;

  const writeableMood = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'mood',
      label: 'Mood',
      view: { enabled: true, component: 'generic-card', display: { template: '{mood}' } },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        futureAllowed: false,
        maxReadingsPerDay: 1,
        inputs: [
          { key: 'mood', type: 'rating', required: true },
          { key: 'wakeUps', type: 'number', default: 0 },
          { key: 'notes', type: 'textarea' },
        ],
      },
    },
    data: [{ date: '2026-05-04', mood: 3 }],
  };

  const ingestOnlySleep = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep-hours',
      label: 'Sleep',
      view: { enabled: true, component: 'generic-card', display: { template: '{hours}' } },
      writeable: { fromWebapp: false },
    },
    data: [{ date: '2026-05-04', hours: 7.5 }],
  };

  const combo = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'sleep',
      label: 'Sleep',
      view: {
        enabled: true,
        component: 'combination-card',
        layout: 'stack',
        combines: [
          { sourceId: 'sleep-hours', role: 'primary', accessor: 'hours' },
          { sourceId: 'mood', role: 'secondary', accessor: 'mood' },
          { sourceId: 'mood', role: 'annotation', accessor: 'wakeUps', label: 'Wake-ups' },
        ],
      },
    },
    data: [],
  };

  before(async () => {
    sandbox = createSandbox({
      seed: {
        'mood.json': writeableMood,
        'sleep-hours.json': ingestOnlySleep,
        'sleep.json': combo,
      },
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('donor meta.writeable is reachable via /api/manifests/:id', async () => {
    // Renderer reads this endpoint to decide whether to show the pencil
    // and what inputs to render in the inline form.
    const res = await req(server.baseUrl, '/api/manifests/mood');
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.writeable.fromWebapp, true);
    assert.equal(res.json.meta.writeable.inputs.length, 3);
    assert.equal(res.json.meta.writeable.inputs[0].key, 'mood');
  });

  test('ingest-only donor: writeable.fromWebapp is false (no pencil)', async () => {
    const res = await req(server.baseUrl, '/api/manifests/sleep-hours');
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.writeable.fromWebapp, false);
  });

  test('POST /api/manifests/mood/data with upserted entry: replaces same-date row', async () => {
    // Simulate what the combo's _onDonorSubmit does: read current data,
    // replace today's row, POST the full array.
    const cur = await req(server.baseUrl, '/api/manifests/mood/data');
    assert.equal(cur.status, 200);
    const existing = cur.json.data;

    const entry = { date: '2026-05-04', mood: 5, wakeUps: 1, notes: 'combo-edit' };
    const others = existing.filter(d => d.date !== entry.date);
    const updated = [...others, entry]
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const post = await req(server.baseUrl, '/api/manifests/mood/data', {
      method: 'POST',
      body: { data: updated },
    });
    assert.equal(post.status, 200);
    assert.equal(post.json.ok, true);

    // Read back
    const verify = await req(server.baseUrl, '/api/manifests/mood/data');
    const today = verify.json.data.find(r => r.date === '2026-05-04');
    assert.equal(today.mood, 5);
    assert.equal(today.wakeUps, 1);
    assert.equal(today.notes, 'combo-edit');
  });

  test('combo manifest is unchanged by donor writes', async () => {
    // Writes go to the donor, never to the combo's own data block.
    const res = await req(server.baseUrl, '/api/manifests/sleep/data');
    assert.deepEqual(res.json.data, []);
  });
});

// --- layout: rings (issue #111) ---
// Verify the rings preset round-trips through the view API with
// goalDaily + colour intact, so the client renderer sees the full
// config.
describe('combination-card layout:"rings" round-trip', () => {
  let sandbox, server;

  const steps = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'steps',
      label: 'Steps',
      view: { enabled: true, component: 'generic-card', display: { template: '{count}' } },
      writeable: { fromWebapp: false },
    },
    data: [{ date: '2026-05-05', count: 7200 }],
  };

  const active = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'active-minutes',
      label: 'Active Minutes',
      view: { enabled: true, component: 'generic-card', display: { template: '{minutes}' } },
      writeable: { fromWebapp: false },
    },
    data: [{ date: '2026-05-05', minutes: 45 }],
  };

  const workouts = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'workouts',
      label: 'Workouts',
      view: { enabled: true, component: 'generic-card', display: { template: '{trained}' } },
      writeable: { fromWebapp: false },
    },
    data: [{ date: '2026-05-05', trained: true, type: 'Running' }],
  };

  const activityRings = {
    $schema: 'klebb.datafile.v1',
    meta: {
      id: 'activity-rings',
      label: 'Activity Rings',
      emoji: '🏅',
      order: 66,
      view: {
        enabled: true,
        component: 'combination-card',
        layout: 'rings',
        combines: [
          { sourceId: 'steps',          role: 'ring-segment', label: 'Steps',  accessor: 'count',   goalDaily: 10000, unit: 'steps', colour: '#0ea5e9' },
          { sourceId: 'active-minutes', role: 'ring-segment', label: 'Active', accessor: 'minutes', goalDaily: 30,    unit: 'min',   colour: '#f59e0b' },
          { sourceId: 'workouts',       role: 'annotation',   label: 'Trained', accessor: 'trained' },
        ],
      },
    },
    data: [],
  };

  before(async () => {
    sandbox = createSandbox({
      seed: {
        'steps.json': steps,
        'active-minutes.json': active,
        'workouts.json': workouts,
        'activity-rings.json': activityRings,
      },
    });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('GET /api/views/view surfaces layout:"rings" with combines[] intact', async () => {
    const res = await req(server.baseUrl, '/api/views/view');
    assert.equal(res.status, 200);
    const combo = res.json.cards.find(c => c.id === 'activity-rings');
    assert.ok(combo, 'rings preset present in view');
    assert.equal(combo.viewConfig.component, 'combination-card');
    assert.equal(combo.viewConfig.layout, 'rings');
    assert.equal(combo.viewConfig.combines.length, 3);
  });

  test('ring-segment entries carry goalDaily + colour client-side', async () => {
    const res = await req(server.baseUrl, '/api/views/view');
    const combo = res.json.cards.find(c => c.id === 'activity-rings');
    const rings = combo.viewConfig.combines.filter(c => c.role === 'ring-segment');
    assert.equal(rings.length, 2);
    assert.equal(rings[0].goalDaily, 10000);
    assert.equal(rings[0].colour, '#0ea5e9');
    assert.equal(rings[1].goalDaily, 30);
    assert.equal(rings[1].colour, '#f59e0b');
  });

  test('non-ring-segment roles are preserved alongside ring-segments', async () => {
    const res = await req(server.baseUrl, '/api/views/view');
    const combo = res.json.cards.find(c => c.id === 'activity-rings');
    const annotation = combo.viewConfig.combines.find(c => c.role === 'annotation');
    assert.ok(annotation);
    assert.equal(annotation.sourceId, 'workouts');
  });

  test('source manifests remain independently readable', async () => {
    const stepsRes = await req(server.baseUrl, '/api/manifests/steps/data');
    assert.equal(stepsRes.json.data[0].count, 7200);
    const activeRes = await req(server.baseUrl, '/api/manifests/active-minutes/data');
    assert.equal(activeRes.json.data[0].minutes, 45);
  });
});
