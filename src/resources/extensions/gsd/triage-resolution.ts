/**
 * GSD Triage Resolution — Execute triage classifications
 *
 * Provides resolution executors for each capture classification type:
 *
 * - inject: appends a new task to the current slice plan
 * - replan: stamps the slice's replan trigger in the database so next dispatchNextUnit enters replanning-slice
 * - defer/note: query helpers for loading deferred/replan captures
 *
 * Also provides detectFileOverlap() for surfacing downstream impact on quick tasks.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { executeDomainOperation } from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { getSlice, setSliceReplanTriggeredAt } from "./gsd-db.js";
import { gsdRoot, milestonesDir, legacyMilestonesDir, resolveMilestonePath } from "./paths.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import type { Classification, CaptureEntry } from "./captures.js";
import {
  loadPendingCaptures,
  loadAllCaptures,
  loadActionableCaptures,
  markCaptureResolved,
  markCaptureExecuted,
} from "./captures.js";

// ─── Resolution Executors ─────────────────────────────────────────────────────

/**
 * Inject a new task into the current slice plan.
 * Reads the plan, finds the highest task ID, appends a new task entry.
 * Returns the new task ID, or null if injection failed.
 */
export function executeInject(
  basePath: string,
  mid: string,
  sid: string,
  capture: CaptureEntry,
): string | null {
  try {
    // Resolve the plan file path
    const planPath = join(gsdRoot(basePath), "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
    if (!existsSync(planPath)) return null;

    const content = readFileSync(planPath, "utf-8");

    // Find the highest existing task ID
    const taskMatches = [...content.matchAll(/- \[[ x]\] \*\*T(\d+):/g)];
    if (taskMatches.length === 0) return null;

    const maxId = Math.max(...taskMatches.map(m => parseInt(m[1], 10)));
    const newId = `T${String(maxId + 1).padStart(2, "0")}`;

    // Build the new task entry
    const newTask = [
      `- [ ] **${newId}: ${capture.text}** \`est:30m\``,
      `  - Why: Injected from capture ${capture.id} during triage`,
      `  - Do: ${capture.text}`,
      `  - Done when: Capture intent fulfilled`,
    ].join("\n");

    // Find the last task entry and append after it
    // Look for the "## Files Likely Touched" section as the boundary
    const filesSection = content.indexOf("## Files Likely Touched");
    if (filesSection !== -1) {
      const updated = content.slice(0, filesSection) + newTask + "\n\n" + content.slice(filesSection);
      atomicWriteSync(planPath, updated, "utf-8");
    } else {
      // No Files section — append at end
      atomicWriteSync(planPath, content.trimEnd() + "\n\n" + newTask + "\n", "utf-8");
    }

    return newId;
  } catch {
    return null;
  }
}

/**
 * Stamp the slice's replan trigger in one slice.replan.trigger Domain
 * Operation and return the stored timestamp. A replay for the same capture
 * writes nothing. Throws when no database is open or the slice has no row.
 */
function recordReplanTrigger(mid: string, sid: string, captureId: string): string {
  const idempotencyKey = `slice.replan.trigger:${mid}/${sid}:${captureId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType: "slice.replan.trigger",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "system",
    sourceTransport: "internal",
    payload: { milestoneId: mid, sliceId: sid, captureId },
  }, () => {
    if (!setSliceReplanTriggeredAt(mid, sid, new Date().toISOString())) {
      throw new Error(`replan trigger requires a slice row for ${mid}/${sid}`);
    }
    return {
      events: [{
        eventType: "slice.replan.triggered",
        entityType: "slice",
        entityId: `${mid}/${sid}`,
        payload: { captureId },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `replan-trigger/${mid}/${sid}`.toLowerCase(),
        projectionKind: "state",
        rendererVersion: "1",
      }],
    };
  });
  return getSlice(mid, sid)!.replan_triggered_at!;
}

/**
 * Trigger replanning. The slice's replan trigger in the database is the
 * trigger: the state derivation reads it and sets phase to "replanning-slice".
 * REPLAN-TRIGGER.md is a render of that row for the user.
 * Returns true if the trigger was stored.
 */
export function executeReplan(
  basePath: string,
  mid: string,
  sid: string,
  capture: CaptureEntry,
): boolean {
  let triggeredAt: string;
  try {
    triggeredAt = recordReplanTrigger(mid, sid, capture.id);
  } catch {
    return false;
  }
  try {
    atomicWriteSync(join(
      basePath, ".gsd", "milestones", mid, "slices", sid, `${sid}-REPLAN-TRIGGER.md`,
    ), [
      `# Replan Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated replan via capture triage"}`,
      `**Triggered:** ${triggeredAt}`,
      ``,
      `This file is a render of the replan trigger in the database. The next`,
      `dispatch cycle reads the database and enters the replanning-slice phase.`,
    ].join("\n"), "utf-8");
  } catch {
    // The file is a render. The database row is the trigger.
  }
  return true;
}

