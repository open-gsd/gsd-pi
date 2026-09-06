// Project/App: gsd-pi
// File Purpose: DB-backed GSD state derivation pipeline stage.
// Post-cutover (T007) this module is the sole state authority on the live
// derive path: DB rows decide phase/registry/progress. Markdown state
// projections on disk (STATE.md, roadmaps, plans, summaries) are never
// parsed as authority here; DB-unavailable fails closed in db-open.ts.
// Canonical-lifecycle read authority (handleAllSlicesDone +
// resolveMilestoneValidationVerdict) is pinned by D005 and unchanged.

import type { ActiveRef, GSDState, MilestoneRegistryEntry, Phase } from '../../types.js';
import { isClosedStatus, isDeferredStatus } from '../../status-guards.js';
import { parseProject } from '../../schemas/parsers.js';
import {
  queryDecisions,
  queryDecisionsFromMemories,
} from '../../context-store.js';
import {
  getAllMilestones,
  getArtifact,
  getMilestoneScopedArtifacts,
  getPlanMilestoneRecoveryBlock,
  getPendingGateCountForTurn,
  getReplanHistory,
  getRequirementCounts,
  getSlice,
  getSliceTasks,
  getSlicesByMilestoneIds,
} from '../../gsd-db.js';
import type { MilestoneRow } from '../../db-milestone-artifact-rows.js';
import type { SliceRow, TaskRow } from '../../db-task-slice-rows.js';
import {
  classifyMilestoneReadiness,
  readinessNeedsDiscussion,
} from '../../milestone-readiness.js';
import {
  needsAttentionBlockerGuidance as formatNeedsAttentionBlocker,
  needsRemediationBlockerGuidance as formatNeedsRemediationBlocker,
} from '../../guidance.js';
import {
  outOfSurfaceBlockerGuidance,
  routeBlockerCategory,
} from '../../out-of-surface-blocker.js';
import { detectPendingEscalation } from '../../escalation.js';
import { countUnmappedActiveRequirements, formatCompletePhaseNextAction } from '../../requirements-backlog.js';
import { logWarning } from '../../workflow-logger.js';
import {
  buildDbUnavailableState,
  ensureExistingWorkflowDbOpen,
  getRequestedMilestoneLock,
} from './db-open.js';
import { resolveMilestoneValidationVerdict } from '../../milestone-validation-verdict.js';

const isStatusDone = isClosedStatus;

type MilestoneProgress = { done: number; total: number };
type SliceProgress = { done: number; total: number };
type TaskProgress = { done: number; total: number };

interface DerivedStateContext {
  activeMilestone: ActiveRef | null;
  activeSlice?: ActiveRef | null;
  activeTask?: ActiveRef | null;
  registry: MilestoneRegistryEntry[];
  requirements: GSDState["requirements"];
  milestoneProgress: MilestoneProgress;
  sliceProgress?: SliceProgress;
  taskProgress?: TaskProgress;
}

interface DerivedStateOptions {
  blockers?: string[];
  lastCompletedMilestone?: ActiveRef | null;
  includeActiveWorkspace?: boolean;
}

function buildProgress(context: DerivedStateContext): NonNullable<GSDState["progress"]> {
  return {
    milestones: context.milestoneProgress,
    ...(context.sliceProgress ? { slices: context.sliceProgress } : {}),
    ...(context.taskProgress ? { tasks: context.taskProgress } : {}),
  };
}

function buildDerivedState(
  context: DerivedStateContext,
  phase: Phase,
  nextAction: string,
  options: DerivedStateOptions = {},
): GSDState {
  return {
    activeMilestone: context.activeMilestone,
    activeSlice: context.activeSlice ?? null,
    activeTask: context.activeTask ?? null,
    phase,
    recentDecisions: loadRecentDecisionsFromDb(),
    blockers: options.blockers ?? [],
    nextAction,
    ...(options.lastCompletedMilestone !== undefined
      ? { lastCompletedMilestone: options.lastCompletedMilestone }
      : {}),
    ...(options.includeActiveWorkspace ? { activeWorkspace: undefined } : {}),
    registry: context.registry,
    requirements: context.requirements,
    progress: buildProgress(context),
  };
}

