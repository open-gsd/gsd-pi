#!/usr/bin/env bash
# Classify changed files for CI path gating. Writes booleans to GITHUB_OUTPUT when set.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-${GITHUB_EVENT_NAME:-pull_request}}"
PR_BASE_SHA="${PR_BASE_SHA:-${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:-}}"
PUSH_BEFORE_SHA="${PUSH_BEFORE_SHA:-${GITHUB_EVENT_BEFORE:-}}"
HEAD_SHA="${HEAD_SHA:-${GITHUB_SHA:-HEAD}}"

if [ "$EVENT_NAME" = "pull_request" ] && [ -n "$PR_BASE_SHA" ]; then
  BASE="$PR_BASE_SHA"
elif [ -n "$PUSH_BEFORE_SHA" ] && [ "$PUSH_BEFORE_SHA" != "0000000000000000000000000000000000000000" ]; then
  BASE="$PUSH_BEFORE_SHA"
else
  BASE="${CI_DIFF_REF:-origin/main}"
fi

FILES=$(git diff --name-only "$BASE" "$HEAD_SHA" 2>/dev/null || git diff --name-only HEAD~1)
echo "Changed files:"
echo "$FILES"

is_core_file() {
  case "$1" in
    src/*|packages/*|native/*|scripts/*|web/*|extensions/*|integrations/*|tests/*|docker/*|Dockerfile|package.json|pnpm-lock.yaml|tsconfig*.json|.github/*) return 0 ;;
    packages/*/tsconfig.json) return 0 ;;
    *) return 1 ;;
  esac
}

is_web_file() {
  case "$1" in
    web/*|web/package.json|pnpm-lock.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

is_portability_file() {
  case "$1" in
    native/*|packages/native/*|packages/pi-tui/native/*|src/loader*|src/native*|src/rtk*|src/tests/windows-*|src/tests/integration/web-mode-windows-hide.test.ts|src/resources/extensions/gsd/validate-directory*|src/resources/extensions/gsd/tests/validate-directory.test.ts|src/resources/extensions/gsd/auto-worktree*|src/resources/extensions/gsd/workflow-mcp*|pnpm-lock.yaml|tsconfig*.json) return 0 ;;
    packages/*/tsconfig.json) return 0 ;;
    *) return 1 ;;
  esac
}

is_windows_e2e_file() {
  case "$1" in
    tests/e2e/*|src/loader*|src/rtk*|src/native*|src/resources/extensions/gsd/gsd-db*|src/resources/extensions/gsd/extension-host*|src/resources/extensions/gsd/auto-worktree*|src/resources/extensions/gsd/workflow-mcp*|packages/native/*|native/*|pnpm-lock.yaml|tsconfig*.json) return 0 ;;
    packages/*/tsconfig.json) return 0 ;;
    *) return 1 ;;
  esac
}

is_native_attended_file() {
  case "$1" in
    src/resources/extensions/gsd/coordination-maintenance*.ts|src/resources/extensions/gsd/coordination-same-machine-facts.ts|src/resources/extensions/gsd/coordination-maintenance-*.ts|src/coordination-maintenance*.ts|src/resources/extensions/gsd/db/engine.ts|src/resources/extensions/gsd/db-adapter.ts|src/tests/coordination-maintenance-attended*.test.ts|scripts/build-native-fixture-package.mjs|scripts/__tests__/build-native-fixture-package.test.mjs|packages/native/*|native/*|.github/workflows/native-attended.yml) return 0 ;;
    *) return 1 ;;
  esac
}

is_docker_file() {
  case "$1" in
    Dockerfile|docker/*|tests/e2e/docker/*|scripts/install.js|scripts/link-workspace-packages.cjs|scripts/prepack-resolve-workspace.cjs|scripts/postpack-restore-workspace.cjs|scripts/validate-pack.js|native/npm/*/package.json|pnpm-lock.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

HEAVY_CODE=""
WEB=""
PORTABILITY=""
WINDOWS_E2E=""
DOCKER=""
NATIVE_ATTENDED=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if is_core_file "$file"; then
    HEAVY_CODE="${HEAVY_CODE}${file}"$'\n'
  fi
  if is_web_file "$file"; then
    WEB="${WEB}${file}"$'\n'
  fi
  if is_portability_file "$file"; then
    PORTABILITY="${PORTABILITY}${file}"$'\n'
  fi
  if is_windows_e2e_file "$file"; then
    WINDOWS_E2E="${WINDOWS_E2E}${file}"$'\n'
  fi
  if is_docker_file "$file"; then
    DOCKER="${DOCKER}${file}"$'\n'
  fi
  if is_native_attended_file "$file"; then
    NATIVE_ATTENDED="${NATIVE_ATTENDED}${file}"$'\n'
  fi
done <<< "$FILES"

write_output() {
  local key="$1"
  local value="$2"
  local notice="$3"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
  export "${key//-/_}=${value}"
  if [ "$value" = "true" ]; then
    echo "$notice"
  else
    echo "::notice::$notice"
  fi
}

if [ -n "$HEAVY_CODE" ]; then
  write_output "heavy-code-changed" "true" "Build/runtime-relevant files changed:"
  echo "$HEAVY_CODE"
else
  write_output "heavy-code-changed" "false" "No build/runtime-relevant changes — skipping heavy build/test jobs"
fi

if [ -n "$WEB" ]; then
  write_output "web-changed" "true" "Web host files changed:"
  echo "$WEB"
else
  write_output "web-changed" "false" "No web host changes"
fi

if [ -n "$PORTABILITY" ]; then
  write_output "portability-changed" "true" "Portability-relevant files changed:"
  echo "$PORTABILITY"
else
  write_output "portability-changed" "false" "No portability-relevant changes — skipping Windows portability checks"
fi

if [ -n "$WINDOWS_E2E" ]; then
  write_output "windows-e2e-changed" "true" "Windows e2e-relevant files changed:"
  echo "$WINDOWS_E2E"
else
  write_output "windows-e2e-changed" "false" "No Windows e2e-relevant changes — skipping Windows e2e"
fi

if [ -n "$DOCKER" ]; then
  write_output "docker-changed" "true" "Docker-relevant files changed:"
  echo "$DOCKER"
else
  write_output "docker-changed" "false" "No Docker-relevant changes — skipping Docker e2e"
fi

if [ -n "$NATIVE_ATTENDED" ]; then
  write_output "native-attended-changed" "true" "Native attended maintenance files changed:"
  echo "$NATIVE_ATTENDED"
else
  write_output "native-attended-changed" "false" "No native attended maintenance changes — skipping macOS attended fixtures"
fi
