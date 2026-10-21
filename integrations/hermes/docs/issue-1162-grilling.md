# Issue #1162 — Grilling summary: `/gsd new-milestone` via Hermes

Source: `grill-with-docs` + `grilling` + `domain-modeling` skills on issue #1162.
This is the shared understanding the interview reached — the design tree walked
branch-by-branch with a decision at each node. Implementation should conform to
this; deviations should re-open the corresponding question, not silently diverge.

Glossary for every term below lives in [`../CONTEXT.md`](../CONTEXT.md).

---

## The one-line design

Add a `/gsd new-milestone <spec>` slash command that spawns
`gsd headless new-milestone` as a **plugin-owned subprocess**, fires-and-forgets
an ack, drives lifecycle (blocker/terminal) notifications from the subprocess's
stream-json stdout, and hands execution off to the **existing, untouched**
`/gsd auto` path. No `--auto` chaining, no new MCP tool, no TS-side changes.

---

## Decision tree (Q1–Q9)

### Q1 — Mechanism & transport → **(A) Slash command → CLI subprocess**
- New `_cmd_new_milestone` in `GsdCommandRouter`. Shells out to
  `gsd headless new-milestone --context-text <spec>`.
- **Not** a Hermes skill (B), **not** a new MCP `gsd_create_milestone` tool (C).
- Rationale: the plugin already has a proven direct-CLI pattern (`progress()`
  calls `gsd read progress --json`); `new-milestone` is even more naturally a
  CLI call (it bootstraps `.gsd/`, has a 10-min timeout, manages its own RPC
  child). An MCP tool would re-implement what the CLI already does, and the
  upstream lease-layer co-run issue (CHANGELOG:509, open) makes advertising
  `gsd_create_milestone` over MCP actively unsafe to every MCP client.
- A later Hermes skill (B) can wrap the same client method with zero rework.

### Q2 — Co-run safety gate → **(A) Local supervisor state only**
- Reject if `SupervisorContext.state in (RUNNING, BLOCKED)` before spawning.
- **Not** a server-side cross-binding check (B). Documented limitation: a
  session started by *another* plugin instance / a headless run outside this
  plugin is invisible to the local guard; the CLI's own lease check is the
  backstop.
- Rationale: the plugin can only authoritatively own its own state; a
  server-side "is anything running?" check is itself racy and adds a new query
  path to design and test.

### Q3 — Run model → **(A) Fire-and-track via the existing async-push model**
- Return "🚀 Milestone creation started (session X)" immediately; push
  blocker/terminal notifications from a background stream-reader.
