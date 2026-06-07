#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/invite.js — issue an invite code
// Usage: node scripts/invite.js --label alice [--expires-days 3]

const invites = require('../auth/invites');
const ENV = require('../config/env');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--label') args.label = argv[++i];
    else if (k === '--expires-days') args.expiresInDays = parseInt(argv[++i], 10);
    else if (k === '--help' || k === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: npm run invite -- --label <name> [--expires-days N]

Issues a single-use invite code for passkey registration.

Options:
  --label          required; person/device label (e.g. "alice", "phone")
  --expires-days   default 3; how long the invite is valid
  --help, -h       show this help

Example:
  npm run invite -- --label alice
  npm run invite -- --label laptop --expires-days 7`);
}

const args = parseArgs(process.argv);
if (args.help || !args.label) { usage(); process.exit(args.help ? 0 : 1); }

const invite = invites.createInvite({ label: args.label, expiresInDays: args.expiresInDays || 3 });

// Warn loudly if the resulting config.json is owned by a uid/gid that
// differs from the running process. This catches the Docker footgun where
// `docker exec <container> node scripts/invite.js` runs as root and writes
// /data/config.json as 0600 root:root, leaving the long-running klebb
// server (UID 1001) unable to read it. See issue #301.
try {
  const fs = require('fs');
  const PATHS = require('../config/paths');
  if (typeof process.getuid === 'function') {
    const st = fs.statSync(PATHS.CONFIG_PATH);
    const puid = process.getuid();
    const pgid = typeof process.getgid === 'function' ? process.getgid() : null;
    if (st.uid !== puid || (pgid !== null && st.gid !== pgid)) {
      process.stderr.write(
        `[invite] WARNING: ${PATHS.CONFIG_PATH} is owned by ${st.uid}:${st.gid} but ` +
        `this process runs as ${puid}:${pgid}. The webapp likely runs as a ` +
        `different user and may not be able to read the file. ` +
        `Run \`chown <webapp-user> ${PATHS.CONFIG_PATH}\` from the host.\n`
      );
    }
  }
} catch {}

// Work out the registration URL
const origin = process.env.HEALTH_ORIGIN || ENV.WEBAUTHN_ORIGIN || 'https://localhost:8080';

console.log('');
console.log(`Invite created for "${invite.label}":`);
console.log('');
console.log(`  Code:       ${invite.code}`);
console.log(`  Label:      ${invite.label}`);
console.log(`  Expires:    ${invite.expiresAt}`);
console.log('');
console.log(`  URL:        ${origin}/register?code=${invite.code}`);
console.log('');
console.log('Share the URL with the user. Single-use; consumed on first successful registration.');
