// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/hygiene-nudge-wiring.test.js
// Source-level coverage for the stale-card nudge in the chat peek bar
// (#452). The Lit component can't run under Node (esm.sh import), so this
// pins the load-bearing wiring: the ambient fetch, the real findings
// contract (findings[{cardId,kind,severity,detail}], NOT the storyboard's
// {stale:[...]}), the paste-into-chat seed, and the dismiss POST.
// Interactive behaviour is owned by tests-e2e/hygiene-nudge.spec.js.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHAT = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'components', 'health-chat.js'),
  'utf8',
);

describe('peek-bar stale nudge wiring (#452)', () => {
  test('widget fetches the ambient hygiene surface', () => {
    assert.ok(/fetch\('\/api\/hygiene'/.test(CHAT), 'GET /api/hygiene fetched');
  });

  test('built to the real contract: findings array, not the storyboard stale key', () => {
    assert.ok(/body\?\.findings/.test(CHAT), 'reads the findings key');
    assert.ok(!/body\?\.stale\b/.test(CHAT), 'does not read the abandoned stale key');
  });

  test('nudge text derives from cardId + detail of the first finding', () => {
    assert.ok(/_nudgeText/.test(CHAT), 'nudge text helper present');
    assert.ok(/f\.cardId/.test(CHAT), 'uses cardId');
    assert.ok(/No entry in \(\\d\+\) days/.test(CHAT), 'parses the days from detail');
  });

  test('tapping the nudge seeds chat via klebb-paste-into-chat', () => {
    const body = CHAT.slice(CHAT.indexOf('_useNudge'), CHAT.indexOf('_dismissNudge'));
    assert.ok(/klebb-paste-into-chat/.test(body), 'seeds through the shared paste event');
    assert.ok(/f\.detail/.test(body), 'carries the finding detail into the seed');
  });

  test('dismiss POSTs to the per-card dismiss endpoint with the finding kind', () => {
    assert.ok(/\/api\/hygiene\/\$\{encodeURIComponent\(f\.cardId\)\}\/dismiss/.test(CHAT),
      'dismiss endpoint targeted per card');
    assert.ok(/JSON\.stringify\(\{ kind: f\.kind \}\)/.test(CHAT),
      'kind rides the dismiss body');
  });

  test('dismiss does not bubble into the peek-bar open handler', () => {
    const start = CHAT.indexOf('async _dismissNudge');
    assert.ok(start > -1, '_dismissNudge method present');
    const body = CHAT.slice(start, CHAT.indexOf('}', CHAT.indexOf('catch', start)) + 1);
    assert.ok(/stopPropagation/.test(body), 'dismiss stops propagation');
  });

  test('nudge renders in the peek bar and reverts to the ask bar when absent', () => {
    assert.ok(/peek-bar nudge/.test(CHAT), 'nudge variant of the peek bar');
    assert.ok(/nudge-dismiss/.test(CHAT), 'dismiss affordance present');
    assert.ok(/this\._nudge && !this\._open \? html/.test(CHAT),
      'nudge branch gated on a finding, falls back to the normal bar');
  });
});
