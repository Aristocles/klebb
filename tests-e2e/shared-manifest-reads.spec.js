// SPDX-License-Identifier: AGPL-3.0-only
// Shared reads must reduce traffic without hiding confirmed changes.
const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

const IDS = ['shared_read_a', 'shared_read_b', 'shared_read_combo_a', 'shared_read_combo_b'];

function fixtures() {
  const today = todayISO();
  const donors = IDS.slice(0, 2).map((id, index) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label: `Shared value ${index + 1}`, order: 500 + index,
      view: { enabled: true, component: 'generic-card', display: { template: '{value}' } },
      calendar: { enabled: true, marker: { type: 'template', template: '{value}' } },
      writeable: {
        fromWebapp: true, todayAllowed: true, pastAllowed: true,
        inputs: [{ key: 'value', type: 'number', label: 'Value', required: true }],
      },
    },
    description: 'Synthetic shared-read fixture.',
    data: [{ date: today, value: index + 11 }, { date: shiftDays(today, -1), value: index + 21 }],
  }));
  const combinations = IDS.slice(2).map((id, index) => ({
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label: `Shared summary ${index + 1}`, order: 600 + index,
      view: {
        enabled: true, component: 'combination-card', layout: 'stack',
        combines: IDS.slice(0, 2).map(sourceId => ({ sourceId, role: 'annotation', accessor: 'value' })),
      },
    },
    description: 'Synthetic combination fixture.',
    data: [],
  }));
  return [...donors, ...combinations];
}

function recordReads(page) {
  const counts = new Map();
  page.on('request', request => {
    if (request.method() !== 'GET') return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) counts.set(path, (counts.get(path) || 0) + 1);
  });
  return counts;
}

// Keep the browser argument explicit rather than relying on closure capture.
async function ready(page) {
  for (const id of IDS.slice(2)) {
    const card = page.locator(`[data-card-id="${id}"] eh-combination-card`);
    await expect(card).toBeVisible();
    await expect.poll(() => card.evaluate((element, donors) =>
      !element._loading && donors.every(id => element._sources[id]?.loaded), IDS.slice(0, 2),
    )).toBe(true);
  }
  await page.waitForLoadState('networkidle');
}

test.beforeEach(async ({ page, sandboxState }) => {
  for (const fixture of fixtures()) {
    const response = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, { data: fixture });
    expect(response.status()).toBe(201);
  }
});

test.afterEach(async ({ page, sandboxState }) => {
  for (const id of [...IDS].reverse()) await page.request.delete(`${sandboxState.baseUrl}/api/manifests/${id}`);
});

test('ordinary cards and two combinations share one history and metadata read per donor', async ({ page }) => {
  const reads = recordReads(page);
  await page.goto('/');
  await ready(page);
  console.log('SHARED_READ_COUNTS', JSON.stringify(Object.fromEntries(reads)));
  for (const id of IDS.slice(0, 2)) {
    expect(reads.get(`/api/manifests/${id}/data`)).toBe(1);
    expect(reads.get(`/api/manifests/${id}`)).toBe(1);
  }
});

test('opening and revisiting the calendar reuses loaded ordinary history', async ({ page }) => {
  const reads = recordReads(page);
  await page.goto('/');
  await ready(page);
  const before = IDS.slice(0, 2).map(id => reads.get(`/api/manifests/${id}/data`));
  const initialLists = reads.get('/api/manifests');
  for (let index = 0; index < 2; index++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/calendar' } })));
    const calendar = page.locator('eh-calendar-view');
    await expect(calendar).toBeVisible();
    await expect.poll(() => calendar.evaluate(element => !element._loading)).toBe(true);
    await expect.poll(() => calendar.evaluate((element, id) =>
      [...element._markers.values()].some(markers => markers.some(marker => marker.id === id)), IDS[0],
    )).toBe(true);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/' } })));
    await ready(page);
  }
  console.log('CALENDAR_READ_COUNTS', JSON.stringify(Object.fromEntries(reads)));
  for (const [index, id] of IDS.slice(0, 2).entries()) {
    expect(reads.get(`/api/manifests/${id}/data`)).toBe(before[index]);
  }
  expect(reads.get('/api/manifests')).toBe(initialLists);
});

