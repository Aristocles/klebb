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
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Directories to skip entirely.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'tests',                 // tests can legitimately mention names (they are fixtures)
  '_legacy-v1',            // legacy UI not loaded anymore
  'data.example',          // example cards can contain anonymised names
  'seed',                  // seed content (not currently used, but allowed)
]);

// File suffixes to scan.
const SCAN_EXTS = new Set(['.js', '.md', '.html', '.css', '.json']);

// Files to skip individually (by absolute path from repo root).
const SKIP_FILES = new Set([
  'package-lock.json',
  'CHANGELOG.md', // historical notes legitimately mention pre-rename values
  'tests/no-personal-refs.test.js', // this file contains the forbidden strings as data
]);

// Forbidden patterns. Each entry: { pattern: RegExp, name: string, severity: 'error' }.
const FORBIDDEN = [
  // Personal identifiers — word-boundary match to avoid false positives
  { pattern: /\bAxis\b/, name: 'Axis' },
  { pattern: /\bEddy\b/, name: 'Eddy' },
  { pattern: /\bOnyx\b/, name: 'Onyx' },
  { pattern: /\bChuck\b/, name: 'Chuck' },
  { pattern: /\bSayadian\b/, name: 'Sayadian' },
  // Hardcoded absolute paths
  { pattern: /\/home\/minecraft/, name: '/home/minecraft' },
  { pattern: /\/mnt\/nas/, name: '/mnt/nas' },
  { pattern: /\/opt\/onyx/, name: '/opt/onyx' },
  { pattern: /~\/axis/, name: '~/axis' },
  // Leaked tokens — anything that looks like a production bearer token
  // (32+ hex chars) shouldn't be in source. We'll pattern-match on
  // 48-char hex strings as a heuristic.
  { pattern: /['"][0-9a-f]{48,}['"]/, name: 'hex token ≥48 chars' },
];

function scanDir(dir) {
  const findings = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      findings.push(...scanDir(path.join(dir, ent.name)));
    } else if (ent.isFile()) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(REPO_ROOT, full);
      if (SKIP_FILES.has(rel)) continue;
      const ext = path.extname(ent.name);
      if (!SCAN_EXTS.has(ext)) continue;
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            findings.push({
              file: rel,
              line: idx + 1,
              rule: rule.name,
              text: line.trim().slice(0, 120),
            });
          }
        }
      });
    }
  }
  return findings;
}

describe('no-personal-refs (repo hygiene)', () => {
  test('no personal identifiers or hardcoded paths in source', () => {
    const findings = scanDir(REPO_ROOT);
    if (findings.length > 0) {
      const report = findings
        .map(f => `  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`)
        .join('\n');
      assert.fail(`Found ${findings.length} forbidden reference(s):\n${report}`);
    }
  });
});
