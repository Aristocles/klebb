// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const SESSION_SECRET = 'invented-collection-readiness-key-for-isolated-tests';

async function readyCollection(data, paired, categories) {
  // Reuse the real authenticated exchange. This is an invented companion report,
  // never a provider read, SDK receipt or permission/device completion claim.
  const F = require('./health-connect-sticky-admission-fixture.cjs');
  assert.ok(Array.isArray(categories) && categories.length > 0);
  assert.equal(new Set(categories).size, categories.length);
  assert.deepEqual(Object.keys(paired.streams).sort(), [...categories].sort());
  const source = { paired: structuredClone(paired), binding: {
    tenantId: paired.tenantId, instanceId: paired.instanceId,
    sourceStoreId: paired.sourceStoreId, installationId: paired.installationId,
    generation: paired.streams[categories[0]].generation, restoreEpoch: paired.restoreEpoch,
  } };
  assert.ok(data.markers.includes(paired.credential));
  data.readinessVersion = 2;
  data.readiness ||= [];
  for (const type of categories) await F.activateReadiness(data, source, type);
  return source.paired;
}

module.exports = { readyCollection, SESSION_SECRET };