- **Not** a synchronous blocking call (rejected after discovering the plugin is
  fundamentally async-push — `_cmd_auto` already works this way; the target
  chat platforms don't hold request/response open for minutes).
- *(Note: "reuse `SupervisorFsm` unchanged" was initially proposed under this
  label but does NOT work — see A1 below.)*

### Q3 follow-up — How to drive the fire-and-track → **(A1) Client-owned subprocess, direct stream→notification**
- `GsdMcpClient` spawns `gsd headless new-milestone --output-format stream-json`
  on a background thread, reads stdout line-by-line, captures
  `init_result.sessionId`, and on terminal/blocker events calls
  `NotificationService` directly.
- `SupervisorContext` is **shared state** (written by the stream-reader, read by
  `/gsd status`, `/gsd cancel`, the co-run gate); the `SupervisorFsm` poll loop
  is **not** reused for the milestone path (its `_tick` calls `gsd_status`,
  which can't see our subprocess).
- Rationale: the stream *is* the lifecycle signal; polling would be a lossy
  proxy for events we already get deterministically. Reuses
  `NotificationService` and `SupervisorContext` unchanged.

### Q4 — Cancellation → **(A) Local PID ownership + direct SIGTERM**
- `GsdMcpClient` holds the `subprocess.Popen` handle; `cancel_milestone()` calls
  `proc.terminate()` directly. `_cmd_cancel` routes to it when a milestone proc
  is active.
- **Not** a new `.gsd/milestone.lock` pid file for the MCP backstop (B) — that
  crosses the Python/TS boundary and inverts ownership. **Not** "no cancel during
  planning" (C) — a stuck planning run needs an escape hatch.
- Discovered: MCP `cancelSessionByDir`'s `auto.lock` pid backstop does NOT find
  our planning subprocess (no `auto.lock` exists during planning — it's an
  auto-loop concept). So local ownership is required, not optional.
- Plus explicit supervisor stop on cancel (immediate confirmation, don't wait
  for next poll tick).

### Q5 — Scope: `--auto` (chained execution)? → **No. Planning-only.**
- The plugin creates the milestone and hands off; execution is `/gsd auto`'s job.
- `/gsd auto` already has a robust path (MCP `gsd_execute` → self-healing poll
  supervisor). Chaining `--auto` would duplicate that with a stateful
  stream-reader over hours (fragile) instead of the proven poll loop.
- **Boundary clarification:** this plugin (`gsd-pi/integrations/hermes/`) is the
  chat gateway. One-shot `new-milestone --auto` is gsd-core's terminal surface,
  not the gateway's.
- `/gsd new-milestone --auto` is **rejected at the command level** with a message
  pointing to the two-step flow.

### Q6 — Input shape → **Bare positional, with `--file` escape**
- `/gsd new-milestone <spec text>` → `--context-text` (matches `/gsd reply`).
- `/gsd new-milestone --file <path>` → `--context <file>` (explicit opt-in).
- **Not** auto-detect path-vs-text (heuristic misroutes on collision — rule #5).
- **Not** `--description "..."` flag form (issue's example used it, but the bare
  positional matches the sibling command users already know).

### Q7 — Output → **(A) Bounded summary via `gsd_query` at completion, with (B) as graceful fallback**
- Immediate ack: "🚀 Milestone creation started for `<project>`."
- Completion push: bounded summary — milestone id, slice count, task count,
  one-line next step ("Run `/gsd auto` to start."). Built from
  `gsd_query {projectDir, query: "milestones"}` after exit-0.
- Fallback: if the query comes back empty/missing after exit-0, degrade to
  "✅ Milestone created. Run `/gsd status` for details."
- **Trust exit-0; no defensive re-querying.** If exit-0 lies about flush state,
  that's a gsd-core bug to fix at the source, not a leak for the plugin to patch
  with a racy retry loop.
- Error/blocked cases route through existing `notify_terminal`/`notify_blocker`
  unchanged.

### Q8 — Failure modes
| # | Mode | Disposition |
|---|---|---|
| 1 | Active auto session (co-run) | Reject before spawn; fail closed |
| 2 | No project bound | Reuse `BindingError` path (zero new code) |
| 3 | Empty spec | Usage message (matches `_cmd_reply`/`_cmd_bind`) |
| 4 | Spec too long for `--context-text` | Surface `E2BIG`/`OSError`; point to `--file` |
| 5 | Planning errors (non-zero exit) | `notify_terminal(status, error)` via existing path |
| 6 | Planning hits a blocker | `notify_blocker`; reply via **client-owned stdin** (see below) |
| 7 | `--file` missing/unreadable | Validate before spawn |
| 8 | Stream-reader thread/pipe dies | Best-effort: set FAILED, `notify_terminal("failed", "stream lost — run /gsd cancel")`. **No watchdog.** Cancel is the escape hatch. |
| 9 | Plugin restart mid-planning | **Documented limitation.** Orphaned subprocess survives; invisible after restart (same as existing supervisor's restart-blindness). |
| 10 | User passes `--auto` | Reject at command level (see Q5) |

**Blocker replies (#6) — client-owned, not MCP-routed.** `gsd_resolve_blocker`
calls `sessionManager.resolveBlocker` which looks up the MCP server's *own*
sessions map — our subprocess isn't there, so it throws "Session not found".
Because we own the subprocess's stdin (A1), `/gsd reply` for a planning blocker
writes the response to *our* subprocess's stdin via a new
`respond_to_milestone_blocker(response)` method. `_cmd_reply` gets one branch:
if a milestone subprocess with a pending blocker is active, route locally; else
fall through to the existing MCP `resolve_blocker` path.

### Q9 — Cross-effects on existing commands
- **`_cmd_cancel`** — MUST change: add milestone-subprocess branch routing to
  local `cancel_milestone()` (SIGTERM) when one is active. *Required.*
- **`_cmd_auto`** — MUST change: add symmetric co-run guard (reject if
  `SupervisorContext` shows an active milestone run, point to `/gsd cancel`).
  *Required* — without it, `/gsd auto` during milestone planning silently
  re-exposes the unsafe co-run (the MCP server's "Session already active"
  rejection does NOT fire for our planning subprocess, since it's not registered
  and writes no `auto.lock`). Rule #12 (fail loud) over rule #3 (surgical) here.
- **`/gsd status`** — leave alone. Reads disk honestly; the Q3-accepted planning
  progress gap means it may show stale/partial state early on. The completion
  notification is the real "done" signal.
- **`/gsd reply`** — additive branch only (Q8 #6); core MCP path untouched.
- **`SupervisorFsm`** — untouched (A1 uses a separate stream-reader driver).
- **TS MCP server** — untouched (no new tools).

---

## Implementation surface (additive unless noted)

**`gsd_client.py`** — new methods + state:
- `self._milestone_proc: subprocess.Popen | None`
- `create_milestone(project_dir, *, context_text=None, context_file=None) -> str` —
  spawns `gsd headless new-milestone --output-format stream-json`, starts the
  stream-reader thread, returns `sessionId` (captured from `init_result`). Throws
  on co-run guard / missing spec.
- `_milestone_stream_loop(proc)` — reads stdout JSONL; on `init_result` captures
  `sessionId`; on blocker event → `notify_blocker` + sets
  `SupervisorContext.pending_blocker_id`; on terminal/exit → `notify_terminal` +
  sets `SupervisorContext.state`.
- `cancel_milestone()` — `proc.terminate()` + cleanup.
- `respond_to_milestone_blocker(response)` — writes UI-response to proc stdin.
- `milestone_active()` predicate for the co-run gate.

**`commands.py`** — new handler + two modifications:
- `_cmd_new_milestone(rest)` — the new command (guard, parse, spawn, ack).
- `_cmd_cancel` (modify) — milestone-subprocess branch.
- `_cmd_auto` (modify) — symmetric co-run guard.
- `_cmd_reply` (modify) — milestone-blocker branch (additive).
- `_cmd_help` (modify) — list `new-milestone`.

**`__init__.py`** — wire the new client methods / supervisor notifications if
the constructor surface changes (likely no change — `GsdMcpClient` already has
`config`, and `NotificationService` is already injected).

**Tests** (new, matching existing `tests/test_*.py` patterns):
- `test_new_milestone_command.py` — guard (co-run both ways), input parsing
  (bare text, `--file`, empty, `--auto` rejected), spawn + ack.
- extend `test_gsd_client_cache.py` or new `test_milestone_client.py` —
  stream-reader captures sessionId from `init_result`; blocker event →
  `notify_blocker`; terminal → `notify_terminal`; cancel SIGTERMs the proc;
  blocker reply writes stdin.
- extend cancel/reply tests for the new branches.

---

## Explicitly OUT of scope (v1)

- `--auto` chaining (execution stays with `/gsd auto`).
- Cross-instance / server-side co-run coordination (Q2 limitation).
- Plugin-restart recovery of an orphaned planning subprocess (Q8 #9).
- A Hermes skill (issue's Option B) — additive follow-on, wraps the same client.
- Any TS-side / MCP-server change.
