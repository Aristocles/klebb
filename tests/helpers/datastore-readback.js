// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/datastore-readback.js
// Read a card's data straight from a sandbox instance's SQLite file, via a
// throwaway datastore handle. WAL lets this read committed rows while the
// registry under test still holds its own handle open, so a suite can assert
// the DURABLE state (not just the served value) after a write or a throw.

const path = require('path');
const { open } = require('../../lib/datastore');

// Reconstructs the value for `id` from <sandbox>/db/klebb.db. Returns null for
// an unknown card (same as datastore.getData). Opens, loads, closes each call.
function readStored(sandboxRoot, id) {
  const store = open(path.join(sandboxRoot, 'db', 'klebb.db'));
  try {
    store.load();
    return store.getData(id);
  } finally {
    store.close();
  }
}

module.exports = { readStored };
