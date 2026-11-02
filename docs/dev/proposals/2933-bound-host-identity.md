# Bound project, worktree and session identity across host UIs

> **Status: design proposal — maintainer review required.** This document does not
> approve implementation, claim ownership, introduce a protocol, or establish host
> acceptance. It is input to the existing pickup, not a competing assignment.

- Design child: [#2933](https://github.com/open-gsd/gsd-pi/issues/2933), D01 under
  [#2913](https://github.com/open-gsd/gsd-pi/issues/2913).
- Discussion reviewed: 2026-11-02, including the
  [existing #2933 design input](https://github.com/open-gsd/gsd-pi/issues/2933#issuecomment-6304538040)
  and the bodies/comments of #2934, #2935 and #2936.
- Initial source inspection: upstream `main` at
  [`f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19`](https://github.com/open-gsd/gsd-pi/tree/f76d1d0fa692e0d7a2b1249d9bb2cceca25cfa19).
- Follow-up review on 2026-11-02 rechecked the relevant current-source claims
  against live `main` at `52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`; current
  claims below are limited to that follow-up.
- The issue packet's `b09bdf3fc770309deb60aa373f184febed3c739a` anchors are
  historical discovery inputs, not the source baseline used here.

## Problem and scope

A host must identify the context it actually owns or observes before presenting
project state, session costs, activity, output actions or notifications as current.
A matching folder name, active editor or integrated terminal does not establish a
shared execution. Two sessions may use the same worktree; two worktrees may share
one GSD project authority.

This proposal defines a bounded presentation and ownership contract using existing
sources. It permits partial knowledge: an honest `unknown` is better than
associating an action or result with the wrong successor session.

The live issues #2913, #2933, #2934, #2935 and #2936 remain open. The umbrella's
older descriptions of #2917, #2930 and #2926 are not current delivery status:

| Linked work | Current delivery record |
| --- | --- |
| #2914 implementation PR [#2917](https://github.com/open-gsd/gsd-pi/pull/2917) | Merged at `5b71b60a46dc6f75b36e2bc31c7c96930baf1531`; #2914 remains open. |
| #2930 activity lifecycle | Closed with merged PR [#2940](https://github.com/open-gsd/gsd-pi/pull/2940), `cd58aa6cd71e6fad07953b065366bb8bf3edb610`. |
| #2926 cmux ownership | Closed with merged PR [#2942](https://github.com/open-gsd/gsd-pi/pull/2942), `dcf4b53452767982b9eeb20c6ad35330173846f2`. |
| #2916 real-host validation | Open; no host acceptance is claimed here. |

Delivered fixes are regression inputs, not work to reopen. Merge state is not
evidence that this identity contract is implemented or that host acceptance passed.

## Existing authority and its limits

Source paths below are relative to the pinned repository tree.

| Dimension | Existing source | Authority and limitation |
| --- | --- | --- |
| GSD project | `packages/contracts/src/rpc.ts`: `ProjectSnapshot.authority`; `src/resources/extensions/gsd/state/project-snapshot.ts`: DB-authoritative snapshot reader | `projectId`, `schemaVersion`, `revision`, `authorityEpoch` describe project authority. Revision/epoch are freshness and authority fences, not session/worktree IDs. A missing snapshot is not a fabricated project identity. |
| Project and execution roots | `src/resources/extensions/gsd/paths.ts`: `GsdPathContract`, `resolveGsdPathContract`; `src/resources/extensions/gsd/worktree-root.ts`: `resolveWorktreeProjectRoot` | Separates `projectRoot`, `workRoot`, `projectGsd`, `projectDb`, `worktreeGsd` and `isWorktree`. Uses existing explicit original-root, GSD worktree/environment and filesystem resolution rules. No durable, move-stable worktree UUID is exposed. |
| Agent session | `packages/contracts/src/rpc.ts`: `RpcSessionState`; `packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts`: `get_state`; `packages/pi-coding-agent/src/core/session-manager.ts` | The session manager supplies `sessionId`, optional `sessionFile`, and display name through RPC state. Name/path is not a substitute for session ID. `get_state` does not assert resolved project/worktree roots. |
| VS Code launch | `vscode-extension/src/extension.ts`; `vscode-extension/src/gsd-client-spawn.ts` | Selects `workspaceFolders[0]` or `process.cwd()` and launches its own `--mode rpc` child using that cwd and stdio. This is not terminal/cmux attachment. |
| VS Code local trust | `vscode-extension/src/gsd-client.ts`: `projectRoot`, `projectContextGeneration`, `isProjectContextTrusted`, `mutateSession` | `projectRoot` returns constructor cwd. Generations are local fences, not wire provenance. Spawn establishes local trust. Session mutations invalidate it; only explicit cancellation can restore prior trust in the same process/generation. Successful new/switch/fork does not independently verify a new root. |
| Read provenance and guards | `vscode-extension/src/sidebar-refresh.ts`; `vscode-extension/src/copilot-tools.ts`; `vscode-extension/src/copilot-tools-guards.ts` | Progress metadata distinguishes database, projection and unknown; root/trust guards constrain project reads. Neither a projection nor matching workspace path upgrades session binding. |
| Native TUI | `packages/gsd-agent-modes/src/modes/interactive/components/gsd-status-widget.ts` | Compact/expanded path rendering uses `progress.path` or a basename of `state.cwd`. This is a path label, not binding proof. |
| VS Code activity | `vscode-extension/src/activity-feed.ts`; `vscode-extension/src/activity-model.ts` | Provider-local model and connection transitions support tool/run correlation and interrupted presentation, not cross-host identity discovery. |
| cmux destination | `src/resources/extensions/cmux/index.ts`: `detectCmuxEnvironment`, `statusKeyFor`, `CmuxClient` | Socket/workspace/surface select routing. Per-surface status ownership and shared-progress coordination exist; destination IDs are not GSD project or agent session IDs. |

`RpcSessionState` does not carry project snapshot authority or resolved worktree
identity. Separate `get_state` and project reads are not an atomic identity bundle.
Do not manufacture one by merging whichever responses arrived most recently.
`WorkflowCommandIdentity`'s existing `idempotencyKey` and `expectedRevision` protect
workflow mutations; they do not prove attachment, authorize transfer, or replace
session attribution.

### Ownership diagram

```text
native TUI process -> own session manager -> own execution observations
VS Code extension -> own RPC child -> session state / separate project reads
integrated terminal -> independent gsd process and session
owning process -> cmux socket / workspace / surface (delivery destination only)

owning execution's roots -> existing path resolver -> project/worktree context
project snapshot reader -> existing DB authority -> projectId / revision / epoch
```

Arrows indicate existing ownership/read/routing boundaries, not a new transport.
There is no inferred VS Code-to-terminal or VS Code-to-cmux session attachment.

## Recommended boundary and alternatives

**Recommend A: explicit local binding, without cross-host attachment.** Each host
shows the process/session it already owns. The user may select a session through
that host's supported operations; selection is not proof of its project root.
Initially, the selected execution can simply be the host's own launched execution.
No global selector, registry or discovery service is needed.

| Option | Benefit | Cost and disposition |
| --- | --- | --- |
| A — explicit local ownership | Prevents silent adoption; reuses current process/session sources | Requires visible separation and explicit switching. Recommended for review, not approved. |
| B — opt-in attachment | Could observe an independently running execution | Requires supported transport, verified identity, transfer permissions and detach semantics absent here. Defer to a separate accepted design/RFC. |
| C — independent labels only | Smallest display-only change | Labels alone cannot satisfy action/rebind fencing. Possible limited first slice, not full #2933 acceptance. |

The maintainer must choose the boundary. None permits automatic VS Code/cmux
mirroring or discovery by similar paths.

## Identity contract

These are design terms, **not new wire fields or a persisted identity subsystem**.
Reuse existing values; absence remains explicit rather than generating authority.

1. **Project** is the existing authority's `projectId`, with observed revision/epoch
   and read provenance. It may be shared across worktrees. A cwd, repository URL,
   branch, project title or database filename cannot supply it.
2. **Worktree context** is the owning execution's resolved `workRoot` in relation
   to resolved `projectRoot`, using the existing path contract. Show both when
   known. Branch is metadata, not identity. When only launch cwd is known, label
   it **spawn cwd**, not **verified worktree**.
3. **Session** is the producer's `sessionId`, scoped to the selected host
   process/connection lifetime. Full value must be inspectable. `sessionName` and
   short IDs are labels; `sessionFile` may be absent. Session, workflow unit,
   prompt/run and tool invocation remain separate scopes.
4. **Host lifetime** owns subscriptions, requests and cleanup. Use the existing
   process/context generation where present. It is a callback fence, not a global
   execution ID or a new RPC version.
5. **Destination** is a routing address, such as a cmux workspace/surface. Check
   availability and ownership separately from execution state. A reused
   destination cannot adopt the previous owner's work.
6. **Binding** records the host's selection and evidence for each dimension.
   Project known/session unknown and session known/root unverified are valid
   partial states. `connected` does not make every dimension trusted.

For an asynchronous observation, capture its local owner/generation and any
existing session/run/tool/unit identity in the owning adapter. Publish only to
that owner while current. If an event could belong to either side of a switch and
lacks sufficient identity, reject it from current attribution; never stamp it with
the successor's identity. Local wrapping is not producer attestation. Do not invent
missing fields on legacy events.

Project snapshots and session state may be displayed together only with individual
provenance and freshness. A context change while either read is in flight
invalidates the combined view. A raw successful `get_state`, normalized path
equality or successful project read must not bypass existing root/trust guards.
Non-GSD chat remains usable without project identity; only operations requiring
unresolved authority are withheld.

### Worktree resolution and relocation

Use the existing resolver, including recognized GSD worktree layouts and explicit
original-project-root inputs. No parent-name guessing, string-prefix containment,
basename similarity or adjacent-directory search. Existing normalized-path guards
may compare roots for their documented local purpose; that is neither adoption
nor a durable worktree ID.

On move, rename, symlink change, reopen or root disagreement, invalidate old root
evidence and resolve again in the owning context. Keep old values only as
last-known. If sources cannot establish the relationship, show `Worktree unknown`
or `Root unverified` and withhold affected project/attachment actions. Matching
`projectId` values do not prove the same worktree, session or continued authority
after a database copy. No continuity across relocation or cloned state is promised.

### Freshness, transitions and outcome

Binding observation state is separate from execution outcome. The following is
required future policy, not a claim about all current hosts.

| Transition | Required display and behavior |
| --- | --- |
| Unbound / unknown | Show unknown dimensions. No borrowed editor/terminal identity or guessed attachment. Local session operations need not depend on unavailable project authority. |
| Selected, evidence pending | Show selected local owner and `Verifying context` or `Root unverified`. Do not reuse the previous session's costs, reports, actionable logs or notifications as current. |
| Selected, evidence current | Show only established values. Keep launch cwd distinct from resolved roots and project authority. |
| Disconnect / transport loss | Mark retained identity **last known — disconnected**. Observation becomes unknown; running work is not thereby failed/successful. Interrupted presentation is not an authoritative execution-failure assertion. |
| Reconnect / restart | Begin a new local generation and fetch current state. Same cwd/name/session file/destination is insufficient to adopt the old binding. A confirmed same session may be displayed with fresh evidence; a successor stays distinct. |
| Explicit new / switch / fork | Fence old callbacks before sending; keep previous identity historical. After success, fetch current session state and independently establish required root/project evidence. Preserve current fail-closed trust behavior; a state refresh does not promise restored trust. |
| Explicit cancellation / failed switch | Only confirmed cancellation for the still-current owner can preserve prior selection/trust under the existing client rule. Error, timeout or lost response leaves the result unresolved; do not assume rollback. |
| Release / detach / host disposal | Stop the old subscription and release only owned resources. Label retained history; no stale cleanup may clear the successor's destination, progress or subscriptions. |
| Late / replayed event | Drop from the current view or retain under an identifiable historical owner. Replayed terminal events are idempotent and cannot take over a new binding. Message text cannot repair unknown ownership. |
| Authoritative terminal outcome | Retain producer completion/cancellation/failure semantics and attribution. Later disconnect/rebind cannot rewrite the outcome or assign its costs to the successor. |

Example design trace, **not executed evidence**: H owns session A in worktree W;
A's terminal result is delayed; the user selects B in W; A's result then arrives.
H fences A before selection and awaits B's state. A's result is historical or
rejected, never B's completion. Transport loss makes B disconnected/unknown, not
failed. Disposal of A cannot erase B's cmux row or subscriptions.

## Host presentation and action matrix

Compact labels orient; every participating interactive host needs a
keyboard-reachable detail path showing full known values, source and freshness.
Disambiguation must not depend solely on hover. Shortening paths/IDs must not alter
values used for attribution or explicit copy.

Suggested compact wording: `project label · session label · state`. Use
`Project unknown` when unavailable, not cwd as a replacement. Details include host
kind, own-process versus attached provenance, spawn cwd, resolved project/work
roots if known, full session ID and optional file, available project ID/revision/
epoch, and connection/freshness state. Do not export absolute paths or session-file
contents to unrelated hosts or telemetry.

Treat identity labels, paths, IDs and session names as untrusted display text:
escape terminal controls and bidi characters, normalize multiline labels, and
bound their visible length. Keep the authoritative values and explicitly copied
full paths separate from their sanitized/truncated presentation.

| Host surface | Ownership and proposed presentation | Stale/unknown and action boundary |
| --- | --- | --- |
| Native TUI status widget / session details | Interactive process owns its session. Keep compact `path` explicitly a path; provide session/root details without requiring auto mode. | No GSD project is valid. Do not invent authority from path or equate widget visibility with session outcome. |
| cmux sidebar / status / progress / notifications | Owning process emits to its known destination. Provide concise local session context; use native TUI details when destination text is constrained. | Missing destination means routing unavailable, not execution failed. Preserve delivered per-surface ownership/shared-progress arbitration; no global takeover. |
| VS Code sidebar header / status bar / session tree / activity feed | Extension owns its RPC child, initially launched from the first workspace folder. Show that launch context even when another editor/folder is active; expose full details by keyboard. | Clear or label current sections on context change; historical rows keep attribution. Different-folder project actions use existing root/trust guards, not active editor. Do not imply multi-root rebinding exists. |
| VS Code integrated terminal | Terminal's `gsd` process is independent of extension child, even at the same cwd. | Terminal title/presence/cmux membership is not attachment proof; no mirroring is inferred. |
| Headless / RPC / MCP consumer | Display only fields its producer supplies; retain unknown dimensions. | No assumed terminal controls or local opener. Missing capability differs from missing identity and execution outcome. |

## Inputs for adjacent design children

These are dependency inputs, not a new shared adapter or blanket blocking
dependencies. Independent correctness fixes may use existing authoritative inputs.
Coordinate with each existing pickup before changing shared surfaces.

| Consumer | Input from this proposal | Decisions retained by that child |
| --- | --- | --- |
| [#2934 output-log actions](https://github.com/open-gsd/gsd-pi/issues/2934) | Separate current-session evidence from saved/historical log references. Rebind cannot relabel a log as B's output. Project/session/path display alone is not a read capability. Existing `src/resources/extensions/gsd/exec-sandbox.ts` and `src/resources/extensions/gsd/exec-history.ts` supply log records/paths, not universal attachment attestation. | Safe read/view/copy/open policy, validated provenance, bounded race-safe reads, containment/symlink/replacement handling and remote capability. Saved-log READ needs its own validated historical reference: neither accept arbitrary paths because the current project matches nor reject all historical logs merely because session changed. Preserve complete original stdout/stderr path fallback and truthful execution status; fallback text grants no file access. |
| [#2935 notification urgency/dedup](https://github.com/open-gsd/gsd-pi/issues/2935) | Attribute to originating local session and existing invocation/unit/transition evidence where available, separately from delivery destination. Same worktree/text is not a dedup key; late A notifications cannot become B notifications. | Event ownership, urgency, per-surface dedup/window policy and fallback for identity-poor events. Unknown attribution must not suppress distinct required actions/failures. No global session dedup, automatic approval or acknowledgement; read state is not workflow approval. |
| [#2936 activity summary](https://github.com/open-gsd/gsd-pi/issues/2936) | Carry project/worktree/session provenance with each dimension. Workflow unit, assistant turn, tool invocation and background child identity stay distinct; do not merge sessions sharing a root. | Composition of workflow, assistant, foreground tools and background jobs. Parent completion does not prove child completion; transport loss is not failure; costs retain producer scope. Existing child identity/model/cost foundations do not justify invented counts or a unified lifecycle. |

#2930's activity lifecycle and #2926's cmux ownership fixes supply regression seams,
not an unapproved global identity layer. Other #2913 proposals remain separate
lanes; this contract does not silently expand their scope.

## Maintainer decisions before implementation

- [ ] Select A, B or explicitly limited C; agree the smallest first host/surface
  slice and coordinate with the existing #2933 pickup.
- [ ] Confirm who may initiate selection, release or future attachment. Recommended:
  user-initiated local selection only; no automatic transfer.
- [ ] Accept path-scoped worktree context with unresolved relocation, or request a
  separate design for stronger continuity. Do not silently add persistent IDs.
- [ ] Agree how hosts independently verify roots after successful session mutation.
  Until accepted evidence exists, preserve the current fail-closed guard rather
  than weakening it to make the UI appear rebound.
- [ ] Choose compact labels, keyboard detail placement, path/privacy policy and
  whether stale history remains visible or is cleared on each surface.
- [ ] Agree compatibility for identity-poor events and whether additive producer
  payloads are necessary. Any payload change needs a separate reviewed schema/
  producer/consumer plan; this document specifies none.
- [ ] Agree #2934 saved-log trust, #2935 dedup scope and #2936 lifecycle separation
  with their owners; this proposal is not their approval.
- [ ] Approve the regression/host evidence plan and any RFC required by
  `CONTRIBUTING.md`. Design acceptance, issue claim and implementation authorization
  are separate gates.

## Regression and host evidence required

No test, build, install or host-runtime check was executed for this design.
Fixtures and observations below are **proposed**, not PASS claims. Use isolated
fixtures/authorized hosts, never another session's runtime.

### Contract and race fixtures

| Case | Fixture / stimulus | Required assertion |
| --- | --- | --- |
| D01-R01 | Two cmux sessions in one worktree, distinct session/owner lifetimes | Distinct execution labels/notifications; one owner's cleanup cannot clear the other. |
| D01-R02 | Two worktrees sharing project authority; multi-root editor changes active folder | Shared project cannot merge worktrees/sessions; launch binding stays visible; wrong-folder action refused. |
| D01-R03 | Delayed state/tool result from A arrives after A→B | Old callback cannot publish B's identity/activity/cost/report/action. Include identity-poor events and out-of-order reads. |
| D01-R04 | Duplicate terminal event, including after reconnect | Idempotent presentation for original owner; no successor takeover or extra notification merely from replay. |
| D01-R05 | Transport loss while running and after known completion | Observation disconnected/unknown; known outcome unchanged; no synthetic failure/success. |
| D01-R06 | Producer reports genuine failed execution | Preserve producer reason/scope; stderr or missing host capability alone never creates failure. |
| D01-R07 | New/switch/fork A→B; cancelled switch; failed/lost response | Fence first; verify new state separately; cancellation restores only eligible prior trust; uncertainty never assumes rollback. |
| D01-R08 | Dispose/reload A after B acquired destination/subscription | A releases only its resources; B's row, progress contribution and callbacks survive. |
| D01-R09 | Rename, symlink change, reopen, nested directory, arbitrary sibling worktree | Existing resolver result or unresolved state; no path-similarity adoption. Include missing/deleted roots. |
| D01-R10 | Missing snapshot/session ID, mismatched roots, old producer, project copied to another root | Partial/unknown display; no invented attachment. Project-required actions fail closed without disabling unrelated chat. |
| D01-R11 | Current/historical output across rebind; repeated text from distinct sessions | #2934 validates historical read authority separately; #2935 does not cross-dedup; #2936 preserves parent/child outcomes. |

Existing test seams, inspected as paths rather than executed here:

- `vscode-extension/test/gsd-client-context.test.ts` and
  `vscode-extension/test/rpc-display-contract.test.ts` for local trust, protocol
  compatibility and rejected/malformed responses.
- `vscode-extension/test/sidebar-refresh.test.ts` and
  `vscode-extension/test/activity-model.test.ts` for superseded refreshes and
  lifecycle presentation.
- `src/resources/extensions/gsd/tests/cmux.test.ts` for destination ownership and
  cleanup; `src/resources/extensions/gsd/tests/worktree-root-resolution.test.ts`
  for root resolution.
- `packages/gsd-agent-modes/src/modes/interactive/components/__tests__/tool-execution.test.ts`
  for rendered output/action boundaries, coordinated with #2934.

New fixtures/files remain proposed until implemented. Existing passing suites
would not prove this contract alone. Run targeted regressions only in an
authorized implementation environment with pinned prerequisites; record BLOCKED
rather than installing/building/substituting dummy checks when prerequisites are
unavailable. Broader gates follow current contribution policy.

### Real-host acceptance matrix

| Environment | Observation needed |
| --- | --- |
| Native TUI, compact/expanded, narrow width | Bound session and full roots/ID keyboard discoverable; abbreviated labels truthful; no-project and disconnected states legible. |
| Two cmux sessions/surfaces, same worktree, then two worktrees | Destination/execution stay separate; rebind/reload/late cleanup cannot affect another owner; unavailable cmux does not mark execution failed. |
| VS Code Extension Development Host, single-root and multi-root | Visible extension-child spawn versus terminal context; explicit mutation, cancellation, disconnect, restart, late response; full details accessible without hover. |
| Remote/headless or missing-capability consumer | Unknown identity and unavailable interaction explicit; no assumed local path/opener or terminal capability. |
| Historical output, notification and activity integration | Original attribution survives selection changes; path fallback, required-action delivery and independent child outcomes preserved. |

For each observation retain exact source SHA, host/runtime/extension versions, OS,
launch roots and independently observed session IDs, reproduction steps,
expected/observed results, and sanitized screenshots/logs or traces. Distinguish
unit/contract results, installed-host observations and human acceptance. Untested
hosts are pending/blocked, not successful. Attach evidence to the appropriate child
and coordinate cross-host acceptance with #2916; this proposal does not close #2913.

## Ordered follow-up and non-goals

After maintainer agreement and separate implementation authorization:

1. Confirm selected contract and event/cleanup owners against then-current source;
   revise the proposal if authority inputs changed.
2. Add adversarial fixtures at existing context, resolver and destination seams
   before presentation wiring. Do not create a shared identity service.
3. Implement the agreed compact/details slice in the owning host, preserving
   root/trust guards and original event attribution. Add other hosts separately.
4. Integrate agreed inputs with #2934/#2935/#2936 without conflating security,
   urgency or lifecycle decisions; collect authorized host evidence.

Stop if identity, transport, root verification, ownership or cleanup cannot be
established. Escalate that specific gap rather than hiding it with a label.

Explicit non-goals: path-similarity inference; automatic VS Code/cmux or
integrated-terminal mirroring; implicit adoption; a new identity subsystem,
daemon, registry or orchestrator; database/protocol redesign; durable worktree IDs;
workflow authority changes; synthesized outcomes; approval/acknowledgement bypass;
automatic transfer or detach of another owner's execution. No implementation,
GitHub publication, runtime mutation or release is authorized by this document.
