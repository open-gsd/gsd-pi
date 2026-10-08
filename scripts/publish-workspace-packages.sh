#!/usr/bin/env bash
# gsd-pi + scripts/publish-workspace-packages.sh
#
# Publishes every publishable @opengsd workspace package to npm, in dependency
# order, at the current root package.json version. The package list is derived
# from scripts/lib/npm-release-packages.cjs (driven by each package's
# publishConfig) — NOT a hardcoded list — so a new publishable package can never
# be silently forgotten by a stale hardcoded list.
#
# Assumes the build already ran and prepack has resolved workspace: ranges
# (callers run scripts/prepack-resolve-workspace.cjs + the postpack restore trap).
# Idempotent only when the registry tarball exactly matches the intended bytes.
#
# Env:
#   TAG_FLAG        extra npm publish flags (e.g. "--tag latest"); optional
#   NODE_AUTH_TOKEN npm auth token for the token-auth fallback; optional (OIDC default)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="latest"
if [[ -n "${TAG_FLAG:-}" ]]; then
  if [[ "${TAG_FLAG}" =~ ^--tag[[:space:]]+([a-z][a-z0-9-]*)$ ]]; then
    TAG="${BASH_REMATCH[1]}"
  else
    echo "::error::Unsupported TAG_FLAG: ${TAG_FLAG}"
    exit 1
  fi
fi

# Lines of "<name>:<workspace-dir>" in dependency order.
# Capture discovery separately so a failed package-list command cannot be
# mistaken for an empty successful publication. This also works with Bash 3.
RAW_ENTRIES="$(node scripts/lib/npm-release-packages.cjs --workspace-dirs)"
ENTRIES=()
while IFS= read -r entry; do
  [[ -n "$entry" ]] && ENTRIES+=("$entry")
done <<< "$RAW_ENTRIES"

if [ "${#ENTRIES[@]}" -eq 0 ]; then
  echo "No publishable workspace packages found."
  exit 0
fi

echo "Publishing ${#ENTRIES[@]} workspace package(s) at ${VERSION} (dependency order):"
printf '  - %s\n' "${ENTRIES[@]}"

for entry in "${ENTRIES[@]}"; do
  workspace="${entry%%:*}"
  dir="${entry#*:}"
  echo "Publishing and verifying ${workspace}@${VERSION}..."
  node "${ROOT}/scripts/publish-npm-package.mjs" "${ROOT}/${dir}" "${VERSION}" "${TAG}"

done

echo "All workspace packages published at ${VERSION}."
