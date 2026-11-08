// SPDX-License-Identifier: AGPL-3.0-only
// Refresh throttling must retain confirmed ordinary history, bound retries
// and leave failed writes for an explicit user retry.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO } = require('./helpers/seed-manifests');

function fixture(id, checked = true) {
  const date = todayISO();
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: 'Read recovery fixture',
      view: { enabled: true, component: 'schedule-card' },
      writeable: { fromWebapp: true, todayAllowed: true, pastAllowed: true },
    },
    description: 'Synthetic confirmed-history refresh fixture.',
    data: {
      items: [{
        name: 'Fixture item',
        schedule: { type: 'daily', start_date: '2026-01-01' },
        doses: checked ? [{ scheduledDate: date, takenAt: `${date}T08:00:00.000Z` }] : [],
      }],
    },
  };
}

async function withFixture(page, sandboxState, id, run, checked = true) {
  const created = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, {
    data: fixture(id, checked),
  });
  expect(created.status()).toBe(201);
  try {
    await page.goto('/');
    const card = page.locator(`[data-card-id="${id}"] eh-schedule-card`);
    await expect(card.locator('.checkbox')).toBeVisible();
    await run(card);
  } finally {
    await page.request.delete(`${sandboxState.baseUrl}/api/manifests/${id}`);
  }
}

async function refresh(page, id) {
  await page.evaluate(cardId => {
    window.dispatchEvent(new CustomEvent('manifest-data-changed', { detail: { cardId } }));
  }, id);
}

test('a throttled refresh retains checked history and recovers once at the deadline', async ({ page, sandboxState }) => {
  const id = 'e2e_throttle_retained';
  await withFixture(page, sandboxState, id, async card => {
    await expect(card.locator('.checkbox')).toHaveClass(/checked/);
    let reads = 0;
    let releaseRecovery;
    const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
    const pattern = `**/api/manifests/${id}/data`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      reads++;
      if (reads === 1) {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary read throttle' }),
        });
      } else {
        await recoveryGate;
        await route.continue();
      }
    });
    try {
      await refresh(page, id);
      await expect(card.getByRole('status')).toContainText(/temporar|retry|busy|updat/i);
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      await expect(card.locator('.checkbox')).toHaveAttribute('aria-disabled', 'true');
      // Repeated invalidations during cooldown must share one recovery.
      await refresh(page, id);
      await refresh(page, id);
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      await expect.poll(() => reads).toBe(2);
      releaseRecovery();
      await expect(card.getByRole('status')).toHaveCount(0);
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      expect(reads).toBe(2);
    } finally {
      releaseRecovery();
      await page.unroute(pattern);
    }
  });
});

test('an unavailable first read shows a temporary message and automatically recovers', async ({ page, sandboxState }) => {
  const id = 'e2e_throttle_initial';
  let reads = 0;
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const pattern = `**/api/manifests/${id}/data`;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++;
    if (reads === 1) {
      await route.fulfill({
        status: 429,
        headers: { 'Retry-After': '1' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary read throttle' }),
      });
    } else {
      await recoveryGate;
      await route.continue();
    }
  });
  const created = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, { data: fixture(id) });
  expect(created.status()).toBe(201);
  try {
    await page.goto('/');
    const card = page.locator(`[data-card-id="${id}"] eh-schedule-card`);
    await expect(card.getByRole('status')).toContainText(/temporar|retry|busy|updat/i);
    await expect(card.locator('.checkbox')).toHaveCount(0);
    releaseRecovery();
    await expect(card.locator('.checkbox')).toHaveClass(/checked/);
    await expect(card.getByRole('status')).toHaveCount(0);
    expect(reads).toBe(2);
  } finally {
    releaseRecovery();
    await page.unroute(pattern);
    await page.request.delete(`${sandboxState.baseUrl}/api/manifests/${id}`);
  }
});

test('a 429 write is never replayed automatically and permits an explicit retry', async ({ page, sandboxState }) => {
  const id = 'e2e_throttle_write';
  await withFixture(page, sandboxState, id, async card => {
    let writes = 0;
    const pattern = `**/api/manifests/${id}/data`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++;
      if (writes === 1) {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary write throttle' }),
        });
      } else {
        await route.continue();
      }
    });
    try {
      await card.locator('.checkbox').click();
      await expect(card.getByRole('alert')).toContainText(/429|save/i);
      await expect(card.locator('.checkbox')).not.toHaveClass(/checked/);
      await refresh(page, id);
      await card.evaluate(async element => {
        await element.updateComplete;
        await new Promise(resolve => setTimeout(resolve, 1200));
      });
      expect(writes).toBe(1);
      await card.locator('.checkbox').click();
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      await expect(card.getByRole('alert')).toHaveCount(0);
      expect(writes).toBe(2);
    } finally {
      await page.unroute(pattern);
    }
  }, false);
});

