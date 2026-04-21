#!/usr/bin/env bash
# scripts/verify-install.sh — pre-flight sanity check for a Klebb install.
#
# Reports on $HEALTH_HOME: directory perms, card file status, known-bad
# legacy shapes still lingering, credentials/sessions dirs, config.json
# validity. Does NOT modify anything.
#
# Usage:
#   ./scripts/verify-install.sh                        # uses $HEALTH_HOME
#   ./scripts/verify-install.sh --health-home <path>
#   ./scripts/verify-install.sh --help

set -euo pipefail

HEALTH_HOME="${HEALTH_HOME:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --health-home) HEALTH_HOME=$2; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [--health-home <path>]

Reports status of a Klebb install — perms, card files, schema conformance,
auth dirs, config validity. Does NOT modify anything.

Exits 0 if everything looks healthy, 1 if issues were found, 2 on error.
EOF
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$HEALTH_HOME" ]] && { echo "error: HEALTH_HOME not set (use --health-home or export it)"; exit 2; }
[[ ! -d "$HEALTH_HOME" ]] && { echo "error: $HEALTH_HOME does not exist or is not a directory"; exit 2; }

ISSUES=0
pass()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m⚠\033[0m %s\n' "$*"; ISSUES=$((ISSUES + 1)); }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; ISSUES=$((ISSUES + 1)); }
info()  { printf '  ℹ %s\n' "$*"; }

echo "Verifying Klebb install at: $HEALTH_HOME"
echo ""

# --- 1. Dir structure ---
echo "Directory layout:"
for sub in data credentials sessions; do
  if [[ -d "$HEALTH_HOME/$sub" ]]; then
    pass "$sub/ exists"
  else
    warn "$sub/ missing (will be created on first use)"
  fi
done

DATA_DIR="$HEALTH_HOME/data"

# --- 2. config.json ---
echo ""
echo "Configuration:"
if [[ -f "$HEALTH_HOME/config.json" ]]; then
  if python3 -c "import json,sys; json.load(open('$HEALTH_HOME/config.json'))" 2>/dev/null; then
    pass "config.json is valid JSON"
  else
    fail "config.json is INVALID JSON"
  fi
else
  info "config.json not present (acceptable for a fresh install)"
fi

# --- 3. Card files ---
echo ""
echo "Card files:"
if [[ ! -d "$DATA_DIR" ]]; then
  warn "$DATA_DIR does not exist — no cards"
else
  TOTAL=$(find "$DATA_DIR" -maxdepth 1 -name '*.json' | wc -l)
  info "$TOTAL json file(s) at top level of data/"

  # Count by schema
  KLEBB=$(find "$DATA_DIR" -maxdepth 1 -name '*.json' -exec grep -l '"klebb.datafile.v1"' {} \; 2>/dev/null | wc -l)
  LEGACY_EDDZ=$(find "$DATA_DIR" -maxdepth 1 -name '*.json' -exec grep -l '"eddzhealth.datafile.v1"' {} \; 2>/dev/null | wc -l)
  BARE=$((TOTAL - KLEBB - LEGACY_EDDZ))

  if [[ $KLEBB -gt 0 ]]; then pass "$KLEBB file(s) on klebb.datafile.v1 schema"; fi
  if [[ $LEGACY_EDDZ -gt 0 ]]; then
    warn "$LEGACY_EDDZ file(s) still on eddzhealth.datafile.v1 — run: npm run migrate-schema"
  fi
  if [[ $BARE -gt 0 ]]; then
    info "$BARE file(s) without a \$schema (legacy or non-manifest; ignored by registry)"
  fi

  # --- 4. Dead renderer references ---
  DEAD_COMPONENTS="metric-card notes-card quick-action-card"
  for comp in $DEAD_COMPONENTS; do
    MATCHES=$(find "$DATA_DIR" -maxdepth 1 -name '*.json' \
      -exec grep -l "\"component\": *\"$comp\"" {} \; 2>/dev/null | wc -l)
    if [[ $MATCHES -gt 0 ]]; then
      warn "$MATCHES file(s) still reference the dead renderer '$comp' — run: npm run migrate-schema; then the card-specific migration"
    fi
  done

  # --- 5. Date-keyed object data in known ids ---
  for id in mood notes daily-notes; do
    f="$DATA_DIR/$id.json"
    if [[ -f "$f" ]]; then
      SHAPE=$(python3 -c "
import json
try:
  d = json.load(open('$f'))
  data = d.get('data')
  if isinstance(data, list): print('array')
  elif isinstance(data, dict) and data:
    first = next(iter(data))
    print('date-keyed' if len(first)==10 and first[4]=='-' and first[7]=='-' else 'object')
  elif isinstance(data, dict) and not data: print('empty-object')
  else: print('unknown')
except Exception: print('error')
" 2>/dev/null)
      case "$SHAPE" in
        array) pass "$id.json uses array shape" ;;
        date-keyed) warn "$id.json still uses date-keyed object shape — run: node scripts/migrate-date-keyed-to-array.js --dir $DATA_DIR" ;;
        error) warn "$id.json failed to parse" ;;
      esac
    fi
  done
fi

# --- 6. Credentials + sessions ---
echo ""
echo "Auth:"
if [[ -f "$HEALTH_HOME/credentials/webauthn.json" ]]; then
  pass "webauthn credentials present"
elif [[ -f "$DATA_DIR/webauthn-credentials.json" ]]; then
  info "legacy webauthn-credentials.json in data/ (supported)"
else
  info "no credentials yet — first /register will bootstrap"
fi

# --- Summary ---
echo ""
if [[ $ISSUES -eq 0 ]]; then
  printf '\033[32mAll checks passed.\033[0m\n'
  exit 0
else
  printf '\033[33m%d issue(s) found.\033[0m See above for remediation.\n' "$ISSUES"
  exit 1
fi
