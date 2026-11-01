// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/no-personal-refs.test.js
// Safety-net test: grep the entire repo for personal identifiers and hardcoded
// paths that should never appear in source. This is the backstop against any
// future PR re-introducing them.
//
// If this test fails, either:
//   (a) a legitimate new reference was added that needs whitelisting, OR
//   (b) a personal reference slipped in and should be removed.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findPrivateSourceRules, parsePrivateIdentifiers } = require('../lib/private-source-rules');
const LOCAL_IDENTIFIERS = parsePrivateIdentifiers(process.env.KLEBB_PRIVATE_IDENTIFIERS || '');

const REPO_ROOT = path.join(__dirname, '..');

// One reviewed synthetic native-test byte asset; all other files use the normal rules.
const QUEUE_INPUT_FIXTURE = 'android/app/src/androidTest/assets/queue-storage-inputs-v1.json';
const QUEUE_INPUT_FIXTURE_SHA256 = '5c8e25ad6c14e06162ad5576b5198696927f605fc6bb6d8563e977f05ada1816';

// Top-level directory prefixes to skip. The scanner is driven off
// git ls-files so node_modules / .git are already excluded; this list
// covers tracked paths whose contents legitimately mention names
// (test fixtures).
const SKIP_PREFIXES = [
  'tests/',
];

// File suffixes to scan.
const SCAN_EXTS = new Set(['.js', '.md', '.html', '.css', '.json']);

// Files to skip individually (paths relative to repo root, forward-slash form).
const SKIP_FILES = new Set([
  'package-lock.json',
  'CHANGELOG.md', // historical notes legitimately mention pre-rename values
  'tests/no-personal-refs.test.js', // this file contains the forbidden strings as data
]);

// Generic user paths and credential syntax always apply. Exact local-name
// coverage is optional: KLEBB_PRIVATE_IDENTIFIERS is a JSON string array.
// Cryptographic source hashes alone are not credential evidence.

// List tracked files via git so the scan only sees what actually ships.
// Ignored local configuration and data are outside the tracked-source scan.
// Fixes #330.
function listTrackedFiles() {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function scanRepo() {
  const findings = [];
  for (const rel of listTrackedFiles()) {
    if (SKIP_FILES.has(rel)) continue;
    if (SKIP_PREFIXES.some(p => rel.startsWith(p))) continue;
    const ext = path.extname(rel);
    if (!SCAN_EXTS.has(ext)) continue;
    const full = path.join(REPO_ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      // File listed by git but not on disk (e.g. case-only rename mid-checkout).
      continue;
    }
    if (rel === QUEUE_INPUT_FIXTURE) {
      const digest = crypto.createHash('sha256')
        .update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
      assert.strictEqual(digest, QUEUE_INPUT_FIXTURE_SHA256,
        'Synthetic queue input fixture differs from its reviewed bytes');
      continue;
    }
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const rule of findPrivateSourceRules(line, LOCAL_IDENTIFIERS)) {
        findings.push({
          fileId: crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12),
          line: idx + 1,
          rule,
        });
      }
    });
  }
  return findings;
}

