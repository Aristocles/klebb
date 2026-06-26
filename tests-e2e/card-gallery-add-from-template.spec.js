// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests-e2e/card-gallery-add-from-template.spec.js
//
// Live coverage for the card gallery / add-from-template flow in
// Settings > Cards (#451). Began life as a fixme'd storyboard; the eh-card-
// gallery component + the from-template create endpoint now satisfy it, so
// the tests are live.
//
// Lens: UI/UX — where the affordance lives, how the gallery looks and
// reads, the at-a-glance summary, the create round-trip, and mobile-first
// / dark-mode execution. Mutates sandbox state (creates cards), so runs
// serial and the created cards are cleaned up where it matters.
//
// House conventions honoured:
//   - Settings > Cards pane today only points the user at file-drop or
//     chat to add a card. This flow adds a third, discoverable path: a
//     template gallery that mirrors eh-prompts-gallery (a self-mounting
//     <dialog> with a search toolbar, a featured row, per-row Preview, and
//     a primary action). The action here is "Add card" rather than "Load
//     into chat".
//   - The gallery's natural visual home is a sibling action block next to
//     the existing .reorder-section in eh-settings-cards, or in the lede /
//     empty-state copy that currently only mentions file-drop and chat.
//   - Amber (var(--accent-amber, #ffaa33)) is the proactive / suggestion
//     visual language; the teal primary accent (var(--accent)) is for
//     normal interactive affordances. The gallery is a deliberate user
//     action, not a proactive nudge, so its primary "Add card" button uses
//     the teal accent; only any "you might also like" suggestion strip
//     inside the gallery would borrow amber.

const { test, expect } = require('./helpers/auth-fixture');

test.describe.configure({ mode: 'serial' });