function stripMilestonePrefix(title: string): string {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || title;
}

function buildCompletenessSet(basePath: string, milestones: MilestoneRow[]) {
  const completeMilestoneIds = new Set<string>();
  const parkedMilestoneIds = new Set<string>();

  // DB-authoritative: a milestone is only "complete" when its DB row says so.
  // SUMMARY-file presence is NOT a completion signal here — an orphan SUMMARY
  // (crashed complete-milestone turn, partial merge, manual edit) must not
  // flip derived state to complete and cascade into a false auto-merge (#4179).
  for (const m of milestones) {
    if (m.status === 'parked') {
      parkedMilestoneIds.add(m.id);
      continue;
    }
    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }
  }
  return { completeMilestoneIds, parkedMilestoneIds };
}

function loadRecentDecisionsFromDb(): string[] {
  const fromMemories = queryDecisionsFromMemories();
  const rows = fromMemories.length > 0 ? fromMemories : queryDecisions();
  return rows.slice(-5).map(
    (d) => `${d.id} (${d.when_context}): ${d.decision} -> ${d.choice}`,
  );
}

// The IDs the user actually committed to as their roadmap, read from the
// PROJECT.md artifact stored in the DB. A content-less queued milestone that
// appears here is a real, not-yet-planned roadmap stage (e.g. the first
// milestone right after deep-project setup) and is safe to promote to active.
// A content-less queued row that is NOT listed here is a phantom left by
// gsd_milestone_generate_id that was never made part of the roadmap (#1524)
// and must not be promoted. Returns an empty set when the PROJECT artifact is
// absent or unparsable, which keeps phantom-only repos out of the promotion
// path. Disk PROJECT.md is a projection and is never opened here.
function loadProjectSequenceIds(): Set<string> {
  const project = getArtifact("PROJECT.md");
  if (!project?.full_content) return new Set<string>();
  try {
    return new Set(parseProject(project.full_content).milestones.map((m) => m.id));
  } catch (e) {
    logWarning('state', `failed to parse PROJECT.md milestone sequence: ${(e as Error).message}`);
    return new Set<string>();
  }
}

