#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/migrate-credential-fields.js
//
// Backfills per-credential `nickname` and `lastUsedAt` on the WebAuthn
// credential store so the passkey-management UI has fields to show.
//
// For each credential:
//   - nickname   -> null if absent (user sets it later; UI falls back to deviceType)
//   - lastUsedAt -> registeredAt if absent (best available signal pre-migration)
//
// Idempotent: a credential that already has both fields is left untouched.
// Takes a timestamped backup of the store before writing (Rule 7).
//
// Usage:
//   node scripts/migrate-credential-fields.js [--dry-run]
//
// Operates on $HEALTH_HOME's resolved credentials file (config/paths.js).

const fs = require('fs');
const PATHS = require('../config/paths');

function parseArgs(argv) {
  const args = { dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: migrate-credential-fields.js [--dry-run]

Backfills nickname (null) and lastUsedAt (from registeredAt) on stored
passkey credentials. Idempotent; backs up the store before writing.

Options:
  --dry-run   Report what would change; write nothing
  --help      Show this message`);
}

// Pure transform. Returns { data, changed } where changed counts credentials
// that gained a field. Does not mutate the input.
function backfill(store) {
  let changed = 0;
  const users = {};
  for (const [userId, entry] of Object.entries((store && store.users) || {})) {
    const credentials = (entry.credentials || []).map(c => {
      const next = { ...c };
      let touched = false;
      if (!('nickname' in next)) { next.nickname = null; touched = true; }
      if (!next.lastUsedAt) { next.lastUsedAt = next.registeredAt || null; touched = true; }
      if (touched) changed++;
      return next;
    });
    users[userId] = { ...entry, credentials };
  }
  return { data: { ...store, users }, changed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }

  const file = PATHS.WEBAUTHN_CREDENTIALS_FILE;
  if (!fs.existsSync(file)) {
    console.log(`No credential store at ${file}; nothing to migrate.`);
    return 0;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not read/parse ${file}: ${e.message}`);
    return 2;
  }

  const { data, changed } = backfill(store);

  if (changed === 0) {
    console.log('All credentials already have nickname + lastUsedAt; nothing to do.');
    return 0;
  }

  if (args.dryRun) {
    console.log(`Would backfill ${changed} credential(s) in ${file} (dry-run).`);
    return 0;
  }

  // Backup first (Rule 7). Timestamp via file mtime avoids Date.now in tests.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);

  console.log(`Backfilled ${changed} credential(s).`);
  console.log(`Backup written to ${backup}`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
} else {
  module.exports = { backfill };
}
