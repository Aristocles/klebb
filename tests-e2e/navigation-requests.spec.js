// SPDX-License-Identifier: AGPL-3.0-only
// Regression coverage for #908: date navigation projects fresh ordinary
// history locally and keeps compatible card elements mounted.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');
const fs = require('node:fs');
const path = require('node:path');

const IDS = ['navigation_metric', 'navigation_secondary', 'navigation_entries'];

function cardFixture(id, index) {
  const viewConfig = {
    enabled: true,
    component: 'generic-card',
    display: { template: '{value}', primaryField: 'value' },
    ...(index === 0 ? { priority: 1 } : {}),
    ...(index === 2 ? { slot: 'top' } : {}),
  };
  return {
    id,
    meta: {
      id,
      label: `Navigation metric ${index + 1}`,
      view: viewConfig,
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        maxReadingsPerDay: index === 2 ? 2 : 1,
        inputs: [{ key: 'value', label: 'Value', type: 'number' }],
      },
    },
    viewConfig,
  };
}

async function installFixtures(page) {
  const today = todayISO();
  const fixture = {
    cards: IDS.map(cardFixture),
    getCounts: {},
    writes: [],
    reorders: [],
    viewResponses: [],
    viewRequestTimes: [],
  };
  const data = Array.from({ length: 15 }, (_, index) => ({
    date: shiftDays(today, -index),
    value: 100 + index,
  }));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.startsWith('/api/')) {
      fixture.getCounts[path] = (fixture.getCounts[path] || 0) + 1;
      if (path === '/api/views/view') fixture.viewRequestTimes.push(Date.now());
    }
    if (request.method() === 'POST' && path.endsWith('/data')) {
      fixture.writes.push({ path, body: request.postDataJSON() });
    }
    if (request.method() === 'POST' && path === '/api/manifests/reorder') {
      fixture.reorders.push(request.postDataJSON().order);
    }
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    if (request.method() === 'GET' && path === '/api/views/view') {
      const response = fixture.viewResponses.shift();
      if (response) {
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          headers: response.headers || {},
          body: JSON.stringify(response.body || { error: 'Temporary read limit' }),
        });
        return;
      }
      body = { cards: fixture.cards, errors: [] };
    } else if (request.method() === 'GET' && path === '/api/manifests') {
      body = { entries: fixture.cards };
    } else if (request.method() === 'GET' && path === '/api/settings/cards') {
      body = { cards: fixture.cards.map(card => ({ ...card, enabled: true })) };
    } else if (request.method() === 'GET'
        && fixture.cards.some(card => path === `/api/manifests/${card.id}/data`)) {
      body = { data };
    } else if (request.method() === 'POST' && path === '/api/manifests/reorder') {
      const order = request.postDataJSON().order;
      if (fixture.reorderGate) await fixture.reorderGate;
      const byId = new Map(fixture.cards.map(card => [card.id, card]));
      fixture.cards = [
        ...order.map(id => byId.get(id)).filter(Boolean),
        ...fixture.cards.filter(card => !order.includes(card.id)),
      ];
      body = { ok: true };
    } else {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return fixture;
}

function counts(fixture) {
  const allApiGets = { ...fixture.getCounts };
  const entries = Object.entries(allApiGets);
  return {
    allApiGets,
    total: entries.reduce((sum, [, count]) => sum + count, 0),
    history: entries.filter(([path]) => /^\/api\/manifests\/[^/]+\/data$/.test(path))
      .reduce((sum, [, count]) => sum + count, 0),
    views: allApiGets['/api/views/view'] || 0,
  };
}

async function rememberIdentity(page) {
  await page.locator('eh-date-view').evaluate((view, ids) => {
    const renderer = view.shadowRoot.querySelector('eh-view-renderer');
    window.__navigationIdentity = {
      view,
      renderer,
      cards: Object.fromEntries(ids.map(id => {
        const wrapper = renderer.shadowRoot.querySelector(`[data-card-id="${id}"]`);
        return [id, { wrapper, card: wrapper.querySelector('eh-generic-card') }];
      })),
    };
  }, IDS);
}