async function buildRegistryAndFindActive(
  milestones: MilestoneRow[],
  completeMilestoneIds: Set<string>,
  parkedMilestoneIds: Set<string>
) {
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeMilestoneSlices: SliceRow[] = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  let firstPromotableQueuedShell: { id: string; title: string; deps: string[]; hasDraftContext: boolean } | null = null;

  const projectSequenceIds = loadProjectSequenceIds();

  const activeMilestoneIds = milestones
    .filter((m) => !parkedMilestoneIds.has(m.id))
    .map((m) => m.id);
  const slicesByMilestone = getSlicesByMilestoneIds(activeMilestoneIds);

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    const slices = slicesByMilestone.get(m.id) ?? [];

    // DB-authoritative completeness (#4179): only trust completeMilestoneIds,
    // which is itself derived from DB status. SUMMARY-file presence alone must
    // not imply completion.
    if (completeMilestoneIds.has(m.id)) {
      const title = stripMilestonePrefix(m.title) || m.id;
      registry.push({ id: m.id, title, status: 'complete' });
      continue;
    }

    const allSlicesDone = slices.length > 0 && slices.every(s => isStatusDone(s.status));

    const title = stripMilestonePrefix(m.title) || m.id;
    const artifacts = getMilestoneScopedArtifacts(m.id);
    const hasContext = artifacts.some((a) => a.artifact_type === "CONTEXT");
    const hasDraftContext = !hasContext && artifacts.some((a) => a.artifact_type === "CONTEXT-DRAFT");
    const readiness = classifyMilestoneReadiness({
      status: m.status,
      hasContext,
      hasDraftContext,
      sliceCount: slices.length,
    });

    if (!activeMilestoneFound) {
      const deps = m.depends_on;
      const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));

      if (depsUnmet) {
        registry.push({ id: m.id, title, status: 'pending', dependsOn: deps });
        continue;
      }

      if (readiness.kind === 'queued-shell') {
        // Only a *promotable* queued-shell may become active in the fallback
        // below: one that carries draft context (discuss-milestone was started)
        // or is listed in the PROJECT artifact roadmap sequence (a real, not-yet-
        // planned stage). A content-less shell that is neither is a phantom left
        // by gsd_milestone_generate_id that was never planned; promoting it
        // strands the user on an empty milestone (#1524), so we record it only
        // as 'pending' and never promote it. Storing just the first promotable
        // shell also means an earlier phantom can't mask a later resumable one.
        const promotable = readiness.hasDraftContext || projectSequenceIds.has(m.id);
        if (promotable && !firstPromotableQueuedShell) {
          firstPromotableQueuedShell = { id: m.id, title, deps, hasDraftContext: readiness.hasDraftContext };
        }
        registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        continue;
      }

      if (allSlicesDone) {
        activeMilestone = { id: m.id, title };
        activeMilestoneSlices = slices;
        activeMilestoneFound = true;
        registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        continue;
      }

      if (readinessNeedsDiscussion(readiness)) activeMilestoneHasDraft = true;

      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    } else {
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    }
  }

  // Promote the first promotable queued-shell as a fallback when no other
  // milestone became active. "Promotable" (tracked above) means it either
  // carries draft context or is part of the PROJECT artifact roadmap sequence.
  // Content-less phantom rows never reach here, so state falls through to
  // handleNoActiveMilestone and the doctor can flag them as orphans (#1524).
  // A draft-bearing shell resumes discussion (needs-discussion); an in-sequence
  // shell with no draft goes to pre-planning, so only carry the draft flag
  // when the shell actually has draft context.
  if (!activeMilestoneFound && firstPromotableQueuedShell) {
    const shell = firstPromotableQueuedShell;
    activeMilestone = { id: shell.id, title: shell.title };
    activeMilestoneSlices = [];
    activeMilestoneFound = true;
    if (shell.hasDraftContext) activeMilestoneHasDraft = true;
    const entry = registry.find(e => e.id === shell.id);
    if (entry) entry.status = 'active';
  }

  return { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft };
}

