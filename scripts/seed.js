#!/usr/bin/env node
// scripts/seed.js — copy a small starter set of cards into $HEALTH_HOME/data/.
//
// Opt-in. Does not run automatically. User invokes `npm run seed` when they
// want a few starter cards in their data directory.
//
// Copies:
//   - welcome.example.json → welcome.json
//   - weight.example.json  → weight.json
//   - notes.example.json   → notes.json
//   - how-to-add-a-card.example.json → how-to-add-a-card.json
//
// Safe: will NOT overwrite existing files. Skips any that already exist.
//
// Usage:
//   npm run seed                 # uses $HEALTH_HOME/data
//   npm run seed -- --force      # overwrite existing files
//   npm run seed -- --dir /path  # alternate data dir
//
// No --help flag; this script is tiny. Read the source.

const fs = require('fs');
const path = require('path');

const SEED_CARDS = [
  'welcome.example.json',
  'weight.example.json',
  'notes.example.json',
  'how-to-add-a-card.example.json',
];

function parseArgs(argv) {
  const args = { dir: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--dir') args.dir = argv[++i];
    else if (a.startsWith('--dir=')) args.dir = a.slice(6);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'data.example');

let target = args.dir;
if (!target) {
  const home = process.env.HEALTH_HOME || path.join(require('os').homedir(), 'klebb');
  target = path.join(home, 'data');
}

fs.mkdirSync(target, { recursive: true });

let copied = 0;
let skipped = 0;
let missing = 0;

for (const src of SEED_CARDS) {
  const srcPath = path.join(SOURCE_DIR, src);
  // Target filename drops the ".example" — welcome.example.json → welcome.json
  const dstName = src.replace('.example', '');
  const dstPath = path.join(target, dstName);

  if (!fs.existsSync(srcPath)) {
    console.warn(`[seed] ${src}: source file missing, skipping`);
    missing++;
    continue;
  }
  if (fs.existsSync(dstPath) && !args.force) {
    console.log(`[seed] ${dstName}: already exists, skipping (use --force to overwrite)`);
    skipped++;
    continue;
  }
  fs.copyFileSync(srcPath, dstPath);
  console.log(`[seed] ${dstName}: copied`);
  copied++;
}

console.log(`\nSeeded ${copied} card(s) into ${target}.`);
if (skipped > 0) console.log(`  ${skipped} skipped (already existed)`);
if (missing > 0) console.log(`  ${missing} not found in data.example/`);
if (copied > 0) {
  console.log('\nRestart the server (or just refresh the page) to see the new cards.');
}