test('an acknowledged donor edit updates both summaries without refetching unrelated history', async ({ page, sandboxState }) => {
  const reads = recordReads(page);
  await page.goto('/');
  await ready(page);
  const before = new Map(reads);
  const combo = page.locator(`[data-card-id="${IDS[2]}"] eh-combination-card`);
  await combo.locator('.edit-btn').first().click();
  const form = combo.locator('eh-input-form');
  await form.locator('input[type="number"]').fill('37');
  const saved = page.waitForResponse(response =>
    response.url().endsWith(`/api/manifests/${IDS[0]}/data`) && response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Update', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(form).toHaveCount(0);
  for (const id of IDS.slice(2)) {
    const summary = page.locator(`[data-card-id="${id}"] eh-combination-card`);
    await expect.poll(() => summary.evaluate((element, sourceId) =>
      element._sources[sourceId]?.data?.find(row => row.date === element.date)?.value, IDS[0],
    )).toBe(37);
  }
  const ordinary = page.locator(`[data-card-id="${IDS[0]}"] eh-generic-card`);
  await expect.poll(() => ordinary.evaluate(element =>
    element.data?.find(row => row.date === element.date)?.value,
  )).toBe(37);
  await page.waitForLoadState('networkidle');
  for (const id of IDS.slice(0, 2)) {
    expect(reads.get(`/api/manifests/${id}/data`)).toBe(before.get(`/api/manifests/${id}/data`));
  }
  expect(reads.get('/api/cc-suggestions')).toBe(before.get('/api/cc-suggestions'));
  expect(reads.get('/api/health-auto-export/discoveries')).toBe(before.get('/api/health-auto-export/discoveries'));
  const response = await page.request.get(`${sandboxState.baseUrl}/api/manifests/${IDS[0]}/data`);
  expect((await response.json()).data.find(row => row.date === todayISO()).value).toBe(37);
});

test('an external data change refreshes only its donor and reaches the calendar', async ({ page, sandboxState }) => {
  const reads = recordReads(page);
  await page.goto('/');
  await ready(page);
  const before = new Map(reads);
  const data = fixtures()[0].data.map(row => row.date === todayISO() ? { ...row, value: 43 } : row);
  const saved = await page.request.post(`${sandboxState.baseUrl}/api/manifests/${IDS[0]}/data`, { data: { data } });
  expect(saved.status()).toBe(200);
  await page.evaluate(cardId => window.dispatchEvent(new CustomEvent('manifest-data-changed', {
    detail: { cardId },
  })), IDS[0]);
  for (const id of IDS.slice(2)) {
    await expect.poll(() => page.locator(`[data-card-id="${id}"] eh-combination-card`).evaluate(
      (element, sourceId) => element._sources[sourceId]?.data?.find(row => row.date === element.date)?.value, IDS[0],
    )).toBe(43);
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/calendar' } })));
  const calendar = page.locator('eh-calendar-view');
  await expect.poll(() => calendar.evaluate((element, { id, date }) =>
    element._markers.get(date)?.find(marker => marker.id === id)?.marker,
  { id: IDS[0], date: todayISO() })).toBe('43');
  expect(reads.get(`/api/manifests/${IDS[0]}/data`)).toBe(before.get(`/api/manifests/${IDS[0]}/data`) + 1);
  expect(reads.get(`/api/manifests/${IDS[1]}/data`)).toBe(before.get(`/api/manifests/${IDS[1]}/data`));
});

test('a delayed multi-source refresh cannot replace newer history adopted on navigation', async ({ page, sandboxState }) => {
  await page.goto('/');
  await ready(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pattern = `**/api/manifests/${IDS[1]}/data`;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await gate;
    await route.continue();
  });
  try {
    const firstResponse = page.waitForResponse(response =>
      response.request().method() === 'GET' && response.url().endsWith(`/api/manifests/${IDS[0]}/data`));
    await page.evaluate(async ({ donors, comboId }) => {
      const { invalidateManifestCache } = await import('/js/lib/manifest-reads.js');
      for (const id of donors) invalidateManifestCache(id);
      const renderer = document.querySelector('health-app').shadowRoot
        .querySelector('eh-date-view').shadowRoot.querySelector('eh-view-renderer');
      const combo = renderer.shadowRoot.querySelector(`[data-card-id="${comboId}"] eh-combination-card`);
      window.heldSummaryRefresh = combo._fetchAll(donors);
    }, { donors: IDS.slice(0, 2), comboId: IDS[2] });
    await (await firstResponse).finished();
    const data = fixtures()[0].data.map(row => ({ ...row, value: 31 }));
    expect((await page.request.post(`${sandboxState.baseUrl}/api/manifests/${IDS[0]}/data`, {
      data: { data },
    })).status()).toBe(200);
    await page.evaluate(async id => {
      const { invalidateManifestCache, fetchManifestData } = await import('/js/lib/manifest-reads.js');
      invalidateManifestCache(id);
      await fetchManifestData(id);
    }, IDS[0]);
    await page.evaluate(date => window.dispatchEvent(new CustomEvent('navigate', {
      detail: { path: `/day/${date}` },
    })), shiftDays(todayISO(), -1));
    const summary = page.locator(`[data-card-id="${IDS[2]}"] eh-combination-card`);
    const value = () => summary.evaluate((element, id) =>
      element._sources[id]?.data?.find(row => row.date === element.date)?.value, IDS[0]);
    await expect.poll(value).toBe(31);
    release();
    await page.evaluate(() => window.heldSummaryRefresh);
    await page.waitForLoadState('networkidle');
    await expect.poll(value).toBe(31);
  } finally {
    release();
    await page.unroute(pattern);
  }
});

test('returning to the app refreshes expired history and keeps hot history local', async ({ page, sandboxState }) => {
  const reads = recordReads(page);
  await page.goto('/');
  await ready(page);
  const before = new Map(reads);
  const data = fixtures()[0].data.map(row => ({ ...row, value: 47 }));
  expect((await page.request.post(`${sandboxState.baseUrl}/api/manifests/${IDS[0]}/data`, {
    data: { data },
  })).status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForLoadState('networkidle');
  expect(reads.get(`/api/manifests/${IDS[0]}/data`)).toBe(before.get(`/api/manifests/${IDS[0]}/data`));
  await page.clock.setSystemTime(Date.now() + 21000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  for (const id of IDS.slice(2)) {
    const summary = page.locator(`[data-card-id="${id}"] eh-combination-card`);
    await expect.poll(() => summary.evaluate((element, sourceId) =>
      element._sources[sourceId]?.data?.find(row => row.date === element.date)?.value, IDS[0])).toBe(47);
  }
  const ordinary = page.locator(`[data-card-id="${IDS[0]}"] eh-generic-card`);
  await expect.poll(() => ordinary.evaluate(element =>
    element.data?.find(row => row.date === element.date)?.value)).toBe(47);
  expect(reads.get(`/api/manifests/${IDS[0]}/data`)).toBe(before.get(`/api/manifests/${IDS[0]}/data`) + 1);
});

test('unhiding a discovery in Settings invalidates its cached Today surface', async ({ page, sandboxState }) => {
  const metric = 'e2e_unsupported_metric';
  const endpoint = `${sandboxState.baseUrl}/api/health-auto-export/discoveries/${metric}`;
  expect((await page.request.post(endpoint + '/dismiss')).status()).toBe(200);
  try {
    await page.goto('/');
    const discovery = page.locator('eh-hae-discovery-card');
    await expect.poll(() => discovery.evaluate(element =>
      element._data?.dismissed?.some(item => item.metric === 'e2e_unsupported_metric'))).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/settings' } })));
    await page.locator('eh-settings-view [data-tab="security"]').click();
    const security = page.locator('eh-settings-security');
    const hidden = security.locator('.discovery-row').filter({ hasText: metric });
    await security.locator('details').filter({ hasText: 'Hidden' }).first().locator('summary').click();
    await expect(hidden).toBeVisible();
    await hidden.getByRole('button', { name: 'Un-hide', exact: true }).click();
    await expect(hidden).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/' } })));
    await expect.poll(() => page.locator('eh-hae-discovery-card').evaluate(element =>
      element._data?.undismissed?.unsupported?.some(item => item.metric === 'e2e_unsupported_metric'))).toBe(true);
  } finally {
    await page.request.post(endpoint + '/unhide');
  }
});

test('optional Today suggestions recover after mounting during a shared read cooldown', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/calendar' } })));
  await expect.poll(() => page.locator('eh-calendar-view').evaluate(element => !element._loading)).toBe(true);
  const counts = { suggestions: 0, discoveries: 0 };
  await page.route('**/api/cc-suggestions', async route => {
    counts.suggestions++;
    await route.fulfill({ json: { suggestions: [{ category: 'body', cardIds: IDS.slice(0, 2) }] } });
  });
  await page.route('**/api/health-auto-export/discoveries', async route => {
    counts.discoveries++;
    await route.fulfill({ json: {
      undismissed: { supported: {}, unsupported: [{ metric: 'cooldown_fixture_metric' }] }, dismissed: [],
    } });
  });
  await page.route('**/api/read-cooldown-fixture', route => route.fulfill({
    status: 429, headers: { 'Retry-After': '1' }, json: { error: 'Temporary read throttle' },
  }));
  await page.evaluate(async () => {
    const { readJSON, invalidateRead } = await import('/js/lib/manifest-reads.js');
    for (const url of ['/api/cc-suggestions', '/api/settings/cards', '/api/health-auto-export/discoveries']) {
      invalidateRead(url);
    }
    try { await readJSON('/api/read-cooldown-fixture'); } catch (error) {
      if (error.status !== 429) throw error;
    }
    window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/' } }));
  });
  await expect(page.locator('eh-view-renderer').getByRole('status')).toBeVisible();
  expect(counts).toEqual({ suggestions: 0, discoveries: 0 });
  await expect(page.locator('eh-cc-suggestion-card')).toContainText('Combine into a Body card?');
  await expect(page.locator('eh-hae-discovery-card')).toContainText('metric received but not supported yet');
  expect(counts).toEqual({ suggestions: 1, discoveries: 1 });
});

for (const view of ['summaries', 'calendar']) {
  test(`${view} retain confirmed values during throttling and share one recovery read`, async ({ page }) => {
    await page.goto('/');
    await ready(page);
    if (view === 'calendar') {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/calendar' } })));
      await expect.poll(() => page.locator('eh-calendar-view').evaluate(element => !element._loading)).toBe(true);
      await page.waitForLoadState('networkidle');
    }
    let reads = 0;
    let releaseRecovery;
    const recovery = new Promise(resolve => { releaseRecovery = resolve; });
    const pattern = `**/api/manifests/${IDS[0]}/data`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      reads++;
      if (reads === 1) return route.fulfill({
        status: 429, headers: { 'Retry-After': '1' }, contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary read throttle' }),
      });
      await recovery;
      await route.continue();
    });
    try {
      await page.evaluate(cardId => window.dispatchEvent(new CustomEvent('manifest-data-changed', {
        detail: { cardId },
      })), IDS[0]);
      if (view === 'summaries') {
        for (const id of IDS.slice(2)) {
          const summary = page.locator(`[data-card-id="${id}"] eh-combination-card`);
          await expect(summary.getByRole('status')).toBeVisible();
          await expect.poll(() => summary.evaluate((element, sourceId) => ({
            value: element._sources[sourceId]?.data?.find(row => row.date === element.date)?.value,
            editable: element._canEditDonor(sourceId),
          }), IDS[0])).toEqual({ value: 11, editable: false });
        }
      } else {
        const calendar = page.locator('eh-calendar-view');
        await expect(calendar.getByRole('status')).toBeVisible();
        await expect.poll(() => calendar.evaluate((element, { id, date }) =>
          element._markers.get(date)?.find(marker => marker.id === id)?.marker,
        { id: IDS[0], date: todayISO() })).toBe('11');
      }
      await expect.poll(() => reads).toBe(2);
      releaseRecovery();
      const surfaces = view === 'calendar' ? page.locator('eh-calendar-view')
        : page.locator(`[data-card-id="${IDS[2]}"] eh-combination-card`);
      await expect(surfaces.getByRole('status')).toHaveCount(0);
      expect(reads).toBe(2);
    } finally {
      releaseRecovery();
      await page.unroute(pattern);
    }
  });
}
