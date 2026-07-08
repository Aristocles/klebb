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
//   $HEALTH_HOME/data/             — card manifest files
//   $HEALTH_HOME/reports/          — markdown reports (rendered + ingested)
//   $HEALTH_HOME/reports/_archive/ — original files filed away after ingest
//   $HEALTH_HOME/inbox/            — drop zone for ingest pipeline
//   $HEALTH_HOME/inbox/_failed/    — files the pipeline could not extract
//   $HEALTH_HOME/sessions/         — WebAuthn sessions
//   $HEALTH_HOME/credentials/      — WebAuthn credentials
//   $HEALTH_HOME/data/_archive/    — reserved, not scanned
//   $HEALTH_HOME/data/auto-export/ — HealthAutoExport dumps
//   $HEALTH_HOME/config.json       — instance config

const DATA_DIR = process.env.HEALTH_DATA_DIR || path.join(HEALTH_HOME, 'data');

// Reports dir resolution, in priority order:
//   1. HEALTH_REPORTS_DIR env var (explicit override)
//   2. $HEALTH_HOME/reports/ (canonical location; always returned for
//      fresh installs so ingest writes and listing reads stay aligned)
//   3. $HEALTH_HOME/data/reports/ (legacy alt location, only if it
//      already exists from an older install)
function resolveReportsDir() {
  if (process.env.HEALTH_REPORTS_DIR) return process.env.HEALTH_REPORTS_DIR;
  const canonical = path.join(HEALTH_HOME, 'reports');
  if (fs.existsSync(canonical)) return canonical;
  const under = path.join(DATA_DIR, 'reports');
  if (fs.existsSync(under)) return under;
  return canonical;
}
const REPORTS_DIR = resolveReportsDir();

// Canonical reports root for new constructs (ingest archive, inbox).
// Independent of the resolveReportsDir() fallback chain — that chain is
// for backwards-compat with old installs that put reports under data/.
// New paths always anchor on $HEALTH_HOME/reports/.
const REPORTS_CANONICAL = path.join(HEALTH_HOME, 'reports');
const REPORTS_ARCHIVE_DIR = path.join(REPORTS_CANONICAL, '_archive');

const INBOX_DIR = process.env.HEALTH_INBOX_DIR || path.join(HEALTH_HOME, 'inbox');
const INBOX_FAILED_DIR = path.join(INBOX_DIR, '_failed');

const AUTO_EXPORT_DIR = process.env.HEALTH_AUTO_EXPORT_DIR || path.join(DATA_DIR, 'auto-export');
const SESSIONS_DIR = process.env.HEALTH_SESSIONS_DIR || path.join(HEALTH_HOME, 'sessions');
const CREDENTIALS_DIR = process.env.HEALTH_CREDENTIALS_DIR || path.join(HEALTH_HOME, 'credentials');
const ARCHIVE_DIR = process.env.HEALTH_ARCHIVE_DIR || path.join(DATA_DIR, '_archive');
const CHAT_DIR = process.env.HEALTH_CHAT_DIR || path.join(HEALTH_HOME, 'chat');
const CHAT_HISTORY_FILE = path.join(CHAT_DIR, 'history.json');
const CONFIG_PATH = process.env.HEALTH_CONFIG_PATH || path.join(HEALTH_HOME, 'config.json');

// Embedded datastore for card data rows. Lives at HEALTH_HOME level so it
// sits outside the fs.watch scope on data/ but inside every backup, export,
// and teardown path that snapshots the instance dir.
const DB_DIR = process.env.HEALTH_DB_DIR || path.join(HEALTH_HOME, 'db');
const DB_FILE = process.env.HEALTH_DB_FILE || path.join(DB_DIR, 'klebb.db');

// Per-instance runtime state for notifications. Decoupled from manifests
// so the per-card meta block stays clean (config) and last-fired / toggle
// state lives in this opaque sidecar (runtime). Created lazily.
const NOTIFICATIONS_STATE_FILE = process.env.HEALTH_NOTIFICATIONS_STATE_FILE
  || path.join(HEALTH_HOME, 'notifications.state.json');

// Per-instance user preferences (timezone today; future: device nicknames).
// Single-user-per-instance, so this is one file - not a per-user store.
const USER_FILE = process.env.HEALTH_USER_FILE
  || path.join(HEALTH_HOME, 'user.json');

// Long-lived asymmetric keys live under their own directory, separate
// from sessions/ - operator backup-rotation policy is fundamentally
// different from session ephemera.
const KEYS_DIR = process.env.HEALTH_KEYS_DIR || path.join(HEALTH_HOME, 'keys');
const VAPID_FILE = process.env.HEALTH_VAPID_FILE || path.join(KEYS_DIR, 'vapid.json');

// Web Push subscriptions for the operator's devices.
const PUSH_SUBSCRIPTIONS_FILE = process.env.HEALTH_PUSH_SUBSCRIPTIONS_FILE
  || path.join(HEALTH_HOME, 'push-subscriptions.json');

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
  const toEnsure = [DATA_DIR, CHAT_DIR, REPORTS_CANONICAL, REPORTS_ARCHIVE_DIR, INBOX_DIR, INBOX_FAILED_DIR];
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
  REPORTS_ARCHIVE_DIR,
  INBOX_DIR,
  INBOX_FAILED_DIR,
  AUTO_EXPORT_DIR,
  DB_DIR,
  DB_FILE,
  SESSIONS_DIR,
  CREDENTIALS_DIR,
  ARCHIVE_DIR,
  CHAT_DIR,
  CHAT_HISTORY_FILE,
  CONFIG_PATH,
  NOTIFICATIONS_STATE_FILE,
  USER_FILE,
  KEYS_DIR,
  VAPID_FILE,
  PUSH_SUBSCRIPTIONS_FILE,
  WEBAUTHN_CREDENTIALS_FILE,
  WEBAUTHN_SESSIONS_FILE,
  ensureWritableDirs,
};
