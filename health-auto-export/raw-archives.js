// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/raw-archives.js
//
// The pre-#546 raw push archive (auto-export/raw) and the migration's
// moved-aside copies (auto-export/raw.migrated-*). Excluded from every
// export: hundreds of MB of duplicates the samples table supersedes, which
// no customer archive should carry. For exactly that reason the import
// wipe must SPARE them: they exist nowhere else, so neither the imported
// archive nor the rollback snapshot could bring them back (#656). One
// list, two consumers, so the export's skips and the wipe's spares cannot
// drift.

'use strict';

const fs = require('fs');
const path = require('path');

// Absolute paths of the archival directories under the given auto-export
// dir. The fixed `raw` entry is returned whether or not it exists, so a
// skip set built from this list is stable across the export's own walk.
function rawArchiveDirs(autoExportDir) {
  const dirs = [path.join(autoExportDir, 'raw')];
  let names = [];
  try {
    names = fs.readdirSync(autoExportDir);
  } catch {}
  for (const name of names) {
    if (name.startsWith('raw.migrated-')) dirs.push(path.join(autoExportDir, name));
  }
  return dirs;
}

module.exports = { rawArchiveDirs };
