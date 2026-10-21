<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR (proposed) for dirty-scope projection — re-projection triggered at the write seam instead of by caller convention. -->

# ADR-035: Projection Rides the Write — Dirty Scope and One Flush Seam

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Superseded before adoption.** The goal of deriving readable artifacts from authoritative writes remains valid. Process-local dirty scope and the synchronous flush seam are replaced by durable, revision-aware Projection Work stored with the domain mutation.

**Status:** Proposed — adopt when the trigger condition fires (see "Trigger")
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-017 (drift-driven reconciliation), ADR-030 (two-altitude state machine), CONTEXT.md "Domain Write Operation" scoping note (amended by this ADR if adopted)

## Context

### The convention and its safety net

The projection-only invariant (DB authoritative, markdown projection) is
enforced today by a convention: every mutation site must remember to call a
`render*` function afterwards. Eleven call sites carry the convention
(`tools/complete-*.ts`, `tools/reopen-*.ts`, `tools/plan-*.ts`,
`replan-slice`, `reassess-roadmap`, `auto-post-unit.ts`,
`milestone-planning-persistence.ts`, doctor, maintenance, migration audit,
drift repair).

The codebase already documents the failure mode twice:

- The drift catalog carries a `stale-render` kind with detect+repair
  (`state-reconciliation/drift/stale-render.ts`) — a standing repair for
  "someone forgot."
- That file's own header records that `repairStaleRenders` previously had
  **zero production callers** (#5702) — misses happened and nothing healed
  them until reconciliation was wired in.

A convention at N sites plus a repair for violating it is a seam announcing
itself.

### Why this is Proposed, not Accepted

The Domain Write Operation decision in force explicitly scopes write
operations to DB-row atomicity: "markdown re-projection, validation, and
messaging remain in callers." That scoping note is recent, deliberate, and
this ADR contradicts it. Reconciliation currently catches stale renders
before dispatch, so the practical cost of the convention is bounded. The
deepening is recorded now — shape agreed, contradiction explicit — and
adopted only if the safety net proves insufficient.

### Trigger

Adopt when either:

- `stale-render` drift recurs in production telemetry after the
  reconciliation wiring (i.e. the repair is doing standing work, not
  one-off healing), or
- a new mutation surface ships that bypasses `reconcileBeforeDispatch`
  (e.g. interactive closeout paths from ADR-032 mutating outside the auto
  loop's reconcile cadence).

## Decision (when adopted)

### 1. Writes mark a Dirty Projection Scope

Domain Write Operations (and the status/cascade writers) append the scope
they touched — `(milestoneId, sliceId?, taskId?)` — to an in-process dirty
set as part of the write. No I/O at write time; marking is a set insert.

### 2. One Projection Flush seam

```ts
flushProjections(basePath): Promise<void>  // renders exactly the dirty scopes
```

Called at the existing pipeline exits: end of each workflow tool executor,
end of Unit closeout (ADR-032), and by doctor/maintenance as a full-scope
flush. The eleven per-site `render*` calls are deleted; callers stop knowing
the rule exists.

### 3. The drift class demotes to an assertion

`stale-render` detection remains as a cheap invariant check in
reconciliation, expected to fire never. Its repair stays as the recovery path
for externally-edited markdown, which dirty-scope marking cannot see.

## Consequences

- **Deletes a failure mode** rather than repairing it: a write without a
  projection becomes unrepresentable from inside the process.
- **Locality:** projection policy (what renders for which scope, ordering,
  descriptor-dir resolution — the class of bug where renderers resolved the
  wrong descriptor dir) lives at one seam.
- **Cost:** the CONTEXT.md Domain Write Operation scoping note must be
  amended; writers gain a (tiny) responsibility; flush placement must be
  audited so no exit path is missed — which is the same class of convention
  this ADR removes, but at ~3 pipeline exits instead of 11 mutation sites.
