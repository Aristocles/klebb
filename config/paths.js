// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// config/paths.js
// Central path + env resolution for Klebb.
// All other modules must import paths from here — no hardcoded absolute paths elsewhere.
//
// Precedence:
//   1. HEALTH_HOME env var (required for production deployments)
//   2. $HOME/klebb (sensible default for local-dev)
//
// Individual paths can also be overridden directly if set:
//   HEALTH_DATA_DIR, HEALTH_REPORTS_DIR, HEALTH_AUTO_EXPORT_DIR,
//   HEALTH_SESSIONS_DIR, HEALTH_CREDENTIALS_DIR, HEALTH_ARCHIVE_DIR, HEALTH_CONFIG_PATH

const path = require('path');
const fs = require('fs');
const os = require('os');

function resolveHealthHome() {
  if (process.env.HEALTH_HOME && process.env.HEALTH_HOME.trim()) {
    return path.resolve(process.env.HEALTH_HOME);
  }
  const fallback = path.join(os.homedir(), 'klebb');
  if (!process.env.HEALTH_HOME_WARNED) {
    console.warn('[paths] HEALTH_HOME not set; defaulting to', fallback);
    console.warn('[paths] Set HEALTH_HOME in the environment to customise.');
    process.env.HEALTH_HOME_WARNED = '1';
  }
  return fallback;
}

const HEALTH_HOME = resolveHealthHome();

// Standard layout:
//   $HEALTH_HOME/data/           — card manifest files
//   $HEALTH_HOME/reports/        — markdown reports
//   $HEALTH_HOME/sessions/       — WebAuthn sessions
//   $HEALTH_HOME/credentials/    — WebAuthn credentials
//   $HEALTH_HOME/data/_archive/  — reserved, not scanned
//   $HEALTH_HOME/data/auto-export/  — HealthAutoExport dumps
//   $HEALTH_HOME/config.json     — instance config

const DATA_DIR = process.env.HEALTH_DATA_DIR || path.join(HEALTH_HOME, 'data');

// Reports dir resolution, in priority order:
//   1. HEALTH_REPORTS_DIR env var (explicit override)
//   2. $HEALTH_HOME/reports/ (canonical location)
//   3. $HEALTH_HOME/data/reports/ (alt location)
//   4. $HEALTH_HOME/ (last resort — flat layout)
function resolveReportsDir() {
  if (process.env.HEALTH_REPORTS_DIR) return process.env.HEALTH_REPORTS_DIR;
  const canonical = path.join(HEALTH_HOME, 'reports');
  if (fs.existsSync(canonical)) return canonical;
  const under = path.join(DATA_DIR, 'reports');
  if (fs.existsSync(under)) return under;
  return HEALTH_HOME;
}
const REPORTS_DIR = resolveReportsDir();

const AUTO_EXPORT_DIR = process.env.HEALTH_AUTO_EXPORT_DIR || path.join(DATA_DIR, 'auto-export');
const SESSIONS_DIR = process.env.HEALTH_SESSIONS_DIR || path.join(HEALTH_HOME, 'sessions');
const CREDENTIALS_DIR = process.env.HEALTH_CREDENTIALS_DIR || path.join(HEALTH_HOME, 'credentials');
const ARCHIVE_DIR = process.env.HEALTH_ARCHIVE_DIR || path.join(DATA_DIR, '_archive');
const CHAT_DIR = process.env.HEALTH_CHAT_DIR || path.join(HEALTH_HOME, 'chat');
const CHAT_HISTORY_FILE = path.join(CHAT_DIR, 'history.json');
const CONFIG_PATH = process.env.HEALTH_CONFIG_PATH || path.join(HEALTH_HOME, 'config.json');

// WebAuthn credentials + sessions. Historical installs may have stored these
// inside DATA_DIR as `webauthn-credentials.json` / `webauthn-sessions.json`;
// prefer those if found, otherwise use the modern subdir layout.
function resolveWebauthnCredentialsFile() {
  const legacy = path.join(DATA_DIR, 'webauthn-credentials.json');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(CREDENTIALS_DIR, 'webauthn.json');
}

function resolveWebauthnSessionsFile() {
  const legacy = path.join(DATA_DIR, 'webauthn-sessions.json');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(SESSIONS_DIR, 'webauthn.json');
}

const WEBAUTHN_CREDENTIALS_FILE = resolveWebauthnCredentialsFile();
const WEBAUTHN_SESSIONS_FILE = resolveWebauthnSessionsFile();

// Ensure directories exist where we expect to write.
// Does NOT create HEALTH_HOME itself (bootstrap responsibility).
function ensureWritableDirs() {
  const toEnsure = [DATA_DIR, CHAT_DIR];
  if (WEBAUTHN_CREDENTIALS_FILE.startsWith(CREDENTIALS_DIR)) toEnsure.push(CREDENTIALS_DIR);
  if (WEBAUTHN_SESSIONS_FILE.startsWith(SESSIONS_DIR)) toEnsure.push(SESSIONS_DIR);
  for (const dir of toEnsure) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

module.exports = {
  HEALTH_HOME,
  DATA_DIR,
  REPORTS_DIR,
  AUTO_EXPORT_DIR,
  SESSIONS_DIR,
  CREDENTIALS_DIR,
  ARCHIVE_DIR,
  CHAT_DIR,
  CHAT_HISTORY_FILE,
  CONFIG_PATH,
  WEBAUTHN_CREDENTIALS_FILE,
  WEBAUTHN_SESSIONS_FILE,
  ensureWritableDirs,
};
