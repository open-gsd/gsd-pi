#!/usr/bin/env bash
# Local parity with CI PR merge gates (ci.yml blocking jobs when heavy-code-changed).
# See docs/dev/test-confidence-stack.md for the full tier map.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLASSIFY_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/verify-merge-classify.XXXXXX")"
cleanup() {
	rm -f "$CLASSIFY_OUTPUT"
}
trap cleanup EXIT

DEFAULT_BASE_REF="upstream/main"
if ! git rev-parse --verify "$DEFAULT_BASE_REF" >/dev/null 2>&1; then
	DEFAULT_BASE_REF="origin/main"
fi
VERIFY_MERGE_BASE_REF="${VERIFY_MERGE_BASE_REF:-$DEFAULT_BASE_REF}"
VERIFY_MERGE_HEAD_REF="${VERIFY_MERGE_HEAD_REF:-HEAD}"

echo "── verify:merge (CI PR blocking parity) ──"

echo "── classify changes vs ${VERIFY_MERGE_BASE_REF} ──"
CLASSIFY_EXIT=0
if [ "${VERIFY_MERGE_VERBOSE:-0}" = "1" ]; then
	GITHUB_OUTPUT="$CLASSIFY_OUTPUT" \
		EVENT_NAME=pull_request \
		PR_BASE_SHA="$VERIFY_MERGE_BASE_REF" \
		HEAD_SHA="$VERIFY_MERGE_HEAD_REF" \
		bash scripts/ci-classify-changes.sh || CLASSIFY_EXIT=$?
else
	GITHUB_OUTPUT="$CLASSIFY_OUTPUT" \
		EVENT_NAME=pull_request \
		PR_BASE_SHA="$VERIFY_MERGE_BASE_REF" \
		HEAD_SHA="$VERIFY_MERGE_HEAD_REF" \
		bash scripts/ci-classify-changes.sh >/dev/null 2>&1 || CLASSIFY_EXIT=$?
fi

# Fail SAFE, not closed: an unresolvable base ref (e.g. a shallow/single-commit
# checkout without origin/main fetched) must never silently skip real coverage.
# If classification didn't produce a trustworthy answer, default every gate to
# the heavy/full path instead of aborting or guessing "nothing changed".
if [ "$CLASSIFY_EXIT" -ne 0 ] || [ ! -s "$CLASSIFY_OUTPUT" ]; then
	echo "verify:merge note: change classification failed (base ref '${VERIFY_MERGE_BASE_REF}' may not resolve in this checkout, e.g. a shallow clone) -- defaulting to the safe/heavy path for every gate below."
	PORTABILITY_CHANGED="true"
	DOCKER_CHANGED="true"
	HEAVY_CODE_CHANGED="true"
else
	PORTABILITY_CHANGED="$(sed -n 's/^portability-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
	DOCKER_CHANGED="$(sed -n 's/^docker-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
	HEAVY_CODE_CHANGED="$(sed -n 's/^heavy-code-changed=//p' "$CLASSIFY_OUTPUT" | tail -n 1)"
	[ -n "$PORTABILITY_CHANGED" ] || PORTABILITY_CHANGED="true"
	[ -n "$DOCKER_CHANGED" ] || DOCKER_CHANGED="true"
	[ -n "$HEAVY_CODE_CHANGED" ] || HEAVY_CODE_CHANGED="true"
fi

if [ "$HEAVY_CODE_CHANGED" != "true" ]; then
	echo "verify:merge note: CI would skip heavy build/test jobs for this diff; prefer verify:fast unless you need extra confidence."
else
	echo "verify:merge note: CI would run the heavy Linux build/test gate for this diff."
fi
if [ "$DOCKER_CHANGED" = "true" ]; then
	echo "verify:merge note: docker paths changed; local CI parity still also needs pnpm run test:e2e:docker."
fi

echo "── native addon from source (test-fault-injection) ──"
if ! command -v rustc >/dev/null 2>&1; then
  echo "verify:merge needs Rust to build the local native engine (pnpm run build:native:test)."
  echo "CI does this before unit tests so ProjectionRootIdentityLock matches this commit."
  echo "Install rustup, then re-run. See CONTRIBUTING.md (Native engine version lockstep)."
  exit 1
fi
pnpm run build:native:test

echo "── install dependencies ──"
pnpm install --frozen-lockfile

echo "── build:core ──"
pnpm run build:core

echo "── web host (stale-aware; required by validate-pack) ──"
node scripts/build-web-if-stale.cjs

echo "── typecheck:extensions ──"
pnpm run typecheck:extensions

echo "── validate-pack ──"
pnpm run validate-pack

echo "── verify:workspace-coverage ──"
pnpm run verify:workspace-coverage

echo "── verify:extension-coverage ──"
pnpm run verify:extension-coverage

echo "── compile test artifacts ──"
pnpm run test:compile

echo "── test:unit ──"
mkdir -p dist-test/native/addon
cp native/addon/*.node dist-test/native/addon/
export GSD_NATIVE_PREFER_LOCAL=1
pnpm run test:unit:compiled

echo "── test:packages ──"
if [ "$PORTABILITY_CHANGED" = "true" ]; then
	GSD_SKIP_NATIVE_PACKAGE_TESTS=0 pnpm run test:packages:compiled
else
	GSD_SKIP_NATIVE_PACKAGE_TESTS=1 pnpm run test:packages:compiled
fi

echo "── test:pi-ai (vitest) ──"
pnpm --filter @gsd/pi-ai test

echo "── test:integration ──"
pnpm run test:integration

echo "── test:e2e ──"
chmod +x dist/loader.js
export GSD_SMOKE_BINARY="${ROOT}/dist/loader.js"
pnpm run test:e2e

echo "verify:merge: all checks passed ✓"
