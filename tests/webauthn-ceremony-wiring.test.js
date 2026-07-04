// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/webauthn-ceremony-wiring.test.js
// The ceremony module is browser-only (esm.sh import + navigator.credentials),
// so it can't be required in Node and e2e injects a session cookie rather than
// running the ceremony. This wiring test guards the #470 extraction: the module
// exposes the expected ceremonies against the right endpoints, and setup.html /
// login.html consume it instead of re-implementing the flow inline.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MODULE = path.join(PUBLIC, 'js', 'lib', 'webauthn-ceremony.js');
const SETUP = path.join(PUBLIC, 'setup.html');
const LOGIN = path.join(PUBLIC, 'login.html');

const read = f => fs.readFileSync(f, 'utf8');

describe('#470 webauthn-ceremony module', () => {
  const src = read(MODULE);

  test('exports the three ceremony helpers', () => {
    assert.match(src, /export async function registerCredential/);
    assert.match(src, /export async function authenticate/);
    assert.match(src, /export async function checkRegisterAvailable/);
  });

  test('registration hits options then verify', () => {
    assert.match(src, /\/auth\/register\/options/);
    assert.match(src, /\/auth\/register\/verify/);
  });

  test('authentication hits options then verify', () => {
    assert.match(src, /\/auth\/login\/options/);
    assert.match(src, /\/auth\/login\/verify/);
  });

  test('forwards the nickname to verify (wiring for the Security pane)', () => {
    assert.match(src, /nickname/);
  });

  test('uses the simplewebauthn browser helpers for the authenticator step', () => {
    assert.match(src, /startRegistration/);
    assert.match(src, /startAuthentication/);
  });
});

describe('#470 setup.html consumes the module', () => {
  const html = read(SETUP);

  test('imports registerCredential + checkRegisterAvailable from the module', () => {
    assert.match(html, /import\s*\{[^}]*registerCredential[^}]*\}\s*from\s*['"]\/js\/lib\/webauthn-ceremony\.js['"]/);
  });

  test('no longer imports the raw ceremony library directly', () => {
    assert.doesNotMatch(html, /@simplewebauthn\/browser/);
    assert.doesNotMatch(html, /startRegistration/);
  });
});

describe('#470 login.html consumes the module', () => {
  const html = read(LOGIN);

  test('imports authenticate from the module', () => {
    assert.match(html, /import\s*\{[^}]*authenticate[^}]*\}\s*from\s*['"]\/js\/lib\/webauthn-ceremony\.js['"]/);
  });

  test('no longer imports the raw ceremony library directly', () => {
    assert.doesNotMatch(html, /@simplewebauthn\/browser/);
    assert.doesNotMatch(html, /startAuthentication/);
  });

  test('demo-login path is preserved (not part of the ceremony extraction)', () => {
    assert.match(html, /\/auth\/demo-login/);
  });
});
