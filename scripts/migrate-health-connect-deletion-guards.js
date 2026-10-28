#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const args = process.argv.slice(2);
const allowed = ['--dry-run', '--apply', '--help', '--windows-development'];
const mode = args.filter(arg => ['--dry-run', '--apply', '--help'].includes(arg));
if (new Set(args).size !== args.length || args.some(arg => !allowed.includes(arg)) ||
    mode.length !== 1 || (args.includes('--windows-development') &&
      (!args.includes('--apply') || process.platform !== 'win32'))) {
  process.stderr.write('Usage: migrate-health-connect-deletion-guards.js --dry-run | --apply [--windows-development] | --help\n');
  process.exitCode = 2;
} else if (mode[0] === '--help') {
  process.stdout.write('Validate (--dry-run) or explicitly migrate (--apply) configured native health storage to V2.\n'
    + 'Apply requires a verified private database directory. Windows development additionally requires --windows-development;\n'
    + 'that profile does not establish POSIX directory durability. A verified timestamped safety copy precedes changes.\n'
    + 'This script does not restore or prune copies and does not activate deletion suppression.\n');
} else {
  try {
    const { readHistorySnapshot, withHistoryTransaction, HistoryError } =
      require('../lib/health-connect/history');
    const { validateMigrationSchema } = require('../lib/health-connect/guard-migration');
    let result;
    if (mode[0] === '--dry-run') {
      result = readHistorySnapshot((db, present) => {
        if (!present) throw new HistoryError(503, 'storage-unavailable');
        validateMigrationSchema(db);
        return { version: db.prepare('SELECT version FROM health_schema_version').get().version,
          migrated: false, safetyCopy: null, directoryDurability: null };
      });
    } else {
      result = withHistoryTransaction((db, migration) => ({
        version: db.prepare('SELECT version FROM health_schema_version').get().version,
        migrated: migration !== null,
        safetyCopy: migration?.safetyCopy ?? null,
        directoryDurability: migration?.directoryDurability ?? null,
      }), { deletionSchema: true, windowsDevelopment: args.includes('--windows-development') });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('storage-unavailable\n');
    process.exitCode = 1;
  }
}
