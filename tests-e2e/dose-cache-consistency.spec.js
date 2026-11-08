// SPDX-License-Identifier: AGPL-3.0-only
// Regression coverage for #905 and #906: scheduled check-offs must survive
// navigation, failed writes and a replacement card loading during a save.

const { test, expect } = require('./helpers/auth-fixture');
const { todayISO, shiftDays } = require('./helpers/seed-manifests');

function manifest(id, component, maxReadingsPerDay = 1) {
  const today = todayISO();
  const earlier = shiftDays(today, -3);
  const schedule = { type: 'daily', start_date: shiftDays(today, -10) };
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id,
      label: `Dose consistency ${id}`,
      view: { enabled: true, component },
      writeable: {
        fromWebapp: true,
        todayAllowed: true,
        pastAllowed: true,
        maxReadingsPerDay,
      },
    },
    description: 'Synthetic navigation and failed-save regression fixture.',
    data: {
      fixtureNote: 'Preserve root metadata',
      items: [
        {
          name: 'Primary item',
          dose_mg: 1,
          schedule,
          fixtureNote: 'Preserve item metadata',
          doses: [{
            scheduledDate: earlier,
            takenAt: `${earlier}T08:00:00.000Z`,
            note: 'Preserve earlier dose metadata',
            tags: ['first', 'second'],
          }],
        },
        {
          name: 'Unrelated item',
          dose_mg: 2,
          schedule,
          fixtureNote: 'Preserve unrelated item metadata',
          doses: [
            { scheduledDate: earlier, takenAt: `${earlier}T09:00:00.000Z`, note: 'Earlier entry' },
            { scheduledDate: earlier, takenAt: `${earlier}T10:00:00.000Z`, note: 'Second entry' },
          ],
        },
      ],
    },
  };
}

function configureDoseForm(fixture) {
  const today = todayISO();
  fixture.meta.view.checkOffForm = { currentDoseFields: ['note'] };
  fixture.meta.writeable.inputs = [{ key: 'note', label: 'Dose note', type: 'text' }];
  fixture.data.items[0].doses.push(
    { scheduledDate: today, takenAt: `${today}T08:00:00.000Z`, note: 'First entry', marker: 'preserve first' },
    { scheduledDate: today, takenAt: `${today}T09:00:00.000Z`, note: 'Latest entry', marker: 'preserve latest' },
  );
  fixture.data.items[1].doses.push({
    scheduledDate: today, takenAt: `${today}T07:00:00.000Z`, note: 'Remove this entry',
  });
  return fixture;
}

