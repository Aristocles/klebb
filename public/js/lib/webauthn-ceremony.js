// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/webauthn-ceremony.js
//
// The browser-side WebAuthn ceremonies, in one place. Both are a two-step
// dance with the server: POST /options to get a challenge, hand it to the
// platform authenticator (Face ID / Windows Hello / security key) via
// @simplewebauthn/browser, then POST /verify with the signed result. The
// library handles the ArrayBuffer<->base64url conversions the raw WebAuthn
// API needs; we only orchestrate the fetches.
//
// Extracted from setup.html / login.html so the setup page, the login page,
// and the in-app Security settings pane all run the identical flow.

import {
  startRegistration,
  startAuthentication,
} from 'https://esm.sh/@simplewebauthn/browser@13';

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { res, json };
}

// Ask the server whether registration is currently possible and, if so, which
// label it will bind the new credential to. Mirrors GET /auth/register/available.
// Returns the parsed body ({ available, reason, label? }) or a closed stub.
export async function checkRegisterAvailable(code) {
  try {
    const qs = code ? `?code=${encodeURIComponent(code)}` : '';
    const r = await fetch('/auth/register/available' + qs);
    return await r.json();
  } catch {
    return { available: false, reason: 'error' };
  }
}

// Run the registration ceremony. opts: { code?, nickname? }.
// Resolves { verified, label } on success; throws Error(message) otherwise.
// The label is resolved server-side (from the invite, the session, or
// bootstrap) and echoed back via /available so verify can match the pending
// challenge by label.
export async function registerCredential({ code = null, nickname = null } = {}) {
  const { json: options } = await postJSON('/auth/register/options', code ? { code } : {});
  if (!options || options.error) throw new Error((options && options.error) || 'Could not start registration');

  const available = await checkRegisterAvailable(code);
  const label = available.label || '';

  const attestation = await startRegistration({ optionsJSON: options });

  const { json: result } = await postJSON('/auth/register/verify', {
    ...attestation,
    label,
    code,
    nickname,
  });
  if (!result || !result.verified) throw new Error((result && result.error) || 'Registration failed');
  return result;
}

// Run the authentication ceremony. Resolves { verified, label } on success;
// throws Error(message) otherwise.
export async function authenticate() {
  const { json: options } = await postJSON('/auth/login/options', {});
  if (!options || options.error) throw new Error((options && options.error) || 'Could not start sign-in');

  const assertion = await startAuthentication({ optionsJSON: options });

  const { json: result } = await postJSON('/auth/login/verify', assertion);
  if (!result || !result.verified) throw new Error((result && result.error) || 'Sign-in failed');
  return result;
}
