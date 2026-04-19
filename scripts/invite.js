#!/usr/bin/env node
// scripts/invite.js — issue an invite code
// Usage: node scripts/invite.js --label chuck [--expires-days 3]

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
  --label          required; person/device label (e.g. "chuck", "phone")
  --expires-days   default 3; how long the invite is valid
  --help, -h       show this help

Example:
  npm run invite -- --label chuck
  npm run invite -- --label laptop --expires-days 7`);
}

const args = parseArgs(process.argv);
if (args.help || !args.label) { usage(); process.exit(args.help ? 0 : 1); }

const invite = invites.createInvite({ label: args.label, expiresInDays: args.expiresInDays || 3 });

// Work out the registration URL
const origin = process.env.HEALTH_ORIGIN || ENV.WEBAUTHN_ORIGIN || 'https://eddzhealth.axis.vorignet.com';

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
