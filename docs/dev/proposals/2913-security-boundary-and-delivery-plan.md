# Security boundary and staged delivery plan for #2913

> **Status: proposal for maintainer review.** This amendment resolves security and sequencing gaps found during the 2026-11-06 review of the merged #2913 contract and #2933/#2934 proposals. It records no implementation, CI, host acceptance, or maintainer approval. The operator has authorized agent-led review and later merges only after the plan and reviews pass.

- Umbrella: [#2913](https://github.com/open-gsd/gsd-pi/issues/2913).
- Related issues: [#2914](https://github.com/open-gsd/gsd-pi/issues/2914), [#2916](https://github.com/open-gsd/gsd-pi/issues/2916), [#2933](https://github.com/open-gsd/gsd-pi/issues/2933), and [#2934](https://github.com/open-gsd/gsd-pi/issues/2934).
- Reviewed source baseline: upstream `main` at `6769961e419a4dc364ae0420be4fe8fb63b0f2f5`.
- If this amendment conflicts with the earlier implementation contract or proposals, this amendment is the proposed security boundary for review; do not silently infer approval from the older text.

## Review findings this amendment addresses

The owner-bound `RpcBindingSnapshot` added by #3088 is a useful observation after a trusted RPC connection exists. It is not, by itself, proof that a discovered endpoint is the live session owner or authorization to attach. A filesystem path, worktree/project identifier, process ID, session UUID, timestamp, or snapshot copied from disk must never grant authority.

Three additional gaps must be closed before their features ship:

1. Pending UI responses are single-use by request ID but are not yet bound to the producer session, owner generation, and expiry. The server must reject late responses after replacement, detach, timeout, or shutdown.
2. A normal untitled VS Code document may be retained by Hot Exit. “Untitled” does not guarantee that unsent text disappears on extension or window restart.
3. Editable `exec-history` sidecars do not prove that a saved stream still belongs to the recorded producer or current session. A current binding snapshot must not turn a modified or replaced artifact into trusted output.

These are design and integration blockers, not reports of a demonstrated current remote exploit. Preserve the existing root/generation guards, single-use response consumption, path derivation safeguards, redaction, and fail-closed behavior.

## Supported trust boundary

The first implementation is **local-host only**. Native GSD TUI and VS Code may discover local candidates. Remote hosts, cross-device identity, network listeners, port scans, automatic attachment, and persistent attachment credentials are out of scope. A host not supported by the verified transport must show the feature as unavailable rather than falling back to an unauthenticated transport.

Treat discovery records and host-provided labels as untrusted hints. Treat repository contents, command output, and subprocess input as untrusted data. Do not pass attachment keys or grants to agent/repository subprocesses, command arguments, environment variables, logs, or durable files.

The security guarantee is against another OS account, stale/forged discovery metadata, replay, and untrusted repository content attempting to gain attachment authority. A hostile process already running as the same OS user is not an isolated OS principal; it may cause a consent prompt or denial of service, but it must not obtain control without the authenticated pairing and explicit source-session approval. Do not claim confidentiality against a fully compromised same-user process or OS account.

## Authenticated local pairing and revocable grants

On macOS and Linux, use a Unix-domain socket inside a per-user runtime directory created with mode `0700`; ensure the socket cannot be replaced through a symlink and is accessible only through that directory. Do not use TCP or a project-directory socket. Windows attachment remains disabled until a named-pipe adapter demonstrates an explicit current-user ACL and has cross-user regression tests. Discovery records are candidates only; they do not prove endpoint ownership.

For each pairing attempt, generate an ephemeral X25519 key pair on both peers and a fresh 256-bit challenge. Derive the shared secret with Node's `crypto.diffieHellman`; derive separate directional keys and a SAS key with HKDF-SHA-256 using the domain label `gsd-attach-v1`. Bind a canonical, role-ordered transcript to the protocol version, both ephemeral public keys, both nonces, connection ID, live session ID, and owner generation. Display a human-verifiable fingerprint of at least 128 bits, derived from the SAS key and transcript, in both UIs. The user must compare the matching fingerprints and explicitly approve in the source session; the fingerprint is not itself a grant. Do not accept `RpcBindingSnapshot` fields, a project path, or client-supplied identity as authentication. Expire the challenge quickly and reject replay, duplicate approval, malformed keys, and mismatched transcripts. No private key or derived grant is persisted.

Before marking the connection authenticated, both peers must prove possession of the derived key with role-specific `KEY_CONFIRM` messages. Every later post-handshake frame—request, response, unsolicited session event, lifecycle notification, or transport-control message—must carry an HMAC-SHA-256 over the exact versioned frame bytes, direction, connection ID, session ID, owner generation, and a strictly increasing sequence number. Verify the MAC in constant time before parsing, dispatching, or applying host-state updates; reject altered, duplicate, skipped, or out-of-order frames. Bind a grant to the authenticated connection rather than trusting a client-supplied capability claim.

Only after fingerprint comparison and a separate source-local approval may the owner issue an in-memory grant bound to the authenticated connection, destination ephemeral identity, session ID, owner generation, expiry, and explicit capability set. Source approval must not be callable through the attached connection's ordinary `extension_ui_response` or any general UI-response capability. Initial attached capabilities are limited to observing the selected session and responding once to a specific pending UI request. They do not authorize shell execution, arbitrary file reads, workflow approval, recovery/resume, attach approval, or access to another session. The server checks the grant, message MAC, sequence, and current owner generation at every privileged RPC operation; the UI is not the enforcement boundary.

Detach, owner replacement, root-generation change, request expiry, failed owner verification, and process shutdown revoke grants server-side and close the connection. Clear ephemeral keys and pending requests. Never restore a grant from a project file, snapshot, editor text, or host restart.

Required negative tests include forged or stale advertisements, mismatched fingerprints, replayed challenges/grants/messages/events, out-of-order sequence numbers, cross-user access, source approval attempts through `extension_ui_response`, capability escalation, detach/replacement with an open connection, and use of a revoked grant on every privileged operation. Include a transparent proxy that relays the handshake so both peers display the same fingerprint but lacks the derived secret; it must be unable to forge key confirmation, inject or alter a request, response, unsolicited session event, lifecycle notification, or transport-control message, change capabilities, or consume a grant.

## Producer-owned request lifetime

Each pending UI request must carry an immutable request ID, originating session ID, owner generation, creation/expiry time, and permitted response capability. The producer owns its lifecycle. The server accepts a response only once and only while all fields still match the live owner and pending request.

Every session transition, detach, timeout, shutdown, and owner replacement cancels the request and notifies the host so its Send control is disabled. A UI transition alone is insufficient. Test runtime-driven transitions as well as client-driven switches, Send/Cancel races, duplicate responses, timeout, disconnect, late completion, and session replacement. In particular, verify an attached peer cannot reach source-local approval through `extension_ui_response` before protocol detection.

## Non-persistent VS Code editor destination

Do not use a normal untitled `TextDocument` for sensitive request text: VS Code Hot Exit can retain unsaved untitled content. Use a transient, webview-backed editor surface with an accessible text area. Do not register a `WebviewPanelSerializer`, call `setState`, implement backup/restore, or write request contents to workspace or extension storage. The request capability is never serialized.

The surface has explicit **Send** and **Cancel** actions. Send consumes the exact request capability once; closing, cancellation, timeout, disconnect, or extension restart invalidates it. A restored or copied text buffer never restores authority. No global Hot Exit setting may be changed, and unrelated dirty documents must remain untouched. Verify the text is neither restored nor written to extension state/backups. Test hostile prefill escaping and forged webview messages, plus keyboard and screen-reader access, focus return, concurrent requests, restart, duplicate submission, and dismissal.

This intentionally revises the earlier “untitled editable text document” mechanism to preserve its non-persistence promise. The standard Hot Exit contract is documented by [VS Code](https://code.visualstudio.com/docs/editing/codebasics#_hot-exit); serializer-based webview restoration is opt-in through the [Webview API](https://code.visualstudio.com/api/extension-guides/webview).

## Execution-owned saved output and READ provenance

An attributed saved-output action is available only while trusted producer provenance can be verified. At execution time, record a producer ID, execution ID, stream (`stdout` or `stderr`), session/owner generation, byte count, SHA-256 content digest, captured path identity, and capture time. Generate a random per-session HMAC-SHA-256 key with Node `crypto.randomBytes`; authenticate canonical metadata with it. Keep the key only in the trusted GSD process, never write it to disk, and never expose it to child processes or logs.

Authenticate the purpose and all action-driving identity/path/stream fields as well as the digest. At read time, verify the metadata authenticator, current producer/session lifetime, exact stream, canonical captured root, and content digest before showing an execution-purpose label or offering an artifact-specific action. For native READ, use the existing single `ops.readFile` buffer: verify HMAC and SHA-256 against the complete raw file bytes from that open before UTF-8 decoding, range selection, line/byte truncation, or continuation-notice formatting. Return the range/truncated text and notices from that same buffer; never hash the visible range as if it were the full stream and never reopen the path after verification. If the full bytes cannot be safely obtained within the existing bounded read contract, suppress attribution and fall back to ordinary READ. Reject symlinks, replacement races, mismatched streams, missing or oversized metadata, and changed content. Use a constant-time authenticator comparison. A custom or remote READ implementation may not display attribution unless it uses the same verified-byte contract. Treat output as untrusted text; it cannot provide commands, arbitrary paths, command URIs, approval, or workflow authority.

If the process restarts and the metadata cannot be cryptographically verified, keep ordinary READ behavior available but suppress execution attribution and artifact-specific navigation. Do not treat editable sidecars as an append-only ledger. This is a safe fallback, not proof that historic attribution is preserved across restart.

## PR-sized delivery order

1. **#2914 / PR #3097:** integrate the reviewed fix with current upstream `main`, rerun the exact-source checks and CI, then merge only if those checks remain green. This closes only the Exec-rendering child, not #2913 or #2916.
2. **Identity foundation (#2933):** add producer-owned owner-generation and verified-observation fields to the existing RPC/session contracts. Preserve partial/unknown values and existing ownership guards.
3. **Local pairing and backend grants (#2933):** implement the local-only transport, source-side consent, capability checks, and server-side revocation. Keep unsupported platforms disabled until ACL tests pass.
4. **Confirmed attachment surfaces (#2933):** add native TUI and VS Code candidate selection and matching authentication-string confirmation. Do not add a remote host or automatic attach.
5. **Pending request lifecycle and transient editor (#2933):** enforce owner-generation/expiry on the server, then add the non-persistent VS Code editor and race/retention tests.
6. **Actionable blocker navigation (#2932) and truthful activity (#2936):** add source-backed observations and safe native destinations without changing workflow authority or collapsing unknown states.
7. **Notification identity and urgency (#2935):** use producer-owned stable IDs, bounded deduplication, explicit urgency, and visible delivery/failure outcomes.
8. **Saved output and READ context (#2934):** add execution-owned provenance and safe artifact actions with ordinary READ fallback when proof is absent.
9. **Prose width and semantic emphasis (#2931/#2929):** preserve code, diffs, raw logs, and non-color cues; test narrow/normal/wide terminals and supported themes.
10. **#2916 host acceptance:** run the complete exact-candidate native terminal matrix, real UAT streaming, and an external MCP-host observation after required CI is green. Keep #2916 and #2913 open until their own evidence is complete.

Each implementation PR must remain independently reviewable, list unsupported-host behavior and rollback/fallback, pass its exact-head checks, and receive a fresh focused review. Do not bundle the whole umbrella into one implementation PR.

## Approval and evidence gates

Before implementation of attachment, editor, or saved-output attribution, obtain an independent security review of this concrete amendment and resolve every blocking finding with regression evidence. Agent review is not a substitute for recorded owner approval where the repository requires it; the operator has authorized agent-led review and subsequent merges after the gates pass.

For #2916, bind every observation to the final reviewed commit, build identity, OS, terminal/host, and width. Unit/component tests and successful CI are necessary but do not substitute for real-host observations. Earlier evidence for PR #3097 is tied to older SHAs and must be repeated after source changes.
