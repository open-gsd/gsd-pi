<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for cmux sidebar status and shared-progress ownership across coexisting GSD sessions (issue #2926). -->

# ADR-051: cmux Sidebar Ownership — Per-Session Status Keys and Fold-Written Shared Progress

**Status:** Accepted (2026-10-21)
**Date:** 2026-10-21
**Related:** [ADR-006](ADR-006-extension-modularization.md) (extension decoupling), issue #2926, umbrella #2913 (O07)

## Context

The cmux extension syncs a sidebar from GSD auto-mode state. Two properties of
the cmux CLI shaped this decision:

- `set-status` / `clear-status` are **keyed** — several status rows can coexist
  in a workspace.
- `set-progress` / `clear-progress` are **workspace-scoped with no key** — a
  workspace has exactly one progress slot.

At main `b09bdf3fc` the extension used the fixed key `gsd` for status, wrote
the single progress slot on every sync, and cleared both on every sidebar
`clear` event (stop cleanup emits one unconditionally). Consequences when two
independent GSD sessions share one cmux workspace:

1. Both sessions write the same `gsd` status row — last writer clobbers the other.
2. Any session completing, exiting, or cleaning up erases the *other* session's
   live status and progress.
3. `completing-milestone` rendered with the same green check as `complete`, so
   a still-finalizing run presented as authoritatively completed.
4. The snapshot cache was keyed by workspace only, so one session's sync could
   suppress another session's push.

A unique status key alone does not solve the shared progress slot, and a new
daemon or global workflow engine is out of scope (issue constraint).

## Decision

**Session identity.** The existing `CMUX_SURFACE_ID` environment variable is
the per-session identity; every sidebar-enabled session has one (availability
requires it). Session key = `gsd:<surfaceId>` (status key space), falling back
to the historical `gsd` when no surface id exists (non-cmux fallbacks).

**Status ownership.** Each session writes and clears only its own keyed status
row, and it rewrites the row on **every** sync unconditionally. There are no
snapshot caches: a cache that suppresses an identical rewrite cannot detect
that another process (e.g. a same-key predecessor finishing its cleanup)
cleared the row in between, and would leave it missing indefinitely. Syncs are
low-frequency state transitions, so the redundant local CLI call is cheap next
to correctness.

**Progress coordination.** The single workspace-scoped slot is written with a
**deterministic fold** over a registry of live sessions. The registry is a
per-workspace directory in the OS temp directory
(`gsd-cmux-progress-<sanitized-workspace>/sessions/<key>.json`) holding ONE
FILE PER SESSION (`{ pid, progress, updatedAt }`):

- **Every session only ever creates, updates, or removes its own file.** There
  is no read-modify-write over shared state, so concurrent mutations
  structurally cannot lose a member (a single-file registry with atomic rename
  would still lose the loser of a last-writer-wins race).
- The fold sums each progress level across the members reporting it and
  applies the existing single-session deepest-level preference (tasks →
  slices → milestones) and label format (`buildCmuxProgress`). Because the
  fold is a pure function of the directory state, any session that writes the
  slot writes the same value; concurrent refreshes converge.
- **There is no dedicated owner and there are no write-dedup caches.** Every
  sync rewrites the slot with the current fold, unconditionally. Any private
  cache ("I already wrote this value") can suppress a repair after another
  member interleaved a different value and then vanished — a crash between
  this process's syncs, or a delayed cleanup landing after a survivor joined —
  and no read-back API exists to detect that. Unconditional rewrite makes the
  freeze class structurally impossible: the bar is exact after any member's
  next sync, and members sync on their own state transitions without waiting
  on peers.
- **Liveness is pid-based; there is no expiry timeout.** Entries whose pid is
  dead are unlinked on every listing (idempotent — any member may do it) and
  reported as **reaped**; the survivor that reaps a key also clears that
  session's orphaned status row — the dead pid proves the identity is gone, so
  this is not erasing live state. A crashed session is therefore fully
  reclaimed (registry entry, progress contribution, status row) by the next
  sync of any survivor. Corrupt or unreadable entries are treated as garbage,
  removed, and reported the same way; the owner re-registers on its next sync.
- A departing session (any sidebar `clear`) removes its own entry — fenced
  against the recorded pid, so a same-key replacement that registered first is
  never removed — and then writes the fold over the survivors, or clears the
  slot when none remain. A departure can never erase or stale-freeze another
  session's live state.
- Registry writes are temp file + rename (atomic); listings tolerate a missing
  directory by returning an empty member set.

**Finalization semantics.** `completing-milestone` (closeout running) renders
with distinct icon/color (`settings` / `#eab308`); only `complete` — the state
machine's post-closeout-gate phase — keeps the authoritative green check. The
label already carries the phase string, so text semantics stay distinct.

## Failure and restart behavior

- **Crash without cleanup:** pid death prunes the entry on the next listing by
  any survivor; that survivor's next sync rewrites the fold unconditionally,
  so the crashed session's contribution disappears without operator action.
- **Corrupt/unreadable registry:** the offending entry file is removed and the
  syncing session rebuilds its own. Survivors re-register on their next sync.
- **Restart/reconnect:** a restarting session re-registers under the same
  session key (same surface id) with its new pid on its first sync, and both
  its status row and its progress contribution are rewritten unconditionally.
- **Same-key replacement racing cleanup:** if a new process with the same
  surface id registers before the old process clears up, the pid fence keeps
  the replacement's registry entry. Residual: the status *row* is keyed
  identically and cannot be fenced (the CLI has no status read API), so the
  old process's cleanup transiently clears it; the replacement's next sync
  rewrites it unconditionally, so the gap is bounded by one sync.
- **Transient fold races:** two members refreshing concurrently read the
  directory at slightly different moments; both writes are deterministic folds
  and every subsequent sync rewrites the current fold. The same bounds the
  microsecond check-then-unlink race in entry removal: a same-key replacement
  or re-writing member whose entry is removed mid-flight re-registers on its
  next sync. The bar is eventually-exact under activity, never permanently
  erased; eliminating the last window would require cross-process file
  locking, which is disproportionate for a sidebar progress bar.
- **pid reuse:** a reused pid can keep a stale entry alive-looking until that
  pid dies. Same residual risk class as any pid-file scheme; accepted.
- **Multi-user machines:** the registry lives in the shared temp directory,
  exactly like cmux's own default socket path (`/tmp/cmux.sock`); no new
  isolation model is introduced.

## Consequences

- Two independent sessions can interleave syncs, complete, exit, crash, and
  restart in one workspace without erasing each other's sidebar state, and a
  member's progress change is visible without waiting on any peer.
- The progress bar shows the deterministic fold of live sessions; a single
  session sees exactly the pre-#2926 values and label.
- No daemon, no host coupling, no background processes: coordination is one
  small file per member plus pid checks on existing sync paths.
- Real-cmux observation evidence (source SHA, loaded runtime, host version,
  dimensions/theme, durable captures) remains a host-pass, recording-gated
  item per the #2671/#2672 precedent.
