// config/paths.js
// Central path + env resolution for EddzHealth.
// All other modules must import paths from here — no hardcoded absolute paths elsewhere.
//
// Precedence:
//   1. HEALTH_HOME env var (explicit, modern deployment)
//   2. Legacy hardcoded path at ~/axis/workspace/.private/health (Eddy's existing instance)
//      — logs a deprecation warning; still works
//
// Individual paths can also be overridden directly if set:
//   HEALTH_DATA_DIR, HEALTH_REPORTS_DIR, HEALTH_AUTO_EXPORT_DIR,
//   HEALTH_SESSIONS_DIR, HEALTH_CREDENTIALS_DIR, HEALTH_ARCHIVE_DIR, HEALTH_CONFIG_PATH

const path = require('path');
const fs = require('fs');
const os = require('os');

const LEGACY_DEFAULT = path.join(os.homedir(), 'axis/workspace/.private/health');

function resolveHealthHome() {
  if (process.env.HEALTH_HOME && process.env.HEALTH_HOME.trim()) {
    return path.resolve(process.env.HEALTH_HOME);
  }
  // Backward-compat: if legacy path exists, use it with a warning
  if (fs.existsSync(LEGACY_DEFAULT)) {
    if (!process.env.HEALTH_HOME_WARNED) {
      console.warn('[paths] HEALTH_HOME not set; falling back to legacy path:', LEGACY_DEFAULT);
      console.warn('[paths] Set HEALTH_HOME=/path/to/health in systemd env to migrate.');
      process.env.HEALTH_HOME_WARNED = '1';
    }
    return LEGACY_DEFAULT;
  }
  // Otherwise default to $HOME/health
  return path.join(os.homedir(), 'health');
}

const HEALTH_HOME = resolveHealthHome();

// For legacy installs, data dir sits at <home>/data
// For new installs pointing at the new skeleton, same layout applies
const DATA_DIR = process.env.HEALTH_DATA_DIR || path.join(HEALTH_HOME, 'data');

// Reports dir: legacy had reports alongside data/ (at $HEALTH_HOME root).
// New layout moves them under data/reports for true encapsulation.
// Fall back to $HEALTH_HOME for legacy compatibility (where DEBRIEF-*.md lived).
function resolveReportsDir() {
  if (process.env.HEALTH_REPORTS_DIR) return process.env.HEALTH_REPORTS_DIR;
  const modern = path.join(DATA_DIR, 'reports');
  if (fs.existsSync(modern)) return modern;
  // Legacy: markdown reports at $HEALTH_HOME root (e.g. DEBRIEF-2026-03-12.md)
  return HEALTH_HOME;
}
const REPORTS_DIR = resolveReportsDir();

const AUTO_EXPORT_DIR = process.env.HEALTH_AUTO_EXPORT_DIR || path.join(DATA_DIR, 'auto-export');
const SESSIONS_DIR = process.env.HEALTH_SESSIONS_DIR || path.join(HEALTH_HOME, 'sessions');
const CREDENTIALS_DIR = process.env.HEALTH_CREDENTIALS_DIR || path.join(HEALTH_HOME, 'credentials');
const ARCHIVE_DIR = process.env.HEALTH_ARCHIVE_DIR || path.join(DATA_DIR, '_archive');
const CONFIG_PATH = process.env.HEALTH_CONFIG_PATH || path.join(HEALTH_HOME, 'config.json');

// Legacy file locations (still honoured during M1–M6 transition).
// auth/webauthn used to store credentials + sessions in DATA_DIR as:
//   webauthn-credentials.json + webauthn-sessions.json
// We look for those first, fall back to new CREDENTIALS_DIR / SESSIONS_DIR.
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
  const toEnsure = [DATA_DIR];
  // Only create session/credential dirs if we're using the modern locations.
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
  CONFIG_PATH,
  WEBAUTHN_CREDENTIALS_FILE,
  WEBAUTHN_SESSIONS_FILE,
  LEGACY_DEFAULT,
  ensureWritableDirs,
};