async function readData(page, baseUrl, id) {
  const response = await page.request.get(`${baseUrl}/api/manifests/${id}/data`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

function cardFor(page, id, component) {
  return page.locator(`[data-card-id="${id}"] eh-${component}`);
}

function checkboxFor(card) {
  return card.locator('.item', { hasText: 'Primary item' }).locator('.checkbox');
}

async function navigate(page, card, direction) {
  await page.getByRole('button', { name: `${direction} day`, exact: true }).click();
  await expect(card).toBeVisible();
  // Let the replacement Lit card mount and start its read. A reader may
  // stay in Loading while the previous card's save is still pending.
  await card.evaluate(async element => {
    await element.updateComplete;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function save(page, id, control) {
  const saved = page.waitForResponse(response =>
    response.url().endsWith(`/api/manifests/${id}/data`)
      && response.request().method() === 'POST',
  );
  await control.click();
  const response = await saved;
  expect(response.status()).toBe(200);
  await response.finished();
}

async function withCard(page, sandboxState, id, component, run, maxReadingsPerDay = 1, configure = fixture => fixture) {
  const baseUrl = sandboxState.baseUrl;
  const seeded = await page.request.post(`${baseUrl}/api/manifests`, {
    data: configure(manifest(id, component, maxReadingsPerDay)),
  });
  expect(seeded.status()).toBe(201);
  try {
    const initial = await readData(page, baseUrl, id);
    await page.goto('/');
    const card = cardFor(page, id, component);
    await expect(card).toBeVisible();
    await expect(checkboxFor(card)).toBeVisible();
    await run({ card, initial, baseUrl });
  } finally {
    await page.request.delete(`${baseUrl}/api/manifests/${id}`);
  }
}

function expectPreserved(data, initial) {
  expect(data.fixtureNote).toBe(initial.fixtureNote);
  expect(data.items[0].fixtureNote).toBe(initial.items[0].fixtureNote);
  expect(data.items[0].schedule).toEqual(initial.items[0].schedule);
  expect(data.items[0].doses[0]).toEqual(initial.items[0].doses[0]);
  expect(data.items[1]).toEqual(initial.items[1]);
}

function takenDates(data) {
  return data.items[0].doses.filter(dose => dose.takenAt).map(dose => dose.scheduledDate);
}

async function waitForBarrier(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function holdSave(page, id, baseUrl, { reject = false } = {}) {
  // This is a real pre-save API response. Delivering it to reads started
  // while the POST is held makes the old-data race independent of local
  // network speed. Reads started after release go to the server normally.
  const before = await page.request.get(`${baseUrl}/api/manifests/${id}/data`);
  const snapshot = await before.text();
  let release;
  let started;
  let holding = true;
  let intercepted = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  const pattern = `**/api/manifests/${id}/data`;
  const handler = async route => {
    if (route.request().method() === 'POST' && !intercepted) {
      intercepted = true;
      started();
      await barrier;
      if (reject) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary save failure' }),
        });
      } else {
        await route.continue();
      }
    } else if (route.request().method() === 'GET' && holding) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: snapshot });
    } else {
      await route.continue();
    }
  };
  await page.route(pattern, handler);
  return {
    saving,
    release() {
      holding = false;
      release();
    },
    async dispose() {
      holding = false;
      release();
      await page.unroute(pattern, handler);
    },
  };
}

