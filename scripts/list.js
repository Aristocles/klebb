#!/usr/bin/env node
// scripts/list.js — list registered users + pending invites
// Usage: node scripts/list.js

const fs = require('fs');
const PATHS = require('../config/paths');
const invites = require('../auth/invites');

function ageDays(iso) {
  const d = new Date(iso).getTime();
  return Math.round((Date.now() - d) / 86400000 * 10) / 10;
}

function isoLocal(iso) {
  try {
    return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  } catch { return iso; }
}

// Credentials
let creds = { users: {} };
try { creds = JSON.parse(fs.readFileSync(PATHS.WEBAUTHN_CREDENTIALS_FILE, 'utf8')); } catch {}

console.log('');
console.log('=== Registered credentials ===');
const users = Object.keys(creds.users || {});
if (users.length === 0) {
  console.log('  (none)');
} else {
  for (const u of users) {
    const list = creds.users[u].credentials || [];
    console.log(`  ${u}: ${list.length} credential(s)`);
    list.forEach((c, i) => {
      const when = c.registeredAt ? ` ${ageDays(c.registeredAt)}d ago (${isoLocal(c.registeredAt)})` : '';
      console.log(`    [${i}] ${c.deviceType || 'unknown'}${when}`);
    });
  }
}

console.log('');
console.log('=== Active sessions ===');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(PATHS.WEBAUTHN_SESSIONS_FILE, 'utf8')); } catch {}
const sKeys = Object.keys(sessions);
if (sKeys.length === 0) {
  console.log('  (none)');
} else {
  for (const k of sKeys) {
    const s = sessions[k];
    const when = s.created ? `${ageDays(new Date(s.created).toISOString())}d old` : '?';
    console.log(`  ${k.slice(0, 8)}…  user=${s.userId || '?'}  ${when}`);
  }
}

console.log('');
console.log('=== Invites ===');
const pending = invites.listInvites();
if (pending.length === 0) {
  console.log('  (none)');
} else {
  for (const inv of pending) {
    const status = inv.used ? '[USED]' : (new Date(inv.expiresAt) < new Date() ? '[EXPIRED]' : '[ACTIVE]');
    console.log(`  ${status.padEnd(11)} ${inv.code}  label=${inv.label}  expires ${isoLocal(inv.expiresAt)}`);
  }
}
console.log('');