describe('no-personal-refs (repo hygiene)', () => {
  test('no personal identifiers or hardcoded paths in source', () => {
    const findings = scanRepo();
    if (findings.length > 0) {
      const report = findings
        .map(f => `  file-${f.fileId}:${f.line}  [${f.rule}]`)
        .join('\n');
      assert.fail(`Found ${findings.length} forbidden reference(s):\n${report}`);
    }
  });
  test('portable checks use invented literals and omit private diagnostic values', () => {
    const cases = [
      {
        "id": "G01",
        "text": "C:\\Users\\ExamplePerson\\notes\\private.txt",
        "identifiers": [],
        "expected": [
          "PRIVATE_USER_PATH"
        ]
      },
      {
        "id": "G02",
        "text": "/home/example-person/project/private.txt",
        "identifiers": [],
        "expected": [
          "PRIVATE_USER_PATH"
        ]
      },
      {
        "id": "G03",
        "text": "/Users/ExamplePerson/private.txt",
        "identifiers": [],
        "expected": [
          "PRIVATE_USER_PATH"
        ]
      },
      {
        "id": "G04",
        "text": "/usr/local/bin/node",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G05",
        "text": "C:\\Program Files\\ExampleLibrary\\tool.exe",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G06",
        "text": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G07",
        "text": "aa1133445566778899aabbccddeeff00112233445566778899aabbccddeeff0011",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G08",
        "text": "-----BEGIN PRIVATE KEY-----",
        "identifiers": [],
        "expected": [
          "PRIVATE_KEY_MATERIAL"
        ]
      },
      {
        "id": "G09",
        "text": "sk-exampletokenabcdefghijklmnopqrstuv",
        "identifiers": [],
        "expected": [
          "STRUCTURED_SECRET_TOKEN"
        ]
      },
      {
        "id": "G10",
        "text": "ordinary fixture value",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G11",
        "text": "example-local-identifier appears here",
        "identifiers": [
          "example-local-identifier"
        ],
        "expected": [
          "LOCAL_IDENTIFIER"
        ]
      },
      {
        "id": "G12",
        "text": "example-local-identifier appears here",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G13",
        "text": "PUBLIC_API_NAME and unsupported records",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G14",
        "text": "const EXPECTED_SHA256 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';",
        "identifiers": [],
        "expected": []
      },
      {
        "id": "G15",
        "text": "Authorization: Bearer inventedbearertokenabcdefghijklmnopqrstuv",
        "identifiers": [],
        "expected": [
          "STRUCTURED_SECRET_TOKEN"
        ]
      },
      {
        "id": "G16",
        "text": "const apiKey = \"inventedcredentialabcdefghijklmnopqrstuv\";",
        "identifiers": [],
        "expected": [
          "SECRET_VALUE_WITH_CREDENTIAL_CONTEXT"
        ]
      },
      {
        "id": "G17",
        "text": "const home = \"C:\\\\Users\\\\ExamplePerson\\\\private.txt\";",
        "identifiers": [],
        "expected": [
          "PRIVATE_USER_PATH"
        ]
      },
      {
        "id": "G18",
        "text": "aXb",
        "identifiers": [
          "a.b"
        ],
        "expected": []
      },
      {
        "id": "G19",
        "text": "a.b",
        "identifiers": [
          "a.b"
        ],
        "expected": [
          "LOCAL_IDENTIFIER"
        ]
      },
      {
        "id": "G20",
        "text": "/home/<user>/example",
        "identifiers": [],
        "expected": []
      }
    ];
    cases.push(
      {"id": "URL01", "text": "https://example.com/home/member/profile", "identifiers": [], "expected": []},
      {"id": "PATH01", "text": "/home/example-person/project/private.txt", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]},
      {"id": "PATH02", "text": "const root = \"/home/example-person/project/private.txt\";", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]},
      {"id": "PATH03", "text": "const root = \"/Users/ExamplePerson/private.txt\";", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]}
    );
    cases.push(
      {"id": "BT01", "text": "Use `/home/example-person/private.txt`", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]},
      {"id": "BT02", "text": "`/home/example-person`", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]},
      {"id": "BT03", "text": "`/Users/ExamplePerson`", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]},
      {"id": "BT04", "text": "`C:\\Users\\ExamplePerson`", "identifiers": [], "expected": ["PRIVATE_USER_PATH"]}
    );
    for (const fixture of cases) {
      assert.deepStrictEqual(findPrivateSourceRules(fixture.text, fixture.identifiers), fixture.expected, fixture.id);
    }
    assert.deepStrictEqual(parsePrivateIdentifiers(), []);
    assert.deepStrictEqual(parsePrivateIdentifiers('[]'), []);
    assert.deepStrictEqual(parsePrivateIdentifiers('["example-local-identifier"]'), ['example-local-identifier']);
    assert.throws(() => parsePrivateIdentifiers('example-local-identifier'), { message: 'Optional local identifiers must be a JSON array of nonempty strings' });
    const diagnostics = JSON.stringify(findPrivateSourceRules('example-local-identifier appears here', ['example-local-identifier']));
    assert.ok(!diagnostics.includes('example-local-identifier'));
    assert.ok(!diagnostics.includes('appears here'));
  });
});