async function identity(page) {
  return page.locator('eh-date-view').evaluate((view, ids) => {
    const renderer = view.shadowRoot.querySelector('eh-view-renderer');
    const previous = window.__navigationIdentity;
    return {
      dateView: view === previous.view,
      renderer: renderer === previous.renderer,
      date: view.date,
      cards: Object.fromEntries(ids.map(id => {
        const wrapper = renderer.shadowRoot.querySelector(`[data-card-id="${id}"]`);
        const card = wrapper?.querySelector('eh-generic-card, eh-list-card');
        return [id, {
          wrapper: wrapper === previous.cards[id].wrapper,
          element: card === previous.cards[id].card,
          date: card?.date,
          dateMode: card?.dateMode,
        }];
      })),
    };
  }, IDS);
}

async function expectDate(page, date, value) {
  await expect(page.locator('eh-date-view input[type="date"]')).toHaveValue(date);
  await expect(page.locator(`[data-card-id="${IDS[0]}"] .gen-headline`))
    .toHaveText(String(value));
}

async function attachCounts(testInfo, before, fixture, identities = []) {
  const after = counts(fixture);
  const reportPath = testInfo.outputPath('navigation-request-counts.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    before,
    after,
    additionalApiGets: after.total - before.total,
    additionalHistoryReads: after.history - before.history,
    additionalViewReads: after.views - before.views,
    identities,
  }, null, 2));
  await testInfo.attach('navigation-request-counts', {
    path: reportPath,
    contentType: 'application/json',
  });
  return after;
}

function expectStable(snapshot, date, mode) {
  expect(snapshot.dateView).toBe(true);
  expect(snapshot.renderer).toBe(true);
  expect(snapshot.date).toBe(date);
  for (const card of Object.values(snapshot.cards)) {
    expect(card.wrapper).toBe(true);
    expect(card.element).toBe(true);
    expect(card.date).toBe(date);
    expect(card.dateMode).toBe(mode);
  }
}

