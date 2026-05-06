// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/template-substitute.js
// Placeholder substitution for Add Card templates.
//
// Placeholder syntax in a template's raw JSON:
//   "{{name}}"           -> string default
//   "{{string:name}}"    -> string
//   "{{number:name}}"    -> number (written unquoted in JSON)
//   "{{boolean:name}}"   -> boolean
//   "{{date:name}}"      -> ISO date string
//   "{{enum:name}}"      -> string (enum validation is form-side)
//
// Public API:
//   extractPlaceholders(rawJson) -> [{ name, type }]
//   substitutePlaceholders(rawJson, values) -> string (substituted JSON)
//   parseSubstituted(rawJson, values) -> { manifest, error }

const PLACEHOLDER_RE = /\{\{([a-z]+:)?([a-z0-9_]+)\}\}/gi;
const QUOTED_PLACEHOLDER_RE = /"\{\{([a-z]+:)?([a-z0-9_]+)\}\}"/gi;

const VALID_TYPES = new Set(['string', 'number', 'boolean', 'date', 'enum']);

export function extractPlaceholders(rawJson) {
  const seen = new Map();
  for (const m of rawJson.matchAll(PLACEHOLDER_RE)) {
    const type = m[1] ? m[1].slice(0, -1) : 'string';
    const name = m[2];
    if (!VALID_TYPES.has(type)) {
      throw new Error(`unknown placeholder type: ${type}`);
    }
    if (!seen.has(name)) {
      seen.set(name, { name, type });
    } else if (seen.get(name).type !== type) {
      throw new Error(`placeholder "${name}" declared with conflicting types`);
    }
  }
  return [...seen.values()];
}

// Stringify a JS value for JSON embedding based on placeholder type.
function stringifyForType(value, type) {
  if (value === undefined || value === null || value === '') {
    // Sensible fallbacks so preview renders even before the user types.
    switch (type) {
      case 'number': return '0';
      case 'boolean': return 'false';
      case 'date': return JSON.stringify(new Date().toISOString().slice(0, 10));
      case 'string':
      case 'enum':
      default:
        return '""';
    }
  }
  switch (type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      return String(n);
    }
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false';
    case 'date':
    case 'string':
    case 'enum':
    default:
      return JSON.stringify(String(value));
  }
}

export function substitutePlaceholders(rawJson, values) {
  // Quoted placeholders first: "{{type:name}}" -> typed literal (numbers and
  // booleans land unquoted; strings/dates/enums stay quoted).
  let out = rawJson.replace(QUOTED_PLACEHOLDER_RE, (_, typePrefix, name) => {
    const type = typePrefix ? typePrefix.slice(0, -1) : 'string';
    return stringifyForType(values[name], type);
  });
  // Unquoted placeholders (rare, e.g. embedded inside a string template).
  // Substitute as raw string values without re-quoting; if the surrounding
  // JSON expected a number, the author should have used "{{number:...}}".
  out = out.replace(PLACEHOLDER_RE, (_, typePrefix, name) => {
    const v = values[name];
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}

export function parseSubstituted(rawJson, values) {
  const substituted = substitutePlaceholders(rawJson, values);
  try {
    return { manifest: JSON.parse(substituted), error: null };
  } catch (e) {
    return { manifest: null, error: e.message };
  }
}
