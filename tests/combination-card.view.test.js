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