test('an overlapping throttle extends recovery without spending the automatic retry', async ({ page, sandboxState }) => {
  const ids = ['e2e_throttle_short', 'e2e_throttle_extended'];
  for (const id of ids) {
    const created = await page.request.post(`${sandboxState.baseUrl}/api/manifests`, { data: fixture(id) });
    expect(created.status()).toBe(201);
  }
  let releaseExtended;
  const extendedGate = new Promise(resolve => { releaseExtended = resolve; });
  const reads = new Map(ids.map(id => [id, 0]));
  const handlers = new Map();
  try {
    await page.goto('/');
    const cards = ids.map(id => page.locator(`[data-card-id="${id}"] eh-schedule-card`));
    for (const card of cards) await expect(card.locator('.checkbox')).toHaveClass(/checked/);
    for (const id of ids) {
      const handler = async route => {
        if (route.request().method() !== 'GET') return route.continue();
        reads.set(id, reads.get(id) + 1);
        if (reads.get(id) !== 1) return route.continue();
        if (id === ids[1]) await extendedGate;
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': id === ids[0] ? '1' : '2' },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary read throttle' }),
        });
      };
      handlers.set(id, handler);
      await page.route(`**/api/manifests/${id}/data`, handler);
    }
    // Start both network reads before either response establishes cooldown.
    await page.evaluate(cardIds => {
      for (const cardId of cardIds) {
        window.dispatchEvent(new CustomEvent('manifest-data-changed', { detail: { cardId } }));
      }
    }, ids);
    await expect(cards[0].getByRole('status')).toBeVisible();
    await expect.poll(() => reads.get(ids[1])).toBe(1);
    releaseExtended();
    await expect(cards[1].getByRole('status')).toBeVisible();
    for (const card of cards) {
      await expect(card.getByRole('status')).toHaveCount(0);
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      await expect(card.locator('.checkbox')).toHaveAttribute('aria-disabled', 'false');
    }
    expect([...reads.values()]).toEqual([2, 2]);
  } finally {
    releaseExtended();
    for (const id of ids) {
      if (handlers.has(id)) await page.unroute(`**/api/manifests/${id}/data`, handlers.get(id));
      await page.request.delete(`${sandboxState.baseUrl}/api/manifests/${id}`);
    }
  }
});

test('date navigation adopts history refreshed by another reader without another GET', async ({ page, sandboxState }) => {
  const id = 'e2e_read_adopt_confirmed';
  await withFixture(page, sandboxState, id, async card => {
    await expect(card.locator('.checkbox')).toHaveClass(/checked/);
    let reads = 0;
    const pattern = `**/api/manifests/${id}/data`;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET') reads++;
      await route.continue();
    });
    try {
      const changed = await page.request.post(`${sandboxState.baseUrl}/api/manifests/${id}/data`, {
        data: { data: fixture(id, false).data },
      });
      expect(changed.status()).toBe(200);
      await page.evaluate(async cardId => {
        const reads = await import('/js/lib/manifest-reads.js');
        reads.invalidateManifestCache(cardId);
        await reads.fetchManifestData(cardId);
      }, id);
      await expect(card.locator('.checkbox')).toHaveClass(/checked/);
      expect(reads).toBe(1);
      await page.getByRole('button', { name: 'previous day', exact: true }).click();
      await page.getByRole('button', { name: 'next day', exact: true }).click();
      await expect(card.locator('.checkbox')).not.toHaveClass(/checked/);
      expect(reads).toBe(1);
    } finally {
      await page.unroute(pattern);
    }
  });
});

test('same-renderer metadata replacement refreshes history after central scope invalidation', async ({ page, sandboxState }) => {
  const id = 'e2e_read_metadata_refresh';
  await withFixture(page, sandboxState, id, async card => {
    await expect(card.locator('.checkbox')).toHaveClass(/checked/);
    await card.evaluate(element => { window.fixtureRenderer = element; });
    let reads = 0;
    const pattern = `**/api/manifests/${id}/data`;
    await page.route(pattern, async route => {
      if (route.request().method() === 'GET') reads++;
      await route.continue();
    });
    try {
      const changed = await page.request.post(`${sandboxState.baseUrl}/api/manifests/${id}/data`, {
        data: { data: fixture(id, false).data },
      });
      expect(changed.status()).toBe(200);
      const renamed = await page.request.patch(`${sandboxState.baseUrl}/api/manifests/${id}`, {
        data: { meta: { label: 'Updated recovery fixture' } },
      });
      expect(renamed.status()).toBe(200);
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('klebb-cards-changed'));
      });
      await expect(card).toContainText('Updated recovery fixture');
      await expect(card.locator('.checkbox')).not.toHaveClass(/checked/);
      expect(await card.evaluate(element => element === window.fixtureRenderer)).toBe(true);
      expect(reads).toBe(1);
    } finally {
      await page.unroute(pattern);
      await page.evaluate(() => { delete window.fixtureRenderer; });
    }
  });
});
