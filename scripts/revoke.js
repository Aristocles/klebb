#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/revoke.js — revoke a user's credentials
// Usage: node scripts/revoke.js --label alice

const fs = require('fs');
const PATHS = require('../config/paths');
const webauthn = require('../auth/webauthn');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--label') args.label = argv[++i];
    else if (k === '--help' || k === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: npm run revoke -- --label <name>

Removes all passkey credentials registered under <name>, and invalidates
any active sessions for that user. The user will need a new invite to
register again.

Options:
  --label   required; person/device label
  --help    show this help`);
}

const args = parseArgs(process.argv);
if (args.help || !args.label) { usage(); process.exit(args.help ? 0 : 1); }

// Remove credentials
let credsRemoved = 0;
try {
  if (fs.existsSync(PATHS.WEBAUTHN_CREDENTIALS_FILE)) {
    const creds = webauthn.loadCredentials();
    if (creds.users && creds.users[args.label]) {
      const inLabel = (creds.users[args.label].credentials || []).length;
      // Guard: refuse to empty the store. isSetup() flips to false when no
      // credentials remain, re-opening the instance to bootstrap registration
      // by any visitor. Revoking the last label would lock the instance open.
      if (inLabel > 0 && webauthn.countCredentials(creds) - inLabel === 0) {
        console.error(
          `Refusing to revoke "${args.label}": it holds the only remaining ` +
          `credential(s). Emptying the store would re-open the instance to ` +
          `bootstrap registration. Register another passkey first, or delete ` +
          `${PATHS.WEBAUTHN_CREDENTIALS_FILE} by hand to intentionally reset.`
        );
        process.exit(3);
      }
      credsRemoved = inLabel;
      delete creds.users[args.label];
      webauthn.saveCredentials(creds);
    }
  }
} catch (e) {
  console.error('Could not read credentials file:', e.message);
  process.exit(2);
}

// Invalidate sessions belonging to this user
let sessionsKilled = 0;
try {
  if (fs.existsSync(PATHS.WEBAUTHN_SESSIONS_FILE)) {
    const raw = fs.readFileSync(PATHS.WEBAUTHN_SESSIONS_FILE, 'utf8');
    const sessions = JSON.parse(raw);
    for (const token of Object.keys(sessions)) {
      if (sessions[token].userId === args.label) {
        delete sessions[token];
        sessionsKilled++;
      }
    }
    fs.writeFileSync(PATHS.WEBAUTHN_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  }
} catch {}

console.log('');
console.log(`Revoked "${args.label}":`);
console.log(`  Credentials removed: ${credsRemoved}`);
console.log(`  Sessions invalidated: ${sessionsKilled}`);
console.log('');
if (credsRemoved === 0) console.log('Note: no credentials were found under that label.');
