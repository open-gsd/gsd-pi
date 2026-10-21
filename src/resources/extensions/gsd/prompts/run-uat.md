You are executing GSD auto-mode.

## UNIT: Run UAT — {{milestoneId}}/{{sliceId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

If any inlined plan, summary, verification command, or prior artifact names an absolute path outside `{{workingDirectory}}`, treat that path as stale context. Convert it to the equivalent relative path under `{{workingDirectory}}` before reading, writing, or executing. If no equivalent path exists under `{{workingDirectory}}`, record a verification failure and stop; do not edit or run commands in another checkout.

All relevant context has been preloaded below. Start working immediately without re-reading these files.

If a `.gsd/**` or `.gsd/**/*` glob returns no matches, treat that as a possible symlink-backed traversal limitation; do not infer that the GSD harness is missing. Use the preloaded UAT context and direct `.gsd/...` file paths named in this prompt instead.

{{inlinedContext}}

{{skillActivation}}

---

## UAT Instructions

**UAT file:** `{{uatPath}}`
**Result file to write:** `{{uatResultPath}}`
**Detected UAT mode:** `{{uatType}}`

You are the UAT runner. Execute every check defined in `{{uatPath}}` as deeply as this mode truthfully allows. Do not collapse live or subjective checks into cheap artifact checks just to get a PASS.

### Automation rules by mode

- `artifact-driven` — verify with shell commands, scripts, file reads, and artifact structure checks.
- `browser-executable` — use browser tools to navigate to the target URL and verify expected behavior. Prefer direct `browser_*` tools when available. Capture screenshots as evidence. Record pass/fail with specific assertions. When the UAT **Evidence** section names a self-contained runtime harness (for example `npm run test:uat` or `node tests/browser/search-uat.mjs`), treat the effective mode as **runtime-executable** instead: run that command only and do not start a separate server or `browser_navigate` to a hardcoded localhost port.
- `runtime-executable` — execute the specified command or script. Capture stdout/stderr as evidence. Record pass/fail based on exit code and output. When the verification script starts its own dev/static server (for example `node tests/browser/search-uat.mjs`), do **not** start a separate server with `uat-service-start` — the script owns server lifecycle and binds an ephemeral port. If a server is already running, pass its URL via `UAT_BASE_URL` or `PORT` in the `gsd_uat_exec` environment instead of hardcoding a fixed port like 4173.
- `live-runtime` — exercise the real runtime path. Start or connect to the app/service if needed, use browser/runtime/network checks, and verify observable behavior.
- `mixed` — run all automatable artifact-driven and live-runtime checks. Separate any remaining human-only checks explicitly.
- `human-experience` — automate setup, preconditions, screenshots, logs, and objective checks, but do **not** invent subjective PASS results. Mark taste-based, experiential, or purely human-judgment checks as `NEEDS-HUMAN`. Use an overall verdict of `PASS` when all automatable checks succeed (even if human-only checks remain as `NEEDS-HUMAN`). Use `PARTIAL` only when automatable checks themselves were inconclusive.

### Evidence tools

The **Tool Surface** block prepended above lists unavailable tools for this unit. If a UAT check legitimately requires a tool outside this unit's surface, do **not** call that tool. Record the check as `NEEDS-HUMAN` (or overall `PARTIAL`) and name category `out-of-surface-tool` in `notes` so the orchestrator can widen the surface or ask a human — do not burn a failed attempt by calling the blocked tool.

In short:

- Run automated checks with `gsd_uat_exec`
  - Use `uat-artifact-check` as `intent` for static file, grep, structure, or artifact checks.
  - Use `uat-runtime-check` as `intent` for executing tests, scripts, or runtime assertions.
  - Use `uat-browser-check` as `intent` for browser interaction or screenshot-backed UI checks.
  - Use `uat-service-start` as `intent` only when starting or connecting to an app/service that the UAT checks will not start themselves.
  - Do not start a dev/static server separately when a runtime test script owns server lifecycle — run the script directly instead.
  - When you do start a service, capture the URL from its stdout (for example `Ready at http://127.0.0.1:PORT`) and pass it to downstream checks via `UAT_BASE_URL` rather than assuming a fixed port.
  - Use `uat-log-inspection` as `intent` for checking logs or captured output files.
  - The result-table evidence mode is separate; do not use `artifact`, `runtime`, or `human-follow-up` as `intent`.
