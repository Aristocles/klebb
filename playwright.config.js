// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// playwright.config.js
// Playwright harness for Klebb's E2E suite. Boots an ephemeral
// HEALTH_HOME + server per run via tests-e2e/global-setup.js and tears
// it down via global-teardown.js. No CI-only branching here — run the
// same config locally and in CI; use CLI flags (--headed) for the
// watch-along workflow.

const { defineConfig, devices } = require('@playwright/test');

const IS_CI = !!process.env.CI;

module.exports = defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: 1,
  reporter: IS_CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  globalSetup: require.resolve('./tests-e2e/helpers/global-setup.js'),

  use: {
    // baseURL is injected per-test by the auth-fixture (reads the sandbox
    // URL from tests-e2e/.state/state.json, which globalSetup writes).
    trace: IS_CI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: IS_CI ? 'retain-on-failure' : 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // When running headed (watch-along), slow every action so the
          // operator can actually see what happened. Headless runs and CI
          // are unaffected.
          slowMo: process.env.PWHEADED || process.argv.includes('--headed') ? 400 : 0,
        },
      },
    },
  ],
});