// ─── File Overlap Detection ───────────────────────────────────────────────────

/**
 * Detect file overlap between a capture's affected files and planned tasks.
 *
 * Parses the slice plan for task file references and returns task IDs
 * whose files overlap with the capture's affected files.
 *
 * @param affectedFiles - Files the capture would touch
 * @param planContent - Content of the slice plan.md
 * @returns Array of task IDs (e.g., ["T03", "T04"]) whose files overlap
 */
export function detectFileOverlap(
  affectedFiles: string[],
  planContent: string,
): string[] {
  if (!affectedFiles || affectedFiles.length === 0) return [];

  const overlappingTasks: string[] = [];

  // Normalize affected files for comparison
  const normalizedAffected = new Set(
    affectedFiles.map(f => f.replace(/^\.\//, "").toLowerCase()),
  );

  // Parse plan for incomplete tasks and their file references
  const taskPattern = /- \[ \] \*\*(T\d+):[^*]*\*\*/g;
  const tasks = [...planContent.matchAll(taskPattern)];

  for (const taskMatch of tasks) {
    const taskId = taskMatch[1];
    const taskStart = taskMatch.index!;

    // Find the end of this task (next task or end of section)
    const nextTask = planContent.indexOf("- [", taskStart + 1);
    const sectionEnd = planContent.indexOf("##", taskStart + 1);
    const taskEnd = Math.min(
      nextTask === -1 ? planContent.length : nextTask,
      sectionEnd === -1 ? planContent.length : sectionEnd,
    );

    const taskContent = planContent.slice(taskStart, taskEnd);

    // Extract file references — look for backtick-quoted paths
    const fileRefs = [...taskContent.matchAll(/`([^`]+\.[a-z]+)`/g)]
      .map(m => m[1].replace(/^\.\//, "").toLowerCase());

    // Check for overlap
    const hasOverlap = fileRefs.some(f => normalizedAffected.has(f));
    if (hasOverlap) {
      overlappingTasks.push(taskId);
    }
  }

  return overlappingTasks;
}

// ─── Defer Milestone Creation ─────────────────────────────────────────────────

/**
 * Ensure the milestone directory exists when triage defers a capture to a
 * not-yet-created milestone (e.g., "M005").
 *
 * Creates the directory with a seed CONTEXT-DRAFT.md so that `deriveState()`
 * discovers the milestone and enters the discussion phase instead of
 * treating the project as fully complete.
 *
 * @param basePath - Project root
 * @param targetMilestone - The milestone ID to defer to (e.g., "M005")
 * @param captures - Captures being deferred to this milestone
 * @returns true if the directory was created (or already existed), false on error
 */
export function ensureDeferMilestoneDir(
  basePath: string,
  targetMilestone: string,
  captures: CaptureEntry[],
): boolean {
  if (!MILESTONE_ID_RE.test(targetMilestone)) return false;

  // Check if the milestone dir already exists in either layout.
  const existingDir = resolveMilestonePath(basePath, targetMilestone);
  if (existingDir && existsSync(existingDir)) return true;
  // Create new dir in the layout-appropriate location.
  const legacyBase = legacyMilestonesDir(basePath);
  const msBase = existsSync(legacyBase) ? legacyBase : milestonesDir(basePath);
  const msDir = join(msBase, targetMilestone);

  try {
    mkdirSync(msDir, { recursive: true });

    // Seed CONTEXT-DRAFT.md with deferred capture context
    const captureList = captures
      .map(c => `- **${c.id}:** ${c.text}`)
      .join("\n");

    const draftContent = [
      `# ${targetMilestone}: Deferred Work`,
      ``,
      `This milestone was created by triage when captures were deferred here.`,
      `Discuss scope and goals before planning slices.`,
      ``,
      `## Deferred Captures`,
      ``,
      captureList || `(no captures yet)`,
      ``,
    ].join("\n");

    atomicWriteSync(
      join(msDir, `${targetMilestone}-CONTEXT-DRAFT.md`),
      draftContent,
      "utf-8",
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Load deferred captures (classification === "defer") for injection into
 * reassess-roadmap prompts.
 */
export function loadDeferredCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.classification === "defer");
}

/**
 * Load replan-triggering captures for injection into replan-slice prompts.
 */
export function loadReplanCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.classification === "replan");
}

