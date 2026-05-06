// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/no-secrets.test.js
// Hygiene scanner — sibling to tests/no-personal-refs.test.js.
// Blocks secret-shaped strings from being committed.
//
// If this test fails, one of:
//   (a) an actual secret slipped in — remove it, rotate it, and amend
//       the commit
//   (b) a legitimate non-secret false-positive — whitelist the file/path
//       in SKIP_FILES or extend the FALSE_POSITIVE_HINTS array

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_legacy-v1',
  'tests',              // fixtures use placeholder tokens like 'test-agent-token-ab12cd34ef56'
]);

const SCAN_EXTS = new Set(['.js', '.md', '.html', '.css', '.json', '.yml', '.yaml', '.sh', '.service']);

const SKIP_FILES = new Set([
  'package-lock.json',
  'tests/no-secrets.test.js',   // this file contains the patterns as data
]);

// Detect patterns. Each rule: { pattern, name, severity: 'error'|'warn' }
const RULES = [
  {
    pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/,
    name: 'PEM private key header',
  },
  {
    pattern: /-----BEGIN\s+CERTIFICATE-----/,
    name: 'PEM certificate header',
  },
  {
    // AWS access key pattern: AKIA[0-9A-Z]{16}
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    name: 'AWS access key id',
  },
  {
    // GitHub personal access token (classic): ghp_…40+ chars
    pattern: /\bghp_[A-Za-z0-9]{30,}\b/,
    name: 'GitHub PAT (ghp_)',
  },
  {
    // GitHub fine-grained token
    pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
    name: 'GitHub fine-grained PAT',
  },
  {
    // Slack bot / user token
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    name: 'Slack token',
  },
  {
    // Google API key pattern
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    name: 'Google API key',
  },
  {
    // OpenAI API key (sk-… with long hex/base62)
    pattern: /\bsk-[A-Za-z0-9]{30,}\b/,
    name: 'OpenAI-style API key',
  },
  {
    // Stripe live/test secret
    pattern: /\bsk_(live|test)_[A-Za-z0-9]{20,}\b/,
    name: 'Stripe secret key',
  },
  {
    // Generic 'key=' / 'token=' / 'secret=' / 'password=' with a value
    // that looks non-trivial (8+ non-quote chars). This is noisy so it's
    // only flagged when the value matches a high-entropy heuristic.
    pattern: /(password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/i,
    name: 'credential-assignment with plausible value',
  },
];

// Lines to ignore even if they match. Used to suppress docs that describe
// the patterns (like CHANGELOG mentioning token rotation). Match is a
// substring check against the line.
const FALSE_POSITIVE_HINTS = [
  'no-secrets',              // this file
  'placeholder',             // docs describing placeholders
  'example',                 // docs with example strings
  // Tokens that are explicitly described as anonymised / reserved
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
        const lineLower = line.toLowerCase();
        if (FALSE_POSITIVE_HINTS.some(h => lineLower.includes(h))) return;
        for (const rule of RULES) {
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

describe('no-secrets (repo hygiene)', () => {
  test('no secret-shaped tokens, keys, or PEM blocks in source', () => {
    const findings = scanDir(REPO_ROOT);
    if (findings.length > 0) {
      const report = findings
        .map(f => `  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`)
        .join('\n');
      assert.fail(`Found ${findings.length} potential secret(s):\n${report}\n\n` +
        `If these are false positives, whitelist them in tests/no-secrets.test.js.`);
    }
  });
});
