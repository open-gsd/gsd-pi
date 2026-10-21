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
# Idempotent: a package already published at this version is skipped.
#
# Env:
#   TAG_FLAG        extra npm publish flags (e.g. "--tag latest"); optional
#   NODE_AUTH_TOKEN npm auth token for the token-auth fallback; optional (OIDC default)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG_FLAG="${TAG_FLAG:-}"

# Extract the dist-tag name from TAG_FLAG (e.g. "--tag latest" → "latest").
# Echoes "" if no --tag is present.
_extract_tag() {
  if [[ "${TAG_FLAG}" =~ --tag[[:space:]]+([^[:space:]]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

# Verify that dist-tag $2 on package $1 resolves to ${VERSION}; exits 1 if not.
_verify_dist_tag() {
  local pkg="$1" tag="$2"
  local actual
  actual=$(npm view "${pkg}" "dist-tags.${tag}" 2>/dev/null || true)
  if [[ "${actual}" != "${VERSION}" ]]; then
    echo "::error::@${tag} points to '${actual:-<unset>}' not ${VERSION} for ${pkg}."
    echo "::error::Move the tag manually if intended: npm dist-tag add ${pkg}@${VERSION} ${tag}"
    exit 1
  fi
  echo "Confirmed: ${pkg} @${tag} → ${VERSION}."
}

# Lines of "<name>:<workspace-dir>" in dependency order.
mapfile -t _raw_entries < <(node scripts/lib/npm-release-packages.cjs --workspace-dirs)
# Filter empty strings (defense-in-depth: prevents a stray trailing newline
# from loading one blank element that bypasses the early-exit check).
ENTRIES=()
for _e in "${_raw_entries[@]+"${_raw_entries[@]}"}"; do
  [[ -n "$_e" ]] && ENTRIES+=("$_e")
done
unset _raw_entries _e

if [ "${#ENTRIES[@]}" -eq 0 ]; then
  echo "No publishable workspace packages found."
  exit 0
fi

wait_for_workspace_package() {
  local package="$1"
  local delay=5
  for attempt in $(seq 1 10); do
    if [ "$(npm view "${package}@${VERSION}" version 2>/dev/null || echo "")" = "${VERSION}" ]; then
      echo "  ✓ ${package}@${VERSION} visible on npm (attempt ${attempt})"
      return 0
    fi
    if [ "${attempt}" = "10" ]; then
      # `npm publish` already confirmed registry acceptance ("+ pkg@version").
      # Brand-new packages can lag significantly in read-after-write propagation,
      # so a slow read MUST NOT abort the remaining publishes (that is exactly how
      # later packages like mcp-server got left unpublished). Warn and continue;
      # the verify-npm-release gate before the GitHub release is the real check.
      echo "::warning::${package}@${VERSION} not yet visible on npm after ${attempt} attempts; publish was accepted, continuing."
      return 0
    fi
    echo "  Attempt ${attempt}: ${package}@${VERSION} not visible yet, retrying in ${delay}s..."
    sleep "${delay}"
    delay=$((delay * 2))
    if [ "${delay}" -gt 30 ]; then delay=30; fi
  done
}

echo "Publishing ${#ENTRIES[@]} workspace package(s) at ${VERSION} (dependency order):"
printf '  - %s\n' "${ENTRIES[@]}"

for entry in "${ENTRIES[@]}"; do
  workspace="${entry%%:*}"
  dir="${entry#*:}"
  _tag="$(_extract_tag)"
  if npm view "${workspace}@${VERSION}" version >/dev/null 2>&1; then
    if [[ -n "${_tag}" ]]; then
      echo "${workspace}@${VERSION} already on registry — verifying @${_tag} dist-tag."
      _verify_dist_tag "${workspace}" "${_tag}"
    else
      echo "${workspace}@${VERSION} already published, skipping"
    fi
    continue
  fi
  # Publish from the package's OWN directory. `npm publish --workspace` does NOT
  # work here: the repo defines its workspace via pnpm-workspace.yaml and root
  # package.json has no npm "workspaces" field, so npm reports "No workspaces
  # found" and silently publishes nothing. prepack-resolve-workspace.cjs (run by
  # the caller) has already rewritten internal workspace:* ranges to ^VERSION.
  # shellcheck disable=SC2086
  if OUTPUT=$( cd "${ROOT}/${dir}" && npm publish --ignore-scripts ${TAG_FLAG} 2>&1 ); then
    echo "$OUTPUT"
  elif echo "$OUTPUT" | grep -q "cannot publish over the previously published\|You cannot publish over"; then
    echo "::warning::${workspace}@${VERSION} concurrent publish detected — verifying dist-tag."
    if [[ -n "${_tag}" ]]; then
      _verify_dist_tag "${workspace}" "${_tag}"
    else
      echo "${workspace}@${VERSION} already published (no dist-tag to verify), skipping."
    fi
    continue
  else
    echo "$OUTPUT"
    exit 1
  fi
  wait_for_workspace_package "${workspace}"
done

echo "All workspace packages published at ${VERSION}."