function handleNoActiveMilestone(
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number }
): GSDState {
  const pendingEntries = registry.filter(e => e.status === 'pending');
  const parkedEntries = registry.filter(e => e.status === 'parked');

  const context: DerivedStateContext = {
    activeMilestone: null,
    registry,
    requirements,
    milestoneProgress,
  };

  if (pendingEntries.length > 0) {
    const blockerDetails = pendingEntries
      .filter(e => e.dependsOn && e.dependsOn.length > 0)
      .map(e => `${e.id} is waiting on unmet deps: ${e.dependsOn!.join(', ')}`);

    // Genuine dependency block: at least one pending milestone is waiting on an
    // unmet dependency, so directing the user at those deps is accurate.
    if (blockerDetails.length > 0) {
      return buildDerivedState(context, 'blocked', 'Resolve milestone dependencies before proceeding.', {
        blockers: blockerDetails,
      });
    }

    // No pending milestone has unmet deps, yet none could be promoted to
    // active. These are content-less queued shells — phantom rows left by
    // gsd_milestone_generate_id with no CONTEXT/CONTEXT-DRAFT/slices — so the
    // old "resolve dependencies" blocker was misleading and offered no recovery
    // path (#1524). Point the user at the doctor (which now flags these as
    // orphan milestone rows) or at planning a real milestone.
    const phantomIds = pendingEntries.map(e => e.id).join(', ');
    return buildDerivedState(
      context,
      'pre-planning',
      `Found queued milestone(s) with no planning content and no dependencies (${phantomIds}) — likely orphaned rows. Run /gsd doctor fix to repair them, or /gsd to plan a milestone.`,
    );
  }

  if (parkedEntries.length > 0) {
    const parkedIds = parkedEntries.map(e => e.id).join(', ');
    return buildDerivedState(
      context,
      'pre-planning',
      `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
    );
  }

  if (registry.length === 0) {
    return buildDerivedState(
      { ...context, registry: [], milestoneProgress: { done: 0, total: 0 } },
      'pre-planning',
      'No milestones found. Run /gsd to create one.',
    );
  }

  const lastEntry = registry[registry.length - 1];
  const unmappedActive = countUnmappedActiveRequirements();
  const completionNote = formatCompletePhaseNextAction(unmappedActive);
  return buildDerivedState(context, 'complete', completionNote, {
    lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
  });
}

async function handleAllSlicesDone(
  basePath: string,
  activeMilestone: ActiveRef,
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number },
  sliceProgress: { done: number, total: number }
): Promise<GSDState> {
  const verdict = await resolveMilestoneValidationVerdict(basePath, activeMilestone.id);

  const context: DerivedStateContext = {
    activeMilestone,
    registry,
    requirements,
    milestoneProgress,
    sliceProgress,
  };

  if (verdict === undefined) {
    return buildDerivedState(
      context,
      'validating-milestone',
      `Validate milestone ${activeMilestone.id} before completion.`,
    );
  }

  // All roadmap slices are done (enforced by caller) and verdict is
  // needs-remediation — remediation cannot progress without new slices.
  // Return blocked instead of re-dispatching validate-milestone (#4506).
  if (verdict === 'needs-attention') {
    return buildDerivedState(
      context,
      'blocked',
      `Resolve ${activeMilestone.id} validation attention before proceeding.`,
      { blockers: [formatNeedsAttentionBlocker(activeMilestone.id)] },
    );
  }

  if (verdict === 'needs-remediation') {
    return buildDerivedState(
      context,
      'blocked',
      `Resolve ${activeMilestone.id} remediation before proceeding.`,
      { blockers: [formatNeedsRemediationBlocker(activeMilestone.id)] },
    );
  }

  return buildDerivedState(
    context,
    'completing-milestone',
    `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
  );
}

function resolveSliceDependencies(activeMilestoneSlices: SliceRow[]): { activeSlice: ActiveRef | null, activeSliceRow: SliceRow | null } {
  const doneSliceIds = new Set(
    activeMilestoneSlices.filter(s => isStatusDone(s.status)).map(s => s.id)
  );

  const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : undefined;
  if (sliceLock) {
    const lockedSlice = activeMilestoneSlices.find(s => s.id === sliceLock);
    if (lockedSlice) {
      return { activeSlice: { id: lockedSlice.id, title: lockedSlice.title }, activeSliceRow: lockedSlice };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLock} not found in active slices — worker has no assigned work`);
      return { activeSlice: null, activeSliceRow: null };
    }
  }

  for (const s of activeMilestoneSlices) {
    if (isStatusDone(s.status)) continue;
    if (isDeferredStatus(s.status)) continue;
    if (s.depends.every(dep => doneSliceIds.has(dep))) {
      return { activeSlice: { id: s.id, title: s.title }, activeSliceRow: s };
    }
  }

  return { activeSlice: null, activeSliceRow: null };
}

async function detectBlockers(basePath: string, milestoneId: string, sliceId: string, tasks: TaskRow[]): Promise<string | null> {
  const completedTasks = tasks.filter(t => isStatusDone(t.status));
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      return ct.id;
    }
  }
  return null;
}

function checkReplanTrigger(basePath: string, milestoneId: string, sliceId: string): boolean {
  const sliceRow = getSlice(milestoneId, sliceId);
  return !!sliceRow?.replan_triggered_at;
}

export async function deriveStateFromDb(
  basePath: string,
  _artifactReadRoot: string = basePath,
  options: { syncQueueOrder?: boolean } = {},
): Promise<GSDState> {
  // Use the canonical read root (matches the caller's DB-open call in
  // derive/index.ts) — a worktree basePath can resolve to a different (or
  // nonexistent) DB path than the canonical project root.
  if (!ensureExistingWorkflowDbOpen(_artifactReadRoot, options)) {
    return buildDbUnavailableState();
  }

  const requirements = getRequirementCounts();

  const allMilestones = getAllMilestones();

  const milestoneLock = getRequestedMilestoneLock();
  const milestones = milestoneLock
    ? allMilestones.filter(m => m.id === milestoneLock)
    : allMilestones;

  if (milestones.length === 0) {
    return buildDerivedState(
      {
        activeMilestone: null,
        registry: [],
        requirements,
        milestoneProgress: { done: 0, total: 0 },
      },
      'pre-planning',
      'No milestones found. Run /gsd to create one.',
    );
  }

  const { completeMilestoneIds, parkedMilestoneIds } = buildCompletenessSet(basePath, milestones);
  
  const registryContext = await buildRegistryAndFindActive(milestones, completeMilestoneIds, parkedMilestoneIds);
  const { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft } = registryContext;
  
  const milestoneProgress = {
    done: registry.filter(e => e.status === 'complete').length,
    total: registry.length,
  };

  if (!activeMilestone) {
    return handleNoActiveMilestone(registry, requirements, milestoneProgress);
  }

  if (activeMilestoneSlices.length === 0) {
    const planningBlocker = getPlanMilestoneRecoveryBlock(activeMilestone.id);
    if (planningBlocker) {
      return buildDerivedState(
        { activeMilestone, registry, requirements, milestoneProgress },
        'blocked',
        `Milestone ${activeMilestone.id} planning is blocked. Resolve the planning failure before resuming auto-mode.`,
        { blockers: [planningBlocker.reason] },
      );
    }
    const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
    const nextAction = activeMilestoneHasDraft
      ? `Discuss draft context for milestone ${activeMilestone.id}.`
      : `Plan milestone ${activeMilestone.id}.`;
    return buildDerivedState(
      { activeMilestone, registry, requirements, milestoneProgress },
      phase,
      nextAction,
    );
  }

  const allSlicesDone = activeMilestoneSlices.every(s => isStatusDone(s.status));
  const sliceProgress = {
    done: activeMilestoneSlices.filter(s => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length,
  };
  const sliceStateContext: DerivedStateContext = {
    activeMilestone,
    registry,
    requirements,
    milestoneProgress,
    sliceProgress,
  };

  if (allSlicesDone) {
    return handleAllSlicesDone(basePath, activeMilestone, registry, requirements, milestoneProgress, sliceProgress);
  }

  const activeSliceContext = resolveSliceDependencies(activeMilestoneSlices);
  if (!activeSliceContext.activeSlice) {
    // If locked slice wasn't found, it returns null but logs warning, we need to return 'blocked'
    const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : undefined;
    if (sliceLock) {
      return buildDerivedState(
        sliceStateContext,
        'blocked',
        'Slice lock references a non-existent slice — check orchestrator dispatch.',
        { blockers: [`GSD_SLICE_LOCK=${sliceLock} not found in active milestone slices`] },
      );
    }
    return buildDerivedState(
      sliceStateContext,
      'blocked',
      'Resolve dependency blockers or plan next slice.',
      { blockers: ['No slice eligible — check dependency ordering'] },
    );
  }
  const { activeSlice } = activeSliceContext;
  const activeSliceRow = activeSliceContext.activeSliceRow;

  // ADR-011: DB slice metadata is authoritative for sketch refinement.
  // Stale sketch flags (PLAN on disk but is_sketch=1) are repaired by
  // sketchFlagHandler via reconcileBeforeDispatch — not during derivation.
  // PLAN.md and preference flags are projections/configuration and are
  // deliberately not used to infer whether the slice itself is a sketch.
  if (activeSliceRow?.is_sketch === 1) {
    return buildDerivedState(
      { ...sliceStateContext, activeSlice },
      'refining',
      `Refine sketch slice ${activeSlice.id} (${activeSlice.title}) using prior slice context.`,
    );
  }

  const tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
  
  const taskProgress = {
    done: tasks.filter(t => isStatusDone(t.status)).length,
    total: tasks.length,
  };
  const taskStateContext: DerivedStateContext = {
    ...sliceStateContext,
    activeSlice,
    taskProgress,
  };

  const activeTaskRow = tasks.find(t => !isStatusDone(t.status));

  if (!activeTaskRow && tasks.length > 0) {
    return buildDerivedState(
      taskStateContext,
      'summarizing',
      `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
    );
  }

  if (!activeTaskRow) {
    return buildDerivedState(
      taskStateContext,
      'planning',
      `Slice ${activeSlice.id} has no DB tasks. Plan slice tasks before execution.`,
    );
  }

  const activeTask: ActiveRef = { id: activeTaskRow.id, title: activeTaskRow.title };
  const activeTaskStateContext: DerivedStateContext = {
    ...taskStateContext,
    activeTask,
  };

  // ── Quality gate evaluation check ──────────────────────────────────
  // Pause before execution only when gates owned by the `gate-evaluate`
  // turn (Q3/Q4) are still pending. Q8 is also `scope:"slice"` but is
  // owned by `complete-slice`, so it must NOT block the evaluating-gates
  // phase — otherwise auto-loop stalls forever waiting for a gate that
  // this turn never evaluates. See gate-registry.ts for the ownership map.
  // Slices with zero gate rows (pre-feature or simple) skip straight through.
  const pendingGateCount = getPendingGateCountForTurn(
    activeMilestone.id,
    activeSlice.id,
    "gate-evaluate",
  );
  if (pendingGateCount > 0) {
    return buildDerivedState(
      taskStateContext,
      'evaluating-gates',
      `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
    );
  }

  const blockerTaskId = await detectBlockers(basePath, activeMilestone.id, activeSlice.id, tasks);
  if (blockerTaskId) {
    const blockerTask = tasks.find((task) => task.id === blockerTaskId);
    if (routeBlockerCategory(blockerTask?.blocker_source) === "surface-widen") {
      return buildDerivedState(
        activeTaskStateContext,
        "escalating-task",
        outOfSurfaceBlockerGuidance(blockerTaskId, activeSlice.id),
        {
          blockers: [outOfSurfaceBlockerGuidance(blockerTaskId, activeSlice.id)],
          includeActiveWorkspace: true,
        },
      );
    }
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return buildDerivedState(
        activeTaskStateContext,
        'replanning-slice',
        `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        {
          blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
          includeActiveWorkspace: true,
        },
      );
    }
  }

  // ADR-011 Phase 2: pause-on-escalation takes precedence over dispatching the
  // next task. `awaiting_review` tasks (continueWithDefault=true) still pause
  // here so silence is never treated as consent.
  //
  // We do NOT gate this on `phases.mid_execution_escalation` — creation of
  // new escalations is gated at the write site (tools/complete-task.ts:315),
  // but any escalation_pending row already persisted in the DB must be
  // honored even if the user later toggles the flag off. Otherwise those
  // rows would silently orphan, the loop would advance past the paused task,
  // and the user's prior resolution never lands.
  const escalatingTaskId = detectPendingEscalation(tasks, basePath);
  if (escalatingTaskId) {
    return buildDerivedState(
      activeTaskStateContext,
      'escalating-task',
      `Run /gsd escalate show ${escalatingTaskId} to review, then /gsd escalate resolve ${escalatingTaskId} <choice> to proceed.`,
      {
        blockers: [`Task ${escalatingTaskId} requires a user decision before the loop can proceed`],
        includeActiveWorkspace: true,
      },
    );
  }

  if (!blockerTaskId) {
    const isTriggered = checkReplanTrigger(basePath, activeMilestone.id, activeSlice.id);
    if (isTriggered) {
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return buildDerivedState(
          activeTaskStateContext,
          'replanning-slice',
          `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          {
            blockers: ['Triage replan trigger detected — slice replan required'],
            includeActiveWorkspace: true,
          },
        );
      }
    }
  }

  return buildDerivedState(
    activeTaskStateContext,
    'executing',
    `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
  );
}
