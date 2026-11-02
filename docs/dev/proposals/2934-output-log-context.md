# Saved Exec Output Context on Native READ

**Status:** Design proposal for [#2934](https://github.com/open-gsd/gsd-pi/issues/2934), related to umbrella [#2913](https://github.com/open-gsd/gsd-pi/issues/2913). This document does not record maintainer approval or real-host acceptance. The reviewed source baseline is upstream `main` at `52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6`.

## Problem

The native TUI already groups `read` calls as context reads and presents a shortened path and optional line range. When a designer or agent reads saved stdout/stderr from an earlier command, the card does not identify it as an execution artifact or show the producer's recorded purpose. The reader must reconstruct that relationship from a UUID-like filename or an earlier EXEC card.

This proposal narrows the October 22 saved-log READ plan to the behavior not already delivered. [PR #2939](https://github.com/open-gsd/gsd-pi/pull/2939) provides a complete-path list/detail/copy fallback; this proposal does not redo that interaction.

## Relationship to the 22 October Plan

The supplied plan's source snapshot and its description of [PR #2917](https://github.com/open-gsd/gsd-pi/pull/2917) as open/conflicted are historical: #2917 merged on 2026-10-28. The TUI already identifies ordinary reads as context reads and shows path/range; the remaining design is specifically about recognizing saved execution output and safely presenting stream/purpose context. The proposed 64 KiB sidecar cap remains unaccepted.

## Proposed User-Visible Behavior

For an eligible captured output read, show one concise heading and supporting context:

- Standard output is labelled `Captured standard output`.
- Standard error is labelled `Captured standard error`; stderr is not itself a failure signal.
- Show `From: <recorded purpose>` only when producer origin and association are verified. Missing, blank or invalid purpose yields a useful stream label without invented attribution.
- Normalize purpose for display only: single-line, whitespace/control/bidi-safe and display-bounded. Preserve original purpose metadata and raw READ content.
- Preserve the native READ's range and outcome. A successful read does not claim that the producing command succeeded, that evidence was recorded, or that a child task completed.
- Ordinary files and reads with unverified provenance retain their existing behavior.

The added stream/purpose label is presentation metadata only. It must not be inserted into the READ tool's raw content or model-facing text. The existing `/gsd logs exec` list/detail/copy flow preserves the producer-recorded original path; it does not expose an arbitrary later READ's actual resolved path. Whether to retain and present requested, actual and recorded paths is a decision in this proposal. Escape control/bidi characters in displayed paths without rewriting stored or copied values; a shortened display path must never become a stored rename or new file target.

## Provenance Boundary

The purpose field, the `.stdout`/`.stderr` suffix, or a tool name alone is not sufficient evidence to associate a read with a producer. Before adding context, the host contract must establish all of the following:

1. The executed tool is the native built-in READ implementation, not a same-named custom tool.
2. The read used the default local filesystem backend, not custom, remote, MCP or other `ReadOperations`.
3. The actual resolved path used by that operation is available to the association logic.
4. The stream and producer metadata refer to the same validated run identity.
5. Execution-owned evidence establishes that this artifact pair was produced by that invocation and defines its session/host lifetime; a structurally matching sidecar alone is not producer attestation.

Path, filename and metadata consistency are necessary association checks, not proof of producer authenticity. If origin, session/host lifetime or any other item is unknown, suppress attribution and extra context. Do not block or alter the requested file read.

## Bounded Association Proposal

After the host/provenance decision is accepted, a GSD-owned helper could associate only an exact producer-recorded stdout/stderr artifact path with its exact sibling metadata file. It should not scan directories, search execution history, or maintain a second purpose database. The result should be selected before transcript persistence and stored with the result so replay does not perform filesystem I/O.

The helper should validate the run ID, stream-specific basename, metadata shape, canonical containment, file type and the relationship between requested, actually read and recorded paths. It must also consume producer-origin evidence owned by the execution boundary, not infer origin from the sidecar itself. Symlinks, lookalike names, fabricated or replaced matching sidecars, cross-session/host attribution, mismatches, missing or malformed metadata, relocation, and paths outside the expected root must suppress attribution. The original READ result, raw content and error remain authoritative.

The earlier plan proposed a 64 KiB metadata cap; this is a design value, not an accepted API limit. Maintainers should decide the cap and the race-resistant filesystem strategy with the core package owner before implementation. The renderer must be pure and must not read files.

## Current Source Boundary

At the reviewed source baseline:

- [`read.ts`](https://github.com/open-gsd/gsd-pi/blob/52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6/packages/pi-coding-agent/src/core/tools/read.ts) owns native path resolution and permits alternate read operations; it does not currently expose a verified execution-origin contract for this association.
- [`agent-session-extensions.ts`](https://github.com/open-gsd/gsd-pi/blob/52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6/packages/gsd-agent-core/src/session/agent-session-extensions.ts) forwards tool-result information to extension hooks. The current public event must be reviewed before treating it as proof of the native tool or backend.
- [`register-hooks.ts`](https://github.com/open-gsd/gsd-pi/blob/52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6/src/resources/extensions/gsd/bootstrap/register-hooks.ts) already observes successful native reads; enrichment must preserve that behavior.
- [`exec-sandbox.ts`](https://github.com/open-gsd/gsd-pi/blob/52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6/src/resources/extensions/gsd/exec-sandbox.ts) writes execution metadata, and [`exec-history.ts`](https://github.com/open-gsd/gsd-pi/blob/52c3fc3d2be4e37a8fef1fd4e29a81ee80519dc6/src/resources/extensions/gsd/exec-history.ts) reads it for history features.

These are source locations, not proof that the proposed association exists or has been accepted.

## Decisions Requested Before Implementation

1. Is an additive, execution-owned origin contract for native/local READ acceptable, and where should it be produced and persisted?
2. How must the contract distinguish the built-in tool and default local backend from custom or remote implementations?
3. Is exact-sibling metadata association acceptable, and what size limit and file-identity checks are required?
4. Which current/requested/recorded path values should be retained for transcript replay and worktree relocation?
5. Which host surfaces are in scope for the first implementation, and what security review is required?

Until these decisions are accepted, this remains a design-only addendum. Do not infer approval from the user's request to prepare a PR or from the issue's existing pickup comment.

## Regression and Acceptance Matrix

After the design gate is resolved, tests should cover:

- stdout and stderr with valid producer-origin evidence, matching metadata and purpose;
- fabricated/replaced matching sidecars, cross-session/host attribution and stale producer bindings;
- blank/missing purpose, missing/malformed/oversized metadata, mismatched IDs and wrong stream basenames;
- terminal escapes, control/bidi characters, multiline, long Unicode and empty-after-sanitization purposes;
- symlinks, lookalike directories, out-of-root paths, moved worktrees and custom/remote read operations;
- read success, read failure, capped output, repeated reads and transcript reload;
- unchanged raw source, range, truncation, error semantics and ordinary-file rendering;
- no filesystem access during rendering, no directory/history scan, and no association when provenance is uncertain.

Real-host acceptance remains separate under [#2916](https://github.com/open-gsd/gsd-pi/issues/2916). Unit/transport tests alone cannot establish that the intended resources were loaded in a particular terminal, VS Code or MCP host.
