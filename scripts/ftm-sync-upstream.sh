#!/usr/bin/env bash
# FTM fork: merge the latest stable open-gsd/gsd-pi release into main.
#
# Usage:
#   scripts/ftm-sync-upstream.sh              # merge, build, open PR + auto-merge
#   scripts/ftm-sync-upstream.sh --dry-run    # print target tag / noop decision
#   scripts/ftm-sync-upstream.sh --no-pr      # merge + build locally; do not push/PR
#
# Env:
#   UPSTREAM_REPO   default open-gsd/gsd-pi
#   PNPM_VERSION    default 10.12.1 (matches packageManager)
#   GH_TOKEN / GITHUB_TOKEN  required for gh release + PR steps (unless --no-pr/--dry-run)

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-open-gsd/gsd-pi}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO}.git}"
PNPM_VERSION="${PNPM_VERSION:-10.12.1}"
DRY_RUN=0
NO_PR=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-pr) NO_PR=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# Prefer the real GitHub CLI over shadow binaries (e.g. conda "Github browser opener"
# also named `gh`). Export GH_BIN for subsequent gh invocations.
resolve_github_cli() {
  if [[ -n "${GH_BIN:-}" && -x "${GH_BIN}" ]]; then
    if "$GH_BIN" --version 2>/dev/null | grep -q '^gh version'; then
      export PATH="$(dirname "$GH_BIN"):$PATH"
      return 0
    fi
  fi
  local candidate
  for candidate in \
    "${GH_BIN:-}" \
    "$(command -v gh 2>/dev/null || true)" \
    /usr/bin/gh \
    /opt/homebrew/bin/gh \
    "$HOME/.local/bin/gh"
  do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if "$candidate" --version 2>/dev/null | grep -q '^gh version'; then
      GH_BIN="$candidate"
      export GH_BIN
      # Put the real CLI ahead of PATH shadows for bare `gh` calls.
      export PATH="$(dirname "$candidate"):$PATH"
      return 0
    fi
  done
  return 1
}

require_cmd git
require_cmd node

require_github_cli() {
  resolve_github_cli || die "GitHub CLI (cli/cli) required; install https://cli.github.com/ (not a conda/browser 'gh' shim)"
}

ensure_remotes() {
  if ! git remote get-url origin >/dev/null 2>&1; then
    die "origin remote is required"
  fi
  if git remote get-url upstream >/dev/null 2>&1; then
    local current
    current="$(git remote get-url upstream)"
    if [[ "$current" != "$UPSTREAM_URL" && "$current" != "${UPSTREAM_URL%.git}" && "$current" != "${UPSTREAM_URL}.git" ]]; then
      log "Updating upstream remote URL -> $UPSTREAM_URL"
      git remote set-url upstream "$UPSTREAM_URL"
    fi
  else
    log "Adding upstream remote -> $UPSTREAM_URL"
    git remote add upstream "$UPSTREAM_URL"
  fi
}

resolve_tag() {
  local tag=""
  if resolve_github_cli; then
    tag="$(gh release view --repo "$UPSTREAM_REPO" --json tagName -q .tag_name 2>/dev/null || true)"
  fi
  if [[ -z "$tag" ]]; then
    log "gh release lookup unavailable; falling back to git ls-remote tags"
    git fetch upstream --tags --quiet
    tag="$(
      git ls-remote --tags --refs upstream \
        | awk '{print $2}' \
        | sed 's#refs/tags/##' \
        | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
        | sort -V \
        | tail -1
    )"
  fi
  [[ -n "$tag" ]] || die "could not resolve latest upstream release tag"
  printf '%s\n' "$tag"
}

normalize_ref() {
  # Accept v1.22.0 or 1.22.0; prefer the form that exists as a tag.
  local tag="$1"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    printf '%s\n' "$tag"
    return
  fi
  if [[ "$tag" == v* ]] && git rev-parse -q --verify "refs/tags/${tag#v}" >/dev/null 2>&1; then
    printf '%s\n' "${tag#v}"
    return
  fi
  if [[ "$tag" != v* ]] && git rev-parse -q --verify "refs/tags/v$tag" >/dev/null 2>&1; then
    printf '%s\n' "v$tag"
    return
  fi
  printf '%s\n' "$tag"
}

ensure_remotes
git fetch origin --prune --quiet
git fetch upstream --tags --prune --quiet

