<!-- markdownlint-disable MD013 -->

# Exec host findings and bounded repair plan — 2026-11-11

> Plan and observed blockers, not acceptance. H01–H12 are not collectively passed, #2916 is not complete, and this document does not approve or install a release.

This follows the [canonical host matrix](2916-host-acceptance-matrix.md) for [#2916](https://github.com/open-gsd/gsd-pi/issues/2916), under [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). Closed implementation/documentation children remain delivered work; the remaining task is truthful, source-bound host acceptance and any repairs it actually requires.

## Observed candidate and evidence boundary

The installed package was **1.23.0**, associated with source `a21924b9b6c77316d7185fb208b72dcdf990934b`. Existing exact-source CI/build evidence was reused as preparation, never as host PASS. Bootstrap, interactive core and RPC core hashes were rechecked against the preserved installation audit. Later process-scoped V8 coverage demonstrated execution of the actual core mode/renderer and MCP-server modules; resolving a filename alone was not counted as loaded-code proof.

Core `@gsd/agent-modes` and bundled/managed extensions are separate layers. A missing core marker in the extensions directory is not evidence that the core fix is absent.

Observations used fresh owned CLI processes, isolated writable profiles/workspaces, a deterministic credential-free provider and real tool calls. Native captures came from one explicitly owned cmux surface and actual interactive PTYs. Other windows were not driven. No installed-package rebuild, global installation or cmux restart was performed.

[The public findings projection](2916-host-findings-20261111.json) contains original capture hashes, actual header text, relevant result fields and provenance labels. It excludes private session context and unrelated workstream logs. The original raw packet is retained separately by its operator.

Historical contradictory payloads are **declared controlled replay fixtures**, derived from real synthetic-session graphs with field-level provenance. They are not represented as historical production executions. The native host actually loaded each fixture and navigated to the selected tool-result entry. A scoped guard recorded zero attempted accesses to the fixture metadata paths; that is not a global filesystem or subprocess audit.

## F1 — In-flight arguments are not reflected consistently

During two parallel Node exec calls, sibling A retained **`Run a Bash script`** while running, although its actual call arguments specified `runtime: node` and purpose **`Observe sibling A while sibling B runs`**. Sibling B displayed its supplied purpose. A displayed the correct purpose only after completion. The behavior was captured both during ordinary running display and inspection while the siblings were active.

This is not narrow-width purpose elision. The relevant normal-width view was 110 PTY columns. Execution and persisted call arguments remained correct; the observed defect is presentation of the active call.

The repair must trace how complete execution-start arguments refresh an already-created streamed component. The proposed invariant is that the current executed call's complete arguments—not a stale partial-call default—drive its running presentation. Do not change execution arguments, tool IDs or backend state to repair a label.

## F2 — Strong failure flags are contradicted by a success frame

Three controlled native replays rendered a **success** header with `isError: false` and exit-zero-looking metadata, despite one of these explicit flags being true:

- `timed_out`
- `aborted`
- `force_resolved`

The result body exposed the stronger condition, but the native frame still reported success. The separate historical `isError: true` precedence case did not establish these three stronger-flag cases.

The repair must derive native exec presentation conservatively: existing `isError: true` and explicit strong execution-failure flags must not be downgraded by success-looking metadata. Preserve the distinctions in the result body, recording warnings, terminal state and IDs. Do not rewrite persisted historical results or turn presentation metadata into workflow-completion authority.

## F3 — The external MCP host loses the remote error carrier

A real interactive GSD client completed actual server listing, discovery and three calls to its own stdio MCP server. The real trust dialog was inspected against the approved command/configuration and confirmed through the actual UI in the isolated profile.

An observer of the installed SDK's unchanged `Client.callTool` response recorded:

- Success: exit zero, no remote error flag.
- Failure: exit seven and raw MCP `isError: true`.
- Timeout: `timed_out: true` and raw MCP `isError: true`.

All five corresponding host-wrapper tool results, including listing/discovery, nevertheless had `isError: false`. The backend protocol did not lose the flag: the client wrapper dropped it while converting the returned content.

The minimal repair should preserve the protocol's boolean error carrier in the host tool result, without inferring failure from stderr or arbitrary output text. Preserve existing text truncation and wrapper-owned metadata. Do not flatten remote structured data into trusted local execution/authority fields. A broader structured-data wrapper API is not required by this repair; raw SDK structured data and wrapper presentation remain explicitly distinguished.

## Repair sequence and review gates

1. Confirm the relevant current-source behavior, including renamed/moved files, before editing. The tested installed candidate and a later source checkout are not interchangeable evidence.
2. Review and merge this evidence-backed plan independently before implementation. This is planning authority only, not host acceptance.
3. Repair the native presentation/argument-refresh cluster and the MCP client error-carrier cluster in non-overlapping scopes where possible.
4. Add failing-before-fix regressions for streamed sibling argument refresh, each contradictory strong flag, ordinary success/stderr, and remote MCP success/error/timeout flag propagation. Keep IDs, backend results, UAT intent/purpose and evidence semantics unchanged.
5. Run focused source checks/tests without a local full build. Use online CI for the exact proposed source SHA and produce an immutable package/artifact manifest bound to that SHA. A workflow repository's own head SHA is not proof of the separately checked-out source SHA.
6. Verify artifact digests and safe extraction, then run only the owned candidate artifact. Keep the global 1.23.0 installation and other windows unchanged. No installation/version label alone proves that patched core or extension code is active.
7. Reobserve the affected matrix partitions on the new artifact. Reuse earlier observations only when their source scope, host configuration and unchanged artifact components genuinely justify it. Source tests and green CI remain supplemental to host observations.
8. Reconcile every H01–H12 partition, review findings and current child states; obtain real operator acceptance before recording complete acceptance or closing #2916/#2913.

The operator authorized the exact-SHA online fix build and execution of its unpacked artifact in the isolated test environment. That authorization is **not** acceptance of the resulting behavior and does not authorize changing another window or the global runtime.

## Process supervision and excluded probes

The original empty-input MCP probe was not a protocol test and remained alive after a TERM-only timeout. Its exact owned process was identified and removed. Subsequent host runs used a monotonic hard deadline, owned process-group tracking, TERM-to-KILL escalation and verified reaping. The supervisor's regressions include idle callers, TERM-resistant processes and descendants.

MCP request cancellation was observed through real cancellation notification, a promptly aborted recorded sandbox run and a subsequent successful ping. A cancelled request's suppressed response must not be awaited as if it were ordinary completion.

Early probe failures are retained but excluded from acceptance: an unsupported CLI flag, observer preload interference with a scrubbed sandbox environment, first-run provider setup, a blocking terminal-capture path, an undersized cold-start budget, and a capped discovery preview incorrectly used as registration truth. Corrected diagnostic logging must remain bounded without making truncated output authoritative.

Stdin EOF did not by itself end the tested persistent modes. Supervision therefore does not depend on EOF or cooperative TERM. This plan does not claim that backend mode shutdown behavior has been repaired.

## Completion contract

The planning PR may be merged once reviewed and its applicable checks pass. The implementation and acceptance remain open. No missing host, material automatable failure, substituted CI result or fabricated operator approval may be converted into a passed matrix row. The final report must identify both the exact accepted artifact and the fact that the operator's global installed runtime was not changed by these isolated checks.
