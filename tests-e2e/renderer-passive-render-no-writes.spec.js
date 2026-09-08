// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/renderer-passive-render-no-writes.spec.js
// Structural guard for the #704 class: rendering a card must never mutate
// manifest state. The greeting banner used to implement its motd rotation
// as a data write fired from render(), which meant presentation depended
// on meta.writeable and read-only cards silently froze. docs/CARDS.md
// documents each renderer's writes; passive render is always "none".
//
// The dashboard is seeded with every demo fixture (the realistic estate:
// generic, checklist, schedule, table, list, chart-bearing cards) plus a
// writeable greeting, then loaded and left to settle. Any non-GET request
// to /api/manifests* during that window is a contract violation. Writes
// driven by user interaction (ticking an item, submitting a form) are out
// of scope here and covered by their own specs.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./helpers/auth-fixture');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'demo', 'fixtures');

function loadFixtures() {
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')));
}

const GREETING = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'e2e_greet_contract_704',
    label: 'Greet Contract',
    emoji: '\u{1F44B}',
    order: 1,
    view: { enabled: true, component: 'greeting-banner', slot: 'top' },
    // Deliberately writeable: a renderer that writes from render() only
    // when allowed to is exactly the defect this guard exists to catch.
    writeable: { fromWebapp: true, todayAllowed: true },
  },
  description: 'Greeting banner for the passive-render contract spec.',
  data: ['One.', 'Two.', 'Three.'],
};

test.describe('passive render never writes manifest state', () => {
  test('a fully seeded dashboard render fires zero manifest writes', async ({ page, sandboxState }) => {
    const baseUrl = sandboxState.baseUrl;
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(10);

    // The sandbox baseline may already seed some of the same card ids;
    // those are on the dashboard either way, so they still count as
    // coverage. Only create (and later delete) what is missing.
    const existingRes = await page.request.get(`${baseUrl}/api/manifests`);
    const existing = new Set((await existingRes.json()).entries.map(e => e.id));

    const created = [];
    for (const manifest of [...fixtures, GREETING]) {
      if (existing.has(manifest.meta.id)) continue;
      const res = await page.request.post(`${baseUrl}/api/manifests`, { data: manifest });
      expect(res.status(), `seeding ${manifest.meta.id}`).toBe(201);
      created.push(manifest.meta.id);
    }

    try {
      const writes = [];
      page.on('request', (req) => {
        if (req.method() === 'GET') return;
        const { pathname } = new URL(req.url());
        if (pathname.startsWith('/api/manifests')) writes.push(`${req.method()} ${pathname}`);
      });

      await page.goto('/');
      await expect(page.locator('eh-greeting-banner').first()).toBeVisible();
      // A representative data card must have rendered too, or the guard
      // would pass vacuously on an empty dashboard.
      expect(await page.locator('[class*="card"], eh-generic-card, eh-checklist-card, eh-schedule-card').count()).toBeGreaterThan(0);
      // Settle window: the old rotation write was fire-and-forget from
      // render(), so give any such write ample time to fire.
      await page.waitForTimeout(1000);

      expect(writes, `manifest writes during passive render: ${writes.join(', ')}`).toEqual([]);
    } finally {
      for (const id of created) {
        await page.request.delete(`${baseUrl}/api/manifests/${id}`);
      }
    }
  });
});
