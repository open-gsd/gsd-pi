// Project/App: gsd-pi
// File Purpose: Maps each auto-loop liveness guard id to its owning guard's real
// recovery command, so a tripped wedge names a reachable exit (ADR-047 §5).

/**
 * ADR-047 §5 requires a wedge record to name the sanctioned, state-mutating
 * exit for the guard that blocked. The loop's shared adjudication boundary sees
 * only the guard id and the failure payload, so the owning guard's instruction
 * lives here — copied from where that guard already prints it to users, never
 * invented:
 *
 * - `/gsd rebuild markdown` — the #1520 dispatch stop and the drift reports in
 *   state-reconciliation/drift/* and migration-auto-check.ts.
 * - `/gsd doctor fix` — commands-handlers.ts parseDoctorArgs ("fix" mode).
 * - `/gsd recover <recoveryActionId>` — terminal Task recovery abort notices.
 * - `/gsd status` + `/gsd auto` — lease-conflict-notice.ts.
 * - `/gsd auto` — decideMemoryPressure's own stop message.
 *
 * Every entry is a command that exists today (`/gsd help full` lists them);
 * unknown guard ids fall back to the generic-but-actionable triage pair.
 */
const GUARD_SANCTIONED_EXITS: Record<string, string> = {
  "max-iterations":
    "Auto mode burned its iteration ceiling without completing the milestone. Find the unit that kept re-dispatching with `/gsd status` and `/gsd forensics`, fix it, then re-run `/gsd auto`.",
  "memory-pressure":
    "The Node heap hit its limit. Restart the session to reclaim memory, then resume with `/gsd auto` — auto mode continues from the last checkpoint.",
  "missing-command-context":
    "This auto session has no command context to dispatch into. Re-run `/gsd auto` from an interactive `gsd` session, or run `gsd headless auto` for automation.",
  "session-lock-lost":
    "Another GSD session took the workflow session lock. Inspect the holder with `/gsd status`, stop that session, then re-run `/gsd auto`.",
  "user-backtrack":
    "The backtrack directive was applied and auto mode paused. Re-run `/gsd auto` to continue from the updated workflow state.",
  "user-stop":
    "The stop directive was honored and marked executed. Re-run `/gsd auto` when you are ready to continue.",
  "stop-guard-error":
    "A dispatch guard failed while evaluating. Repair workflow state with `/gsd doctor fix`, read the failure with `/gsd forensics`, then re-run `/gsd auto`.",
  "budget-halt":
    "The configured budget ceiling halted auto mode. Raise or remove `budget_ceiling` in `.gsd/PREFERENCES.md`, then re-run `/gsd auto`.",
  "budget-pause":
    "The configured budget ceiling paused auto mode. Resume with `/gsd auto` to override and continue.",
  "context-window":
    "The context window reached its configured pause threshold. Run `/gsd auto` to continue in a fresh session.",
  "unit-break":
    "The unit stopped with a terminal failure. If its task recovery aborted, resume it with `/gsd recover <recoveryActionId>` using the id named in the failure; otherwise fix the reported failure and re-run `/gsd auto`.",
  "unit-retry":
    "The unit asked to retry twice on identical inputs. Fix the reported failure — a terminal task-recovery abort resumes with `/gsd recover <recoveryActionId>`, projection drift with `/gsd rebuild markdown` — then re-run `/gsd auto`.",
  "finalize-break":
    "Closeout failed terminally for this unit. Inspect it with `/gsd status`, repair state with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "finalize-retry":
    "Closeout verification failed twice with identical inputs. Re-project the missing artifact with `/gsd rebuild markdown`, confirm with `/gsd status`, then re-run `/gsd auto`.",
  "orchestration-skip":
    "The orchestrator skipped the same state twice without advancing. Inspect it with `/gsd status` and repair with `/gsd doctor fix` (`/gsd rebuild markdown` for projection drift), then re-run `/gsd auto`.",
  "orchestration-stale-active-unit":
    "Auto mode kept re-polling a unit marked active while nothing was executing. That marker is per-session: stop this session and re-run `/gsd auto` to re-derive it. If the unit itself is stuck, inspect it with `/gsd status` and `/gsd forensics` first, and resume an aborted task recovery with `/gsd recover <recoveryActionId>`.",
  "orchestration-transient-pause":
    "A transient failure never healed. Read the failing operation with `/gsd forensics`, repair `.gsd/` state with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "transient-retry-exhausted":
    "Transient retries were exhausted on the same failure. Read the failing operation with `/gsd forensics`, repair `.gsd/` state with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "orchestration-stop":
    "The orchestrator stopped without a terminal outcome twice. Inspect the workflow with `/gsd status`, repair it with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "orchestration-unknown-outcome":
    "The orchestrator returned an outcome the loop cannot route. Report it with `/gsd forensics` and repair state with `/gsd doctor fix` before re-running `/gsd auto`.",
  "orchestration-missing":
    "Auto orchestration is not wired into this session. Re-run `/gsd auto` from a session started by `gsd`; if it persists, repair the install with `/gsd doctor fix`.",
  "pre-dispatch-hook-skip":
    "A pre-dispatch hook skipped the same unit twice. Review hook configuration with `/gsd hooks` and disable or fix the skipping hook, then re-run `/gsd auto`.",
  "milestone-lease-conflict":
    "The milestone is already active in another GSD worker. Inspect it with `/gsd status`, then re-run `/gsd auto` once that worker finishes or its lease expires.",
  "dispatch-claim-stale-lease":
    "The dispatch claim kept failing behind a stale milestone lease. Inspect the holder with `/gsd status`, then re-run `/gsd auto` once its lease expires.",
  "dispatch-claim-skip":
    "The unit dispatch claim was refused twice for the same reason. Inspect concurrent workers with `/gsd status`, repair the ledger with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "custom-engine-dispatch-stop":
    "The custom engine refused to produce a dispatch. Fix its GRAPH.yaml, confirm the derived phase with `/gsd status`, then re-run `/gsd auto`.",
  "custom-engine-dispatch-skip":
    "The custom engine skipped dispatch twice from the same state. Fix its GRAPH.yaml, confirm the derived phase with `/gsd status`, then re-run `/gsd auto`.",
  "custom-engine-dispatch-mismatch":
    "The custom engine returned a dispatch the loop cannot run. Fix its GRAPH.yaml, then re-run `/gsd auto`; `/gsd forensics` carries the mismatch detail.",
  "custom-engine-task-replan":
    "The replanned task artifact never became durable. Re-project it with `/gsd rebuild markdown`, confirm with `/gsd status`, then re-run `/gsd auto`.",
  "custom-engine-task-verify":
    "Task verification kept failing for this task. Inspect the verdict with `/gsd status`; if its recovery aborted, resume with `/gsd recover <recoveryActionId>`; then re-run `/gsd auto`.",
  "custom-engine-verify":
    "Custom-engine verification kept failing for this unit. Fix the verification failure — `/gsd forensics` carries the failing command — then re-run `/gsd auto`.",
  "custom-engine-reconcile":
    "The custom engine could not reconcile the completed step twice. Repair state with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "model-policy-dispatch":
    "Every candidate model was denied by policy. Inspect the effective policy with `/gsd show-config`, pin an allowed model with `/gsd model`, then re-run `/gsd auto`.",
  "infrastructure-error":
    "An infrastructure error recurred (disk, memory, or permissions). Fix the host condition — `/gsd doctor` reports environment problems — then resume with `/gsd auto`.",
  "credential-cooldown":
    "Provider credentials stayed rate-limited. Check the key and quota with `/gsd keys test`, then re-run `/gsd auto`.",
  "credential-cooldown-exhausted":
    "Credential cooldown retries were exhausted. Check the key and quota with `/gsd keys test`, then re-run `/gsd auto`.",
  "iteration-error":
    "The same iteration error recurred. Read it with `/gsd forensics`, repair state with `/gsd doctor fix`, then re-run `/gsd auto`.",
  "iteration-error-exhausted":
    "The iteration error budget was exhausted on the same failure. Read it with `/gsd forensics`, repair state with `/gsd doctor fix`, then re-run `/gsd auto`.",
};

