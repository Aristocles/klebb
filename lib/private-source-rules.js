// SPDX-License-Identifier: AGPL-3.0-only
// Portable source checks. Optional local identifiers remain outside source.
const RULES = [
  { name: 'PRIVATE_USER_PATH', pattern: /(?:^|[\s`"'(=:\[{])\/(?:home|Users)\/[a-z0-9][a-z0-9._-]*(?=[\/`"'\s]|$)/i },
  { name: 'PRIVATE_USER_PATH', pattern: /[a-z]:(?:\\+|\/)Users(?:\\+|\/)[a-z0-9][a-z0-9._-]*(?=[\\/`"'\s]|$)/i },
  { name: 'PRIVATE_KEY_MATERIAL', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'STRUCTURED_SECRET_TOKEN', pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'STRUCTURED_SECRET_TOKEN', pattern: /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/i },
  { name: 'SECRET_VALUE_WITH_CREDENTIAL_CONTEXT', pattern: /\b(?:[a-z0-9]+[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|password|secret)\b["']?\s*[:=]\s*["'][A-Za-z0-9+_.\/=-]{20,}["']/i },
];

function parsePrivateIdentifiers(raw = '') {
  if (raw === '') return [];
  let identifiers;
  try { identifiers = JSON.parse(raw); } catch { /* fixed diagnostic below */ }
  if (!Array.isArray(identifiers) || identifiers.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('Optional local identifiers must be a JSON array of nonempty strings');
  }
  return identifiers;
}

function findPrivateSourceRules(text, identifiers = []) {
  const findings = new Set(RULES.filter(rule => rule.pattern.test(text)).map(rule => rule.name));
  for (const identifier of identifiers) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i');
    if (pattern.test(text)) findings.add('LOCAL_IDENTIFIER');
  }
  return [...findings];
}

module.exports = { findPrivateSourceRules, parsePrivateIdentifiers };
