#!/usr/bin/env bash
# Publish all @opengsd/engine-* platform packages for the root package version.
# Skips packages already on npm; continues on per-platform failure and reports a summary at the end (avoids leaving platforms unpublished after an early exit).

set -euo pipefail

PLATFORMS=(darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu win32-x64-msvc)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${ENGINE_VERSION:-$(node -p "require('./package.json').version")}"
TAG_FLAG="${TAG_FLAG:-}"

FAILED=()
SKIPPED=()
PUBLISHED=()

for platform in "${PLATFORMS[@]}"; do
  PKG="@opengsd/engine-${platform}"
  EXISTING="$(npm view "${PKG}@${VERSION}" version 2>/dev/null || true)"

  if [ "${EXISTING}" = "${VERSION}" ]; then
    echo "✓ ${PKG}@${VERSION} already on npm, skipping"
    SKIPPED+=("${platform}")
    continue
  fi

  echo "Publishing ${PKG}@${VERSION}..."
  cd "${ROOT}/native/npm/${platform}"
  # shellcheck disable=SC2086
  if OUTPUT="$(npm publish --access public ${TAG_FLAG} 2>&1)"; then
    echo "${OUTPUT}"
    PUBLISHED+=("${platform}")
  elif echo "${OUTPUT}" | grep -qE "cannot publish over the previously published|You cannot publish over"; then
    echo "Already published ${PKG}, skipping"
    SKIPPED+=("${platform}")
  else
    echo "::error::Failed to publish ${platform}:"
    echo "${OUTPUT}"
    FAILED+=("${platform}")
  fi
  cd "${ROOT}"
done

echo ""
echo "Engine package publish summary for ${VERSION}:"
echo "  published: ${PUBLISHED[*]:-none}"
echo "  skipped:   ${SKIPPED[*]:-none}"
echo "  failed:    ${FAILED[*]:-none}"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "::error::${#FAILED[@]} platform package(s) failed to publish: ${FAILED[*]}"
  echo "::error::If packages do not exist on npm yet, re-run with publish_auth=token and NPM_TOKEN set. See docs/dev/ci-cd-pipeline.md."
  exit 1
fi