for (const component of ['schedule-card', 'checklist-card']) {
  test.describe(`#905/#906: ${component} dose consistency`, () => {
    test('a confirmed check-off stays checked after fast date navigation', async ({ page, sandboxState }) => {
      const id = `e2e_dose_confirmed_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        await save(page, id, checkboxFor(card));
        await expect(checkboxFor(card)).toHaveClass(/checked/);
        await navigate(page, card, 'previous');
        await expect(checkboxFor(card)).not.toHaveClass(/checked/);
        await navigate(page, card, 'next');
        await expect(checkboxFor(card)).toHaveClass(/checked/);
        const data = await readData(page, baseUrl, id);
        expectPreserved(data, initial);
        expect(takenDates(data)).toContain(todayISO());
      });
    });

    test('saving another date after a pending save preserves both dates and unrelated data', async ({ page, sandboxState }) => {
      const id = `e2e_dose_two_dates_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        const gate = await holdSave(page, id, baseUrl);
        try {
          const saved = page.waitForResponse(response =>
            response.url().endsWith(`/api/manifests/${id}/data`)
              && response.request().method() === 'POST',
          );
          await checkboxFor(card).click();
          await gate.saving;
          await navigate(page, card, 'previous');
          gate.release();
          expect((await saved).status()).toBe(200);
          await expect(checkboxFor(card)).toBeVisible();
          await expect(checkboxFor(card)).not.toHaveClass(/checked/);
          await save(page, id, checkboxFor(card));

          const data = await readData(page, baseUrl, id);
          expectPreserved(data, initial);
          expect(takenDates(data)).toContain(todayISO());
          expect(takenDates(data)).toContain(shiftDays(todayISO(), -1));
          await navigate(page, card, 'next');
          await expect(checkboxFor(card)).toHaveClass(/checked/);
        } finally {
          await gate.dispose();
        }
      });
    });

    test('a rejected check-off reports an error and does not remain checked', async ({ page, sandboxState }) => {
      const id = `e2e_dose_rejected_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        const pattern = `**/api/manifests/${id}/data`;
        await page.route(pattern, async route => {
          if (route.request().method() === 'POST') {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Temporary save failure' }),
            });
          } else {
            await route.continue();
          }
        });
        try {
          const rejected = page.waitForResponse(response =>
            response.url().endsWith(`/api/manifests/${id}/data`)
              && response.request().method() === 'POST',
          );
          await checkboxFor(card).click();
          expect((await rejected).status()).toBe(503);
          expect(await readData(page, baseUrl, id)).toEqual(initial);
          await expect(card.getByRole('alert')).toBeVisible();
          await expect(card.getByRole('alert')).toContainText(/503|save failed|unable to save|could not save/i);
          await expect(checkboxFor(card)).not.toHaveClass(/checked/);
        } finally {
          await page.unroute(pattern);
        }
      });
    });

    test('returning to a date during a pending save shows the saved check-off when it completes', async ({ page, sandboxState }) => {
      const id = `e2e_dose_pending_return_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        const gate = await holdSave(page, id, baseUrl);
        try {
          const saved = page.waitForResponse(response =>
            response.url().endsWith(`/api/manifests/${id}/data`)
              && response.request().method() === 'POST',
          );
          await checkboxFor(card).click();
          await gate.saving;
          await navigate(page, card, 'previous');
          await navigate(page, card, 'next');
          gate.release();
          expect((await saved).status()).toBe(200);
          const data = await readData(page, baseUrl, id);
          expectPreserved(data, initial);
          expect(takenDates(data)).toContain(todayISO());
          await expect(checkboxFor(card)).toHaveClass(/checked/);
        } finally {
          await gate.dispose();
        }
      });
    });

    test('a save rejected after navigation reports the failure on the replacement card and permits retry', async ({ page, sandboxState }) => {
      const id = `e2e_dose_navigation_rejection_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        const gate = await holdSave(page, id, baseUrl, { reject: true });
        try {
          const rejected = page.waitForResponse(response =>
            response.url().endsWith(`/api/manifests/${id}/data`)
              && response.request().method() === 'POST',
          );
          await checkboxFor(card).click();
          await gate.saving;
          await navigate(page, card, 'previous');
          gate.release();
          expect((await rejected).status()).toBe(503);
          expect(await readData(page, baseUrl, id)).toEqual(initial);
          await expect(card.getByRole('alert')).toBeVisible();
          await expect(card.getByRole('alert')).toContainText(/503|save failed|unable to save|could not save/i);
          await expect(checkboxFor(card)).not.toHaveClass(/checked/);

          await save(page, id, checkboxFor(card));
          await expect(card.getByRole('alert')).toHaveCount(0);
          const data = await readData(page, baseUrl, id);
          expectPreserved(data, initial);
          expect(takenDates(data)).toContain(shiftDays(todayISO(), -1));
          expect(takenDates(data)).not.toContain(todayISO());
          await navigate(page, card, 'next');
          await expect(checkboxFor(card)).not.toHaveClass(/checked/);
        } finally {
          await gate.dispose();
        }
      });
    });

    test('a pre-save read arriving after success cannot replace the confirmed data in another mounted reader', async ({ page, sandboxState }) => {
      const id = `e2e_dose_late_read_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        const readerComponent = component === 'schedule-card' ? 'checklist-card' : 'schedule-card';
        // Mount another real renderer for this manifest so the writer remains
        // usable while an independent reader has an outstanding API request.
        await card.evaluate(async (source, { id, readerComponent }) => {
          const reader = document.createElement(`eh-${readerComponent}`);
          reader.id = `late-reader-${id}`;
          reader.card = source.card;
          reader.date = source.date;
          reader.dateMode = source.dateMode;
          document.body.append(reader);
          await reader.updateComplete;
        }, { id, readerComponent });
        const reader = page.locator(`#late-reader-${id}`);
        await expect(checkboxFor(reader)).toBeVisible();

        let release;
        let captured;
        let delivered;
        let intercepted = false;
        const barrier = new Promise(resolve => { release = resolve; });
        const snapshotCaptured = new Promise(resolve => { captured = resolve; });
        const snapshotDelivered = new Promise(resolve => { delivered = resolve; });
        const pattern = `**/api/manifests/${id}/data`;
        const handler = async route => {
          if (route.request().method() === 'GET' && !intercepted) {
            intercepted = true;
            try {
              const response = await route.fetch();
              captured({ status: response.status() });
              await barrier;
              await route.fulfill({
                response,
                headers: { ...response.headers(), 'x-fixture-delayed-read': '1' },
              });
              delivered({});
            } catch (error) {
              captured({ error });
              delivered({ error });
              await route.abort().catch(() => {});
            }
          } else {
            await route.continue();
          }
        };
        await page.route(pattern, handler);
        try {
          // Navigation now preserves the shared cache. Explicitly expire
          // this history before reconnecting to establish the delayed GET.
          await reader.evaluate(async element => {
            const { invalidateManifestCache } = await import('/js/components/eh-base-card.js');
            invalidateManifestCache(element.card.id);
            element.remove();
            document.body.append(element);
          });
          const capturedResult = await waitForBarrier(snapshotCaptured, 'The independent reader did not start its API read');
          if (capturedResult.error) throw capturedResult.error;
          expect(capturedResult.status).toBe(200);
          const received = page.waitForResponse(response =>
            response.url().endsWith(`/api/manifests/${id}/data`)
              && response.headers()['x-fixture-delayed-read'] === '1',
          );
          // Preserve an early routing failure's diagnosis if there is no
          // browser response to await.
          received.catch(() => {});
          await save(page, id, checkboxFor(card));
          release();
          const deliveryResult = await waitForBarrier(snapshotDelivered, 'The delayed API read was not delivered');
          if (deliveryResult.error) throw deliveryResult.error;
          await (await received).finished();
          await reader.evaluate(async element => {
            await element.updateComplete;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });

          await expect(checkboxFor(reader)).toHaveClass(/checked/);
          await expect(checkboxFor(card)).toHaveClass(/checked/);
          // A fresh reader, without disconnecting either existing instance,
          // also catches stale responses poisoning only the shared cache.
          await card.evaluate(async (source, { id, readerComponent }) => {
            const fresh = document.createElement(`eh-${readerComponent}`);
            fresh.id = `cached-reader-${id}`;
            fresh.card = source.card;
            fresh.date = source.date;
            fresh.dateMode = source.dateMode;
            document.body.append(fresh);
            await fresh.updateComplete;
          }, { id, readerComponent });
          await expect(checkboxFor(page.locator(`#cached-reader-${id}`))).toHaveClass(/checked/);
          const data = await readData(page, baseUrl, id);
          expectPreserved(data, initial);
          expect(takenDates(data)).toContain(todayISO());
        } finally {
          release();
          await page.unroute(pattern, handler);
          await page.locator(`#cached-reader-${id}`).evaluateAll(elements => {
            for (const element of elements) element.remove();
          });
          await reader.evaluate(element => element.remove());
        }
      });
    });

    test('multiple doses and their metadata survive navigation and another date save', async ({ page, sandboxState }) => {
      const id = `e2e_dose_multi_${component}`;
      await withCard(page, sandboxState, id, component, async ({ card, initial, baseUrl }) => {
        await save(page, id, checkboxFor(card));
        await save(page, id, checkboxFor(card));
        const before = await readData(page, baseUrl, id);
        const firstDateDoses = before.items[0].doses.filter(dose => dose.scheduledDate === todayISO());
        expect(firstDateDoses).toHaveLength(2);
        expect(firstDateDoses.every(dose => dose.takenAt)).toBe(true);

        await navigate(page, card, 'previous');
        await expect(checkboxFor(card)).toBeVisible();
        await save(page, id, checkboxFor(card));
        const after = await readData(page, baseUrl, id);
        expectPreserved(after, initial);
        expect(after.items[0].doses.filter(dose => dose.scheduledDate === todayISO())).toEqual(firstDateDoses);
        expect(takenDates(after)).toContain(shiftDays(todayISO(), -1));
        await navigate(page, card, 'next');
        await expect(checkboxFor(card)).toHaveClass(/checked/);
      }, 3);
    });
  });
}