/**
 * Build a quick-task execution prompt from a capture.
 */
export function buildQuickTaskPrompt(capture: CaptureEntry): string {
  return [
    `You are executing a quick one-off task captured during a GSD auto-mode session.`,
    ``,
    `## Quick Task`,
    ``,
    `**Capture ID:** ${capture.id}`,
    `**Task:** ${capture.text}`,
    ``,
    `## Instructions`,
    ``,
    `1. **Verify the issue still exists.** Before making any changes, inspect the`,
    `   relevant code to confirm the problem described above is actually present in`,
    `   the current codebase. If the issue has already been fixed (e.g., by planned`,
    `   milestone work), skip to step 6 and report "Already resolved — no changes needed."`,
    `2. Execute this task as a small, self-contained change.`,
    `3. Do NOT modify any \`.gsd/\` plan files — this is a one-off, not a planned task.`,
    `4. Commit your changes with a descriptive message.`,
    `5. Keep changes minimal and focused on the capture text.`,
    `6. Call \`gsd_capture_complete\` with \`captureId: "${capture.id}"\` and an \`outcome\` that says`,
    `   what you changed, or why no change was needed. The quick task is recorded as`,
    `   executed only by this call.`,
    `7. When done, say: "Quick task complete."`,
  ].join("\n");
}

// ─── Post-Triage Resolution Executor ─────────────────────────────────────────

/**
 * Result of executing triage resolutions after a triage-captures unit completes.
 */
export interface TriageExecutionResult {
  /** Number of inject resolutions executed (tasks added to plan) */
  injected: number;
  /** Number of replan triggers written */
  replanned: number;
  /** Number of defer milestone directories created */
  deferredMilestones: number;
  /** Captures classified as quick-task that need dispatch */
  quickTasks: CaptureEntry[];
  /** Number of stop directives (will pause auto-mode via guard) */
  stopped: number;
  /** Backtrack captures (will trigger milestone regression via guard) */
  backtracks: CaptureEntry[];
  /** Details of each action taken, for logging */
  actions: string[];
}

/**
 * Execute pending triage resolutions.
 *
 * Called after a triage-captures unit completes. Reads the database for
 * resolved captures that have actionable classifications (inject, replan,
 * quick-task) but haven't been executed yet, then:
 *
 * - inject: calls executeInject() to add a task to the current slice plan
 * - replan: calls executeReplan() to stamp the slice's replan trigger
 * - quick-task: collects for dispatch (caller handles dispatching quick-task units)
 *
 * Each capture is marked as executed after its resolution action succeeds,
 * preventing double-execution on retries or restarts.
 */
