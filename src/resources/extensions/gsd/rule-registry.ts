// GSD Extension — Unified Rule Registry
//
// Holds all dispatch rules and hooks as a flat list of UnifiedRule objects.
// Provides evaluation methods for each phase (dispatch, post-unit, pre-dispatch)
// and encapsulates mutable hook state as instance fields.
//
// A module-level singleton accessor allows existing code to migrate incrementally.

import { logWarning } from "./workflow-logger.js";
import type { UnifiedRule, RulePhase } from "./rule-types.js";
import type { DispatchAction, DispatchContext, DispatchRule } from "./auto-dispatch.js";
import type {
  PostUnitHookConfig,
  PreDispatchHookConfig,
  HookDispatchResult,
  PreDispatchResult,
  HookExecutionState,
  PersistedHookState,
  HookStatusEntry,
  PostUnitGateBlock,
  PostUnitHookOutcomeVerdict,
} from "./types.js";
import { resolvePostUnitHooks, resolvePreDispatchHooks } from "./preferences.js";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUnitId } from "./unit-id.js";
import {
  buildFlatTaskFileName,
  resolveMilestonePath,
  targetMilestoneFile,
  targetSliceFile,
} from "./paths.js";
import { queryJournal, type JournalEntry } from "./journal.js";
import { readUnitRuntimeRecord, type UnitRuntimePhase } from "./unit-runtime.js";
import { extractFrontmatterVerdict } from "./verdict-parser.js";
import { getDbOrNull } from "./db/engine.js";

// ─── Artifact Path Resolution ──────────────────────────────────────────────

function artifactNameToSuffix(artifactName: string): string | null {
  if (artifactName.includes("/") || artifactName.includes("\\")) return null;
  const match = artifactName.match(/^(.*)\.md$/i);
  return match?.[1] ? match[1] : null;
}

export function resolveHookArtifactPath(basePath: string, unitId: string, artifactName: string): string {
  const { milestone, slice, task } = parseUnitId(unitId);
  const artifactSuffix = artifactNameToSuffix(artifactName);

  // Prefer the active phase directory (flat-phase layout: .gsd/phases/<NN>-.../).
  // Configured gate artifacts are canonical phase-level files (e.g.
  // BROWSER-RUNTIME-EVIDENCE.md), so resolve the exact declared name first,
  // then a task-prefixed variant for retry sentinels / rework briefs.
  const candidates: string[] = [];
  const phaseDir = resolveMilestonePath(basePath, milestone);
  const isFlatPhaseDir = phaseDir !== null
    && !(dirname(phaseDir).endsWith("/milestones") || dirname(phaseDir).endsWith("\\milestones"));
  if (isFlatPhaseDir) {
    candidates.push(join(phaseDir, artifactName));
    if (artifactSuffix !== null) {
      if (slice !== undefined) {
        candidates.push(targetSliceFile(basePath, milestone, slice, artifactSuffix));
      } else {
        candidates.push(targetMilestoneFile(basePath, milestone, artifactSuffix));
      }
    }
    if (task !== undefined) {
      candidates.push(join(phaseDir, `${task}-${artifactName}`));
      if (slice !== undefined && artifactSuffix !== null) {
        candidates.push(join(phaseDir, buildFlatTaskFileName(slice, task, artifactSuffix)));
      }
    }
  }

  // Legacy nested layout fallbacks (.gsd/milestones/<M>/slices/<S>/tasks/...).
  const legacyBase = join(basePath, ".gsd", "milestones", milestone);
  let legacyDefault: string;
  if (task !== undefined && slice !== undefined) {
    legacyDefault = join(legacyBase, "slices", slice, "tasks", `${task}-${artifactName}`);
    candidates.push(legacyDefault);
    candidates.push(join(legacyBase, "slices", slice, "tasks", artifactName));
    candidates.push(join(legacyBase, "slices", slice, artifactName));
  } else if (slice !== undefined) {
    legacyDefault = join(legacyBase, "slices", slice, artifactName);
    candidates.push(legacyDefault);
  } else {
    legacyDefault = join(legacyBase, artifactName);
  }
  candidates.push(join(legacyBase, artifactName));

  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;

  // Nothing on disk yet: prefer the active phase path when the phase dir is
  // known, otherwise fall back to the legacy default (preserves pre-flat-phase
  // behavior for missing-artifact diagnostics).
  if (isFlatPhaseDir) {
    if (artifactSuffix !== null) {
      if (task !== undefined && slice !== undefined) {
        return join(phaseDir!, buildFlatTaskFileName(slice, task, artifactSuffix));
      }
      if (slice !== undefined) {
        return targetSliceFile(basePath, milestone, slice, artifactSuffix);
      }
      return targetMilestoneFile(basePath, milestone, artifactSuffix);
    }
    return join(phaseDir!, artifactName);
  }
  return legacyDefault;
}

// ─── Dispatch Rule Conversion ──────────────────────────────────────────────

/**
 * Convert an array of DispatchRule objects to UnifiedRule[] format.
 * Preserves exact array order — dispatch is order-dependent (first-match-wins).
 */
export function convertDispatchRules(rules: DispatchRule[]): UnifiedRule[] {
  return rules.map((rule) => ({
    name: rule.name,
    when: "dispatch" as const,
    evaluation: "first-match" as const,
    where: rule.match,
    then: (result: any) => result,
    description: `Dispatch rule: ${rule.name}`,
  }));
}

// ─── RuleRegistry ─────────────────────────────────────────────────────────

const HOOK_STATE_FILE = "hook-state.json";
const FAILED_HOOK_RUNTIME_PHASES: ReadonlySet<UnitRuntimePhase> = new Set([
  "timeout",
  "finalize-timeout",
  "crashed",
  "paused",
]);

interface HookFailureState {
  hookName: string;
  unitType: string;
  unitId: string;
  reason: string;
}

type HookCompletionAssessment =
  | { outcome: "success" }
  | { outcome: "failed"; reason: string }
  | { outcome: "unknown" };

const HOOK_OUTCOME_VERDICTS = new Set<PostUnitHookOutcomeVerdict>([
  "pass",
  "advisory",
  "needs-rework",
  "needs-remediation",
  "needs-attention",
]);

interface HookTriggerRef {
  triggerUnitType: string;
  triggerUnitId: string;
  completionOperationId?: string;
  legacyCompletedAt?: string;
}

