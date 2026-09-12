#!/usr/bin/env bash
# Dispatch helper for .github/workflows/pre-review-verification-sharded.yml.

set -euo pipefail

HARNESS_REPO="open-gsd/gsd-pi"
SOURCE_REPO="pimmink/gsd-pi"
SOURCE_REF=""
EXPECTED_SHA=""
SHARD_COUNT="4"
WORKFLOW_REF="main"
WORKFLOW_FILE="pre-review-verification-sharded.yml"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/pre-review-verify.sh dispatch --source-ref <branch> --expected-sha <40-char-sha> [options]
  scripts/pre-review-verify.sh status <run-id> [--repo owner/repo]

Options for dispatch:
  --source-repo owner/repo   Source repository containing the branch (default: pimmink/gsd-pi)
  --repo owner/repo          Repository containing the workflow (default: open-gsd/gsd-pi)
  --workflow-ref ref         Ref containing the workflow file (default: main)
  --shard-count n           Number of shards (default: 4)

The helper verifies source_ref resolves to expected_sha before dispatching.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

parse_dispatch_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source-repo) SOURCE_REPO="$2"; shift 2 ;;
      --source-ref) SOURCE_REF="$2"; shift 2 ;;
      --expected-sha) EXPECTED_SHA="$2"; shift 2 ;;
      --repo) HARNESS_REPO="$2"; shift 2 ;;
      --workflow-ref) WORKFLOW_REF="$2"; shift 2 ;;
      --shard-count) SHARD_COUNT="$2"; shift 2 ;;
      *) die "unknown dispatch argument: $1" ;;
    esac
  done
  [[ "$SOURCE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--source-repo must be owner/repo"
  [[ -n "$SOURCE_REF" ]] || die "--source-ref is required"
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--expected-sha must be a full 40-character lowercase SHA"
  [[ "$SHARD_COUNT" =~ ^[0-9]+$ ]] || die "--shard-count must be an integer"
}

dispatch() {
  parse_dispatch_args "$@"
  local remote_line remote_sha before_id run_id run_url
  remote_line="$(git ls-remote "https://github.com/${SOURCE_REPO}.git" "refs/heads/${SOURCE_REF}")" || die "git ls-remote failed"
  [[ -n "$remote_line" ]] || die "refs/heads/${SOURCE_REF} does not exist on ${SOURCE_REPO}"
  remote_sha="$(printf '%s\n' "$remote_line" | cut -f1)"
  [[ "$remote_sha" == "$EXPECTED_SHA" ]] || die "${SOURCE_REPO}:${SOURCE_REF} is ${remote_sha}, not ${EXPECTED_SHA}"

  before_id="$(gh run list --repo "$HARNESS_REPO" --workflow "$WORKFLOW_FILE" --limit 1 --json databaseId --jq '.[0].databaseId // "none"' 2>/dev/null || echo none)"
  gh workflow run "$WORKFLOW_FILE" --repo "$HARNESS_REPO" --ref "$WORKFLOW_REF" \
    -f "source_repo=${SOURCE_REPO}" \
    -f "source_ref=${SOURCE_REF}" \
    -f "expected_sha=${EXPECTED_SHA}" \
    -f "shard_count=${SHARD_COUNT}"

  for _ in {1..20}; do
    sleep 3
    run_id="$(gh run list --repo "$HARNESS_REPO" --workflow "$WORKFLOW_FILE" --limit 1 --json databaseId --jq '.[0].databaseId // "none"' 2>/dev/null || echo none)"
    if [[ "$run_id" != "none" && "$run_id" != "$before_id" ]]; then
      run_url="$(gh run view "$run_id" --repo "$HARNESS_REPO" --json url --jq '.url')"
      echo "run-id: ${run_id}"
      echo "run-url: ${run_url}"
      echo "source: ${SOURCE_REPO}:${SOURCE_REF} @ ${EXPECTED_SHA}"
      return 0
    fi
  done
  die "could not determine newly-dispatched run id"
}

status() {
  local run_id="${1:-}"
  shift || true
  [[ -n "$run_id" ]] || die "run id is required"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) HARNESS_REPO="$2"; shift 2 ;;
      *) die "unknown status argument: $1" ;;
    esac
  done
  gh run view "$run_id" --repo "$HARNESS_REPO"
}

main() {
  require_cmd git
  require_cmd gh
  local command="${1:-}"
  shift || true
  case "$command" in
    dispatch) dispatch "$@" ;;
    status) status "$@" ;;
    -h|--help|"") usage ;;
    *) die "unknown command: $command" ;;
  esac
}

main "$@"