test('saving another item while a dose form is open preserves the selected edit target', async ({ page, sandboxState }) => {
  const id = 'e2e_dose_open_form_target';
  await withCard(page, sandboxState, id, 'schedule-card', async ({ card, initial, baseUrl }) => {
    const today = todayISO();
    const originalToday = initial.items[0].doses.filter(dose => dose.scheduledDate === today);
    await checkboxFor(card).click();
    const form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();
    await form.getByLabel('Dose note').fill('Edited latest entry');

    const unrelated = card.locator('.item-row', { hasText: 'Unrelated item' });
    await unrelated.locator('.multi-count').click();
    await save(page, id, unrelated.locator('.entry-remove'));
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Dose note')).toHaveValue('Edited latest entry');
    await save(page, id, form.locator('eh-input-form').getByRole('button', { name: /log dose/i }).first());
    await expect(form).toHaveCount(0);

    const data = await readData(page, baseUrl, id);
    const afterToday = data.items[0].doses.filter(dose => dose.scheduledDate === today);
    expect(afterToday).toHaveLength(2);
    expect(afterToday[0]).toEqual(originalToday[0]);
    expect(afterToday[1]).toEqual({ ...originalToday[1], note: 'Edited latest entry' });
    expect(data.items[0].doses[0]).toEqual(initial.items[0].doses[0]);
    expect(data.items[1].doses).toEqual(initial.items[1].doses.filter(dose => dose.scheduledDate !== today));
  }, 2, configureDoseForm);
});

