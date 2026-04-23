#!/usr/bin/env node
// scripts/revoke.js — revoke a user's credentials
// Usage: node scripts/revoke.js --label alice

const fs = require('fs');
const PATHS = require('../config/paths');

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
    const raw = fs.readFileSync(PATHS.WEBAUTHN_CREDENTIALS_FILE, 'utf8');
    const creds = JSON.parse(raw);
    if (creds.users && creds.users[args.label]) {
      credsRemoved = (creds.users[args.label].credentials || []).length;
      delete creds.users[args.label];
      fs.writeFileSync(PATHS.WEBAUTHN_CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
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