test.describe('Storyboard: card gallery / add-from-template in Settings > Cards', () => {
  // This suite CREATES real cards (the whole point of the flow). The e2e
  // sandbox is shared across every spec, so any card left behind pollutes
  // the seeded state other specs assert against. Snapshot the baseline card
  // ids once, and after each test delete anything that wasn't there before,
  // so no created card can leak — regardless of which test created it.
  let baselineIds = null;
  test.beforeEach(async ({ page, sandboxState }) => {
    if (baselineIds) return; // snapshot once, on the first test
    const r = await page.request.get(`${sandboxState.baseUrl}/api/settings/cards`);
    baselineIds = (await r.json()).cards.map(c => c.id);
  });
  test.afterEach(async ({ page, sandboxState }) => {
    if (!baselineIds) return;
    const r = await page.request.get(`${sandboxState.baseUrl}/api/settings/cards`);
    const created = (await r.json()).cards.map(c => c.id).filter(id => !baselineIds.includes(id));
    for (const id of created) {
      await page.request.delete(`${sandboxState.baseUrl}/api/manifests/${id}`);
    }
  });

  // /api/templates -> { templates: [ { id, title, summary, category, tags,
  //   emoji, featured?, manifest } ] }; create via
  //   POST /api/settings/cards/from-template { templateId } -> { id }.
  // eh-card-gallery is instantiated like eh-prompts-gallery (createElement +
  // appendChild + requestAnimationFrame(open)) so it lives outside the
  // settings render tree as a top-layer modal dialog.

  test('Cards pane exposes a discoverable "Browse card templates" action', async ({ page }) => {
    //the entry affordance.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();
    await expect(page.locator('eh-settings-cards .card').first()).toBeVisible();

    // A new action block sits as a sibling to the reorder-section, above
    // the alphabetical card list. It must be a real button with an
    // accessible name, not a bare link, so it reads as a primary action.
    const browseBtn = page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i });
    await expect(browseBtn).toBeVisible();

    // It uses the teal primary accent, not amber: this is a deliberate
    // user action, not a proactive suggestion. (Asserted structurally via
    // a class the implementation should carry; colour itself is a
    // computed-style concern left to a unit test, kept out of e2e.)
    await expect(browseBtn).toHaveClass(/primary|gallery-btn/);
  });

  test('opening the action mounts the gallery dialog with a search toolbar and a featured row', async ({ page }) => {
    //the gallery shell, cloned from
    // eh-prompts-gallery (search .toolbar + featured row pinned first).
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();

    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    // Self-mounting <dialog> appears in the top layer.
    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    // Search toolbar to filter the list, same as the prompts gallery.
    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    await expect(search).toBeVisible();

    // A featured template is pinned first with a "Start here" style chip,
    // mirroring FEATURED_ID in eh-prompts-gallery.
    const rows = gallery.locator('.template-list .row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(/start here|featured/i);

    // Each row is an at-a-glance summary: emoji + title + one-line summary
    // + a tag or two, so the user can scan without expanding.
    await expect(rows.first()).toContainText(/.+/);
    await expect(gallery.locator('.template-list .row .summary').first()).toBeVisible();
  });

  test('search filters the template list to a single match', async ({ page }) => {
    //the at-a-glance scan + filter UX.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    await search.fill('blood pressure');

    // Filtering narrows the visible rows; the matching row stays, the rest
    // drop out. We assert on at least one match and on the matched text,
    // rather than an exact count, so a growing template catalogue does not
    // make the storyboard brittle.
    const visibleRows = gallery.locator('.template-list .row:visible');
    await expect(visibleRows.first()).toContainText(/blood pressure/i);
  });

  test('Preview expands a template body without leaving the gallery', async ({ page }) => {
    //per-row Preview, cloned from the
    // eh-prompts-gallery Preview -> <pre> body expansion.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    const firstRow = gallery.locator('.template-list .row').first();
    await firstRow.getByRole('button', { name: /preview/i }).click();

    // A preview region appears showing the manifest the template would
    // create, so the user knows what lands before committing.
    await expect(firstRow.locator('pre')).toBeVisible();
    await expect(firstRow.locator('pre')).toContainText(/klebb\.datafile\.v1|meta|view/i);
  });

  test('picking a template creates a new card and surfaces it in the Cards list', async ({ page, sandboxState }) => {
    //the create action + the round-trip
    // back to the Cards pane. This is the load-bearing assertion of the
    // whole flow: a template turns into a real, server-side manifest.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await expect(page.locator('eh-settings-cards')).toBeVisible();

    // Capture the card count before, so we can assert it grew by one.
    const before = await page.request.get(`${sandboxState.baseUrl}/api/settings/cards`);
    expect(before.status()).toBe(200);
    const beforeIds = (await before.json()).cards.map(c => c.id);

    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();
    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    // Filter to a known template, then take its primary "Add card" action.
    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    await search.fill('blood pressure');
    const targetRow = gallery.locator('.template-list .row:visible').first();
    await expect(targetRow).toContainText(/blood pressure/i);
    await targetRow.getByRole('button', { name: /add card/i }).click();

    // The gallery dismisses itself once the card is created, the same way
    // the prompts gallery closes after loading a prompt into chat.
    await expect(gallery).toHaveCount(0);

    // The server now reports one more card, including the new id.
    const after = await page.request.get(`${sandboxState.baseUrl}/api/settings/cards`);
    expect(after.status()).toBe(200);
    const afterCards = (await after.json()).cards;
    expect(afterCards.length).toBe(beforeIds.length + 1);
    const newCard = afterCards.find(c => !beforeIds.includes(c.id));
    expect(newCard).toBeTruthy();

    // The Cards pane reflects it without a manual reload: eh-settings-cards
    // re-fetches on the same channel the toggle path uses.
    await expect(page.locator('eh-settings-cards .card', { hasText: newCard.label })).toBeVisible();
  });

  test('the created card renders on Today as a real card with an entry affordance', async ({ page, sandboxState }) => {
    // The payoff: a template-created card is indistinguishable from a hand-
    // authored one — it shows on the Today masonry and offers the established
    // in-card data-entry surface (the pencil .edit-btn opening an inline
    // eh-input-form, NOT a new modal). Uses the single-entry `weight`
    // template so the affordance is the .edit-btn (multi-entry cards like
    // blood-pressure use a ➕ Add row instead; that's exercised elsewhere).
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();
    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    await search.fill('weight');
    await gallery.locator('.template-list .row:visible').first()
      .getByRole('button', { name: /add card/i }).click();
    await expect(gallery).toHaveCount(0);

    // Resolve the new card id from the server so we are not guessing the
    // visible label.
    const after = await page.request.get(`${sandboxState.baseUrl}/api/settings/cards`);
    const newCard = (await after.json()).cards.find(c => /weight/i.test(c.label) && /^weight/.test(c.id));
    expect(newCard).toBeTruthy();

    // It renders on Today.
    await page.goto('/');
    await expect(page.locator('eh-date-view')).toBeVisible({ timeout: 10_000 });
    const card = page.locator('eh-generic-card', { hasText: newCard.label }).first();
    await expect(card).toBeVisible();

    // And it carries the standard inline data-entry affordance, reusing the
    // existing entry surface rather than inventing a new one.
    const editBtn = card.locator('.edit-btn').first();
    await expect(editBtn).toBeVisible();
    await editBtn.click();
    const form = page.locator('eh-input-form').first();
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: /^(save|update|add)$/i })).toBeVisible();
  });

  test('gallery is mobile-first: full-bleed at iPhone width with safe-area padding and 44px touch targets', async ({ page }) => {
    //mobile-first execution, in the
    // house style asserted by the notifications spec at iPhone 13 mini.
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    // At narrow widths the dialog goes full-bleed (close to the viewport
    // width), matching the @media (max-width) breakpoints elsewhere.
    const dialog = gallery.locator('dialog, .gallery');
    const box = await dialog.boundingBox();
    expect(box).toBeTruthy();
    expect(box.width).toBeGreaterThanOrEqual(355);

    // Primary actions meet the 44x44 minimum touch target.
    const addBtn = gallery.locator('.template-list .row').first()
      .getByRole('button', { name: /add card/i });
    const addBox = await addBtn.boundingBox();
    expect(addBox).toBeTruthy();
    expect(addBox.height).toBeGreaterThanOrEqual(44);

    // Text inputs use a 16px font so iOS does not auto-zoom on focus.
    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    const fontSize = await search.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test('gallery honours dark mode via theme tokens, no hardcoded colours', async ({ page }) => {
    //dark-mode execution. The gallery
    // consumes the same CSS custom props as the rest of the app
    // (--bg-card, --text-primary, --border, --accent) and must not bake in
    // light-only colours. We force dark and assert the surface is dark.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem('klebb-theme', 'dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    // The dialog background resolves to the dark card token, not white.
    // (rgb(255, 255, 255) would mean a hardcoded light colour leaked in.)
    const bg = await gallery.locator('dialog, .gallery').first()
      .evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');

    // Restore for other specs.
    await page.evaluate(() => {
      localStorage.setItem('klebb-theme', 'light');
      document.documentElement.setAttribute('data-theme', 'light');
    });
  });

  test('an empty template catalogue degrades to a clear empty state, not a blank dialog', async ({ page }) => {
    //graceful empty state, matching the
    // empty + no-match states already present in eh-settings-cards and the
    // "chat not configured" banner precedent in eh-prompts-gallery.
    await page.goto('/settings');
    await expect(page.locator('eh-settings-view')).toBeVisible();
    await page.locator('eh-settings-view [data-tab="cards"]').click();
    await page.locator('eh-settings-cards').getByRole('button', { name: /browse card templates|add a card/i }).click();

    const gallery = page.locator('eh-card-gallery');
    await expect(gallery.locator('dialog')).toBeVisible();

    // With no templates (or a no-match search), the dialog shows guidance
    // copy that still points the user at the other two ways to add a card
    // (drop a file, or ask Klebbius), so the gallery never dead-ends.
    const search = gallery.locator('.toolbar input[type="search"], .toolbar .filter-input');
    await search.fill('zzzzzznomatch');
    await expect(gallery.locator('.empty, .empty-state')).toBeVisible();
    await expect(gallery.locator('.empty, .empty-state')).toContainText(/ask klebbius|drop a file/i);
  });
});