const FALLBACK_SANCTIONED_EXIT =
  "Read the failure with `/gsd forensics`, repair workflow state with `/gsd doctor fix` " +
  "(`/gsd rebuild markdown` when markdown drifted from the DB), then re-run `/gsd auto`.";

/**
 * Payload truncation width, matching the wedge exit auto/orchestrator.ts
 * already composes for finalize-retry so wedge notices stay comparable.
 */
const PAYLOAD_EXCERPT_LENGTH = 300;

/** The instruction the named guard already prints to users, or the triage pair. */
export function loopGuardRecoveryInstruction(guardId: string): string {
  return GUARD_SANCTIONED_EXITS[guardId] ?? FALLBACK_SANCTIONED_EXIT;
}

/**
 * Compose the sanctioned exit persisted on a loop-level wedge: what blocked,
 * the guard owner's real recovery command, and the failure payload the guard
 * actually read (ADR-047 §5). The payload is omitted when it carries no
 * information beyond the guard id itself.
 */
export function resolveLoopSanctionedExit(input: {
  guardId: string;
  unitType: string;
  unitId: string;
  failurePayload?: string;
}): string {
  const payload = input.failurePayload?.trim();
  const excerpt = payload && payload !== input.guardId
    ? ` Failure: ${payload.length > PAYLOAD_EXCERPT_LENGTH ? `${payload.slice(0, PAYLOAD_EXCERPT_LENGTH)}…` : payload}`
    : "";
  return (
    `${input.guardId} blocked ${input.unitType} ${input.unitId} from advancing. ` +
    `${loopGuardRecoveryInstruction(input.guardId)}${excerpt}`
  );
}

/** Guard ids with an owner-authored instruction — exported for coverage tests. */
export function loopGuardIdsWithInstructions(): string[] {
  return Object.keys(GUARD_SANCTIONED_EXITS);
}
