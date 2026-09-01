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
//     [--cards <ids>] [--reports <paths>] [--no-history]
//   npm run import -- <tree> [--apply] [--target <home>]
//
// --target sets the destination $HEALTH_HOME; without it the ambient
// HEALTH_HOME (or its default) applies.
//
// The three selection flags restore part of the archive instead of all of it
// (#646). Any of them present builds a selection; a family no flag names is
// restored whole, so --no-history alone means everything but the history.
//
// Exit codes: 0 validated/imported clean (warnings allowed), 1 refused or
// the apply did not fully verify, 2 usage errors.
//
// config/paths.js freezes every path at require time, so --target is parsed
// and exported into the environment with plain code before any lib module
// loads: all app requires below are deliberately lazy.

'use strict';

const path = require('path');

// A comma-separated list, blanks dropped. An empty value is an explicit
// "none of this family", which normaliseSelection tells apart from absent.
function parseList(value) {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    tree: null, apply: false, dryRun: false, target: null, help: false, error: null,
    cards: null, reports: null, history: null,
  };
  const valued = { '--target': 'target', '--cards': 'cards', '--reports': 'reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-history') args.history = false;
    else if (valued[name]) {
      const raw = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (raw === undefined) args.error = `${name} requires a value`;
      else if (name === '--target') args.target = raw;
      else args[valued[name]] = parseList(raw);
    } else if (a.startsWith('-')) args.error = `unknown argument: ${a}`;
    else if (!args.tree) args.tree = a;
    else args.error = `unexpected argument: ${a}`;
  }
  if (!args.help && !args.error && !args.tree) args.error = 'tree directory required';
  if (!args.error && args.apply && args.dryRun) args.error = '--apply and --dry-run are contradictory';
  return args;
}

// null means wholesale, which is what every caller passing no selection flag
// gets: an omitted family is not a deselection, so only the flags given narrow
// anything.
function selectionFrom(args) {
  if (args.cards === null && args.reports === null && args.history === null) return null;
  const sel = {};
  if (args.cards !== null) sel.cards = args.cards;
  if (args.reports !== null) sel.reports = args.reports;
  if (args.history !== null) sel.history = args.history;
  return sel;
}

function usage() {
  console.log(`Usage: import-tree.js <tree> [--apply] [--target <home>]
                       [--cards <ids>] [--reports <paths>] [--no-history]

Import an extracted Klebb export tree into a fresh instance.

  <tree>            Directory holding the extracted export (data/, reports/,
                    klebb-export.json).
  --apply           Execute the import. Without it this is a dry run: validate,
                    print the findings and the plan, write nothing.
  --dry-run         Explicitly ask for the dry run (the default).
  --target <home>   Destination $HEALTH_HOME (default: the HEALTH_HOME
                    environment variable, or its usual fallback).
  --cards <ids>     Restore only these card ids (comma-separated). Empty
                    means no cards at all.
  --reports <paths> Restore only these reports (comma-separated tree paths as
                    the plan prints them, e.g. reports/bloods.md). An ingested
                    report brings its archived original with it.
  --no-history      Leave the Apple Health push history out.
  --help            Show this message.

Without a selection flag the whole archive is restored. A family no flag
names is restored whole, so --no-history alone means everything else. The dry
run prints the filtered plan, so a subset can be checked before it is applied.

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

// `full` is the unfiltered plan when a selection narrowed this one, so every
// line says what is being left behind as well as what is coming.
function printPlan(plan, full = null) {
  const of = (n, total) => (full && n !== total ? `${n} of ${total}` : `${n}`);
  console.log('plan:');
  console.log(`  cards (${of(plan.cards.length, full && full.cards.length)}):`);
  for (const c of plan.cards) {
    console.log(`    ${c.id}  ${c.file}  data: ${c.data}`);
  }
  console.log(`  HAE pushes to import: ${of(plan.samplesPushes, full && full.samplesPushes)}`);
  console.log(`  reports to copy: ${of(plan.reports.length, full && full.reports.length)}`);
  console.log(`  config: ${plan.config}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.error) { console.error(`error: ${args.error}`); usage(); return 2; }

  if (args.target) {
    process.env.HEALTH_HOME = path.resolve(args.target);
  }
  const PATHS = require('../config/paths');
  const targetHome = PATHS.HEALTH_HOME;
  const tree = path.resolve(args.tree);

  const selection = selectionFrom(args);

  if (!args.apply) {
    const { validateTree } = require('../lib/import/validate');
    console.log(`Dry run: validating ${tree} against ${targetHome}`);
    const res = await validateTree(tree, { targetHome });
    printFindings(res.findings);
    // A torn tree is not worth filtering: the selection would be checked
    // against an inventory that describes nothing.
    if (selection && res.ok) {
      const { buildItems, normaliseSelection, filterPlan } = require('../lib/import/selection');
      const items = buildItems(tree, res.plan);
      const norm = normaliseSelection(items, selection);
      if (norm.errors.length) {
        printFindings(norm.errors);
        console.error('\nRefused: the selection does not match this archive.');
        return 1;
      }
      const sel = norm.selection;
      console.log(`selection: ${sel.cards.length} card(s), ${sel.reports.length} report item(s), `
        + `history ${sel.history ? 'on' : 'off'}`);
      printPlan(filterPlan(res.plan, items, sel), res.plan);
    } else {
      printPlan(res.plan);
    }
    if (!res.ok) {
      console.error('\nRefused: fix the findings above and re-run.');
      return 1;
    }
    console.log('\nTree validates. Re-run with --apply to import.');
    return 0;
  }

  const { applyTree } = require('../lib/import/apply');
  console.log(`Importing ${tree} into ${targetHome}`);
  const res = await applyTree(tree, targetHome, { selection });
  printFindings(res.findings);
  if (res.verified) {
    console.log(`verified: ${res.verified.cards} card(s), `
      + `${res.verified.pushes} HAE push(es), ${res.verified.reports} report(s)`);
  }
  console.log(`status: ${res.status}`);
  return res.status === 'ok' ? 0 : 1;
}

if (require.main === module) {
  main().then(code => process.exit(code));
}
