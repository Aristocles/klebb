// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/datastore/import.js
// Import inbox: a manifest file carrying a `data` key gets that block
// imported into the datastore and stripped from the file, leaving a
// timestamped backup beside it.
//
// Crash-safe ordering: backup copy -> datastore transaction -> file rewrite
// (tmp+rename). A crash after the DB commit leaves the file still carrying
// its data key, so the next load simply re-imports: a full replace of the
// same value, idempotent by construction. The whole flow converges — once
// stripped, a file is never an import candidate again — so a reload
// triggered by the rewrite itself finds nothing to do.
//
// `data: null` imports as "no data": the key is stripped and the datastore
// bookkeeping row records the null, preserving today's hasData distinction
// between a null data block and no data key at all (which never imports).

'use strict';

const fs = require('fs');

// Matches the registry's BACKUP_NAME_RE ("two .json segments"): the loader
// skips these, so a backup can never load as a duplicate card.
function backupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  return `${filePath}.pre-import-${stamp}.json`;
}

// One importer per boot. Tracks imported ids: importing the same card twice
// within one boot means the strip rewrite is not sticking (or something is
// re-adding data blocks) and warrants a loud log, not silent convergence.
//
// The tracking set lives in this closure, not at module level, so isolation
// is per importer instance: a wipe-then-reimport flow (the import wizard)
// gets a clean slate by calling createImporter(store) again, and the
// deliberate re-import never fires the strip-not-sticking warning.
function createImporter(store) {
  const importedThisBoot = new Set();

  // filePath: the manifest file on disk. parsed: its already-parsed content
  // (the caller has validated the manifest shape). Returns
  // { imported, id, backup } — imported is false when there is no data key.
  function importParsedFile(filePath, parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('importParsedFile: parsed manifest object required');
    }
    const id = parsed.meta && parsed.meta.id;
    if (!id || typeof id !== 'string') {
      throw new Error('importParsedFile: parsed.meta.id required');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) {
      return { imported: false, id, backup: null };
    }

    if (importedThisBoot.has(id)) {
      console.warn(`[datastore-import] ${id} importing twice in one boot — the data-key strip is not sticking for ${filePath}`);
    }

    const backup = backupPath(filePath);
    fs.copyFileSync(filePath, backup);

    store.setData(id, parsed.data);

    const stripped = { ...parsed };
    delete stripped.data;
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stripped, null, 2));
    fs.renameSync(tmp, filePath);

    importedThisBoot.add(id);
    return { imported: true, id, backup };
  }

  return { importParsedFile };
}

module.exports = { createImporter };