test('another mounted card can save while an open dose form preserves input and edits its original entry', async ({ page, sandboxState }) => {
  const id = 'e2e_dose_shared_open_form_target';
  await withCard(page, sandboxState, id, 'schedule-card', async ({ card, initial, baseUrl }) => {
    const today = todayISO();
    const originalToday = initial.items[0].doses.filter(dose => dose.scheduledDate === today);
    await checkboxFor(card).click();
    const form = card.locator('.checkoff-form');
    await expect(form).toBeVisible();
    await expect(form.locator('.prev-dose-summary')).toContainText('First entry');
    await form.getByLabel('Dose note').fill('Edited after another card saved');

    await card.evaluate(async (source, id) => {
      const reader = document.createElement('eh-checklist-card');
      reader.id = `other-writer-${id}`;
      // Keep the independent writer's controls above the app's fixed
      // footer while driving them through normal browser clicks.
      reader.style.cssText = 'position:fixed;top:80px;left:12px;width:300px;max-height:60vh;overflow:auto;z-index:10000;';
      reader.card = source.card;
      reader.date = source.date;
      reader.dateMode = source.dateMode;
      document.body.append(reader);
      await reader.updateComplete;
    }, id);
    const reader = page.locator(`#other-writer-${id}`);
    try {
      await expect(checkboxFor(reader)).toBeVisible();
      const unrelated = reader.locator('.item', { hasText: 'Unrelated item' });
      await unrelated.locator('.multi-count').click();
      await save(page, id, reader.getByRole('button', { name: 'remove this entry for Unrelated item', exact: true }));
      await expect(form).toBeVisible();
      await expect(form.locator('.prev-dose-summary')).toContainText('First entry');
      await expect(form.getByLabel('Dose note')).toHaveValue('Edited after another card saved');
      await expect(card.locator('.item', { hasText: 'Unrelated item' }).locator('.checkbox')).not.toHaveClass(/checked/);
      // Preserve the second reader's live subscription while freeing the
      // original form's controls from the test overlay.
      await reader.evaluate(element => { element.style.display = 'none'; });
      await save(page, id, form.locator('eh-input-form').getByRole('button', { name: /log dose/i }).first());
      await expect(form).toHaveCount(0);

      const data = await readData(page, baseUrl, id);
      const afterToday = data.items[0].doses.filter(dose => dose.scheduledDate === today);
      expect(afterToday).toHaveLength(2);
      expect(afterToday[0]).toEqual(originalToday[0]);
      expect(afterToday[1]).toEqual({ ...originalToday[1], note: 'Edited after another card saved' });
      expect(data.fixtureNote).toBe(initial.fixtureNote);
      expect(data.items[0].fixtureNote).toBe(initial.items[0].fixtureNote);
      expect(data.items[0].doses[0]).toEqual(initial.items[0].doses[0]);
      expect(data.items[1]).toEqual({
        ...initial.items[1],
        doses: initial.items[1].doses.filter(dose => dose.scheduledDate !== today),
      });
      await expect(unrelated.locator('.checkbox')).not.toHaveClass(/checked/);
    } finally {
      await reader.evaluate(element => element.remove());
    }
  }, 2, configureDoseForm);
});
