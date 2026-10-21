# Plan 010: Redact secrets before persisting activity and exec-sandbox logs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 58dc840f..HEAD -- src/resources/extensions/gsd/activity-log.ts src/resources/extensions/gsd/exec-sandbox.ts src/resources/extensions/gsd/workflow-logger.ts`
> If any file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `58dc840f`, 2026-07-01

## Why this matters

Two on-disk sinks persist raw content without redaction:
`saveActivityLog` writes every LLM/session entry verbatim to `.gsd/activity/*.jsonl`,
and the exec-sandbox captures subprocess stdout/stderr verbatim to `.gsd/exec/`.
Tool output and model context routinely contain API keys, bearer tokens, and
`Authorization` headers (a package manager echoing a registry token, `env` in a
shell step, a curl `-H`). The repo already ships a redaction allow-list
(`_sanitizeForAudit` in `workflow-logger.ts`) and a pattern set in
`scripts/secret-scan.mjs`, but neither runs on these two paths — and
`secret-scan.mjs` explicitly skips `.gsd/`. The result is credentials sitting in
plaintext in the project's state dir, later surfaced back to the agent through
`exec-history` / `digest_preview`. This plan adds one shared redaction helper and
applies it at both write points.

## Current state

- `src/resources/extensions/gsd/activity-log.ts` — `saveActivityLog` streams
  `JSON.stringify(entry)` per session entry (around lines 129-131):

  ```ts
      const fd = openSync(filePath, "w");
      try {
        for (const entry of entries) {
          writeSync(fd, JSON.stringify(entry) + "\n");
        }
      } finally {
        closeSync(fd);
      }
  ```

- `src/resources/extensions/gsd/exec-sandbox.ts` — captures child stdout/stderr
  into buffers that are later written to `.gsd/exec/` (capture around lines
  197-200 and the persisted-output write further down; grep `exec/` and
  `stdout`/`stderr` in this file to find the exact write).

- `src/resources/extensions/gsd/workflow-logger.ts` — `_sanitizeForAudit`
  (line ~364) is an **allow-list** sanitizer for structured log context; it is
  the wrong shape for free-text output but is the precedent for "sanitize before
  persist." `scripts/secret-scan.mjs` holds the regex patterns for secret
  shapes (AWS keys, generic `token`/`key`/`secret` assignments, bearer tokens).

Conventions: single quotes dominate this directory; best-effort file ops use
`try/catch` with an explanatory comment. New shared helpers for the gsd
extension live under `src/resources/extensions/gsd/`. Redaction must be
**value-replacing**, not entry-dropping — replace the secret substring with
`«redacted»`, preserving surrounding text so logs stay useful.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck (extensions) | `pnpm run typecheck:extensions` | exit 0, no errors |
| Compile tests | `pnpm run test:compile` | exit 0 |
| Run the new test | `node --import ./scripts/dist-test-resolve.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/redact-secrets.test.ts` | pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/redact-secrets.ts` (create — the shared helper)
- `src/resources/extensions/gsd/activity-log.ts` (apply at the write loop)
- `src/resources/extensions/gsd/exec-sandbox.ts` (apply before persisting output)
- `src/resources/extensions/gsd/tests/redact-secrets.test.ts` (create)

**Out of scope** (do NOT touch):
- `workflow-logger.ts` `_sanitizeForAudit` — different shape, leave it.
- `scripts/secret-scan.mjs` — reuse its patterns by copying the regexes into the
  new helper; do not refactor the script to export them (it runs standalone).
- The `.gsd/` skip in the secret scanner — unrelated.

## Git workflow

- Branch: `advisor/010-redact-secrets-in-persisted-logs`
- Conventional Commits (e.g. `fix(gsd): redact secrets before persisting activity and exec logs`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create the redaction helper

Create `src/resources/extensions/gsd/redact-secrets.ts` exporting
`redactSecrets(text: string): string`. Port the secret-shape regexes from
`scripts/secret-scan.mjs` (read that file first). Cover at minimum:

- `Authorization: Bearer <token>` and `Bearer <token>` → keep the label, redact the token.
- Assignments like `<KEY>=<value>` / `"<KEY>": "<value>"` where the key name
  matches `/(api[_-]?key|secret|token|password|passwd|credential)/i` → redact the value.
- AWS access key IDs (`AKIA[0-9A-Z]{16}`) and long hex/base64 blobs adjacent to
  a secret-ish key.

Replace matched secret spans with `«redacted»`. The function must be pure and
allocation-light (it runs per log line). Use the two-line file-purpose header
convention seen in sibling files.

**Verify**: `pnpm run typecheck:extensions` → exit 0.

### Step 2: Apply in activity-log

In `saveActivityLog`, wrap the per-entry serialization:
`writeSync(fd, redactSecrets(JSON.stringify(entry)) + "\n")`. Redacting the
serialized JSON string (not per-field) keeps it simple and catches secrets
regardless of which field they hide in.

**Verify**: `grep -n "redactSecrets" src/resources/extensions/gsd/activity-log.ts` → one match at the write.

### Step 3: Apply in exec-sandbox

Find where captured stdout/stderr is written to `.gsd/exec/` (the persisted
artifact, not the live stream returned to the caller — do not alter what the
tool returns in-process, only what is written to disk). Run the persisted
buffers through `redactSecrets` immediately before the disk write.

**Verify**: `grep -n "redactSecrets" src/resources/extensions/gsd/exec-sandbox.ts` → one match at the persist point.

## Test plan

Create `src/resources/extensions/gsd/tests/redact-secrets.test.ts` (model after
any `*.test.ts` in `src/resources/extensions/gsd/tests/`). Cases:

- `Authorization: Bearer sk-abc123...` → token replaced, `Authorization: Bearer` label intact.
- `ANTHROPIC_API_KEY=sk-ant-...` and `"token": "ghp_..."` → value replaced.
- `AKIA` access-key id → replaced.
- A benign line with the word "token" but no secret value is left unchanged
  (guards against over-redaction that would gut the logs).
- Round-trip: `redactSecrets(JSON.stringify({msg: "key=SECRETVALUE"}))` is still
  valid JSON after redaction (the replacement token contains no quote/brace).

**Verify**: the test command from the table → all pass.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] `pnpm run test:compile` exits 0
- [ ] `redact-secrets.test.ts` exists and passes with the 5 cases above
- [ ] `grep -rn "redactSecrets" src/resources/extensions/gsd/{activity-log,exec-sandbox}.ts` shows one call in each
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- The activity-log write loop or exec-sandbox persist path no longer matches the
  excerpts (drifted).
- You cannot locate a distinct "persist to `.gsd/exec/`" write in exec-sandbox
  separate from the in-process return value — if the same buffer is both
  returned and written, redacting it would alter tool output the agent sees;
  report before changing return semantics.
- Redaction would need to run on a hot per-token streaming path (perf) rather
  than once per completed entry — report; the intent is per-entry, not per-chunk.

## Maintenance notes

- New on-disk sinks (session transcripts, forensics dumps) should reuse
  `redactSecrets`. Grep for `.gsd/` + `writeSync`/`writeFileSync` when adding one.
- Redaction is best-effort defense-in-depth, not a guarantee — a reviewer should
  understand it reduces exposure, and the real fix for a leaked key is still
  rotation. Do not weaken the memory-extractor's existing pre-LLM redaction on
  the strength of this.
- If false-positive over-redaction is reported (logs losing useful data), tighten
  the key-name regex rather than removing the pass.
