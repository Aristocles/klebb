# CI

Klebb uses GitHub Actions for continuous integration.

## What runs

Every push to `main` / `master` / `v2-redesign` and every pull request
triggers `.github/workflows/test.yml`, which:

1. Checks out the code
2. Sets up Node.js (matrix: 20 + 22)
3. Runs `npm ci`
4. Runs `npm test`

If any test fails on any Node version, the workflow reports failure.
PRs with failing CI should not be merged.

Timeout: 5 minutes. The full test suite runs in ~3 seconds so this is
generous head-room.

## Reproducing locally

```bash
nvm use 20    # or 22
npm ci
npm test
```

Any Node 20+ install will do. No database, no external services needed.

## Adding new tests

Place new test files in `tests/*.test.js`. The runner picks them up
automatically via the glob in `package.json`'s `test` script.

Follow the existing patterns:
- Use `createSandbox()` / `cleanupSandbox()` from `tests/helpers/sandbox.js`
  for anything that needs a `$HEALTH_HOME` on disk
- Use `spawnServer()` for integration tests that need the HTTP server
- Use `fakeAuthState()` to simulate a registered WebAuthn user
- Keep tests deterministic — avoid wall-clock timing, external network
  calls, etc.

## Safety-net test

`tests/no-personal-refs.test.js` scans the repo for forbidden identifiers
and hardcoded paths. This is a hygiene check that runs in CI alongside
functional tests. If a PR re-introduces a personal name or an absolute
machine path or a high-entropy token, CI fails.

The forbidden-pattern list is defined in the test file. To add a new
pattern, edit `tests/no-personal-refs.test.js`.

## What isn't covered by CI

- WebAuthn registration/verification (requires browser crypto)
- The chat proxy (requires mocking OpenClaw upstream)
- Fish Audio voice endpoints (require real API calls)
- Rate limiting (timing-dependent; manual check only)
- Actual rendering of Lit components (DOM-required)

These are documented as known gaps in the Phase 3 commit message.
Deploy smoke-test + manual QA cover them in practice.
