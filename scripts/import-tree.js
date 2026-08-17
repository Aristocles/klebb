#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/import-tree.js
//
// Import an extracted export tree (docs/EXPORT-FORMAT.md) into a fresh
// instance. Dry-run is the default: validate the tree against the target,
// print every finding and the apply plan, and write nothing. --apply
// executes the import offline (it refuses while a server holds the
// datastore) and verifies every card, HAE push and report against the tree.
//
// Usage:
//   node scripts/import-tree.js <tree> [--apply] [--target <home>]
//   npm run import -- <tree> [--apply] [--target <home>]
//
// --target sets the destination $HEALTH_HOME; without it the ambient
// HEALTH_HOME (or its default) applies.
//
// Exit codes: 0 validated/imported clean (warnings allowed), 1 refused or
// the apply did not fully verify, 2 usage errors.
//
// config/paths.js freezes every path at require time, so --target is parsed
// and exported into the environment with plain code before any lib module
// loads: all app requires below are deliberately lazy.

'use strict';

const path = require('path');

function parseArgs(argv) {
  const args = { tree: null, apply: false, target: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--target') {
      args.target = argv[++i];
      if (args.target === undefined) args.error = '--target requires a path';
    } else if (a.startsWith('--target=')) args.target = a.slice(9);
    else if (a.startsWith('-')) args.error = `unknown argument: ${a}`;
    else if (!args.tree) args.tree = a;
    else args.error = `unexpected argument: ${a}`;
  }
  if (!args.help && !args.error && !args.tree) args.error = 'tree directory required';
  return args;
}

function usage() {
  console.log(`Usage: import-tree.js <tree> [--apply] [--target <home>]

Import an extracted Klebb export tree into a fresh instance.

  <tree>           Directory holding the extracted export (data/, reports/,
                   klebb-export.json).
  --apply          Execute the import. Without it this is a dry run: validate,
                   print the findings and the plan, write nothing.
  --target <home>  Destination $HEALTH_HOME (default: the HEALTH_HOME
                   environment variable, or its usual fallback).
  --help           Show this message.

The target must be fresh (no cards beyond the seeded welcome card, no HAE
history) and, with --apply, must not be held by a running server.

Exit codes: 0 ok, 1 refused / failed verification, 2 usage error.`);
}

function printFindings(findings) {
  if (!findings.length) {
    console.log('findings: none');
    return;
  }
  console.log(`findings (${findings.length}):`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.code} ${f.ref}: ${f.message}`);
  }
}

function printPlan(plan) {
  console.log('plan:');
  console.log(`  cards (${plan.cards.length}):`);
  for (const c of plan.cards) {
    console.log(`    ${c.id}  ${c.file}  data: ${c.data}`);
  }
  console.log(`  HAE pushes to import: ${plan.samplesPushes}`);
  console.log(`  reports to copy: ${plan.reports.length}`);
  console.log(`  config: ${plan.config}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.error) { console.error(`error: ${args.error}`); usage(); return 2; }

  if (args.target) {
    process.env.HEALTH_HOME = path.resolve(args.target);
  }
  const PATHS = require('../config/paths');
  const targetHome = PATHS.HEALTH_HOME;
  const tree = path.resolve(args.tree);

  if (!args.apply) {
    const { validateTree } = require('../lib/import/validate');
    console.log(`Dry run: validating ${tree} against ${targetHome}`);
    const res = validateTree(tree, { targetHome });
    printFindings(res.findings);
    printPlan(res.plan);
    if (!res.ok) {
      console.error('\nRefused: fix the findings above and re-run.');
      return 1;
    }
    console.log('\nTree validates. Re-run with --apply to import.');
    return 0;
  }

  const { applyTree } = require('../lib/import/apply');
  console.log(`Importing ${tree} into ${targetHome}`);
  const res = applyTree(tree, targetHome);
  printFindings(res.findings);
  if (res.verified) {
    console.log(`verified: ${res.verified.cards} card(s), `
      + `${res.verified.pushes} HAE push(es), ${res.verified.reports} report(s)`);
  }
  console.log(`status: ${res.status}`);
  return res.status === 'ok' ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}