export function executeTriageResolutions(
  basePath: string,
  mid: string,
  sid: string,
): TriageExecutionResult {
  const result: TriageExecutionResult = {
    injected: 0,
    replanned: 0,
    deferredMilestones: 0,
    quickTasks: [],
    stopped: 0,
    backtracks: [],
    actions: [],
  };

  const actionable = loadActionableCaptures(basePath, mid || undefined);

  // Also process deferred and milestone-class captures (#3542).
  // A defer/milestone capture's "action" is the triage decision itself —
  // once classified and resolved, the capture is done. The target milestone
  // picks up the work naturally from its planning context.
  const deferrable = loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed &&
      (c.classification === "defer" || (c.classification as string) === "milestone"),
  );
  if (deferrable.length > 0) {
    // Group captures that reference a specific milestone — create dirs as needed.
    const byMilestone = new Map<string, CaptureEntry[]>();
    for (const cap of deferrable) {
      const target = cap.resolution?.match(/\b(M\d{3}(?:-[a-z0-9]{6})?)\b/)?.[1];
      if (target) {
        const list = byMilestone.get(target) ?? [];
        list.push(cap);
        byMilestone.set(target, list);
      }
    }
    for (const [milestoneId, captures] of byMilestone) {
      // Use resolveMilestonePath to check existence in either layout.
      const existingMs = resolveMilestonePath(basePath, milestoneId);
      if (!existingMs || !existsSync(existingMs)) {
        const created = ensureDeferMilestoneDir(basePath, milestoneId, captures);
        if (created) {
          result.deferredMilestones++;
          result.actions.push(`Created milestone ${milestoneId} for ${captures.length} deferred capture(s)`);
        }
      }
    }
    // Stamp ALL defer/milestone captures as executed (#3542 gaps 1-3).
    // Previously only captures that triggered dir creation were stamped.
    // Captures without a milestone ID in resolution text, or targeting an
    // existing directory, were silently dropped — never stamped.
    for (const cap of deferrable) {
      if (!cap.executed) {
        markCaptureExecuted(basePath, cap.id);
      }
    }
  }

  // Mark note captures as executed — they're informational only, no action
  // needed. Without this they stay in "resolved but not executed" limbo (#3578).
  const notes = loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed && c.classification === "note",
  );
  for (const cap of notes) {
    markCaptureExecuted(basePath, cap.id);
    result.actions.push(`Note acknowledged: ${cap.id} — "${cap.text}"`);
  }

  if (actionable.length === 0) return result;

  for (const capture of actionable) {
    switch (capture.classification) {
      case "inject": {
        const newTaskId = executeInject(basePath, mid, sid, capture);
        if (newTaskId) {
          markCaptureExecuted(basePath, capture.id);
          result.injected++;
          result.actions.push(`Injected ${newTaskId} from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to inject ${capture.id}: "${capture.text}" (no plan file or parse error)`);
        }
        break;
      }
      case "replan": {
        const success = executeReplan(basePath, mid, sid, capture);
        if (success) {
          markCaptureExecuted(basePath, capture.id);
          result.replanned++;
          result.actions.push(`Replan triggered from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to trigger replan from ${capture.id}: "${capture.text}"`);
        }
        break;
      }
      case "quick-task": {
        // Quick-tasks are collected for dispatch, not executed inline
        result.quickTasks.push(capture);
        result.actions.push(`Quick-task queued from ${capture.id}: "${capture.text}"`);
        break;
      }
    }
  }

  // Count stop/backtrack captures — these are handled by the pre-dispatch guard
  // in runGuards(), not here. We just report them for logging purposes.
  const allCaptures = loadAllCaptures(basePath);
  for (const cap of allCaptures) {
    if (cap.status !== "resolved" || cap.executed) continue;
    if (cap.classification === "stop") {
      result.stopped++;
      result.actions.push(`Stop directive from ${cap.id}: "${cap.text}" — will pause on next dispatch`);
    } else if (cap.classification === "backtrack") {
      result.backtracks.push(cap);
      result.actions.push(`Backtrack directive from ${cap.id}: "${cap.text}" — auto-mode pauses on the next dispatch`);
    }
  }

  return result;
}