export interface RetryTrigger {
  unitType: string;
  unitId: string;
  retryArtifact?: string;
  completionOperationId?: string;
  legacyCompletedAt?: string;
}

function captureTaskCompletionIdentity(trigger: HookTriggerRef): Pick<
  RetryTrigger,
  "completionOperationId" | "legacyCompletedAt"
> | null {
  if (trigger.triggerUnitType !== "execute-task") return {};
  const { milestone, slice, task } = parseUnitId(trigger.triggerUnitId);
  if (!milestone || !slice || !task) {
    throw new Error(`Cannot dispatch execute-task hook: invalid Task identity ${trigger.triggerUnitId}`);
  }
  const db = getDbOrNull();
  if (!db) {
    throw new Error(`Cannot dispatch execute-task hook for ${trigger.triggerUnitId}: database unavailable`);
  }
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare(`
      SELECT task.status, task.completed_at,
             lifecycle.lifecycle_status, lifecycle.last_operation_id
      FROM tasks task
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.item_kind = 'task'
       AND lifecycle.milestone_id = task.milestone_id
       AND lifecycle.slice_id = task.slice_id
       AND lifecycle.task_id = task.id
      WHERE task.milestone_id = :milestone_id
        AND task.slice_id = :slice_id
        AND task.id = :task_id
    `).get({
      ":milestone_id": milestone,
      ":slice_id": slice,
      ":task_id": task,
    }) as Record<string, unknown> | undefined;
  } catch (error) {
    throw new Error(
      `Cannot dispatch execute-task hook for ${trigger.triggerUnitId}: completion identity query failed`,
      { cause: error },
    );
  }
  if (!row || row["status"] !== "complete") {
    return null;
  }
  if (
    row["lifecycle_status"] === "completed"
    && typeof row["last_operation_id"] === "string"
    && row["last_operation_id"].length > 0
  ) {
    return { completionOperationId: row["last_operation_id"] };
  }
  if (
    !row["lifecycle_status"]
    && typeof row["completed_at"] === "string"
    && row["completed_at"].length > 0
  ) {
    return { legacyCompletedAt: row["completed_at"] };
  }
  throw new Error(
    `Cannot dispatch execute-task hook for ${trigger.triggerUnitId}: Task has no canonical completion identity`,
  );
}

type HookQueueEntry = {
  config: PostUnitHookConfig;
  triggerUnitType: string;
  triggerUnitId: string;
  forceRun?: boolean;
  completionOperationId?: string;
  legacyCompletedAt?: string;
};

interface GateOutcome {
  verdict?: PostUnitHookOutcomeVerdict | "failed";
  artifact?: string;
  artifactPath?: string;
  reason?: string;
}

function isBlockingHook(config: PostUnitHookConfig | undefined): boolean {
  return config?.criticality === "blocking";
}

function hookMaxCycles(config: PostUnitHookConfig): number {
  return config.max_cycles ?? 1;
}

function hookCycleKey(config: PostUnitHookConfig, trigger: HookTriggerRef): string {
  return `${config.name}/${trigger.triggerUnitType}/${trigger.triggerUnitId}`;
}

export class RuleRegistry {
  /** Static dispatch rules provided at construction time. */
  private readonly dispatchRules: UnifiedRule[];

  // ── Mutable hook state (encapsulated, not module-level) ──────────────

  activeHook: HookExecutionState | null = null;
  hookQueue: Array<{
    config: PostUnitHookConfig;
    triggerUnitType: string;
    triggerUnitId: string;
    forceRun?: boolean;
    completionOperationId?: string;
    legacyCompletedAt?: string;
  }> = [];
  cycleCounts: Map<string, number> = new Map();
  /**
   * Cycle keys that have already been granted a one-shot re-dispatch after a
   * lost/interrupted dispatch (hook charged a cycle but never produced its own
   * unit-end). Bounds the dispatch-cycle refund to exactly one per gate so a
   * hook that repeatedly fails to complete cannot loop forever.
   */
  redispatchedGateKeys: Set<string> = new Set();
  retryPending: boolean = false;
  retryTrigger: RetryTrigger | null = null;
  hookFailure: HookFailureState | null = null;
  gateBlockPending: PostUnitGateBlock | null = null;
  /** Hooks queued behind the blocked gate, held for re-queue on resume (#2194). */
  gateBlockQueue: HookQueueEntry[] = [];

  constructor(dispatchRules: UnifiedRule[]) {
    this.dispatchRules = dispatchRules;
  }

  // ── Core query ───────────────────────────────────────────────────────

  /**
   * Returns all rules: static dispatch rules + dynamically loaded hook rules.
   * Hook rules are loaded fresh from preferences on each call (not cached).
   */
  listRules(): UnifiedRule[] {
    const rules: UnifiedRule[] = [...this.dispatchRules];

    // Convert post-unit hooks to unified rules
    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      rules.push({
        name: hook.name,
        when: "post-unit",
        evaluation: "all-matching",
        where: (unitType: string) => hook.after.includes(unitType),
        then: () => hook,
        description: `Post-unit hook: fires after ${hook.after.join(", ")}`,
        lifecycle: {
          artifact: hook.artifact,
          retry_on: hook.retry_on,
          max_cycles: hook.max_cycles,
          criticality: hook.criticality,
        },
      });
    }

    // Convert pre-dispatch hooks to unified rules
    const preHooks = resolvePreDispatchHooks();
    for (const hook of preHooks) {
      rules.push({
        name: hook.name,
        when: "pre-dispatch",
        evaluation: "all-matching",
        where: (unitType: string) => hook.before.includes(unitType),
        then: () => hook,
        description: `Pre-dispatch hook: fires before ${hook.before.join(", ")}`,
      });
    }

