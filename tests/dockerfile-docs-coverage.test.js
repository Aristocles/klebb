// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/dockerfile-docs-coverage.test.js
//
// Regression seed for #248: the read_doc chat tool's allowlist must
// match the Dockerfile's COPY directives, otherwise containerised
// deployments serve every read_doc call as ENOENT.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { DOC_INDEX } = require('../chat/docs');

describe('Dockerfile copies every read_doc allowlist entry', () => {
  const dockerfileRaw = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  // Collapse backslash-continued lines so a multi-line COPY reads as one line.
  const dockerfile = dockerfileRaw.replace(/\\\r?\n\s*/g, ' ');

  test('each DOC_INDEX path is named in a COPY directive', () => {
    const copyLines = dockerfile.split('\n').filter(l => /^\s*COPY\b/.test(l));
    for (const entry of DOC_INDEX) {
      const isInSubdir = entry.path.includes('/');
      const needle = isInSubdir ? entry.path.split('/')[0] : entry.path;
      const matched = copyLines.some(line => {
        const re = new RegExp(`(^|\\s|/)${needle.replace('.', '\\.')}(\\s|/|$)`);
        return re.test(line);
      });
      assert.ok(
        matched,
        `Dockerfile is missing a COPY directive that would include ${entry.path}`,
      );
    }
  });
});
