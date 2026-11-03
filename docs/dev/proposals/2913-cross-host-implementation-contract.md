# Cross-host implementation contract for #2913

> **Status:** operator-selected direction, proposed contract for maintainer review. This amendment records the operator's choices on 2026-11-02; it does not claim maintainer approval, implementation completion, or real-host acceptance. Keep implementation PRs open and unmerged until separately authorized.

- Umbrella: [#2913](https://github.com/open-gsd/gsd-pi/issues/2913).
- Related designs: [#2929](https://github.com/open-gsd/gsd-pi/issues/2929), [#2931](https://github.com/open-gsd/gsd-pi/issues/2931), [#2932](https://github.com/open-gsd/gsd-pi/issues/2932), [#2933](https://github.com/open-gsd/gsd-pi/issues/2933), [#2934](https://github.com/open-gsd/gsd-pi/issues/2934), [#2935](https://github.com/open-gsd/gsd-pi/issues/2935), and [#2936](https://github.com/open-gsd/gsd-pi/issues/2936).
- Source baseline reviewed: upstream `main` at `51a0d97df3680bf58dc9900275ab10635a1587f2`.

## Operator-selected direction

1. Keep workflow, tool, background-job, subagent, attention, and outcome facts separate. Start with the native TUI and add cross-host UI support rather than inventing one global `running` or `done` status.
2. Automatically discover verified live sessions across supported host surfaces, but require the user to confirm before attaching. Discovery must not silently transfer control.
3. Implement cross-host UI now, including VS Code's editor destination. VS Code opens an editable tab; only an explicit **Send** action returns its text to the originating request.
4. Give notifications explicit urgency and deduplicate them by stable event identity. A notification without trustworthy identity must not suppress a distinct required action.

## Identity and attachment contract

- Discovery may be automatic; attachment is an explicit user action. The host must show enough verified session context for the user to select the intended live session before attaching.
- A project ID, worktree ID, path, current working directory, window title, or matching session name is not sufficient proof of live process ownership by itself.
- The implementation must bind the candidate to a live RPC/session owner using an authenticated, capability-protected mechanism. The concrete transport and credential mechanism remain implementation-review items; do not infer them from the shared project path.
- Reject stale, ambiguous, cross-user, or unverifiable candidates. Surface an actionable explanation instead of silently attaching or falling back to a different session.
- Confirmation authorizes only the capabilities declared by the host protocol. It does not approve workflow actions, bypass existing confirmation gates, or transfer authority implicitly.
- Detach, session exit, process replacement, and failed verification must revoke the attachment. Reopening or moving a worktree must not silently restore a prior attachment.
- Remote-host discovery and persistent cross-device identity are not implied by this local host-surface contract. They require a separate threat-model and owner review before support is claimed.

## VS Code editor request lifecycle

- An editor request opens an untitled, editable VS Code text document populated with the request's initial text. It must not create or overwrite a workspace file as a side effect.
- A visible **Send** action returns the current document text to the exact originating request and session. The response is single-use and is not routed to another request if the original session has ended.
- **Cancel** or closing the editor cancels the request. Unsent text is not submitted or persisted across extension/session restart by default.
- If the request times out, the extension disconnects, or the originating session exits, the editor shows that state and disables submission. It must not imply that closing or sending approved a blocked workflow action.
- Keyboard and screen-reader access, focus return, duplicate submissions, and concurrent editor requests need explicit tests.

## Activity, attention, and notifications

- Present workflow state, assistant turn state, foreground tools, background jobs, subagents, availability, freshness, and scoped outcomes as separate facts.
- Missing or unavailable data is not zero, idle assistant state is not global completion, and disappearance from a snapshot is not proof of repair or approval.
- Native TUI is the first delivery surface. Cross-host adapters must preserve the same meaning while clearly reporting unsupported or stale sources.
- Notifications use stable event/request IDs when present. Deduplicate only events proven to describe the same action; keep identity-poor events distinct rather than collapsing by matching text.
- Urgency-to-surface mapping, focus behavior, queue capacity, retention, and the precise meaning of a delivery attempt must be specified and reviewed in the notification implementation PR.

## Blocker navigation and saved output

- A blocker link is navigation only. Opening a task, issue, or editor does not satisfy a prerequisite, approve a workflow, resume recovery, or change task state.
- Preserve the source of each blocker and distinguish current evidence from a missing or stale report. Do not describe a vanished row as resolved without current proof.
- Saved stdout/stderr context may be attributed only from execution-owned metadata that binds the artifact to its producer, execution, and stream. A filename, rendered sidecar, or text inside the output is not provenance proof.
- Opening saved output remains read-only. Output content must never supply commands, arbitrary paths, or authority to the viewer.

## Layout and semantic styling

- Authored prose must wrap at block boundaries without clipping, corrupting tables, or changing code blocks. The implementation PR must state whether its measure is fixed or configurable and test narrow, normal, and wide layouts in every supported host.
- Prefer existing semantic color roles. Any new role needs a documented reason and mappings for themes with color, no-color output, contrast, and non-color cues.
- The exact prose measure and final semantic-role mapping remain open until the corresponding implementation PR presents the current host constraints and tests. Do not silently turn these into unrelated global configuration changes.

## Proposed implementation order

1. Establish the identity envelope and producer-attribution contract.
2. Add verified discovery and confirmed attachment lifecycle.
3. Add source-backed attention data and safe native destinations.
4. Implement the VS Code editor request lifecycle and blocker navigation.
5. Add urgency and stable-ID notification deduplication.
6. Compose truthful activity in the native TUI, then add cross-host presentation parity.
7. Add execution-backed saved-output references and READ context.
8. Implement block-aware prose width and semantic styling.
9. Add cross-host integration evidence and real-host acceptance tracking.

The order is dependency-aware, not permission to bypass review. Each implementation PR must identify its tests, unsupported-host behavior, and rollback or fallback behavior. Keep the PRs draft/open with auto-merge disabled; do not merge any PR under this authorization.

## Required review and acceptance

- Request review from the core/RPC, native-TUI, VS Code, and security owners for the identity and editor contracts. Include cmux owners if that host participates in discovery or notification delivery.
- Contract/unit/integration tests may establish software behavior, but they do not prove installation, live-host behavior, or operator acceptance.
- Keep [#2916](https://github.com/open-gsd/gsd-pi/issues/2916) open for artifact-bound real-host acceptance. Do not close #2913 or claim host acceptance based on merged documents, mocked tests, or green CI alone.