    return rules;
  }

  // ── Dispatch evaluation (async, first-match-wins) ───────────────────

  /**
   * Iterate dispatch rules in order. First match wins.
   * Returns stop action if no rule matches (unhandled phase).
   */
  async evaluateDispatch(ctx: DispatchContext): Promise<DispatchAction> {
    for (const rule of this.dispatchRules) {
      const result = await rule.where(ctx);
      if (result) {
        if (result.action !== "skip") result.matchedRule = rule.name;
        return result;
      }
    }
    return {
      action: "stop",
      reason: `Unhandled phase "${ctx.state.phase}" — run /gsd doctor to diagnose.`,
      level: "info",
      matchedRule: "<no-match>",
    };
  }

  // ── Post-unit hook evaluation (sync, all-matching with lifecycle) ────

  /**
   * Replicate exact semantics of checkPostUnitHooks from post-unit-hooks.ts:
   * hook-on-hook prevention, idempotency, cycle limits, retry_on, dequeue.
   */
  evaluatePostUnit(
    completedUnitType: string,
    completedUnitId: string,
    basePath: string,
    opts?: { blockingOnly?: boolean },
  ): HookDispatchResult | null {
    // If we just completed a hook unit, handle its result
    if (this.activeHook) {
      const observedCleanExecution =
        completedUnitType === `hook/${this.activeHook.hookName}` &&
        completedUnitId === this.activeHook.triggerUnitId;
      return this._handleHookCompletion(basePath, observedCleanExecution);
    }

    // Don't trigger hooks for other hook units (prevent hook-on-hook chains)
    // Don't trigger hooks for triage units or quick-task units
    if (
      completedUnitType.startsWith("hook/") ||
      completedUnitType === "triage-captures" ||
      completedUnitType === "quick-task"
    ) {
      return null;
    }

    // Check if any hooks are configured for this unit type
    const hooks = resolvePostUnitHooks(basePath).filter(h =>
      h.after.includes(completedUnitType),
    );
    // `blockingOnly` (step mode) skips advisory hooks: only `criticality:
    // blocking` gates dispatch there, so a gate can never be bypassed by
    // running the workflow one step at a time (#2194).
    const queueHooks = opts?.blockingOnly
      ? hooks.filter(h => isBlockingHook(h))
      : hooks;
    if (queueHooks.length === 0) return null;

    const completionIdentity = captureTaskCompletionIdentity({
      triggerUnitType: completedUnitType,
      triggerUnitId: completedUnitId,
    });
    if (!completionIdentity) return null;

    // Build hook queue for this trigger
    this.hookQueue = queueHooks.map(config => ({
      config,
      triggerUnitType: completedUnitType,
      triggerUnitId: completedUnitId,
      ...completionIdentity,
    }));

    return this._dequeueNextHook(basePath);
  }

  private _dequeueNextHook(basePath: string): HookDispatchResult | null {
    while (this.hookQueue.length > 0) {
      const entry = this.hookQueue.shift()!;
      const {
        config,
        triggerUnitType,
        triggerUnitId,
        forceRun,
        completionOperationId,
        legacyCompletedAt,
      } = entry;

      // Advisory hooks preserve existing idempotency: any configured artifact
      // means the hook already ran. Blocking gates must verify outcome first.
      if (config.artifact && !forceRun) {
        const artifactPath = resolveHookArtifactPath(basePath, triggerUnitId, config.artifact);
        if (existsSync(artifactPath)) {
          const completion = this._assessConfiguredHookCompletion(basePath, config.name, triggerUnitId);
          if (completion.outcome === "failed") {
            return this._handleFailedHookCompletion(
              basePath,
              {
                hookName: config.name,
                triggerUnitType,
                triggerUnitId,
                cycle: this.cycleCounts.get(hookCycleKey(config, { triggerUnitType, triggerUnitId })) ?? 0,
                pendingRetry: false,
              },
              config,
              completion.reason,
            );
          }
          if (!isBlockingHook(config)) continue;
          const decision = this._handleExistingBlockingArtifact(config, entry, basePath);
          if (decision === "skip") continue;
          return decision;
        }
      }

      const dispatch = this._startHook(config, {
        triggerUnitType,
        triggerUnitId,
        completionOperationId,
        legacyCompletedAt,
      });
      if (dispatch) return dispatch;
      if (isBlockingHook(config)) {
        const cycleKey = hookCycleKey(config, { triggerUnitType, triggerUnitId });
        const maxCycles = hookMaxCycles(config);
        const currentCycle = this.cycleCounts.get(cycleKey) ?? 0;
        if (currentCycle >= maxCycles) {
          this._setGateBlock(config, {
            triggerUnitType,
            triggerUnitId,
            completionOperationId,
            legacyCompletedAt,
          }, {
            action: "pause",
            reason: `gate cycle budget exhausted before ${config.name} produced a passing outcome`,
            cycle: currentCycle,
            maxCycles,
          });
          return null;
        }
      }
    }

    // No more hooks — clear active state
    this.activeHook = null;
    return null;
  }

  private _handleHookCompletion(basePath: string, observedCleanExecution: boolean): HookDispatchResult | null {
    const hook = this.activeHook!;
    const hooks = resolvePostUnitHooks(basePath);
    const config = hooks.find(h => h.name === hook.hookName);
    if (!config) {
      this.activeHook = null;
      return this._dequeueNextHook(basePath);
    }

    const completion = this._assessHookCompletion(basePath, hook);
    if (completion.outcome === "failed") {
      return this._handleFailedHookCompletion(basePath, hook, config, completion.reason);
    }

    // Check if retry was requested via retry_on artifact
    if (config.retry_on) {
      const retryArtifactPath = resolveHookArtifactPath(basePath, hook.triggerUnitId, config.retry_on);
      if (existsSync(retryArtifactPath)) {
        if (this._requestTriggerRetry(config, hook, config.retry_on)) {
          return null;
        }
        if (isBlockingHook(config)) {
          this._setGateBlock(config, hook, {
            action: "pause",
            reason: `gate cycle budget exhausted after ${config.retry_on} requested rework`,
            retryArtifact: config.retry_on,
          });
          this.activeHook = null;
          this.hookQueue = [];
          return null;
        }
      }
    }

    if (isBlockingHook(config)) {
      return this._handleBlockingGateCompletion(config, hook, basePath, observedCleanExecution);
    }

    // Hook completed normally — try next hook in queue
    this.activeHook = null;
    return this._dequeueNextHook(basePath);
  }

  private _startHook(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
  ): HookDispatchResult | null {
    const { triggerUnitType, triggerUnitId, completionOperationId, legacyCompletedAt } = trigger;
    const cycleKey = `${config.name}/${triggerUnitType}/${triggerUnitId}`;
    const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
    const maxCycles = config.max_cycles ?? 1;
    if (currentCycle > maxCycles) return null;

    this.cycleCounts.set(cycleKey, currentCycle);

    this.activeHook = {
      hookName: config.name,
      triggerUnitType,
      triggerUnitId,
      cycle: currentCycle,
      pendingRetry: false,
      completionOperationId,
      legacyCompletedAt,
    };

    return this._buildHookDispatch(config, triggerUnitId);
  }

  /** Construct the sidecar dispatch for a hook without mutating registry state. */
  private _buildHookDispatch(
    config: PostUnitHookConfig,
    triggerUnitId: string,
  ): HookDispatchResult {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(triggerUnitId);
    let prompt = config.prompt
      .replace(/\{milestoneId\}/g, mid ?? "")
      .replace(/\{sliceId\}/g, sid ?? "")
      .replace(/\{taskId\}/g, tid ?? "");

    prompt += "\n\n**Browser tool safety:** Do NOT use `browser_wait_for` with `condition: \"network_idle\"` — it hangs indefinitely when dev servers keep persistent connections (Vite HMR, WebSocket). Use `selector_visible`, `text_visible`, or `delay` instead.";

    return {
      hookName: config.name,
      prompt,
      // Model selection (including fallbacks[]) is handled by
      // resolveModelWithFallbacksForUnit for the `hook/<name>` unit type (#1229).
      unitType: `hook/${config.name}`,
      unitId: triggerUnitId,
    };
  }

  /**
   * Reconstruct the in-flight hook's dispatch from the restored `activeHook`
   * state, without mutating the registry. Used to reconcile a persisted
   * `activeHook` whose session-local dispatch was lost across a pause/resume
   * or crash-recovery, so the hook actually runs instead of being charged
   * against the next unrelated unit's close-out (#1246).
   */
  getPendingHookDispatch(basePath: string): HookDispatchResult | null {
    if (!this.activeHook) return null;
    const config = resolvePostUnitHooks(basePath).find(
      h => h.name === this.activeHook!.hookName,
    );
    if (!config) return null;
    return this._buildHookDispatch(config, this.activeHook.triggerUnitId);
  }

  /**
   * Re-arm a persisted gate block after resume (#2194).
   *
   * A gate block clears `activeHook` before the pause, so a resumed session
   * would otherwise find no hook state and select the next unit without a
   * passing verdict. Re-arm restores the blocked gate to its in-flight shape:
   * the block is consumed, `activeHook` is set (with the captured trigger
   * completion identity, so needs-rework can reopen the task) so the re-run's
   * completion is assessed against the gate artifact, and the dispatch is
   * returned for the caller to enqueue. If the artifact already carries a
   * passing verdict the block is dropped without rerunning the hook. Hooks
   * queued behind the blocked gate are re-queued either way so they still
   * run once the gate resolves.
   */
  reconcileRestoredGateBlock(basePath: string): HookDispatchResult | null {
    const block = this.gateBlockPending;
    if (!block) return null;
    this.gateBlockPending = null;
    this.hookQueue = this.gateBlockQueue;
    this.gateBlockQueue = [];
    const config = resolvePostUnitHooks(basePath).find(h => h.name === block.hookName);
    if (!config) return this._dequeueNextHook(basePath);
    const outcome = this._readGateOutcome(config, block, basePath);
    if (outcome.verdict === "pass" || outcome.verdict === "advisory") {
      return this._dequeueNextHook(basePath);
    }
    this.activeHook = {
      hookName: config.name,
      triggerUnitType: block.triggerUnitType,
      triggerUnitId: block.triggerUnitId,
      cycle: this.cycleCounts.get(hookCycleKey(config, block)) ?? 1,
      pendingRetry: false,
      ...(block.completionOperationId ? { completionOperationId: block.completionOperationId } : {}),
      ...(block.legacyCompletedAt ? { legacyCompletedAt: block.legacyCompletedAt } : {}),
    };
    return this._buildHookDispatch(config, block.triggerUnitId);
  }

  private _assessHookCompletion(
    basePath: string,
    hook: HookExecutionState,
  ): HookCompletionAssessment {
    return this._assessConfiguredHookCompletion(basePath, hook.hookName, hook.triggerUnitId);
  }

  private _assessConfiguredHookCompletion(
    basePath: string,
    hookName: string,
    unitId: string,
  ): HookCompletionAssessment {
    const unitType = `hook/${hookName}`;
    const latestUnitEnd = this._latestHookUnitEnd(basePath, unitType, unitId);
    if (latestUnitEnd) {
      const data = latestUnitEnd.data ?? {};
      const status = data.status;
      const artifactVerified = data.artifactVerified;
      if (status === "completed" && artifactVerified !== false) {
        return { outcome: "success" };
      }
      return {
        outcome: "failed",
        reason: this._formatHookFailureReason(status, artifactVerified, data.errorContext),
      };
    }

    const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
    if (runtime && FAILED_HOOK_RUNTIME_PHASES.has(runtime.phase)) {
      return { outcome: "failed", reason: `runtime phase ${runtime.phase}` };
    }

    return { outcome: "unknown" };
  }

  private _latestHookUnitEnd(
    basePath: string,
    unitType: string,
    unitId: string,
  ): JournalEntry | null {
    const unitEnds = queryJournal(basePath, { eventType: "unit-end", unitId })
      .filter(entry => entry.data?.unitType === unitType);
    return unitEnds[unitEnds.length - 1] ?? null;
  }

  private _formatHookFailureReason(
    status: unknown,
    artifactVerified: unknown,
    errorContext: unknown,
  ): string {
    const parts = [`status ${typeof status === "string" ? status : "unknown"}`];
    if (artifactVerified === false) {
      parts.push("artifact not verified");
    }
    if (typeof errorContext === "object" && errorContext !== null && "message" in errorContext) {
      const message = (errorContext as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        parts.push(message);
      }
    }
    return parts.join("; ");
  }

  private _handleFailedHookCompletion(
    basePath: string,
    hook: HookExecutionState,
    config: PostUnitHookConfig | undefined,
    reason: string,
  ): HookDispatchResult | null {
    if (config) {
      const retry = this._startHook(config, hook);
      if (retry) return retry;
    }

    this.hookFailure = {
      hookName: hook.hookName,
      unitType: `hook/${hook.hookName}`,
      unitId: hook.triggerUnitId,
      reason,
    };
    this.activeHook = null;
    this.hookQueue = [];
    this.persistState(basePath);
    return null;
  }

  private _handleExistingBlockingArtifact(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    basePath: string,
  ): "skip" | HookDispatchResult | null {
    const outcome = this._readGateOutcome(config, trigger, basePath);
    switch (outcome.verdict) {
      case "pass":
      case "advisory":
        return "skip";
      case "needs-rework":
        return this._routeNeedsRework(config, trigger, outcome);
      case "needs-remediation":
      case "needs-attention":
        this._pauseForGate(config, trigger, outcome, `gate reported ${outcome.verdict}`);
        return null;
      case "failed":
      case undefined:
        return this._rerunGateOrBlock(config, trigger, basePath, {
          reason: outcome.reason ?? `gate artifact reported verdict=${outcome.verdict}`,
          outcome,
        });
    }
    return this._rerunGateOrBlock(config, trigger, basePath, {
      reason: `gate artifact reported unsupported verdict=${String(outcome.verdict)}`,
      outcome,
    });
  }

  private _handleBlockingGateCompletion(
    config: PostUnitHookConfig,
    hook: HookExecutionState,
    basePath: string,
    observedCleanExecution: boolean,
  ): HookDispatchResult | null {
    if (!observedCleanExecution) {
      // The hook was charged a cycle at dispatch but never produced its own
      // unit-end — its dispatch was lost/interrupted (pause/resume, crash
      // recovery). Refund that dispatch-consumed cycle exactly once so the gate
      // is re-dispatched at least once instead of hard-blocking on a hook that
      // never actually ran.
      //
      // This refund is intentionally UNCONDITIONAL on the first lost dispatch —
      // it must NOT be gated on `currentCycle >= max_cycles`. A lost dispatch is
      // a non-run: charging its cycle at dispatch time must not consume the
      // hook's real-run budget. Gating the refund on "budget already exhausted"
      // lets a lost dispatch below max_cycles silently eat a genuine cycle, so
      // the hook gets one fewer real run than configured — reintroducing #1244
      // for max_cycles >= 2 (see the "does not steal a real-run cycle" test).
      // The redispatchedGateKeys flag bounds this to a single refund per gate,
      // so repeated lost dispatches still terminate (total dispatches never
      // exceed max_cycles + 1) and a hook that keeps failing blocks normally.
      const cycleKey = hookCycleKey(config, hook);
      if (!this.redispatchedGateKeys.has(cycleKey)) {
        this.redispatchedGateKeys.add(cycleKey);
        const currentCycle = this.cycleCounts.get(cycleKey);
        if (typeof currentCycle === "number" && currentCycle > 0) {
          this.cycleCounts.set(cycleKey, currentCycle - 1);
        }
      }
      return this._rerunGateOrBlock(config, hook, basePath, {
        reason: `hook/${config.name} did not complete cleanly before the trigger unit resumed`,
      });
    }

    const outcome = this._readGateOutcome(config, hook, basePath);
    switch (outcome.verdict) {
      case "pass":
      case "advisory":
        this.activeHook = null;
        return this._dequeueNextHook(basePath);
      case "needs-rework":
        return this._routeNeedsRework(config, hook, outcome);
      case "needs-remediation":
      case "needs-attention":
        return this._pauseForGate(config, hook, outcome, `gate reported ${outcome.verdict}`);
      case "failed":
      case undefined:
        return this._rerunGateOrBlock(config, hook, basePath, {
          reason: outcome.reason ?? `gate artifact reported verdict=${outcome.verdict}`,
          outcome,
        });
    }
    return this._rerunGateOrBlock(config, hook, basePath, {
      reason: `gate artifact reported unsupported verdict=${String(outcome.verdict)}`,
      outcome,
    });
  }

  private _routeNeedsRework(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    outcome: GateOutcome,
  ): null {
    const action = config.on_block?.action ?? "retry-unit";
    if (action === "retry-task" || action === "retry-unit") {
      if (this._requestTriggerRetry(config, trigger, config.on_block?.artifact)) {
        return null;
      }
      this._setGateBlock(config, trigger, {
        action: "pause",
        reason: "gate cycle budget exhausted after needs-rework",
        outcome,
        retryArtifact: config.on_block?.artifact,
      });
      this.activeHook = null;
      this.hookQueue = [];
      return null;
    }
    return this._pauseForGate(config, trigger, outcome, `gate reported needs-rework; configured on_block action is ${action}`);
  }

  private _pauseForGate(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    outcome: GateOutcome,
    reason: string,
  ): null {
    this._setGateBlock(config, trigger, {
      action: config.on_block?.action ?? "pause",
      reason,
      outcome,
      retryArtifact: config.on_block?.artifact,
    });
    this.activeHook = null;
    this.hookQueue = [];
    return null;
  }

  private _requestTriggerRetry(
    config: PostUnitHookConfig,
    hook: HookTriggerRef,
    retryArtifact?: string,
  ): boolean {
    const cycleKey = hookCycleKey(config, hook);
    const currentCycle = this.cycleCounts.get(cycleKey) ?? 1;
    const maxCycles = hookMaxCycles(config);
    if (currentCycle >= maxCycles) return false;

    if (
      hook.triggerUnitType === "execute-task"
      && !hook.completionOperationId
      && !hook.legacyCompletedAt
    ) {
      throw new Error(
        `Cannot retry execute-task ${hook.triggerUnitId}: active hook has no canonical completion identity`,
      );
    }

    this.activeHook = null;
    this.hookQueue = [];
    this.retryPending = true;
    this.retryTrigger = {
      unitType: hook.triggerUnitType,
      unitId: hook.triggerUnitId,
      ...(hook.completionOperationId ? { completionOperationId: hook.completionOperationId } : {}),
      ...(hook.legacyCompletedAt ? { legacyCompletedAt: hook.legacyCompletedAt } : {}),
    };
    if (retryArtifact !== undefined) {
      this.retryTrigger.retryArtifact = retryArtifact;
    }
    return true;
  }

  private _rerunGateOrBlock(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    basePath: string,
    opts: {
      reason: string;
      outcome?: GateOutcome;
    },
  ): HookDispatchResult | null {
    const cycleKey = hookCycleKey(config, trigger);
    const currentCycle = this.cycleCounts.get(cycleKey) ?? 0;
    const maxCycles = hookMaxCycles(config);
    if (currentCycle < maxCycles) {
      this.activeHook = null;
      this.hookQueue.unshift({
        config,
        triggerUnitType: trigger.triggerUnitType,
        triggerUnitId: trigger.triggerUnitId,
        forceRun: true,
        completionOperationId: trigger.completionOperationId,
        legacyCompletedAt: trigger.legacyCompletedAt,
      });
      return this._dequeueNextHook(basePath);
    }

    this._setGateBlock(config, trigger, {
      action: "pause",
      reason: `${opts.reason}; gate cycle budget exhausted`,
      outcome: opts.outcome,
      cycle: currentCycle,
      maxCycles,
    });
    this.activeHook = null;
    this.hookQueue = [];
    return null;
  }

  private _readGateOutcome(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    basePath: string,
  ): GateOutcome {
    if (!config.artifact) {
      return { reason: "blocking gate has no configured artifact" };
    }
    const artifactPath = resolveHookArtifactPath(basePath, trigger.triggerUnitId, config.artifact);
    if (!existsSync(artifactPath)) {
      return {
        artifact: config.artifact,
        artifactPath,
        reason: `missing required gate artifact ${config.artifact}`,
      };
    }
    let content = "";
    try {
      content = readFileSync(artifactPath, "utf-8");
    } catch (e) {
      return {
        artifact: config.artifact,
        artifactPath,
        reason: `could not read gate artifact ${config.artifact}: ${(e as Error).message}`,
      };
    }

    const rawVerdict = extractFrontmatterVerdict(content);
    if (!rawVerdict) {
      return {
        artifact: config.artifact,
        artifactPath,
        reason: `gate artifact ${config.artifact} is missing frontmatter verdict`,
      };
    }
    if (rawVerdict === "failed") {
      return {
        artifact: config.artifact,
        artifactPath,
        verdict: "failed",
        reason: `gate artifact ${config.artifact} reported verdict=failed`,
      };
    }
    if (!HOOK_OUTCOME_VERDICTS.has(rawVerdict as PostUnitHookOutcomeVerdict)) {
      return {
        artifact: config.artifact,
        artifactPath,
        reason: `gate artifact ${config.artifact} has unsupported verdict=${rawVerdict}`,
      };
    }
    return {
      artifact: config.artifact,
      artifactPath,
      verdict: rawVerdict as PostUnitHookOutcomeVerdict,
    };
  }

  private _setGateBlock(
    config: PostUnitHookConfig,
    trigger: HookTriggerRef,
    opts: {
      action: PostUnitGateBlock["action"];
      reason: string;
      outcome?: GateOutcome;
      cycle?: number;
      maxCycles?: number;
      retryArtifact?: string;
    },
  ): void {
    const cycleKey = hookCycleKey(config, trigger);
    const cycle = opts.cycle ?? this.cycleCounts.get(cycleKey) ?? 0;
    this.gateBlockPending = {
      hookName: config.name,
      triggerUnitType: trigger.triggerUnitType,
      triggerUnitId: trigger.triggerUnitId,
      ...(trigger.completionOperationId ? { completionOperationId: trigger.completionOperationId } : {}),
      ...(trigger.legacyCompletedAt ? { legacyCompletedAt: trigger.legacyCompletedAt } : {}),
      artifact: opts.outcome?.artifact ?? config.artifact,
      artifactPath: opts.outcome?.artifactPath,
      verdict: opts.outcome?.verdict,
      action: opts.action,
      reason: opts.reason,
      cycle,
      maxCycles: opts.maxCycles ?? hookMaxCycles(config),
      retryArtifact: opts.retryArtifact,
    };
    // Capture the hooks still queued behind the blocked gate so resume can
    // re-queue them; otherwise later gates are silently skipped once the
    // blocked gate resolves (#2194).
    this.gateBlockQueue = [...this.hookQueue];
  }

  // ── Pre-dispatch hook evaluation (sync, all-matching with compose) ──

  /**
   * Replicate exact semantics of runPreDispatchHooks from post-unit-hooks.ts:
   * modify/skip/replace compose semantics.
   */
  evaluatePreDispatch(
    unitType: string,
    unitId: string,
    prompt: string,
    basePath: string,
  ): PreDispatchResult {
    // Don't intercept hook units
    if (unitType.startsWith("hook/")) {
      return { action: "proceed", prompt, firedHooks: [] };
    }

    const hooks = resolvePreDispatchHooks(basePath).filter(h =>
      h.before.includes(unitType),
    );
    if (hooks.length === 0) {
      return { action: "proceed", prompt, firedHooks: [] };
    }

    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const substitute = (text: string): string =>
      text
        .replace(/\{milestoneId\}/g, mid ?? "")
        .replace(/\{sliceId\}/g, sid ?? "")
        .replace(/\{taskId\}/g, tid ?? "");

    const firedHooks: string[] = [];
    let currentPrompt = prompt;

    for (const hook of hooks) {
      if (hook.action === "skip") {
        if (hook.skip_if) {
          const conditionPath = resolveHookArtifactPath(basePath, unitId, hook.skip_if);
          if (!existsSync(conditionPath)) continue;
        }
        firedHooks.push(hook.name);
        return { action: "skip", firedHooks };
      }

      if (hook.action === "replace") {
        firedHooks.push(hook.name);
        return {
          action: "replace",
          prompt: substitute(hook.prompt ?? ""),
          unitType: hook.unit_type,
          model: hook.model,
          firedHooks,
        };
      }

      if (hook.action === "modify") {
        firedHooks.push(hook.name);
        if (hook.prepend) {
          currentPrompt = `${substitute(hook.prepend)}\n\n${currentPrompt}`;
        }
        if (hook.append) {
          currentPrompt = `${currentPrompt}\n\n${substitute(hook.append)}`;
        }
      }
    }

    return {
      action: "proceed",
      prompt: currentPrompt,
      model: hooks.find(h => h.action === "modify" && h.model)?.model,
      firedHooks,
    };
  }

  // ── State accessors ─────────────────────────────────────────────────

  getActiveHook(): HookExecutionState | null {
    return this.activeHook;
  }

  isRetryPending(): boolean {
    return this.retryPending;
  }

  peekRetryTrigger(): RetryTrigger | null {
    if (!this.retryPending || !this.retryTrigger) return null;
    return { ...this.retryTrigger };
  }

  consumeHookFailure(): HookFailureState | null {
    if (!this.hookFailure) return null;
    const failure = { ...this.hookFailure };
    this.hookFailure = null;
    return failure;
  }

  isGateBlockPending(): boolean {
    return this.gateBlockPending !== null;
  }

  /**
   * Returns the trigger unit info for a pending retry, or null.
   * Clears the retry state after reading.
   */
  consumeRetryTrigger(): RetryTrigger | null {
    if (!this.retryPending || !this.retryTrigger) return null;
    const trigger = { ...this.retryTrigger };
    this.retryPending = false;
    this.retryTrigger = null;
    return trigger;
  }

  acknowledgeRetryTrigger(basePath: string): RetryTrigger | null {
    if (!this.retryPending || !this.retryTrigger) return null;
    const trigger = { ...this.retryTrigger };
    this.retryPending = false;
    this.retryTrigger = null;
    try {
      this._persistStateOrThrow(basePath);
    } catch (error) {
      this.retryPending = true;
      this.retryTrigger = trigger;
      const message = `failed to persist hook state: ${(error as Error).message}`;
      logWarning("registry", message);
      throw new Error(message, { cause: error });
    }
    return trigger;
  }

  /**
   * Returns a pending post-unit gate block, or null.
   * Clears the block state after reading.
   */
  consumeGateBlock(): PostUnitGateBlock | null {
    if (!this.gateBlockPending) return null;
    const block = { ...this.gateBlockPending };
    this.gateBlockPending = null;
    return block;
  }

  /** Clear all mutable hook lifecycle state. */
  resetState(): void {
    this.activeHook = null;
    this.hookQueue = [];
    this.cycleCounts.clear();
    this.redispatchedGateKeys.clear();
    this.retryPending = false;
    this.retryTrigger = null;
    this.hookFailure = null;
    this.gateBlockPending = null;
    this.gateBlockQueue = [];
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private _hookStatePath(basePath: string): string {
    return join(basePath, ".gsd", HOOK_STATE_FILE);
  }

  /** Persist current hook state to disk. */
  persistState(basePath: string): void {
    try {
      this._persistStateOrThrow(basePath);
    } catch (error) {
      const message = `failed to persist hook state: ${(error as Error).message}`;
      logWarning("registry", message);
      if (this.retryPending) throw new Error(message, { cause: error });
    }
  }

  private _persistStateOrThrow(basePath: string): void {
    const state: PersistedHookState = {
      cycleCounts: Object.fromEntries(this.cycleCounts),
      redispatchedGateKeys: Array.from(this.redispatchedGateKeys),
      activeHook: this.activeHook ? { ...this.activeHook } : null,
      hookQueue: this.hookQueue.map(entry => ({
        hookName: entry.config.name,
        triggerUnitType: entry.triggerUnitType,
        triggerUnitId: entry.triggerUnitId,
        forceRun: entry.forceRun,
        completionOperationId: entry.completionOperationId,
        legacyCompletedAt: entry.legacyCompletedAt,
      })),
      retryPending: this.retryPending,
      retryTrigger: this.retryTrigger ? { ...this.retryTrigger } : null,
      gateBlockPending: this.gateBlockPending ? { ...this.gateBlockPending } : null,
      gateBlockQueue: this.gateBlockQueue.map(entry => ({
        hookName: entry.config.name,
        triggerUnitType: entry.triggerUnitType,
        triggerUnitId: entry.triggerUnitId,
        forceRun: entry.forceRun,
        completionOperationId: entry.completionOperationId,
        legacyCompletedAt: entry.legacyCompletedAt,
      })),
      savedAt: new Date().toISOString(),
    };
    const dir = join(basePath, ".gsd");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const statePath = this._hookStatePath(basePath);
    const temporaryPath = `${statePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf-8");
    renameSync(temporaryPath, statePath);
  }

  /** Restore hook state from disk after a crash/restart. */
  restoreState(basePath: string): void {
    try {
      const filePath = this._hookStatePath(basePath);
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf-8");
      const state: PersistedHookState = JSON.parse(raw);
      if (state.cycleCounts && typeof state.cycleCounts === "object") {
        this.cycleCounts.clear();
        for (const [key, value] of Object.entries(state.cycleCounts)) {
          if (typeof value === "number") {
            this.cycleCounts.set(key, value);
          }
        }
      }
      this.redispatchedGateKeys.clear();
      if (Array.isArray(state.redispatchedGateKeys)) {
        for (const key of state.redispatchedGateKeys) {
          if (typeof key === "string") {
            this.redispatchedGateKeys.add(key);
          }
        }
      }
      this.activeHook = state.activeHook && typeof state.activeHook === "object"
        ? { ...state.activeHook }
        : null;
      this.hookQueue = this._restoreQueueEntries(basePath, state.hookQueue);
      const retryTrigger = state.retryTrigger;
      if (
        state.retryPending === true &&
        retryTrigger &&
        typeof retryTrigger.unitType === "string" &&
        typeof retryTrigger.unitId === "string"
      ) {
        this.retryPending = true;
        this.retryTrigger = { ...retryTrigger };
      } else {
        this.retryPending = false;
        this.retryTrigger = null;
      }
      const gateBlock = state.gateBlockPending;
      if (
        gateBlock &&
        typeof gateBlock === "object" &&
        typeof gateBlock.hookName === "string" &&
        typeof gateBlock.triggerUnitType === "string" &&
        typeof gateBlock.triggerUnitId === "string"
      ) {
        this.gateBlockPending = { ...gateBlock };
      } else {
        this.gateBlockPending = null;
      }
      this.gateBlockQueue = this._restoreQueueEntries(basePath, state.gateBlockQueue);
    } catch (e) {
      logWarning("registry", `failed to restore hook state: ${(e as Error).message}`);
    }
  }

  /** Rehydrate persisted queue entries against current hook configuration;
   *  entries whose hook no longer exists are dropped. */
  private _restoreQueueEntries(
    basePath: string,
    entries: PersistedHookState["hookQueue"] | PersistedHookState["gateBlockQueue"],
  ): HookQueueEntry[] {
    const restored: HookQueueEntry[] = [];
    if (!Array.isArray(entries)) return restored;
    const hooks = resolvePostUnitHooks(basePath);
    for (const entry of entries) {
      const config = hooks.find(h => h.name === entry.hookName);
      if (config) {
        restored.push({
          config,
          triggerUnitType: entry.triggerUnitType,
          triggerUnitId: entry.triggerUnitId,
          forceRun: entry.forceRun,
          completionOperationId: entry.completionOperationId,
          legacyCompletedAt: entry.legacyCompletedAt,
        });
      }
    }
    return restored;
  }

  /** Clear persisted hook state file from disk. */
  clearPersistedState(basePath: string): void {
    try {
      const filePath = this._hookStatePath(basePath);
      if (existsSync(filePath)) {
        writeFileSync(
          filePath,
          JSON.stringify({
            cycleCounts: {},
            redispatchedGateKeys: [],
            activeHook: null,
            hookQueue: [],
            retryPending: false,
            retryTrigger: null,
            gateBlockPending: null,
            gateBlockQueue: [],
            savedAt: new Date().toISOString(),
          }, null, 2),
          "utf-8",
        );
      }
    } catch (e) {
      logWarning("registry", `failed to clear hook state: ${(e as Error).message}`);
    }
  }

  // ── Hook status reporting ───────────────────────────────────────────

  /** Get status of all configured hooks for display. */
  getHookStatus(): HookStatusEntry[] {
    const entries: HookStatusEntry[] = [];

    const postHooks = resolvePostUnitHooks();
    for (const hook of postHooks) {
      const activeCycles: Record<string, number> = {};
      for (const [key, count] of this.cycleCounts) {
        if (key.startsWith(`${hook.name}/`)) {
          activeCycles[key] = count;
        }
      }
      entries.push({
        name: hook.name,
        type: "post",
        enabled: hook.enabled !== false,
        targets: hook.after,
        criticality: hook.criticality ?? "advisory",
        activeCycles,
      });
    }

    const preHooks = resolvePreDispatchHooks();
    for (const hook of preHooks) {
      entries.push({
        name: hook.name,
        type: "pre",
        enabled: hook.enabled !== false,
        targets: hook.before,
        activeCycles: {},
      });
    }

    return entries;
  }

  /**
   * Manually trigger a specific hook for a unit.
   * Bypasses normal flow — forces hook to run even if artifact exists.
   */
  triggerHookManually(
    hookName: string,
    unitType: string,
    unitId: string,
    basePath: string,
  ): HookDispatchResult | null {
    const hook = resolvePostUnitHooks(basePath).find(h => h.name === hookName);
    if (!hook) {
      console.error(`[triggerHookManually] Hook "${hookName}" not found in post_unit_hooks`);
      return null;
    }

    if (!hook.prompt || typeof hook.prompt !== "string" || hook.prompt.trim().length === 0) {
      console.error(`[triggerHookManually] Hook "${hookName}" has empty prompt`);
      return null;
    }

    const completionIdentity = captureTaskCompletionIdentity({
      triggerUnitType: unitType,
      triggerUnitId: unitId,
    });
    if (!completionIdentity) return null;

    this.activeHook = {
      hookName: hook.name,
      triggerUnitType: unitType,
      triggerUnitId: unitId,
      cycle: 1,
      pendingRetry: false,
      ...completionIdentity,
    };

    this.hookQueue = [{
      config: hook,
      triggerUnitType: unitType,
      triggerUnitId: unitId,
      ...completionIdentity,
    }];

    const cycleKey = `${hook.name}/${unitType}/${unitId}`;
    const currentCycle = (this.cycleCounts.get(cycleKey) ?? 0) + 1;
    this.cycleCounts.set(cycleKey, currentCycle);
    this.activeHook.cycle = currentCycle;

    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const prompt = hook.prompt
      .replace(/\{milestoneId\}/g, mid ?? "")
      .replace(/\{sliceId\}/g, sid ?? "")
      .replace(/\{taskId\}/g, tid ?? "");

    return {
      hookName: hook.name,
      prompt,
      // Model selection (including fallbacks[]) is resolved by dispatchHookUnit
      // via resolveModelWithFallbacksForUnit for the `hook/<name>` unit type,
      // matching the auto-mode path. Emitting the primary-only model here would
      // discard the configured fallback chain (#1229).
      unitType: `hook/${hook.name}`,
      unitId,
    };
  }

  /** Format hook status for terminal display. */
  formatHookStatus(): string {
    const entries = this.getHookStatus();
    if (entries.length === 0) {
      return "No hooks configured. Add post_unit_hooks or pre_dispatch_hooks to .gsd/PREFERENCES.md";
    }

    const lines: string[] = ["Configured Hooks:", ""];

    const postHooks = entries.filter(e => e.type === "post");
    const preHooks = entries.filter(e => e.type === "pre");

    if (postHooks.length > 0) {
      lines.push("Post-Unit Hooks (run after unit completes):");
      for (const hook of postHooks) {
        const status = hook.enabled ? "enabled" : "disabled";
        const criticality = hook.criticality ?? "advisory";
        const cycles = Object.keys(hook.activeCycles).length;
        const cycleInfo = cycles > 0 ? ` (${cycles} active cycle${cycles === 1 ? "" : "s"})` : "";
        lines.push(`  ${hook.name} [${status}, ${criticality}] → after: ${hook.targets.join(", ")}${cycleInfo}`);
      }
      lines.push("");
    }

    if (preHooks.length > 0) {
      lines.push("Pre-Dispatch Hooks (run before unit dispatches):");
      for (const hook of preHooks) {
        const status = hook.enabled ? "enabled" : "disabled";
        lines.push(`  ${hook.name} [${status}] → before: ${hook.targets.join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ─── Module-level Singleton ─────────────────────────────────────────────────

let _registry: RuleRegistry | null = null;

/** Get the singleton registry. Throws if not initialized. */
export function getRegistry(): RuleRegistry {
  if (!_registry) {
    throw new Error("RuleRegistry not initialized — call initRegistry() or setRegistry() first.");
  }
  return _registry;
}

/** Set the singleton registry instance. */
export function setRegistry(r: RuleRegistry): void {
  _registry = r;
}

/** Create and set the singleton registry with the given dispatch rules. */
export function initRegistry(dispatchRules: UnifiedRule[]): RuleRegistry {
  const registry = new RuleRegistry(dispatchRules);
  setRegistry(registry);
  return registry;
}

/**
 * Get the singleton registry, lazily creating one with empty dispatch rules
 * if not yet initialized. This ensures facade functions work even when
 * the full registry hasn't been set up (e.g. during testing).
 */
export function getOrCreateRegistry(): RuleRegistry {
  if (!_registry) {
    _registry = new RuleRegistry([]);
  }
  return _registry;
}

/** Reset the singleton (for testing). */
export function resetRegistry(): void {
  _registry = null;
}
