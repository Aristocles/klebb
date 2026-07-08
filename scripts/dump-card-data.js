#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/dump-card-data.js
//
// Capture every card's API-visible data from a running instance into a
// directory, one <id>.json per card. Two of these dumps (pre-migration and
// post-migration) diff to prove a storage change was lossless: this is the
// "verification is dumps, not vibes" tool the migration (#494) leans on at
// every rollout step. Storage-agnostic by design — it only speaks HTTP, so
// the same dump works before and after data moves into the datastore.
//
// Usage:
//   node scripts/dump-card-data.js --base <url> --out <dir> [auth]
//   node scripts/dump-card-data.js --base <url> --diff <dirA> <dirB>
//
// Auth (one of; card data is behind auth):
//   --cookie "klebb_session=..."     a session cookie
//   --bearer <KLEBB_ADMIN_TOKEN>     an agent bearer token
//
// Diff mode compares two existing dump directories and exits non-zero on any
// per-card difference, naming each card that diverged. No server needed.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const https = require('https');

function parseArgs(argv) {
  const args = { base: null, out: null, cookie: null, bearer: null, diff: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--cookie') args.cookie = argv[++i];
    else if (a === '--bearer') args.bearer = argv[++i];
    else if (a === '--diff') args.diff = [argv[++i], argv[++i]];
  }
  return args;
}

function usage() {
  console.log(`Usage:
  dump-card-data.js --base <url> --out <dir> [--cookie <c> | --bearer <t>]
  dump-card-data.js --diff <dirA> <dirB>

Captures GET /api/manifests/:id/data for every card into <dir>/<id>.json.
Diff mode deep-equals two dumps and exits non-zero on any difference.`);
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function authHeaders(args) {
  const h = { Accept: 'application/json' };
  if (args.cookie) h.Cookie = args.cookie;
  if (args.bearer) h.Authorization = `Bearer ${args.bearer}`;
  return h;
}

async function listCardIds(base, headers) {
  const res = await get(new URL('/api/settings/cards', base).toString(), headers);
  if (res.status !== 200) {
    throw new Error(`GET /api/settings/cards returned ${res.status} (auth?)`);
  }
  const parsed = JSON.parse(res.body);
  const cards = Array.isArray(parsed.cards) ? parsed.cards : parsed;
  return cards.map((c) => c.id).filter(Boolean).sort();
}

async function dump(args) {
  const headers = authHeaders(args);
  const ids = await listCardIds(args.base, headers);
  fs.mkdirSync(args.out, { recursive: true });
  let ok = 0;
  for (const id of ids) {
    const res = await get(new URL(`/api/manifests/${encodeURIComponent(id)}/data`, args.base).toString(), headers);
    if (res.status !== 200) {
      console.error(`  ! ${id}: GET /data returned ${res.status}`);
      continue;
    }
    const value = JSON.parse(res.body).data;
    fs.writeFileSync(path.join(args.out, `${id}.json`), JSON.stringify(value, null, 2));
    ok += 1;
  }
  console.log(`Dumped ${ok}/${ids.length} card(s) to ${args.out}`);
  return ok === ids.length ? 0 : 1;
}

function readDump(dir) {
  const map = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    map.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return map;
}

function diff(dirA, dirB) {
  const a = readDump(dirA);
  const b = readDump(dirB);
  const ids = new Set([...a.keys(), ...b.keys()]);
  const diffs = [];
  for (const id of [...ids].sort()) {
    if (!a.has(id)) { diffs.push(`${id}: only in ${dirB}`); continue; }
    if (!b.has(id)) { diffs.push(`${id}: only in ${dirA}`); continue; }
    try {
      assert.deepStrictEqual(a.get(id), b.get(id));
    } catch {
      diffs.push(`${id}: value differs`);
    }
  }
  if (diffs.length === 0) {
    console.log(`Dumps deep-equal across ${ids.size} card(s): ${dirA} == ${dirB}`);
    return 0;
  }
  console.error(`${diffs.length} difference(s):`);
  for (const d of diffs) console.error(`  ✗ ${d}`);
  return 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.diff) return diff(args.diff[0], args.diff[1]);
  if (!args.base || !args.out) { console.error('error: --base and --out are required (or --diff)'); usage(); return 2; }
  return dump(args);
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(2); });
} else {
  module.exports = { diff, readDump };
}
