<!-- Project/App: gsd-pi -->
<!-- File Purpose: Accepted umbrella ADR for the database-authoritative workflow refactor. -->

# ADR-046: Database-Authoritative Workflow Lifecycle

**Status:** Accepted (2026-07-11)
**Date:** 2026-07-11
**Decision issue:** [Wayfinder: Database-authoritative GSD workflow refactor](https://github.com/open-gsd/gsd-pi/issues/1405)
**Implementation program:** [Decompose the approved contracts into implementation milestones](https://github.com/open-gsd/gsd-pi/issues/1411#issuecomment-4948101799)
**Approval provenance:** Direct maintainer instruction recorded in the project database as Decision `D001`; proposal merged in [PR #1416](https://github.com/open-gsd/gsd-pi/pull/1416) at commit [`93cd35e5`](https://github.com/open-gsd/gsd-pi/commit/93cd35e5)

> This ADR is the accepted durable decision record accompanying the
> [workflow refactor RFC](proposals/rfc-database-authoritative-workflow-refactor.md).
> The merged proposal and direct maintainer instruction satisfy the architecture
> approval gate. Implementation remains subject to the dependency order, review,
> testing, migration, and release gates recorded below.

## Context

GSD currently expresses workflow authority across database rows, Markdown and
JSONL files, runtime snapshots, process-local counters, several orchestration
loops, and path-specific closeout behavior. Those paths can disagree about the
next work, completion, verification, retry budgets, or whether user input is
required. Repair code then attempts to reconcile the disagreement, sometimes
by reading a projection back into authority or by advancing work that did not
actually succeed.

The product goal is smaller than that machinery: guide a person through what
they want to build, research the uncertain parts, turn the result into
Milestones containing Slices and Tasks, and carry that work to verified
completion. Discovery may last days or weeks and must resume without relying
on one process or one conversation transcript.

## Decision

Adopt one database-authoritative workflow model and incrementally converge all
execution paths on it.

### One hierarchy for discovery and delivery

Every Project uses the ordinary `Milestone -> Slice -> Task` hierarchy.
Milestone Kind describes purpose without creating another lifecycle:

- `discovery`
- `research`
- `requirements`
- `roadmap`
- `delivery`
- `remediation`

A new Project normally begins with four resumable Milestones: product
discovery, domain and technical research, requirements validation, and the
delivery roadmap. Research precedes finalized requirements and roadmap
decisions. New uncertainty creates targeted research dependencies rather than
being guessed away.

Planned start, end, and review dates are advisory forecasts. They never become
readiness rules, timeouts, completion evidence, or automatic blockers.

### Truthful lifecycle and outcomes

Lifecycle Status, immutable Attempt Result, Requirement Disposition, Waiver,
and Blocker are separate concepts.

- An Attempt succeeds, fails, or is interrupted; its history is never erased.
- Failure or interruption never means completion.
- There is no runtime `skipped` outcome. Cancellation plus an authorized
  Waiver represents intentionally omitted work.
- Dependencies unlock only when required work is satisfied or explicitly
  waived by authorized policy.
- Reopening upstream work marks dependency-reachable decisions and evidence
  for revalidation.

### SQLite is the sole Workflow Authority

Normal runtime reads hierarchy, ordering, readiness, lifecycle, questions,
decisions, blockers, waivers, Attempts, recovery state, verification, UAT, and
closeout from one consistent project-database snapshot. Missing or unreadable
authority fails explicitly; runtime does not fall back to files or cached
prose.

Read-only progress integrations are a display-only compatibility boundary:
`gsd read progress` and packaged MCP `gsd_progress` may serve the `STATE.md`
projection only when the project database is missing or cannot be opened, or
when the standalone MCP package has no GSD runtime bridge. Once the database
opens, it remains authoritative and any later read failure is reported instead
of falling back. This exception cannot drive lifecycle state.

Only Domain Operations in the Single Writer layer mutate workflow state. A
Domain Operation validates revision, dependencies, lifecycle, lease/fencing,
evidence, and transport idempotency inside one transaction. That transaction
commits the domain change, immutable events and links, durable Projection Work,
and the new database revision together.

Narrative content may be canonical database content, but every machine-relevant
fact has a normalized database representation. Runtime never reconstructs
workflow truth from narrative prose.

### Markdown and other files are one-way projections

PROJECT, ROADMAP, QUEUE, CONTEXT, PLAN, SUMMARY, ASSESSMENT, UAT,
REQUIREMENTS, RESEARCH, decisions, manifests, compatibility planning trees,
and JSONL audit views are projections or exports only.

Projection Work is durable database state containing desired and rendered
revisions, hashes, attempts, retry timing, and errors. Rendering happens after
the Domain Operation commits and writes atomically. A projection failure is
visible and retryable, but cannot change lifecycle state, satisfy a
dependency, authorize recovery, roll back a committed operation, or block
otherwise valid work. A full projection rebuild is idempotent from the
database.

Legacy disk content enters authority only through explicit Import Preview and
Import Application. Preview is read-only, reports exact mappings and loss, and
binds approval to source fingerprints, parser/schema versions, and database
revision. Application requires unchanged inputs, a verified restorable backup,
resolved ambiguity, required consent, and one transaction. Import is never an
implicit startup, database-open, derive-state, dispatch, or reconciliation
behavior.

### One natural conversation contract

Open Questions, answers, recommendations, Decisions, corrections, and Work
Checkpoints are persisted in the database. Interaction kind is explicit:
`open`, `choice`, `clarification`, `recap`, `consent`, or `subjective-uat`.

The agent asks one focused question in the user's language. Real choices put
the recommendation first and include a plain-language reason, evidence,
confidence, and the uncertainty that could change it. Free-form pushback is
stored separately from its normalized interpretation. Corrections supersede
rather than overwrite prior Decisions and trigger downstream revalidation.

Safe reversible work continues with a recorded recommendation when evidence
and delegated authority permit. Recaps are correction surfaces, not approval
gates. Ordinary choices are not consent.

### One Lifecycle Kernel

One persisted Lifecycle Kernel serves auto, interactive, custom, parallel, and
temporary legacy adapters. Its public control surface is `start`, `advance`,
`resume`, and `stop`. It owns only:

1. **Advance** — read one snapshot, reconcile database invariants, select and
   claim dependency-ready work, and create one fenced Attempt.
2. **Execute** — invoke an executor adapter and persist its immutable result.
3. **Verify** — run required automated criteria and persist fresh evidence.
4. **Route** — select exactly one bounded recovery action.
5. **Closeout** — prepare and settle completion through the shared boundary.

Provider calls, SQL implementation, verification runners, recovery policy,
git/worktree mechanics, projection workers, transports, UI, and parallel
capacity stay in their owning deep modules. They return typed results and do
not mutate lifecycle independently. Parallelism is database-claim concurrency,
not a second lifecycle or a DAG wrapped around one work item.

The refactor remains provider-neutral and extension-first. Provider-specific
execution stays behind typed adapters, and capabilities that do not require
core lifecycle authority remain extensions rather than kernel responsibilities.

### Closeout is prepared, then settled

`prepareCloseout` verifies children, waivers, fresh evidence, required Human
Acceptance, remediation, lease/fencing, and source ownership, then persists an
immutable Closeout Plan while work remains active.

`settleCloseout` performs required host effects using durable effect IDs and
records idempotent Settlement Receipts. Required source commit, worktree, and
merge-safety effects settle before the transaction that marks work complete
and unlocks dependencies. Notifications, metrics, indexing, memory extraction,
presentation, and projection rendering are noncritical follow-on effects.

Closeout reports typed failures to Route; it contains no private retry policy.

### Automation-first verification and recovery

Every Technical Verdict references fresh immutable Verification Evidence with
criterion, work and Attempt identity, exact command/tool and working directory,
timestamps, exit code, source and database revisions, content hashes, durable
output reference, and environment metadata. Missing, stale, malformed, or
inconclusive evidence is never a pass.

Machine-fixable failures create or reuse linked Remediation Tasks. Recovery
chooses exactly one of `retry`, `repair`, `replan`, `remediate`, `clarify`,
`pause`, or `abort`, using persisted bounded budgets and normalized failure
fingerprints. Unrelated ready branches continue.

Human input blocks only the affected dependency and only for:

- missing authority, credential, account access, or external dependency;
- consent for destructive, irreversible, paid, public, or account-level work;
- materially ambiguous product intent with multiple valid routes;
- explicitly required Subjective UAT that tools cannot observe; or
- a user-defined time, cost, privacy, or policy limit.

Failed tests, projection failures, ordinary defects, worktree repair, stale
workers, missing harnesses, browser startup, and git conflicts are not
human-only by default.

## Invariants

1. The project database is the only normal-runtime Workflow Authority.
2. Files never mutate authority except through explicit, authorized import.
3. Every cross-transport mutation is revision-checked, fenced, and idempotent.
4. At most one active Attempt exists per work item; parallel work uses separate
   claims.
5. Attempt, question, decision, evidence, recovery, and closeout progress
   survives restart.
6. Failure, cancellation, timeout, projection state, or artifact presence can
   never fabricate completion.
7. Required evidence and settlement receipts exist before dependency unlock.
8. Projection failure is observable and repairable but non-authoritative.
9. Only the approved human-only taxonomy may pause for a person.
10. Legacy adapters translate into Domain Operations and Kernel Outcomes; they
    contain no independent policy or authority.

## Ownership

| Concern | Owner |
|---|---|
| Lifecycle sequencing, claims, stages, fencing, normalized outcomes | Lifecycle Kernel |
| Workflow mutations, revisions, journal/outbox, Projection Work | Single Writer / Domain Operations |
| Questions, answers, Decisions, corrections, checkpoints | Conversation domain module |
| Verification execution and evidence capture | Verification runners |
| Failure classification and bounded action selection | Recovery Classifier |
| Source isolation, commit, worktree, merge, publication mechanics | Git/worktree/publication modules |
| Rendering, retries, staleness, and rebuild | Projection worker |
| Provider execution, custom definitions, and transport behavior | Typed kernel adapters |

## Migration and cutover

Migration is additive and never runs two authorities.

1. Land characterization and fault-injection baselines before changing schema
   or routing.
2. Add revision/Authority Epoch, lifecycle and Attempt journal, stage
   checkpoints, questions/decisions/checkpoints, blockers/waivers, recovery,
   evidence/UAT, Projection Work, import/provenance, closeout/receipts, and
   custom-definition storage.
3. Backfill in one verified transaction. Preserve raw legacy values; map
   `skipped` only to cancellation and a provable Waiver; convert fabricated
   completion to failed/interrupted work with remediation; treat unreliable
   assessment history as unverified.
4. Route one low-risk work family through the kernel, then auto, interactive,
   standard, custom, and parallel families with semantic shadow comparison.
   Shadow comparison observes outcomes; it never creates disk authority.
5. Increment the per-Project Authority Epoch at cutover. A migrated Project
   cannot downgrade to disk authority.
6. Roll out through development corpus, opt-in canary, and stable release gates
   with restart, fault, import, restore, parity, projection, and performance
   evidence.
7. Restore the exact verified pre-import backup only while its Import
   Application remains the canonical operation head, project revision and
   Authority Epoch still equal the Application result, no later canonical
   Domain Operation or cutover has committed, and explicit destructive consent
   is current. Any later Domain Operation or cutover permanently closes that
   restore window, even when later state equals the Application result. A
   difference review informs consent while the window is open and scopes
   Forward Repair after closure; it never reopens restore eligibility. After
   closure, Forward Repair is mandatory. Never roll back to disk authority.
8. Delete legacy paths only after their replacements, fault and restore gates,
   production routing closure, structural no-authority-read tests, telemetry
   thresholds, and performance baselines pass.

Explicit legacy import/export compatibility remains for two stable releases
and at least 60 days, whichever is longer, beginning when Import Preview and
Import Application ship. Time alone is not a Removal Gate. Backups remain
available through that window and at least one later stable release.

## Consequences

### Positive

- Restart and transport changes cannot change the authoritative next work.
- Discovery can span weeks without a parallel interview state machine.
- Automated evidence and remediation replace routine approval pauses.
- Projection drift becomes an operational concern, not lifecycle truth.
- One sequencer and shared closeout eliminate duplicated policy paths.
- Legacy complexity has explicit deletion gates and a bounded lifetime.

### Negative

- The additive schema and backfill are substantial and need corpus-based
  migration testing.
- Adapters temporarily increase code during the strangler migration.
- Durable evidence, effects, and projection queues add database volume and
  operational surfaces.
- Existing tests coupled to legacy internals must be rewritten around public
  Domain Operations and Kernel Outcomes before deletion.

## Alternatives considered

- **Keep database/filesystem reconciliation bidirectional.** Rejected because
  two authorities make drift unavoidable and recovery ambiguous.
- **Rewrite the workflow in one release.** Rejected because migration,
  restart, provider, git, and compatibility risk cannot be characterized or
  rolled out safely as a big bang.
- **Add another coordinator above existing loops.** Rejected because it
  preserves competing progression and closeout decisions.
- **Keep discovery as an interview-specific subsystem.** Rejected because it
  would need duplicate persistence, resume, dependency, and completion rules.
- **Ask the user to approve every phase or failure.** Rejected because tools
  should resolve observable work and routine defects autonomously.
- **Use process-local dirty projection tracking.** Rejected because projection
  intent and retries must survive process failure and commit atomically with
  the domain change.

## Existing ADR disposition

These dispositions define the accepted post-cutover architecture. They do not
claim that current runtime behavior has changed before the corresponding
migration and cutover gates complete.

| Existing decision | Disposition under ADR-046 |
|---|---|
| ADR-003 Pipeline Simplification | Superseded before adoption. Research remains first-class, resumable Milestone work rather than being merged into planning or reduced to optional artifacts; its ceremony-reduction goal remains valid through the shared Lifecycle Kernel, automated verification, and durable closeout. |
| ADR-009 Unified Orchestration Kernel | Superseded for workflow orchestration. Provider/model/TOS policy remains independently valid. |
| ADR-011 Progressive Planning and Escalation | Progressive refinement retained; file-backed escalation, DAG, broad pauses, and forward-only correction superseded. |
| ADR-013 Memory Store Consolidation | Amended. `memories` remains canonical for reusable cross-session knowledge, while workflow Decisions and their lifecycle effects move to the Conversation domain; memory extraction is noncritical follow-on work. |
| ADR-014 Auto Orchestration Deep Module | Amended and generalized into the shared Lifecycle Kernel. |
| ADR-015 Runtime Invariant Modules | Retained with database-only reconciliation and typed module results. |
| ADR-016 Worktree Lifecycle and Projection | Worktree Lifecycle retained; workflow-state copying and worktree-local authority reconciliation superseded. |
| ADR-016 Worktree Safety | Retained. |
| ADR-016 Phase 2 Design Notes | Historical implementation addendum. |
| ADR-017 Drift-Driven State Reconciliation | Superseded; only idempotent database-invariant repair remains. |
| ADR-018 PROJECT Authority Contract | Retained and generalized to all workflow artifacts; prose cannot register machine facts implicitly. |
| ADR-022 Post-Unit Gate Enforcement | Amended: the shared kernel owns progression; remediation replaces routine pauses. |
| ADR-023 Hook Outcome Frontmatter | Superseded by database Verification Evidence and Technical Verdicts. |
| ADR-025 Closeout Consistency Gate | Retained and generalized by prepared/settled closeout and receipts. |
| ADR-028/029 Preload-Authoritative Guidance | Grounded-context discipline retained; workflow context must derive from one database snapshot. |
| ADR-030 Two-Altitude State Machine | Single Writer chokepoint retained; in-memory phase authority, skipped status, and filesystem replay superseded. |
| ADR-032 Unit Closeout Module | Superseded by `prepareCloseout` plus `settleCloseout`. |
| ADR-033 Unit Registry | Retained as adapter/tool/prompt metadata only. |
| ADR-034 Merge and Publication Split | Retained; required source effects precede completion and publication remains non-authoritative. |
| ADR-035 Dirty Projection Scope | Superseded before adoption by durable Projection Work. |
| ADR-038 Dispatch History Module | Superseded by persisted Attempts, Failure Observations, fingerprints, and recovery budgets. |
| ADR-039 Consent Question Module | Superseded by explicit interaction kinds and the narrow consent boundary. |
| ADR-040 Write-Gate Snapshot Adapters | Superseded by Domain Operations, revisions, fencing, and Authority Epoch. |
| ADR-041 Engine Hook Contract | Retained; hooks submit typed adapter results and cannot own lifecycle. |
| ADR-042 Three Session Types | Session separation retained; durable GSD lifecycle moves out of AutoSession. |
| ADR-045 Flat-Phase Migration | Superseded before adoption; legacy layouts are explicit import/export formats, not startup authority. |

Each superseded or amended ADR has a short top-of-file status notice linking
here. Historical bodies remain intact.

## Implementation boundary and references

Acceptance of this ADR authorizes planning and implementation in the approved
dependency order; it does not waive normal review, testing, migration, or
release gates. Work must first be created as database-backed Milestones,
Slices, Tasks, dependencies, and acceptance contracts. Markdown plans are
rendered review surfaces only.

Implementation follows the twelve-Milestone program in the linked
decomposition. Each Task is a focused reviewable change, characterizes behavior
before replacing a path, uses targeted intent-verifying tests, runs code
simplification after code changes, and reaches green CI before dependent work
advances.

Resolved design contracts:

- [Canonical lifecycle and outcome model](https://github.com/open-gsd/gsd-pi/issues/1415)
- [Resumable discovery and planning horizons](https://github.com/open-gsd/gsd-pi/issues/1406)
- [Conversation and decision persistence](https://github.com/open-gsd/gsd-pi/issues/1409)
- [Database authority, projection, and import](https://github.com/open-gsd/gsd-pi/issues/1410)
- [Automated recovery, verification, UAT, and escalation](https://github.com/open-gsd/gsd-pi/issues/1414)
- [Lifecycle Kernel and shared closeout](https://github.com/open-gsd/gsd-pi/issues/1412)
- [Migration, compatibility retirement, and rollout safety](https://github.com/open-gsd/gsd-pi/issues/1408)
