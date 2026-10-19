#!/usr/bin/env bash
# Publish all @opengsd/engine-* platform packages for the root package version.
# Reuses only byte-identical packages; reports every per-platform failure.

set -euo pipefail

PLATFORMS=(darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu win32-x64-msvc)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${ENGINE_VERSION:-$(node -p "require('./package.json').version")}"
TAG="latest"
if [[ -n "${TAG_FLAG:-}" ]]; then
  if [[ "${TAG_FLAG}" =~ ^--tag[[:space:]]+([a-z][a-z0-9-]*)$ ]]; then
    TAG="${BASH_REMATCH[1]}"
  else
    echo "::error::Unsupported TAG_FLAG: ${TAG_FLAG}"
    exit 1
  fi
fi

FAILED=()
PUBLISHED=()

for platform in "${PLATFORMS[@]}"; do
  PKG="@opengsd/engine-${platform}"
  echo "Publishing and verifying ${PKG}@${VERSION}..."
  if node "${ROOT}/scripts/publish-npm-package.mjs" "${ROOT}/native/npm/${platform}" "${VERSION}" "${TAG}"; then
    PUBLISHED+=("${platform}")
  else
    FAILED+=("${platform}")
  fi

done

echo ""
echo "Engine package publish summary for ${VERSION}:"
echo "  published/verified: ${PUBLISHED[*]:-none}"
echo "  failed:    ${FAILED[*]:-none}"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "::error::${#FAILED[@]} platform package(s) failed to publish: ${FAILED[*]}"
  echo "::error::If packages do not exist on npm yet, re-run with publish_auth=token and NPM_TOKEN set. See docs/dev/ci-cd-pipeline.md."
  exit 1
fi