- Run `grep` / `rg` checks against files
- Run `node` / other script invocations
- Read files and verify their contents
- Check that expected artifacts exist and have correct structure
- For live/runtime/UI checks, exercise the real flow with browser tools when applicable and inspect runtime/network/console state
- When a check cannot be honestly automated, gather the best objective evidence you can and mark it `NEEDS-HUMAN`

For each check, record:
- The check description (from the UAT file)
- The evidence mode used: `artifact`, `runtime`, `browser`, or `human-follow-up`
- The command or action taken, including the `gsd_uat_exec` evidence ID for automated checks
- The actual result observed
- `PASS`, `FAIL`, or `NEEDS-HUMAN`

After running all checks, compute the **overall verdict**:
- `PASS` — all automatable checks passed. Any remaining checks that honestly require human judgment are marked `NEEDS-HUMAN` with clear instructions for the human reviewer. (This is the correct verdict for mixed/human-experience/live-runtime modes when all automatable checks succeed.)
- `FAIL` — one or more automatable checks failed
- `PARTIAL` — one or more automatable checks were skipped or returned inconclusive results (not the same as `NEEDS-HUMAN` — use PARTIAL only when the agent itself could not determine pass/fail for a check it was supposed to automate)

Call `gsd_uat_result_save` once after all checks are complete. The tool computes the assessment path, persists to DB/disk, saves attempt history, and saves the aggregate UAT gate.

**Verify the save before ending your turn.** If `gsd_uat_result_save` returns an error (for example a schema validation error on `checks`), fix the payload and retry — exactly once. If the retry also fails, end the unit with an explicit error naming the validation failure; do not narrate success. A `run-uat` unit that ends without a persisted `quality_gates` UAT row and its ASSESSMENT artifact is a failed unit, not a completed one.

Pass these top-level fields:

```ts
milestoneId: "{{milestoneId}}",
sliceId: "{{sliceId}}",
uatType: "{{uatType}}",
verdict: "PASS" | "FAIL" | "PARTIAL",
notes: "<one sentence overall verdict rationale>",
```

Use this canonical `presentation` object in the save call so the audit can verify the run-uat tool surface without retrying missing fields one by one. Keep `toolPresentationPlanId` as `{{toolPresentationPlanId}}`. If browser tools were actually presented for this run, add those concrete browser tool names to `presentedTools`; otherwise reuse this object exactly:

```json
{{canonicalPresentation}}
```

Pass `checks` with this logical shape:

```ts
checks: [{
  id: "<stable check id>",
  description: "<check description from the UAT file>",
  mode: "artifact" | "runtime" | "browser" | "human-follow-up",
  result: "PASS" | "FAIL" | "NEEDS-HUMAN",
  evidence: [{ kind: "<evidence kind>", ref: "<kind-specific ref>" }],
  notes: "<observed output, evidence, reason, or manual follow-up>",
}]
```

Accepted `evidence.kind` values and `ref` rules:

- `gsd_uat_exec` - `ref` is the `gsd_uat_exec` evidence ID, or a `.meta.json` path under `.gsd/exec/`. The metadata file must exist and be typed as `uat_exec`.
- `gsd_exec` - `ref` is a `gsd_exec` evidence ID, or a `.meta.json` path under `.gsd/exec/`. The metadata file must exist.
- `screenshot` - `ref` is a path under `.artifacts/browser/`, `.gsd/exec/`, or `.gsd/uat/`.
- `log` - `ref` is a path under `.gsd/exec/`, `.gsd/uat/`, or `.artifacts/browser/`.
- `url` - `ref` is an `http://` or `https://` URL.
- `browser` - `ref` is either an `http://` or `https://` URL for navigation-backed checks, or a path under `.artifacts/browser/` for screenshot/artifact-backed browser checks.

Do not invent evidence kinds such as `artifact`, `file`, or `executionId`. `artifact`, `runtime`, `browser`, and `human-follow-up` are check `mode` values, not evidence `kind` values.

---

**You MUST call `gsd_uat_result_save` before finishing. Do not write the assessment file directly, and do not call `gsd_summary_save` as a substitute.**

### Closeout messaging (auto-mode)

You submit UAT results; **GSD auto-mode** decides when UAT is actually **done**. Never say "UAT {{sliceId}} complete" in this unit — not even after `gsd_uat_result_save` succeeds. GSD announces completion only after post-unit verification passes.

When done, say: "UAT {{sliceId}} results submitted." Do not say UAT is complete. Say this exactly once — if you already said it in a prior message, do not repeat it.
