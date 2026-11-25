#!/usr/bin/env bash
# Fast CI gates: security scans, docs injection, skill refs, PR policy checks.
# Mirrors the fast-gates job in .github/workflows/ci.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm run verify:gsd-projection-mutations

# shellcheck source=scripts/ci-fetch-diff-base.sh
source "${ROOT}/scripts/ci-fetch-diff-base.sh"

# Local runs: use merge-base so PR policy checks match CI.
if [ -z "${PR_BASE_SHA:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ]; then
  PR_BASE_SHA="$(git merge-base HEAD "${CI_DIFF_REF}" 2>/dev/null || true)"
  export PR_BASE_SHA
fi

DIFF="${CI_DIFF_REF}"

echo "── secret scan ──"
bash scripts/secret-scan.sh --diff "$DIFF"

echo "── base64 scan ──"
bash scripts/base64-scan.sh --diff "$DIFF"

echo "── docs prompt-injection scan ──"
bash scripts/docs-prompt-injection-scan.sh --diff "$DIFF"

if [ -n "$(git ls-files .gsd .gsd/ 2>/dev/null || true)" ]; then
  echo "::error::.gsd/ must not be checked into git"
  exit 1
fi

echo "── skill references ──"
node scripts/check-skill-references.mjs

if [ -n "${PR_BASE_SHA:-}" ] || [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  echo "── require tests with source changes ──"
  bash scripts/require-tests.sh

  echo "── reject source-grep tests ──"
  bash scripts/check-source-grep-tests.sh
fi

echo "── test confidence tier map ──"
node scripts/audit-test-confidence.mjs --strict

echo "── script policy tests ──"
node --test "scripts/__tests__/*.mjs" "scripts/__tests__/*.cjs"

echo "── test gap strict (unwired) ──"
node scripts/audit-test-gaps.mjs --strict-unwired

echo "── test matrix strict ──"
node scripts/audit-test-matrix.mjs --strict

echo "── pi boundary ──"
pnpm run verify:pi-boundary

echo "── pi overlay snapshot ──"
node scripts/check-pi-overlay-snapshot.cjs

echo "── pi patch allowlist ──"
if [ -n "${PR_BASE_SHA:-}" ]; then
  VERIFY_PI_PATCHES_BRANCH=1 VERIFY_PI_PATCHES_BASE="$PR_BASE_SHA" pnpm run verify:pi-patches
else
  VERIFY_PI_PATCHES_BRANCH=1 pnpm run verify:pi-patches
fi

echo "── actionlint (workflow static analysis) ──"
# Enforced as a blocking job in CI (ci.yml workflow-lint). Locally it runs
# only when the binary is installed so the gate stays dependency-free.
if command -v actionlint >/dev/null 2>&1; then
  actionlint -config-file .config/actionlint.yaml
else
  echo "actionlint not installed locally — skipped here, enforced in CI"
fi

echo "ci-fast-gates: all checks passed ✓"
