# ADR-050: Task and Slice closeout receipts

- **Status:** Accepted
- **Date:** 2026-10-05
- **Driver:** Cutover package P27d — a Task publishes only when its source commit has a Settlement Receipt, and a Slice completes only when its Tasks are published
- **Amends:** ADR-046 (Closeout is prepared, then settled — extends plans from Milestones to Tasks and Slices)

## Context

A Milestone closes out through an immutable Closeout Plan with ordered Closeout
Effects and Settlement Receipts (P27, #2596, #2611, #2621): milestone-merge is
ordinal 1, integration-push 2, github-milestone-close 3, and
`milestone.complete` runs in the settle transaction only after the required
effects have receipts. A Task has no plan. Its source commit is a turn-level
git action the auto loop runs *after* the verified publication: the Task is
already lifecycle `completed` and its dependents are already released when the
commit is attempted. A refused commit (a hook rejection) leaves a published
Task whose work is not committed, and the only repair is the git-commit
remediation retry (#2618) re-selecting the closed Task. The special case "a
Task is already closed when its commit is refused" exists only because
publication does not wait for the commit.

`slice.complete` stores the tested source set hash its completion proved
(#2616), but it does not check that the Tasks it completes were actually
published with their source commits.

## Decision

**The source commit of a Task is Closeout Effect ordinal 1 of a Task Closeout
Plan, and the Task is published only when that effect has a Settlement
Receipt.**

- **Task.** The auto loop prepares the Task Closeout Plan while the Task's
  Attempt is settled succeeded at the verify stage, then commits, then
  records the receipt, then publishes. `task.completion.publish` refuses
  while the plan's source-commit effect has no Settlement Receipt — the
  Kernel `closeout` and `settled` stages never run for a Task whose commit
  has not settled — so a refused or failed commit leaves the Task unpublished
  with its Attempt settled, and the existing git-commit repair retry
  (`unit_dispatch_retries`, #2618) repairs it. After this change the special
  case "a Task is already closed when its commit is refused" does not exist.
- **Git with nothing to commit** settles the effect as `recognized` with the
  current commit as its external reference, the same as the recognized merge.
- **Slice.** A Slice has no Attempt and no Slice Attempt is invented. The
  Slice Closeout Plan is the `slice.completed` fact itself: it cites the
  tested source set hash that `slice.completed` already stores (#2616) and
  the Settlement Receipts of its Tasks. `slice.complete` refuses while a Task
  of the Slice carries an unsettled source-commit effect: every verified Task
  of the Slice must be published with its receipt. A Task whose commit is not
  GSD's to make carries no plan and does not block, and a Task an Import
  Application or the lifecycle backfill attests as legacy stays exempt. The
  schema keeps `workflow_closeout_plans.attempt_id NOT NULL`, so a Slice
  stores no plan row: no table rebuild and no schema version step (the #2621
  no-rebuild rule).
- **When the commit is not GSD's to make** — isolation `none` on the user's
  own working tree, or the turn git action is not `commit`
  (`git.auto_commit: false`, snapshot or status-only mode) — the effect is
  not in the plan, and publication does not wait for it.
- Database content is never lost, a status never changes silently, and an
  unknown legacy status fails loud.

### Kernel stage semantics

`route → closeout → settled` is the terminal chain of a published Task's
Attempt. With this ADR the `closeout` and `settled` stages mean that a
Closeout Plan settled: `publishCanonicalCompletion` appends them only with
the plan and its source-commit receipt. `voidStaleRouteHead` (Task reopen)
keeps consuming a dead lineage head at `route` (a cancelled or interrupted
Attempt has no closeout to lie about and no plan will ever exist); it refuses
to void a head whose Attempt succeeded without the settled receipt, because
silently discarding a publishable success would hide work.

## Consequences

- The auto loop commits before publication for an adopted Task (an Attempt at
  the verify stage). The legacy order — commit after publication — stays for
  an unadopted Task; P35 deletes that path.
- The #2417 operator publication door (`gsd_task_settle` on a stranded
  durable success) publishes only a success whose source-commit receipt is
  settled. A stranded success with an unsettled commit effect refuses with
  the sanctioned exit (re-enter `/gsd auto`, which prepares, commits and
  publishes); the pre-P27d stranded successes without a plan keep publishing
  through the door.
- A kill between commit and receipt restarts into the same boundary: the plan
  already exists, the tree is clean, so the commit settles as `recognized`
  with the commit that is already there — no second commit.
- The execute-task file-change safety audit in
  `postUnitPostVerification` runs after the receipt-covered commit, so its
  diff base is the committed head; for adopted Tasks the audit window narrows
  to the projection renders, which are gitignored.
- `slice.complete` refuses while a Task of the Slice carries an unsettled
  source-commit effect. A Task an Import Application or the lifecycle backfill
  attests as legacy (`isLegacyAdoptedCompletion`) stays exempt, the same
  grandfathering the Technical Verdict gate already applies; blocker-accepted
  and cancelled Tasks are terminal without publication and need no receipt.
- Existing plan machinery is reused, not forked: `workflow_closeout_plans`,
  `workflow_closeout_effects` and `workflow_settlement_receipts` rows keyed
  by the Task's lifecycle, with `task.closeout.prepare` and
  `task.closeout.settle_effect` Domain Operations. No new schema version.

## Rejected alternatives

- **Commit as a post-publication retry, as today.** Rejected: it is the
  behavior this ADR deletes — a published Task whose work is not committed
  breaks invariant 7 (receipts before dependency unlock) and needs the
  "already closed when its commit is refused" special case.
- **A Slice Attempt so a Slice plan row can exist.** Rejected by owner
  decision: a Slice has no execution to attempt, and inventing one would
  fabricate Attempt history. The Slice plan is the `slice.completed` fact
  plus its Tasks' receipts.
- **Making `workflow_closeout_plans.attempt_id` nullable or rebuilding the
  table for Slices.** Rejected: the #2621 no-rebuild rule forbids a table
  rebuild and a schema version step, and the trigger-only replacement path
  cannot lift a NOT NULL column constraint.
- **Gating publication on a plan row without a commit effect** (prepare a
  plan for every Task regardless of git ownership). Rejected: when the
  commit is not GSD's to make, a plan whose only effect can never settle
  would strand publication; "the effect is not in the plan" keeps
  publication reachable.
- **Recording the commit receipt as a journal line or a runtime flag.**
  Rejected: a receipt must be a durable, replay-safe database fact inside a
  Domain Operation; the Settlement Receipt row already carries outcome,
  external reference, proof and hash with causality triggers.