test.describe('#908: stable navigation and ordinary history request budgets', () => {
  test('ten historical date changes reuse elements and fresh history', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    const today = todayISO();
    await page.goto(`/day/${shiftDays(today, -1)}`);
    await expectDate(page, shiftDays(today, -1), 101);
    await expect(page.locator('eh-generic-card')).toHaveCount(3);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const before = counts(fixture);
    const snapshots = [];
    for (let offset = 2; offset <= 11; offset++) {
      await page.getByRole('button', { name: 'previous day', exact: true }).click();
      await expectDate(page, shiftDays(today, -offset), 100 + offset);
      snapshots.push(await identity(page));
    }
    const after = await attachCounts(testInfo, before, fixture, snapshots);
    expect(after.history - before.history).toBe(0);
    expect(after.views - before.views).toBe(0);
    expect(after.total - before.total).toBe(0);
    snapshots.forEach((snapshot, index) => {
      expectStable(snapshot, shiftDays(today, -index - 2), 'past');
    });
  });

  test('ten Today and historical transitions retain the same date view and cards', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    const today = todayISO();
    await page.goto('/');
    await expectDate(page, today, 100);
    await expect(page.locator('eh-generic-card')).toHaveCount(3);
    await expect(page.locator(`[data-card-id="${IDS[0]}"]`)).toHaveClass(/pinned/);
    await expect(page.locator(`[data-card-id="${IDS[2]}"]`)).toHaveClass(/slot-top/);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const before = counts(fixture);
    const snapshots = [];
    for (let round = 0; round < 5; round++) {
      await page.getByRole('button', { name: 'previous day', exact: true }).click();
      await expectDate(page, shiftDays(today, -1), 101);
      await expect(page.locator(`[data-card-id="${IDS[0]}"]`)).not.toHaveClass(/pinned/);
      snapshots.push(await identity(page));
      await page.locator('eh-date-view').getByRole('button', { name: 'Today', exact: true }).click();
      await expectDate(page, today, 100);
      await expect(page.locator(`[data-card-id="${IDS[0]}"]`)).toHaveClass(/pinned/);
      snapshots.push(await identity(page));
    }
    const after = await attachCounts(testInfo, before, fixture, snapshots);
    expect(after.history - before.history).toBe(0);
    expect(after.views - before.views).toBe(0);
    snapshots.forEach((snapshot, index) => {
      expectStable(snapshot, index % 2 ? today : shiftDays(today, -1), index % 2 ? 'today' : 'past');
    });
  });

  test('reorder and compatible list refresh preserve identity; changed or removed renderers leave', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    await expect(page.locator('eh-generic-card')).toHaveCount(3);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const before = counts(fixture);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-enter-reorder-mode')));
    const handle = page.locator(`[data-card-id="${IDS[1]}"] .drag-handle`);
    await handle.press('ArrowUp');
    await expect.poll(() => page.locator('.grid > .card-wrap').evaluateAll(elements =>
      elements.map(element => element.dataset.cardId))).toEqual([IDS[1], IDS[0], IDS[2]]);
    const reordered = await identity(page);
    expectStable(reordered, todayISO(), 'today');
    await expect(handle).toBeFocused();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    fixture.cards = fixture.cards.map(card => ({
      ...card,
      meta: { ...card.meta, label: `${card.meta.label} refreshed` },
    }));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
    await expect(page.locator(`[data-card-id="${IDS[0]}"]`)).toContainText('refreshed');
    const refreshed = await identity(page);
    expectStable(refreshed, todayISO(), 'today');
    fixture.cards = fixture.cards.filter(card => card.id !== IDS[2]).map(card =>
      card.id !== IDS[1] ? card : {
        ...card,
        viewConfig: { ...card.viewConfig, component: 'list-card' },
        meta: { ...card.meta, view: { ...card.meta.view, component: 'list-card' } },
      });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
    await expect(page.locator(`[data-card-id="${IDS[1]}"] eh-list-card`)).toBeVisible();
    await expect(page.locator(`[data-card-id="${IDS[2]}"]`)).toHaveCount(0);
    const changed = await identity(page);
    expect(changed.cards[IDS[0]].element).toBe(true);
    expect(changed.cards[IDS[0]].wrapper).toBe(true);
    expect(changed.cards[IDS[1]].element).toBe(false);
    expect(changed.cards[IDS[1]].wrapper).toBe(false);
    expect(await page.evaluate(() => ({
      replacedConnected: window.__navigationIdentity.cards.navigation_secondary.card.isConnected,
      removedConnected: window.__navigationIdentity.cards.navigation_entries.card.isConnected,
    }))).toEqual({ replacedConnected: false, removedConnected: false });
    await attachCounts(testInfo, before, fixture, [reordered, refreshed, changed]);
  });

  test('drag reorder keeps keyed DOM intact through a later manifest refresh', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    await expect(page.locator('eh-generic-card')).toHaveCount(3);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const before = counts(fixture);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-enter-reorder-mode')));
    const source = page.locator(`[data-card-id="${IDS[0]}"] .drag-handle`);
    const target = page.locator(`[data-card-id="${IDS[1]}"]`);
    const targetBox = await target.boundingBox();
    const saved = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/manifests/reorder'
        && response.request().method() === 'POST');
    await source.dragTo(target, {
      targetPosition: { x: targetBox.width - 8, y: targetBox.height / 2 },
    });
    expect((await saved).status()).toBe(200);
    expect(fixture.reorders).toEqual([[IDS[1], IDS[0], IDS[2]]]);
    await expect.poll(() => page.locator('.grid > .card-wrap').evaluateAll(elements =>
      elements.map(element => element.dataset.cardId))).toEqual([IDS[1], IDS[0], IDS[2]]);
    const dragged = await identity(page);
    expectStable(dragged, todayISO(), 'today');
    fixture.cards = fixture.cards.map(card => ({
      ...card,
      meta: { ...card.meta, label: `${card.meta.label} refreshed` },
    }));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
    await expect(page.locator(`[data-card-id="${IDS[0]}"]`)).toContainText('refreshed');
    await expect.poll(() => page.locator('.grid > .card-wrap').evaluateAll(elements =>
      elements.map(element => element.dataset.cardId))).toEqual([IDS[1], IDS[0], IDS[2]]);
    const refreshed = await identity(page);
    expectStable(refreshed, todayISO(), 'today');
    await attachCounts(testInfo, before, fixture, [dragged, refreshed]);
  });

  test('changing date closes an unsaved multi-entry form without writing another date', async ({ page }) => {
    const fixture = await installFixtures(page);
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    const card = page.locator(`[data-card-id="${IDS[2]}"] eh-generic-card`);
    await card.getByRole('button', { name: 'Edit entry', exact: true }).click();
    await expect(card.locator('eh-input-form')).toBeVisible();
    await card.locator('eh-input-form input[type="number"]').fill('999');
    await rememberIdentity(page);
    await page.getByRole('button', { name: 'previous day', exact: true }).click();
    await expectDate(page, shiftDays(todayISO(), -1), 101);
    await expect(card.locator('eh-input-form')).toHaveCount(0);
    expect((await identity(page)).cards[IDS[2]].element).toBe(true);
    expect(fixture.writes).toEqual([]);
    await card.getByRole('button', { name: 'Edit entry', exact: true }).click();
    await expect(card.locator('eh-input-form input[type="number"]')).toHaveValue('101');
  });

  test('a throttled list refresh retains cards and retries once after its deadline', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    const date = shiftDays(todayISO(), -1);
    await page.goto(`/day/${date}`);
    await expectDate(page, date, 101);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const before = counts(fixture);
    fixture.viewResponses.push({ status: 429, headers: { 'Retry-After': '1' } });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
    const status = page.locator('eh-view-renderer [role="status"]');
    await expect(status).toContainText('temporarily busy');
    expectStable(await identity(page), date, 'past');
    await page.evaluate(() => {
      for (let index = 0; index < 5; index++) {
        window.dispatchEvent(new CustomEvent('klebb-cards-changed'));
      }
    });
    expect(counts(fixture).views - before.views).toBe(1);
    await expect.poll(() => counts(fixture).views - before.views).toBe(2);
    await expect(status).toHaveCount(0);
    expect(counts(fixture).views - before.views).toBe(2);
    expectStable(await identity(page), date, 'past');
    expect(fixture.writes).toEqual([]);
    expect(fixture.reorders).toEqual([]);
    await attachCounts(testInfo, before, fixture, [await identity(page)]);
  });

  test('an initial throttled list shows a temporary status and recovers after Retry-After', async ({ page }, testInfo) => {
    const fixture = await installFixtures(page);
    const before = counts(fixture);
    fixture.viewResponses.push({ status: 429, headers: { 'Retry-After': '1' } });
    const date = shiftDays(todayISO(), -1);
    await page.goto(`/day/${date}`);
    await expect(page.locator('eh-view-renderer [role="status"]')).toContainText('temporarily busy');
    await expect(page.locator('eh-generic-card')).toHaveCount(0);
    await expectDate(page, date, 101);
    await expect(page.locator('eh-generic-card')).toHaveCount(3);
    expect(counts(fixture).views).toBe(2);
    expect(fixture.viewRequestTimes[1] - fixture.viewRequestTimes[0]).toBeGreaterThanOrEqual(1000);
    expect(fixture.writes).toEqual([]);
    await attachCounts(testInfo, before, fixture);
  });

  test('a delayed reorder cannot remove cards added by a newer list refresh', async ({ page }) => {
    const fixture = await installFixtures(page);
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-enter-reorder-mode')));
    let release;
    let releaseList;
    fixture.reorderGate = new Promise(resolve => { release = resolve; });
    try {
      const saved = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/manifests/reorder'
          && response.request().method() === 'POST');
      await page.locator(`[data-card-id="${IDS[1]}"] .drag-handle`).press('ArrowUp');
      await expect.poll(() => fixture.reorders.length).toBe(1);
      fixture.cards.push(cardFixture('navigation_added', 3));
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
      const added = page.locator('[data-card-id="navigation_added"] eh-generic-card');
      await expect(added).toBeVisible();
      await expect(added.locator('.gen-headline')).toHaveText('100');
      // This response records the old order and remains in flight when the
      // reorder commits. A ttl:0 reread must not adopt that older response.
      const oldList = JSON.stringify({ cards: fixture.cards, errors: [] });
      let listStarted;
      const started = new Promise(resolve => { listStarted = resolve; });
      const listGate = new Promise(resolve => { releaseList = resolve; });
      let held = false;
      await page.route('**/api/views/view', async route => {
        if (held) {
          await route.fallback();
          return;
        }
        held = true;
        listStarted();
        await listGate;
        await route.fulfill({ status: 200, contentType: 'application/json', body: oldList });
      });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('klebb-cards-changed')));
      await started;
      release();
      expect((await saved).status()).toBe(200);
      await expect.poll(() => page.locator('.grid > .card-wrap').evaluateAll(elements =>
        elements.map(element => element.dataset.cardId)))
        .toEqual([IDS[1], IDS[0], IDS[2], 'navigation_added']);
      await expect(added).toBeVisible();
      releaseList();
      await page.waitForLoadState('networkidle');
      expect(await page.locator('.grid > .card-wrap').evaluateAll(elements =>
        elements.map(element => element.dataset.cardId)))
        .toEqual([IDS[1], IDS[0], IDS[2], 'navigation_added']);
    } finally {
      release();
      releaseList?.();
    }
  });

  test('a view assigned immediately after connection loads its own list', async ({ page }) => {
    const fixture = await installFixtures(page);
    const alternate = {
      ...fixture.cards[0],
      meta: { ...fixture.cards[0].meta, label: 'Alternate metric' },
    };
    await page.route('**/api/views/alternate', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cards: [alternate], errors: [] }),
    }));
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    await page.evaluate(() => {
      const renderer = document.createElement('eh-view-renderer');
      renderer.dataset.testView = 'alternate';
      document.body.appendChild(renderer);
      renderer.view = 'alternate';
    });
    const renderer = page.locator('eh-view-renderer[data-test-view="alternate"]');
    await expect(renderer).toContainText('Alternate metric');
    expect(await renderer.evaluate(element => element.cards.map(card => card.meta.label)))
      .toEqual(['Alternate metric']);
    expect(fixture.getCounts['/api/views/alternate']).toBe(1);
  });

  test('selecting the active Today route after midnight updates the retained view', async ({ page }) => {
    await installFixtures(page);
    await page.goto('/');
    await expectDate(page, todayISO(), 100);
    await page.waitForLoadState('networkidle');
    await rememberIdentity(page);
    const tomorrow = shiftDays(todayISO(), 1);
    const epoch = await page.evaluate(date => new Date(`${date}T00:00:01`).getTime(), tomorrow);
    await page.clock.setSystemTime(epoch);
    await page.locator('health-app').getByRole('button', { name: 'Today', exact: true }).click();
    await expect(page.locator('eh-date-view input[type="date"]')).toHaveValue(tomorrow);
    expectStable(await identity(page), tomorrow, 'today');
    await expect(page.locator('eh-date-view .today-btn')).toHaveCount(0);
  });
});