TAG_RAW="$(resolve_tag)"
# Ensure the tag object is present after fetch
if ! git rev-parse -q --verify "refs/tags/$TAG_RAW" >/dev/null 2>&1 \
  && ! git rev-parse -q --verify "refs/tags/${TAG_RAW#v}" >/dev/null 2>&1 \
  && ! git rev-parse -q --verify "refs/tags/v${TAG_RAW#v}" >/dev/null 2>&1; then
  die "tag $TAG_RAW not found after fetching upstream"
fi
TAG="$(normalize_ref "$TAG_RAW")"
TAG_SHA="$(git rev-parse "refs/tags/$TAG^{commit}")"
BRANCH="sync/upstream-$TAG"

log "Latest upstream release: $TAG ($TAG_SHA)"

if git merge-base --is-ancestor "$TAG_SHA" "origin/main"; then
  log "origin/main already contains $TAG — nothing to do"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run: would merge $TAG into branch $BRANCH from origin/main"
  exit 0
fi

git checkout -B "$BRANCH" "origin/main"

set +e
git merge --no-ff "$TAG_SHA" -m "Merge upstream $TAG"
MERGE_RC=$?
set -e

if [[ "$MERGE_RC" -ne 0 ]]; then
  log "Merge conflict while integrating $TAG"
  if [[ "$NO_PR" -eq 1 ]]; then
    die "merge conflict; resolve locally on $BRANCH (left in conflicted state)"
  fi
  require_github_cli
  # Commit conflict markers so the PR is actionable; do not invent resolutions.
  git add -A
  git commit --no-verify -m "WIP: merge upstream $TAG (conflicts — needs human)"
  git push -u origin "$BRANCH" --force-with-lease
  if gh pr view "$BRANCH" --json number >/dev/null 2>&1; then
    log "PR already open for $BRANCH"
  else
    gh pr create \
      --base main \
      --head "$BRANCH" \
      --title "sync: merge upstream $TAG (conflicts — needs human)" \
      --body "$(cat <<EOF
Automated FTM upstream sync hit merge conflicts integrating \`$TAG\`.

Conflict markers are committed on \`$BRANCH\` for manual resolution.

## What to do
1. Checkout \`$BRANCH\` and resolve conflict markers.
2. \`pnpm install\` with pnpm@$PNPM_VERSION and \`pnpm run build:web-host\`
3. Amend/replace the WIP commit as needed, push, and merge this PR.

Likely FTM touchpoints: \`runtime-control\`, hooks, agent-core.

Upstream: https://github.com/${UPSTREAM_REPO}/releases/tag/$TAG
EOF
)"
  fi
  exit 1
fi

log "Merge clean; building web host with pnpm@$PNPM_VERSION"
require_cmd corepack
corepack prepare "pnpm@$PNPM_VERSION" --activate
pnpm install
# Fresh package dists so src extensions see updated ProviderConfig / ModelRegistry
# types after an upstream bump (build:web-host alone does not rebuild packages).
pnpm run build:pi-coding-agent
pnpm --filter @gsd/agent-core run build
pnpm run build:web-host

if [[ "$NO_PR" -eq 1 ]]; then
  log "Build OK. --no-pr set; leaving branch $BRANCH checked out (not pushed)"
  exit 0
fi

require_github_cli
git push -u origin "$BRANCH" --force-with-lease

PR_URL=""
if PR_URL="$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null)"; then
  log "PR already exists: $PR_URL"
else
  PR_URL="$(
    gh pr create \
      --base main \
      --head "$BRANCH" \
      --title "sync: merge upstream $TAG" \
      --body "$(cat <<EOF
Automated FTM sync of upstream stable release \`$TAG\`.

- Source: https://github.com/${UPSTREAM_REPO}/releases/tag/$TAG
- Gate: \`pnpm@$PNPM_VERSION\` + \`pnpm run build:web-host\`
- After merge on the daemon host: \`scripts/ftm-deploy-local.sh\`

See \`docs/FTM-UPSTREAM-SYNC.md\`.
EOF
)"
  )"
  log "Opened PR: $PR_URL"
fi

# Prefer merge commits to match historical "Merge upstream …" style.
if gh pr merge "$BRANCH" --auto --merge 2>/dev/null; then
  log "Auto-merge enabled for $BRANCH"
else
  log "Could not enable auto-merge (repo setting or permissions). PR left open: $PR_URL"
fi

exit 0
