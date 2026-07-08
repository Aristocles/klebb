// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/origin-check.js
//
// Origin allowlist predicate for state-changing endpoints. SameSite=Lax
// cookies do not block cross-fetch from same-eTLD+1 subdomains, so a
// sibling subdomain could otherwise POST under a rider session cookie.
// Requests with no Origin header (curl, server-to-server) are allowed:
// they can't have ridden a CSRF.

const ENV = require('../config/env');

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === ENV.WEBAUTHN_ORIGIN;
}

module.exports = { originAllowed };
