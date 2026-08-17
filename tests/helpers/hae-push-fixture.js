// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/hae-push-fixture.js
// Bulk HAE push fixtures for the detached-apply suites (#633). The pipeline
// only suspends inside the samples drain, so the width of the observable
// 'applying' window over HTTP is the drain's duration: a few hundred pushes
// of a couple dozen points each buys a multi-second window on this class of
// machine (measured ~2s for 400x24), wide enough to probe the freeze gate
// without a test-only hold hook.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// n pushes, every one content-unique (qty carries the indices), in the exact
// { receivedAt, payload } shape exportPushes() writes and the inbox drains.
function pushBatch(n, pointsPerPush = 24) {
  const pushes = [];
  for (let i = 0; i < n; i++) {
    const data = [];
    for (let j = 0; j < pointsPerPush; j++) {
      data.push({
        date: `2026-01-${String((j % 27) + 1).padStart(2, '0')}`,
        qty: i * 1000 + j,
      });
    }
    pushes.push({
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
      payload: { data: { metrics: [{ name: 'step_count', units: 'count', data }] } },
    });
  }
  return pushes;
}

// Plant a samples.json into an already-exported tree and list it in the
// tree's klebb-export.json inventory (with its real sha256, so validation
// raises neither VAL_INVENTORY_EXTRA nor VAL_CHECKSUM).
function injectPushes(tree, n, pointsPerPush = 24) {
  const rel = 'data/auto-export/samples.json';
  const file = path.join(tree, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, pushes: pushBatch(n, pointsPerPush) }));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const manifestFile = path.join(tree, 'klebb-export.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.inventory.samples = { file: rel, pushes: n, sha256 };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return n;
}

// Recursive file listing in the { name, sourcePath } shape writeZip takes,
// for re-zipping a tree after injectPushes.
function treeZipEntries(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...treeZipEntries(root, r));
    else if (ent.isFile()) out.push({ name: r, sourcePath: path.join(root, r) });
  }
  return out;
}

module.exports = { pushBatch, injectPushes, treeZipEntries };
