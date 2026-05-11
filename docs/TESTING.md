# Testing

Klebb has three test layers, each with a different job. Write your tests
in the right layer; don't try to cover a UI concern from a lib test or
a backend bug from an E2E spec.

## Layers

### 1. Unit / library tests — `tests/*.test.js`

Node's built-in `node:test` runner. Fast, no HTTP, no browser. For pure
logic: manifest parsing, display-template evaluation, date-range
resolution, schedule expansion, merge-patch behaviour.

- Run: `npm test`
- Harness: plain `require()` of the module under test.
- Target: code under `config/`, `manifests/`, `server/`, `chat/`, `auth/`,
  `health-auto-export/`.

### 2. API integration tests — `tests/*.test.js` + `tests/api/*.test.js`

Same runner, but spin up a real klebb server against an ephemeral
`HEALTH_HOME` and exercise the HTTP API. These catch data-layer
regressions without needing a browser.

- Run: `npm test` (same command).
- Harness: `tests/helpers/sandbox.js`.
- Helpers: `createSandbox`, `spawnServer`, `req`, `fakeAuthState`.
- Target: any API route; manifest write / patch behaviour; HAE ingest;
  auth-gated flows.

Put broad API-surface tests in `tests/`. Put **per-bug regression
tests** in `tests/api/` — one file per issue, named after the bug
(`mood-edit-single-date.test.js`, `hae-ingest-fp-rounding.test.js`,
etc.). When a fix lands, un-skip the test; when a new bug is
reported, add a failing-then-passing seed here so the fix is
locked in by CI.

Write an API test when the bug's symptom is observable without a
browser. Example: "HAE ingest leaks IEEE754 tails" — the proof is
in the manifest file after the push. Don't need a UI.

### 3. End-to-end tests — `tests-e2e/*.spec.js`

Playwright against a real Chromium instance, driven against the same
sandbox harness. Slower, but the only layer that catches user-visible
interaction bugs.

- Run: `npm run test:e2e` (headless).
- Watch along: `npm run test:e2e:headed` (opens a visible browser).
- Debug a single spec: `npm run test:e2e:debug` (Playwright inspector).
- Harness: `tests-e2e/helpers/global-setup.js` boots the sandbox once
  per run; `tests-e2e/helpers/auth-fixture.js` injects the session
  cookie on every new page.

Write an E2E test when the bug's symptom depends on rendering,
navigation, form interaction, or chat-widget state. Example: "edit
pencil doesn't appear on past mood entries" — the check is whether a
DOM element is visible.

## Rubric: which layer?

- Bug is about manifest shape, template evaluation, date maths,
  pure computation → **layer 1**.
- Bug is about what the server returns, what gets written to disk,
  or what happens on a round-trip PATCH → **layer 2**.
- Bug is about what the user sees, clicks, or interacts with → **layer 3**.

If two layers apply, pick the cheapest one that reliably proves the
fix. A Playwright test is rarely the right choice when an API test
would do.

## Writing an E2E test

Use the `test` + `expect` from `tests-e2e/helpers/auth-fixture.js`,
not directly from `@playwright/test`:

```js
const { test, expect } = require('./helpers/auth-fixture');

test('my scenario', async ({ page, sandboxState }) => {
  await page.goto('/');
  await expect(page.locator('eh-generic-card', { hasText: 'Weight' })).toBeVisible();
});
```

The fixture gives you:
- a `page` already pointed at the sandbox (`page.goto('/')` resolves
  against the sandbox URL).
- a valid session cookie set on `context`, so auth-gated routes work.
- `sandboxState`, an object with `baseUrl`, `sessionToken`,
  `sessionCookie`, and `sandbox` (the temp `HEALTH_HOME` path).

### Seeding extra manifests

The default seed lives in `tests-e2e/helpers/seed-manifests.js` and is
intentionally minimal (one weight, one mood). For a spec that needs
richer fixtures, write to the sandbox via the API or directly to the
`sandboxState.sandbox` directory in `test.beforeAll`.

### Selectors

Prefer Lit custom-element selectors (`eh-generic-card`, `eh-schedule-card`,
`eh-date-view`, etc.) over CSS classes. They're stable across styling
changes. Pair with `hasText` to disambiguate:

```js
page.locator('eh-generic-card', { hasText: 'Weight' })
```

### Running headed for debugging

```
npm run test:e2e:headed
```

Opens Chromium, runs the specs with a real window. Actions run with a
400ms slow-mo in headed mode so you can actually see what's happening.

To hold the browser open at the end of each spec for manual
inspection, set `KLEBB_E2E_PAUSE=1`:

```
KLEBB_E2E_PAUSE=1 npm run test:e2e:headed         # bash / zsh
$env:KLEBB_E2E_PAUSE="1"; npm run test:e2e:headed # PowerShell
```

The spec will pause at the end, pop open Playwright's inspector,
and wait for you to close it manually.

You can also drop `await page.pause()` anywhere inside a spec to
freeze at that step and poke around the DOM.

## CI

GitHub Actions runs all three layers on every PR:

- `test` workflow runs `npm test` on Node 20 and 22.
- `e2e` workflow runs `npm run test:e2e` on Node 22 with Chromium.
  On failure, uploads screenshots, traces, and the HTML report as
  build artefacts.

## PR expectations

Every non-trivial PR should include regression coverage at the right
layer. If you're fixing a bug, write the test that proves the fix
first (fails on current `main`, passes with the fix). If you're
adding a feature, cover the happy path + one edge case.

If a change legitimately doesn't need a new test, say so in the PR
body. "No new tests because this is a pure doc change" is fine. "No
new tests because I ran it locally" is not.
