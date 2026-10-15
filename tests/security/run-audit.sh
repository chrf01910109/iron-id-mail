#!/usr/bin/env bash
# IRON ID — automated security audit.
#
#   bash tests/security/run-audit.sh [BASE_URL]
#
# Runs, from the repository root:
#   1. npm audit        known-vulnerable dependencies (webmail, tests/e2e)
#   2. gitleaks         secrets in the working tree and in the whole git history
#   3. semgrep          code patterns from tests/security/semgrep-rules.yml (offline rules)
#   4. http-probe.js    read-only checks of a running server (skipped without BASE_URL)
# Results go to audit-results/<date>/ ; the exit code is non-zero if any step found a problem.
# Tools that aren't installed are reported as SKIPPED (install: gitleaks release binary,
# `pip install semgrep`).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_URL="${1:-${BASE_URL:-}}"
OUT="$ROOT/audit-results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
STATUS=0
note() { echo "$1" | tee -a "$OUT/summary.txt"; }

note "IRON ID security audit — $(date -u +%FT%TZ) — commit $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"

# 1. Dependencies
for d in webmail tests/e2e; do
  if [ -f "$ROOT/$d/package-lock.json" ]; then
    (cd "$ROOT/$d" && npm audit --json > "$OUT/npm-audit-${d//\//-}.json" 2>/dev/null)
    n=$(node -e "const j=require('$OUT/npm-audit-${d//\//-}.json');const m=(j.metadata||{}).vulnerabilities||{};console.log((m.high||0)+(m.critical||0)+(m.moderate||0))" 2>/dev/null || echo "?")
    note "npm audit $d: $n moderate/high/critical"
    [ "$n" != "0" ] && STATUS=1
  fi
done

# 2. Secrets
if command -v gitleaks >/dev/null; then
  gitleaks dir "$ROOT" --no-banner --redact -r "$OUT/gitleaks-tree.json" -f json >/dev/null 2>&1; t=$?
  gitleaks git "$ROOT" --no-banner --redact -r "$OUT/gitleaks-history.json" -f json >/dev/null 2>&1; g=$?
  note "gitleaks working tree: $([ $t = 0 ] && echo clean || echo FINDINGS) ; history: $([ $g = 0 ] && echo clean || echo FINDINGS — see gitleaks-history.json)"
  [ $t != 0 ] && STATUS=1
else
  note "gitleaks: SKIPPED (not installed)"
fi

# 3. Code patterns
if command -v semgrep >/dev/null; then
  semgrep scan --metrics=off --disable-version-check --config "$ROOT/tests/security/semgrep-rules.yml" \
    --exclude node_modules --exclude 'webmail/public/vendor' --exclude docs --exclude audit-results \
    --json -o "$OUT/semgrep.json" "$ROOT" >/dev/null 2>&1
  node -e "
    const j=require('$OUT/semgrep.json');
    const by={}; for (const r of j.results) { const s=r.extra.severity; by[s]=(by[s]||0)+1; console.log(s.padEnd(8), r.check_id.split('.').pop().padEnd(40), r.path+':'+r.start.line); }
    console.log('semgrep: '+j.results.length+' results', JSON.stringify(by), 'errors', j.errors.length);
  " | tee "$OUT/semgrep.txt" | tail -1 | tee -a "$OUT/summary.txt"
  # ERROR-level findings fail the audit; warnings are listed for review.
  node -e "process.exit(require('$OUT/semgrep.json').results.some(r => r.extra.severity === 'ERROR') ? 1 : 0)" || STATUS=1
else
  note "semgrep: SKIPPED (not installed)"
fi

# 4. Running server
if [ -n "$BASE_URL" ]; then
  node "$ROOT/tests/security/http-probe.js" "$BASE_URL" > "$OUT/http-probe.txt" 2>&1; p=$?
  note "http probe $BASE_URL: $(tail -1 "$OUT/http-probe.txt")"
  [ $p != 0 ] && STATUS=1
else
  note "http probe: SKIPPED (give a BASE_URL)"
fi

note "Results: $OUT"
exit $STATUS
