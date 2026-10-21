// Project/App: gsd-pi
// File Purpose: Adapts shared GSD workflow handlers for MCP executor calls.

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { sanitizeCompleteMilestoneParams } from "../bootstrap/sanitize-complete-milestone.js";
import { loadWriteGateSnapshot, shouldBlockContextArtifactSaveInSnapshot, shouldBlockRootArtifactSaveInSnapshot } from "../bootstrap/write-gate.js";
import {
  applyReworkResolutions,
  getActiveRequirements,
  getAllMilestones,
  getMilestone,
  getMilestoneLifecycleShadowSnapshot,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getTask,
  getUnresolvedBlockingReworkFindingsForTask,
  insertMilestone,
  insertAssessment,
  insertGateRun,
  readTransaction,
  saveGateResult,
  setSliceUatMd,
  upsertMilestonePlanning,
  upsertQualityGate,
} from "../gsd-db.js";
import {
  buildLifecycleShadowObservation,
  type MilestoneStatusObservationContext,
} from "../lifecycle-shadow-observation.js";
export {
  MILESTONE_STATUS_OBSERVATION_TOKEN_ENV,
  readMilestoneStatusObservationTurn,
  resolveMilestoneStatusObservationContext,
  resolveMilestoneStatusObservationTokenState,
} from "../milestone-status-observation-context.js";
import { emitLifecycleShadowObservation } from "../uok/audit.js";
import { extractMilestoneSeq } from "../milestone-ids.js";
import { readMilestoneMergeObservation } from "../db/milestone-closeout-readiness.js";
import { immediateTransaction } from "../db/engine.js";
import { isClosedStatus } from "../status-guards.js";
import { GATE_REGISTRY } from "../gate-registry.js";
import { generateRequirementsMd, saveArtifactToDb } from "../db-writer.js";
import { clearPathCache, normalizeRealPath, relMilestoneFile, relSliceFile, relSlicePath, resolveGsdPathContract, resolveMilestoneFile, resolveSliceFile } from "../paths.js";
import { saveFile, clearParseCache } from "../files.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CompleteMilestoneParams } from "./complete-milestone.js";
import { handleCompleteMilestone } from "./complete-milestone.js";
import {
  handleCompleteTask,
  normalizeReworkResolution,
  resolveTaskSummaryPath,
  satisfiesBlockingReworkFinding,
  unresolvedReworkError,
} from "./complete-task.js";
import {
  recoveryRouteLever,
  resolveTaskCompletionAuthority,
  stageTaskCompletion,
} from "../task-completion-compatibility-adapter.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import type { DomainJsonValue } from "../db/domain-operation.js";
import {
  readTaskRecoveryRoute,
  resumeTaskRecovery,
  type TaskRecoveryRouteSnapshot,
} from "../task-recovery-domain-operation.js";
import {
  applyBlockerAcceptedDisposition,
  applyTaskSettle,
  planBlockerAcceptedDisposition,
  planTaskSettle,
} from "../task-settle.js";
import type { CompleteSliceParams, EscalationOption } from "../types.js";
import { handleCompleteSlice } from "./complete-slice.js";
import type { PlanMilestoneParams } from "./plan-milestone.js";
import { handlePlanMilestone } from "./plan-milestone.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import type { PlanSliceParams } from "./plan-slice.js";
import { handlePlanSlice } from "./plan-slice.js";
import type { ReplanSliceParams } from "./replan-slice.js";
import { handleReplanSlice } from "./replan-slice.js";
import type { ReplanTaskParams } from "./replan-task.js";
import { handleReplanTask } from "./replan-task.js";
import type { ReworkBriefSaveParams } from "./rework-brief.js";
import { handleReworkBriefSave } from "./rework-brief.js";
import type { ReopenMilestoneParams } from "./reopen-milestone.js";
import { handleReopenMilestone } from "./reopen-milestone.js";
import type { ReopenSliceParams } from "./reopen-slice.js";
import { handleReopenSlice } from "./reopen-slice.js";
import type { SkipSliceParams } from "./skip-slice.js";
import { handleSkipSlice } from "./skip-slice.js";
import type { ReopenTaskParams } from "./reopen-task.js";
import { handleReopenTask } from "./reopen-task.js";
import type { ReassessRoadmapParams } from "./reassess-roadmap.js";
import { handleReassessRoadmap } from "./reassess-roadmap.js";
import type { ValidateMilestoneOptions, ValidateMilestoneParams } from "./validate-milestone.js";
import { handleValidateMilestone } from "./validate-milestone.js";
import {
  answerMilestoneSubjectiveUat,
  prepareMilestoneSubjectiveUat,
  type AnswerMilestoneSubjectiveUatInput,
  type PrepareMilestoneSubjectiveUatInput,
} from "../milestone-subjective-uat-domain-operation.js";
import { logError, logWarning } from "../workflow-logger.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { parseProject } from "../schemas/parsers.js";
import { autoSession, getAutoRuntimeSnapshot, isAutoActive } from "../auto-runtime-state.js";
import { renderPlanCheckboxes, renderPlanFromDb, writeTaskSummaryProjection } from "../markdown-renderer.js";
import { readUnitHarnessAbort, type UnitHarnessAbortRecord } from "../unit-runtime.js";
import {
  prepareUatRun,
  saveUatAttemptArtifact,
  type UatResultSaveParams,
} from "../uat-run.js";
import { appendNotification } from "../notification-store.js";
import { registerAutoWorker, markWorkerStopping, getAutoWorker } from "../db/auto-workers.js";
import {
  claimMilestoneLease,
  releaseMilestoneLease,
  getMilestoneLease,
  refreshMilestoneLease,
  milestoneLeaseTtlSeconds,
} from "../db/milestone-leases.js";
export type {
  UatCheckResultInput,
  UatEvidenceRef,
  UatPresentationInput,
} from "../uat-run.js";

function removeContextDraftProjection(path: string): void {
  removeProjectionFileSync(path);
}

export const _removeContextDraftProjectionForTest = removeContextDraftProjection;

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = [
  "SUMMARY",
  "RESEARCH",
  "UI-SPEC",
  "CONTEXT",
  "ASSESSMENT",
  "CONTEXT-DRAFT",
  "PROJECT",
  "PROJECT-DRAFT",
  "REQUIREMENTS",
  "REQUIREMENTS-DRAFT",
  "UAT",
] as const;

export function isSupportedSummaryArtifactType(
  artifactType: string,
): artifactType is (typeof SUPPORTED_SUMMARY_ARTIFACT_TYPES)[number] {
  return (SUPPORTED_SUMMARY_ARTIFACT_TYPES as readonly string[]).includes(artifactType);
}

function isRootSummaryArtifactType(artifactType: string): boolean {
  return artifactType === "PROJECT" ||
    artifactType === "PROJECT-DRAFT" ||
    artifactType === "REQUIREMENTS" ||
    artifactType === "REQUIREMENTS-DRAFT";
}

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function blockIfWrongAutoUnit(requiredUnitType: string, operation: string): ToolExecutionResult | null {
  const snapshot = getAutoRuntimeSnapshot();
  if (!snapshot.active || !snapshot.currentUnit) return null;
  if (snapshot.currentUnit.type === requiredUnitType) return null;

  const error = `HARD BLOCK: Tool Contract failure: ${operation} may only run from ${requiredUnitType}; active unit is ${snapshot.currentUnit.type}. Fix unit-tool-contracts.ts or the active Unit prompt. The orchestrator owns phase transitions.`;
  return {
    content: [{ type: "text", text: error }],
    details: { operation, error },
    isError: true,
  };
}

function blockIfHarnessAbortedUnit(operation: string, basePath: string): ToolExecutionResult | null {
  const snapshot = getAutoRuntimeSnapshot();
  if (!snapshot.active || !snapshot.currentUnit) return null;

  const abort = readUnitHarnessAbort(
    snapshot.basePath || basePath,
    snapshot.currentUnit.type,
    snapshot.currentUnit.id,
    snapshot.currentUnit.startedAt,
  );
  if (!abort) return null;

  return harnessAbortResult(operation, snapshot.currentUnit.type, snapshot.currentUnit.id, abort);
}

function harnessAbortResult(
  operation: string,
  unitType: string,
  unitId: string,
  abort: UnitHarnessAbortRecord,
): ToolExecutionResult {
  const toolText = abort.toolName ? ` while calling ${abort.toolName}` : "";
  const message =
    `Retryable harness abort: ${unitType} ${unitId} was truncated by ${abort.kind}${toolText}. ` +
    "This gate result was not saved; leave the gate pending so auto-mode can rerun it.";
  return {
    content: [{ type: "text", text: message }],
    details: {
      operation,
      error: "harness_aborted_needs_retry",
      retryable: true,
      unitType,
      unitId,
      harnessAbortKind: abort.kind,
      harnessAbortReason: abort.reason,
      harnessAbortToolName: abort.toolName,
      harnessAbortCount: abort.count,
    },
    isError: true,
  };
}

function milestoneLeaseConflictResult(
  milestoneId: string,
  byWorker: string,
  expiresAt: string,
): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Milestone ${milestoneId} is currently leased by ${byWorker}. Retry after ${expiresAt}.` }],
    details: {
      operation: "plan_milestone",
      error: "milestone_lease_conflict",
      milestoneId,
      byWorker,
      expiresAt,
    },
    isError: true,
  };
}

export interface SummarySaveParams {
  milestone_id?: string;
  slice_id?: string;
  task_id?: string;
  artifact_type: string;
  content: string;
}

function adoptedMilestoneProjectionDone(milestoneId: string): boolean | null {
  const observation = readMilestoneMergeObservation(milestoneId);
  if (observation.kind === "mismatch") {
    throw new Error(
      `Milestone ${milestoneId} canonical and legacy status mismatch ` +
      `(canonical=${observation.canonicalStatus}, legacy=${observation.legacyStatus})`,
    );
  }
  if (observation.kind === "completed") return true;
  if (observation.kind === "not-completed") return false;
  return null;
}

function existingMilestonesBySequence(): Map<number, ReturnType<typeof getAllMilestones>[number]> {
  const existingBySeq = new Map<number, ReturnType<typeof getAllMilestones>[number]>();
  for (const existing of getAllMilestones()) {
    const seq = extractMilestoneSeq(existing.id);
    if (seq > 0 && !existingBySeq.has(seq)) existingBySeq.set(seq, existing);
  }
  return existingBySeq;
}

function projectMilestoneSequenceRepairNeeded(content: string): boolean {
  const existingBySeq = existingMilestonesBySequence();
  return parseProject(content).milestones.some((milestone) => {
    const canonical = existingBySeq.get(extractMilestoneSeq(milestone.id));
    if (!canonical) return false;
    const canonicalDone = adoptedMilestoneProjectionDone(canonical.id);
    return canonicalDone !== null && milestone.done !== canonicalDone;
  });
}

function registerProjectMilestoneSequence(content: string): string[] {
  return immediateTransaction(() => {
    const parsed = parseProject(content);
    const registered: string[] = [];
    // Reconcile parsed IDs against existing DB milestones before inserting (#807).
    // Under unique_milestone_ids the planner mints suffixed IDs (e.g. "M001-b1nole"),
    // while PROJECT.md's template uses bare sequence IDs (e.g. "M001"). Inserting the
    // bare ID verbatim mints a phantom milestone row that collides with the planner's
    // canonical one: the bare row gets its own git worktree, and at dispatch time the
    // worktree/session scope ("M001") disagrees with ctx.mid ("M001-b1nole"), pausing
    // auto-mode with "Dispatch milestone mismatch". A project DB holds at most one
    // milestone per sequence number, so map each parsed line onto the existing row
    // that shares its sequence number instead of minting a duplicate bare-ID row.
    const existingBySeq = existingMilestonesBySequence();
    const adoptedIds = new Set<string>();
    for (const milestone of parsed.milestones) {
      const canonical = existingBySeq.get(extractMilestoneSeq(milestone.id));
      if (!canonical) continue;
      const canonicalDone = adoptedMilestoneProjectionDone(canonical.id);
      if (canonicalDone !== null) adoptedIds.add(canonical.id);
    }

    for (const milestone of parsed.milestones) {
      const canonical = existingBySeq.get(extractMilestoneSeq(milestone.id));
      const canonicalId = canonical?.id;
      if (canonicalId && adoptedIds.has(canonicalId)) {
        upsertMilestonePlanning(canonicalId, { title: milestone.title });
        registered.push(canonicalId);
        continue;
      }
      if (canonicalId && canonicalId !== milestone.id) {
        // An existing milestone already owns this sequence number. Treat the markdown
        // line as referring to it: refresh the human title, and promote to complete
        // when the line is checked — but never demote an in-flight milestone back to
        // "queued" (the planner's row stays the single source of truth).
        upsertMilestonePlanning(canonicalId, {
          title: milestone.title,
          ...(milestone.done ? { status: "complete" } : {}),
        });
        registered.push(canonicalId);
        continue;
      }
      insertMilestone({
        id: milestone.id,
        title: milestone.title,
        status: milestone.done ? "complete" : "queued",
      });
      registered.push(milestone.id);
    }
    return registered;
  });
}

/** Minimal shape of a DB milestone row needed to re-render the sequence section. */
interface MilestoneSeqRow {
  id: string;
  title: string;
  vision: string;
  done: boolean;
}

function milestoneSequenceRows(): MilestoneSeqRow[] {
  return getAllMilestones().map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    vision: milestone.vision,
    done: adoptedMilestoneProjectionDone(milestone.id) ?? isClosedStatus(milestone.status),
  }));
}

/**
 * Best-effort recovery of the human one-liner for each milestone id from a
 * (possibly malformed) Milestone Sequence body. Deliberately lenient: tolerates
 * any separator the canonical MILESTONE_LINE_RE rejects (en-dash, " : ", a
 * missing checkbox, etc.) so a model formatting slip does not discard the prose.
 */
function recoverMilestoneTails(sequenceBody: string): Map<string, string> {
  const out = new Map<string, string>();
  const lenient = /^\s*(?:-\s*)?(?:\[[ xX]\]\s*)?(M\d{3})\b\s*[:.\-–—]*\s*(.*)$/;
  for (const rawLine of sequenceBody.split("\n")) {
    const m = rawLine.match(lenient);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const idx = trimmed.search(/[.!?](\s|$)/);
  return (idx >= 0 ? trimmed.slice(0, idx + 1) : trimmed).trim();
}

/** Render one canonical, parseable milestone line for the given DB row. */
function renderMilestoneLine(m: MilestoneSeqRow, recoveredTail: string): string {
  const done = m.done;
  let oneLiner = recoveredTail;
  // The recovered tail often still carries the title (e.g. "Foo — bar" or
  // "Foo : bar"). Strip a leading repetition of the title, then any separator.
  if (oneLiner.toLowerCase().startsWith(m.title.toLowerCase())) {
    oneLiner = oneLiner.slice(m.title.length).replace(/^\s*[:.\-–—]+\s*/, "").trim();
  } else {
    const sep = oneLiner.match(/\s+(?:—|–|--|-|:)\s+/);
    if (sep && sep.index !== undefined) oneLiner = oneLiner.slice(sep.index + sep[0].length).trim();
  }
  // MILESTONE_LINE_RE requires non-empty prose after the separator.
  if (!oneLiner) oneLiner = firstSentence(m.vision) || (done ? "Completed." : "Planned.");
  return `- [${done ? "x" : " "}] ${m.id}: ${m.title} — ${oneLiner}`;
}

/**
 * Rebuild the "## Milestone Sequence" section from authoritative DB rows when a
 * model-authored PROJECT.md projection parsed to zero milestone lines but the DB
 * already holds milestones. The DB is the source of truth (markdown is a
 * projection), so this repairs the projection rather than failing the save.
 * Preserves a leading HTML comment in the section and recovers one-liners
 * best-effort. The returned content parses cleanly under MILESTONE_LINE_RE.
 */
function rebuildMilestoneSequenceSection(content: string, milestones: MilestoneSeqRow[]): string {
  const lines = content.split("\n");
  const headerIdx = lines.findIndex(l => /^##\s+Milestone Sequence\s*$/.test(l));

  const canonicalLines = (() => {
    // Recover tails from the existing (malformed) body when the section exists.
    let body = "";
    if (headerIdx !== -1) {
      let end = headerIdx + 1;
      while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
      body = lines.slice(headerIdx + 1, end).join("\n");
    }
    const tails = recoverMilestoneTails(body);
    return milestones.map((m) => {
      const bareId = `M${String(extractMilestoneSeq(m.id)).padStart(3, "0")}`;
      return renderMilestoneLine(m, tails.get(m.id) ?? tails.get(bareId) ?? "");
    });
  })();

  if (headerIdx === -1) {
    // No section at all — append a fresh, canonical one.
    const sep = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}\n## Milestone Sequence\n\n${canonicalLines.join("\n")}\n`;
  }

  let bodyEnd = headerIdx + 1;
  while (bodyEnd < lines.length && !/^##\s+/.test(lines[bodyEnd])) bodyEnd++;
  const existingBody = lines.slice(headerIdx + 1, bodyEnd);

  // Preserve a contiguous leading HTML comment block (the "Check off…" hint).
  let i = 0;
  while (i < existingBody.length && existingBody[i].trim() === "") i++;
  const preserved: string[] = [];
  if (i < existingBody.length && existingBody[i].trim().startsWith("<!--")) {
    while (i < existingBody.length) {
      preserved.push(existingBody[i]);
      const closed = existingBody[i].includes("-->");
      i++;
      if (closed) break;
    }
  }

  return [
    ...lines.slice(0, headerIdx + 1),
    "",
    ...(preserved.length ? [...preserved, ""] : []),
    ...canonicalLines,
    "",
    ...lines.slice(bodyEnd),
  ].join("\n");
}

async function mirrorArtifactToActiveWorktreeProjection(
  basePath: string,
  relativePath: string,
  content: string,
  required: boolean = false,
): Promise<void> {
  const contract = resolveGsdPathContract(basePath);
  if (!contract.worktreeGsd) return;
  if (contract.worktreeGsd === contract.projectGsd) return;

  const fullPath = join(contract.worktreeGsd, relativePath);
  try {
    await saveFile(fullPath, content);
    clearPathCache();
    clearParseCache();
    invalidateStateCache();
  } catch (err) {
    logWarning("tool", `gsd_summary_save worktree projection mirror failed: ${(err as Error).message}`, {
      path: relativePath,
    });
    if (required) throw err;
  }
}

export async function executeSummarySave(
  params: SummarySaveParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot save artifact." }],
      details: { operation: "save_summary", error: "db_unavailable" },
    isError: true,
      };
  }
  if (!isSupportedSummaryArtifactType(params.artifact_type)) {
    return {
      content: [{ type: "text", text: `Error: Invalid artifact_type "${params.artifact_type}". Must be one of: ${SUPPORTED_SUMMARY_ARTIFACT_TYPES.join(", ")}` }],
      details: { operation: "save_summary", error: "invalid_artifact_type" },
    isError: true,
      };
  }
  if (!isRootSummaryArtifactType(params.artifact_type) && !params.milestone_id) {
    return {
      content: [{ type: "text", text: `Error: milestone_id is required for artifact_type "${params.artifact_type}". Root-level artifacts must use PROJECT, PROJECT-DRAFT, REQUIREMENTS, or REQUIREMENTS-DRAFT.` }],
      details: { operation: "save_summary", error: "missing_milestone_id" },
      isError: true,
    };
  }
  if (params.artifact_type === "UAT" && !params.slice_id) {
    return {
      content: [{ type: "text", text: `Error: slice_id is required for artifact_type "UAT". UAT saves are slice-scoped and persist to the slice's UAT record (full_uat_md).` }],
      details: { operation: "save_summary", error: "missing_slice_id" },
      isError: true,
    };
  }
  if (params.artifact_type === "UAT" && params.task_id) {
    return {
      content: [{ type: "text", text: `Error: task_id is not supported for artifact_type "UAT". UAT saves are slice-scoped; omit task_id.` }],
      details: { operation: "save_summary", error: "unexpected_task_id" },
      isError: true,
    };
  }
  const writeGateSnapshot = loadWriteGateSnapshot(basePath);
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
  const rootArtifactGuard = shouldBlockRootArtifactSaveInSnapshot(
    writeGateSnapshot,
    params.artifact_type,
    { requireVerifiedApproval: prefs?.planning_depth === "deep" },
  );
  if (rootArtifactGuard.block) {
    return {
      content: [{ type: "text", text: `Error saving artifact: ${rootArtifactGuard.reason ?? "root artifact write blocked"}` }],
      details: {
        operation: "save_summary",
        error: "root_artifact_write_blocked",
        displayReason: "Approval confirmation required before saving final project setup artifacts.",
      },
      isError: true,
    };
  }
  const contextGuard = shouldBlockContextArtifactSaveInSnapshot(
    writeGateSnapshot,
    params.artifact_type,
    params.milestone_id ?? null,
    params.slice_id ?? null,
  );
  if (contextGuard.block) {
    return {
      content: [{ type: "text", text: `Error saving artifact: ${contextGuard.reason ?? "context write blocked"}` }],
      details: {
        operation: "save_summary",
        error: "context_write_blocked",
        displayReason: "Depth check required before writing milestone context.",
      },
      isError: true,
    };
  }
  try {
    let relativePath: string;
    if (params.artifact_type === "PROJECT") {
      relativePath = "PROJECT.md";
    } else if (params.artifact_type === "PROJECT-DRAFT") {
      relativePath = "PROJECT-DRAFT.md";
    } else if (params.artifact_type === "REQUIREMENTS") {
      relativePath = "REQUIREMENTS.md";
    } else if (params.artifact_type === "REQUIREMENTS-DRAFT") {
      relativePath = "REQUIREMENTS-DRAFT.md";
    } else if (params.task_id && params.slice_id) {
      // Layout-aware path for task-scoped artifacts.
      // Flat-phase: <phaseDir>/TID-TYPE.md  Legacy: milestones/MID/slices/SID/tasks/TID-TYPE.md
      // relSlicePath returns ".gsd/phases/NN-slug" (flat) or ".gsd/milestones/MID/slices/SID" (legacy).
      const sRel = relSlicePath(basePath, params.milestone_id!, params.slice_id).replace(/^\.gsd\//, "");
      relativePath = sRel.startsWith("milestones/")
        ? `${sRel}/tasks/${params.task_id}-${params.artifact_type}.md`
        : `${sRel}/${params.task_id}-${params.artifact_type}.md`;
    } else if (params.slice_id) {
      // Layout-aware path for slice-scoped artifacts.
      // relSliceFile returns ".gsd/..." prefix — strip it to get the DB-relative path.
      relativePath = relSliceFile(basePath, params.milestone_id!, params.slice_id, params.artifact_type).replace(/^\.gsd\//, "");
    } else {
      // Layout-aware path for milestone-scoped artifacts.
      // relMilestoneFile returns ".gsd/..." prefix — strip it to get the DB-relative path.
      relativePath = relMilestoneFile(basePath, params.milestone_id!, params.artifact_type).replace(/^\.gsd\//, "");
    }

    const activeRequirements = params.artifact_type === "REQUIREMENTS"
      ? getActiveRequirements()
      : null;
    if (params.artifact_type === "REQUIREMENTS" && activeRequirements?.length === 0) {
      return {
        content: [{ type: "text", text: "Error: Cannot save REQUIREMENTS artifact — no active requirements found in the database. Call gsd_requirement_save for each requirement before calling gsd_summary_save(REQUIREMENTS)." }],
        details: { operation: "save_summary", error: "no_active_requirements" },
        isError: true,
      };
    }

    let contentToSave = params.artifact_type === "REQUIREMENTS"
      ? generateRequirementsMd(activeRequirements ?? [])
      : params.content;
    const contentSource = params.artifact_type === "REQUIREMENTS"
      ? "requirements_table"
      : "provided_content";
    const isRootArtifact = isRootSummaryArtifactType(params.artifact_type);
    let registeredMilestones: string[] = [];
    let milestoneSequenceSelfHealed = false;
    let projectRegistrationContent: string | null = null;
    if (params.artifact_type === "PROJECT") {
      const parsedMilestones = parseProject(contentToSave).milestones;
      projectRegistrationContent = contentToSave;
      try {
        const repairNeeded = projectMilestoneSequenceRepairNeeded(contentToSave);
        if (repairNeeded || parsedMilestones.length === 0) {
          const existingMilestones = milestoneSequenceRows();
          if (existingMilestones.length === 0) {
            // Genuine first-save failure: no milestones parsed AND none in the DB.
            // /gsd really would report "No Active Milestone" — hard-fail so the
            // caller rewrites the sequence before proceeding.
            logError("tool", "gsd_summary_save: PROJECT.md parsed zero milestones and the DB has no rows", {
              tool: "gsd_summary_save",
            });
            return {
              content: [{
                type: "text",
                text:
                  "Error: PROJECT.md contains zero parseable milestone lines, so no milestones were registered in the DB. " +
                  "/gsd will report \"No Active Milestone\". Rewrite the \"Milestone Sequence\" section using canonical lines: " +
                  `\`- [ ] M001: <Title> — <One-liner>\` (em-dash, double-dash \`--\`, or single-dash \`-\` separator), then re-call gsd_summary_save(PROJECT).`,
              }],
              details: {
                operation: "save_summary",
                path: relativePath,
                artifact_type: params.artifact_type,
                error: "milestone_registration_empty_parse",
              },
              isError: true,
            };
          }

          const repairReason = repairNeeded
            ? "Milestone Sequence disagrees with adopted DB lifecycle state"
            : "Milestone Sequence parsed zero milestone lines";
          logWarning("tool", `gsd_summary_save: PROJECT.md ${repairReason}; DB has ${existingMilestones.length} — rebuilding from DB (projection self-heal)`, {
            tool: "gsd_summary_save",
            path: relativePath,
          });
          if (parsedMilestones.length === 0) {
            registeredMilestones = existingMilestones.map((milestone) => milestone.id);
            projectRegistrationContent = null;
          }
          contentToSave = rebuildMilestoneSequenceSection(contentToSave, existingMilestones);
          milestoneSequenceSelfHealed = true;
        }
      } catch (healErr) {
        const msg = healErr instanceof Error ? healErr.message : String(healErr);
        logError("tool", `gsd_summary_save: PROJECT preflight or Milestone Sequence repair failed: ${msg}`, {
          tool: "gsd_summary_save",
          path: relativePath,
          error: msg,
        });
        return {
          content: [{
            type: "text",
            text:
              `Error: PROJECT.md was not saved because its Milestone Sequence could not be reconciled with DB lifecycle state: ${msg}. ` +
              `Rewrite PROJECT.md so the "Milestone Sequence" section uses canonical lines: ` +
              `\`- [ ] M001: <Title> — <One-liner>\`, then re-call gsd_summary_save(PROJECT).`,
          }],
          details: {
            operation: "save_summary",
            path: relativePath,
            artifact_type: params.artifact_type,
            error: "milestone_sequence_self_heal_failed",
            self_heal_error: msg,
          },
          isError: true,
        };
      }
    }

    if (params.artifact_type === "PROJECT") {
      try {
        if (projectRegistrationContent !== null) {
          registeredMilestones = registerProjectMilestoneSequence(projectRegistrationContent);
        }
        if (registeredMilestones.length === 0) {
          throw new Error("PROJECT.md parsed zero milestone lines after preflight");
        }
        invalidateStateCache();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("tool", `gsd_summary_save: PROJECT milestone registration failed before persistence: ${msg}`, {
          tool: "gsd_summary_save",
          error: String(err),
          stack: err instanceof Error ? err.stack ?? "" : "",
        });
        return {
          content: [{
            type: "text",
            text:
              `Error: PROJECT.md was not saved because milestone registration failed: ${msg}. ` +
              `The registration transaction was rolled back; resolve the underlying error and re-call gsd_summary_save(PROJECT). ` +
              `INSERT OR IGNORE keeps the retry idempotent.`,
          }],
          details: {
            operation: "save_summary",
            path: relativePath,
            artifact_type: params.artifact_type,
            error: "milestone_registration_threw",
            registration_error: msg,
          },
          isError: true,
        };
      }
    }

    const isTaskSummary = params.artifact_type === "SUMMARY" && !!params.milestone_id && !!params.slice_id && !!params.task_id;
    let projectedContent = contentToSave;
    if (isTaskSummary) {
      const contract = resolveGsdPathContract(basePath);
      const projection = await writeTaskSummaryProjection(
        contract.projectRoot,
        params.milestone_id!,
        params.slice_id!,
        params.task_id!,
        contentToSave,
      );
      relativePath = projection.artifactPath;
      projectedContent = projection.content;
    } else {
      if (params.artifact_type === "UAT") {
        // UAT must land in the slice's UAT carrier (full_uat_md), never the
        // summary carrier: after slice completion the UAT projection re-renders
        // from this column, so post-completion corrections survive flushes.
        const updated = setSliceUatMd(params.milestone_id!, params.slice_id!, contentToSave);
        if (!updated) {
          return {
            content: [{ type: "text", text: `Error: no slice "${params.slice_id}" found in milestone "${params.milestone_id}". UAT saves require an existing slice row.` }],
            details: { operation: "save_summary", error: "slice_not_found" },
            isError: true,
          };
        }
      }
      await saveArtifactToDb(
        {
          path: relativePath,
          artifact_type: params.artifact_type,
          content: contentToSave,
          milestone_id: isRootArtifact ? undefined : params.milestone_id,
          slice_id: isRootArtifact ? undefined : params.slice_id,
          task_id: isRootArtifact ? undefined : params.task_id,
        },
        basePath,
      );
    }
    await mirrorArtifactToActiveWorktreeProjection(basePath, relativePath, projectedContent, isTaskSummary);

    if (params.artifact_type === "CONTEXT" && !params.task_id) {
      try {
        const draftFile = params.slice_id
          ? resolveSliceFile(basePath, params.milestone_id!, params.slice_id, "CONTEXT-DRAFT")
          : resolveMilestoneFile(basePath, params.milestone_id!, "CONTEXT-DRAFT");
        if (draftFile) removeContextDraftProjection(draftFile);
      } catch (e) {
        logWarning("tool", `CONTEXT-DRAFT.md unlink failed: ${(e as Error).message}`);
      }
    }

    return {
      content: [{ type: "text", text: `Saved ${params.artifact_type} artifact to ${relativePath}` }],
      details: {
        operation: "save_summary",
        path: relativePath,
        artifact_type: params.artifact_type,
        content_source: contentSource,
        ...(registeredMilestones.length > 0 ? { registeredMilestones } : {}),
        ...(milestoneSequenceSelfHealed ? { milestoneSequenceSelfHealed: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_summary_save tool failed: ${msg}`, { tool: "gsd_summary_save", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving artifact: ${msg}` }],
      details: { operation: "save_summary", error: msg },
    isError: true,
      };
  }
}

type VerificationEvidenceInput =
  | {
      command: string;
      exitCode: number;
      verdict: string;
      durationMs: number;
    }
  | string;

interface TaskEscalationInput {
  question: string;
  options: EscalationOption[];
  recommendation: string;
  recommendationRationale: string;
  continueWithDefault: boolean;
}

export interface TaskCompleteParams {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  oneLiner: string;
  narrative: string;
  verification?: string;
  deviations?: string;
  knownIssues?: string;
  failureModes?: string;
  loadProfile?: string;
  negativeTests?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  blockerDiscovered?: boolean;
  escalation?: TaskEscalationInput;
  verificationEvidence?: VerificationEvidenceInput[];
  reworkResolution?: Array<{
    findingId: string;
    status: "resolved" | "deferred-with-override";
    evidence: string;
    decisionRef?: string;
  }>;
}

type NormalizedVerificationEvidence = {
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
};

function normalizeVerificationEvidence(
  evidence: VerificationEvidenceInput[] | undefined,
): NormalizedVerificationEvidence[] {
  return (evidence ?? []).map((entry) =>
    typeof entry === "string"
      ? { command: entry, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 }
      : entry,
  );
}

function deriveVerificationSummary(
  evidence: NormalizedVerificationEvidence[],
): string | null {
  if (evidence.length === 0) return null;

  const rendered = evidence.slice(0, 3).map((entry) => {
    const command = entry.command.trim() || "(unspecified command)";
    const verdict = entry.verdict.trim() || "recorded";
    return `\`${command}\` exited ${entry.exitCode} (${verdict})`;
  });
  const suffix = evidence.length > rendered.length
    ? `; ${evidence.length - rendered.length} more check(s) recorded`
    : "";

  return `Verification evidence recorded: ${rendered.join("; ")}${suffix}.`;
}

export type CompleteMilestoneExecutorParams = Partial<CompleteMilestoneParams> & Record<string, unknown>;
export type SliceCompleteExecutorParams = CompleteSliceParams;
export type PlanMilestoneExecutorParams = PlanMilestoneParams;
export type PlanSliceExecutorParams = PlanSliceParams;
export type ReplanSliceExecutorParams = ReplanSliceParams;
export type ReplanTaskExecutorParams = ReplanTaskParams;
export type ReworkBriefSaveExecutorParams = ReworkBriefSaveParams;
export type ReopenTaskExecutorParams = ReopenTaskParams;
export interface TaskRecoveryResumeExecutorParams {
  recoveryActionId: string;
  repairSummary: string;
  evidence: Record<string, DomainJsonValue>;
}
export interface TaskSettleExecutorParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  reason: string;
  apply?: boolean;
  reconcileLifecycle?: boolean;
  /** #2202: operator closeout disposition for a discovered blocker. */
  settleDisposition?: "blocker-accepted";
}
export type ReopenSliceExecutorParams = ReopenSliceParams;
export type SkipSliceExecutorParams = SkipSliceParams;
export type ReopenMilestoneExecutorParams = ReopenMilestoneParams;
export type ValidateMilestoneExecutorParams = ValidateMilestoneParams;
export type PrepareMilestoneSubjectiveUatExecutorParams = Omit<
  PrepareMilestoneSubjectiveUatInput,
  "invocation"
>;
export type AnswerMilestoneSubjectiveUatExecutorParams = Omit<
  AnswerMilestoneSubjectiveUatInput,
  "invocation"
>;
export type ReassessRoadmapExecutorParams = ReassessRoadmapParams;

export interface SaveGateResultParams {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string;
  verdict: "pass" | "flag" | "omitted";
  rationale: string;
  findings?: string;
}

export type { UatResultSaveParams };

export async function executeTaskComplete(
  params: TaskCompleteParams,
  basePath: string = process.cwd(),
  invocation?: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete task." }],
      details: { operation: "complete_task", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const coerced = { ...params };
    const verificationEvidence = normalizeVerificationEvidence(params.verificationEvidence);
    coerced.verificationEvidence = verificationEvidence;

    const verification = typeof params.verification === "string" ? params.verification.trim() : "";
    if (verification.length === 0) {
      const derived = deriveVerificationSummary(verificationEvidence);
      if (derived) {
        coerced.verification = derived;
      } else if (params.blockerDiscovered === true) {
        coerced.verification = "Not run: blocker discovered before verification.";
      } else {
        // A model that fires several parallel gsd_task_complete calls for the
        // same task in one turn typically sends one well-formed call plus
        // malformed duplicates. Failing those closed produces spurious
        // error-trace anomalies for a task that actually completed, so when the
        // task is already closed in current DB state, unwind the duplicate as an
        // idempotent success pointing at the existing summary instead (#1569).
        const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
        if (existingTask && isClosedStatus(existingTask.status)) {
          const summaryPath = resolveTaskSummaryPath(
            basePath,
            params.milestoneId,
            params.sliceId,
            params.taskId,
          );
          return {
            content: [{
              type: "text",
              text: `Task ${params.taskId} (${params.sliceId}/${params.milestoneId}) is already complete; ignoring duplicate completion call. Summary: ${summaryPath}`,
            }],
            details: {
              operation: "complete_task",
              taskId: params.taskId,
              sliceId: params.sliceId,
              milestoneId: params.milestoneId,
              summaryPath,
              duplicate: true,
            },
          };
        }
        return {
          content: [{
            type: "text",
            text: "Error completing task: verification is required unless verificationEvidence is provided or blockerDiscovered is true.",
          }],
          details: { operation: "complete_task", error: "verification_required" },
          isError: true,
        };
      }
    }

    const task = {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
    };
    const authority = resolveTaskCompletionAuthority(task, invocation?.idempotencyKey, {
      blockerReport: params.blockerDiscovered === true,
    });
    if (authority === "canonical") {
      if (!invocation) {
        throw new Error("Canonical Task completion requires private invocation identity");
      }
      if (params.escalation) {
        // The durable completion adapter cannot yet record escalation
        // artifacts. Rather than dead-ending the closeout, mirror the legacy
        // escalation gating (see handleCompleteTask): escalation is only
        // honored when phases.mid_execution_escalation is enabled. When it is
        // disabled (the default), the legacy path drops a soft escalation
        // (continueWithDefault !== false) with a warning and completes the
        // task — so do the same here instead of throwing. Only cases the
        // legacy path would actually honor (escalation enabled) or reject (a
        // hard blocker with escalation disabled) have no canonical equivalent
        // yet, so those still surface the unsupported error.
        const escalationEnabled =
          loadEffectiveGSDPreferences(basePath)?.preferences?.phases?.mid_execution_escalation === true;
        const hardBlocker = params.escalation.continueWithDefault === false;
        if (escalationEnabled || hardBlocker) {
          throw new Error("Canonical Task completion escalation is not yet supported by the durable completion adapter");
        }
        logWarning(
          "tool",
          `complete_task received escalation payload but phases.mid_execution_escalation is not enabled; ignoring on the canonical completion path (${params.milestoneId}/${params.sliceId}/${params.taskId})`,
        );
      }
      // Mirror the legacy blocking rework gate (handleCompleteTask) onto the
      // canonical path (#2231): an unresolved blocking finding rejects the
      // closeout unless covered by a satisfying reworkResolution.
      const reworkResolutions = normalizeReworkResolution(params);
      const resolvedFindingIds = new Set(
        reworkResolutions
          .filter(satisfiesBlockingReworkFinding)
          .map((resolution) => resolution.findingId),
      );
      const missingFindingIds = getUnresolvedBlockingReworkFindingsForTask(
        params.milestoneId,
        params.sliceId,
        params.taskId,
      )
        .filter((finding) => !resolvedFindingIds.has(finding.finding_id))
        .map((finding) => finding.finding_id);
      if (missingFindingIds.length > 0) {
        throw new Error(unresolvedReworkError(missingFindingIds));
      }
      // Apply before staging: stageTaskCompletion settles the Attempt and then
      // renders projections, so a post-staging apply could be skipped by a
      // projection throw and leave a succeeded Attempt with pending findings.
      // Applied first, every failure state is benign — if staging throws, the
      // worker-attested resolutions stand and a retry passes the gate (findings
      // no longer pending) with an idempotent no-op apply.
      const resolutionsToApply = reworkResolutions.filter(satisfiesBlockingReworkFinding);
      if (resolutionsToApply.length > 0) {
        applyReworkResolutions(resolutionsToApply);
      }
      const staged = await stageTaskCompletion({
        invocation,
        basePath,
        task,
        completion: {
          oneLiner: params.oneLiner,
          narrative: params.narrative,
          verification: String(coerced.verification),
          deviations: params.deviations ?? "None.",
          knownIssues: params.knownIssues ?? "None.",
          failureModes: params.failureModes ?? "",
          loadProfile: params.loadProfile ?? "",
          negativeTests: params.negativeTests ?? "",
          keyFiles: params.keyFiles ?? [],
          keyDecisions: params.keyDecisions ?? [],
          blockerDiscovered: params.blockerDiscovered ?? false,
          verificationEvidence,
        },
      });
      // A routed blocker must leave the worker with the recoveryActionId that
      // gsd_task_recovery_resume requires instead of forcing it to guess ids
      // or read the database (#2267). Best-effort: a fresh blocker report
      // precedes recovery routing, so no action exists yet and the plain
      // routing notice stands.
      let recoveryRoute: TaskRecoveryRouteSnapshot | null = null;
      if (staged.nextStage === "route") {
        try {
          recoveryRoute = readTaskRecoveryRoute(staged.attemptId);
        } catch {
          recoveryRoute = null;
        }
      }
      return {
        content: [{
          type: "text",
          text: staged.nextStage === "verify"
            ? `Staged task ${params.taskId}; awaiting host verification before completion.`
            : `Recorded blocker for task ${params.taskId}; awaiting recovery routing.${
              recoveryRoute ? recoveryRouteLever(recoveryRoute) : ""
            }`,
        }],
        details: {
          operation: "complete_task",
          taskId: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          attemptId: staged.attemptId,
          resultId: staged.resultId,
          summaryPath: staged.summaryPath,
          nextStage: staged.nextStage,
          ...(recoveryRoute ? {
            recoveryActionId: recoveryRoute.recoveryActionId,
            action: recoveryRoute.action,
            ...(recoveryRoute.resumeEligibility
              ? { resumeEligible: recoveryRoute.resumeEligibility.eligible }
              : {}),
          } : {}),
        },
      };
    }

    const result = await handleCompleteTask(coerced as any, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing task: ${result.error}` }],
        details: { operation: "complete_task", error: result.error },
      isError: true,
      };
    }
    const projectionNotice = result.stale
      ? "The readable status update is pending repair."
      : null;
    if (result.escalation) {
      const recommended = result.escalation.options.find((option) => option.id === result.escalation?.recommendation);
      const optionIds = result.escalation.options.map((option) => option.id).join("|");
      return {
        content: [{
          type: "text",
          text: [
            `Task completed with escalation decision required: ${result.escalation.question}`,
            `Recommendation: ${result.escalation.recommendation}${recommended ? ` (${recommended.label})` : ""} — ${result.escalation.recommendationRationale}`,
            `Resolve with: /gsd escalate resolve ${result.taskId} <${optionIds}|accept|reject-blocker> [rationale...]`,
            ...(projectionNotice ? [projectionNotice] : []),
          ].join("\n"),
        }],
        details: {
          operation: "complete_task",
          taskId: result.taskId,
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          summaryPath: result.summaryPath,
          escalation: result.escalation,
          ...(result.stale ? { stale: true } : {}),
          ...(result.duplicate ? { duplicate: true } : {}),
        },
      };
    }
    return {
      content: [{
        type: "text",
        text: `Completed task ${result.taskId} (${result.sliceId}/${result.milestoneId})${projectionNotice ? `. ${projectionNotice}` : ""}`,
      }],
      details: {
        operation: "complete_task",
        taskId: result.taskId,
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        ...(result.stale ? { stale: true } : {}),
        ...(result.duplicate ? { duplicate: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_task tool failed: ${msg}`, { tool: "gsd_task_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing task: ${msg}` }],
      details: { operation: "complete_task", error: msg },
    isError: true,
      };
  }
}

export async function executeTaskReopen(
  params: ReopenTaskExecutorParams,
  basePath: string = process.cwd(),
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen task." }],
      details: { operation: "reopen_task", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = await handleReopenTask(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening task: ${result.error}` }],
        details: { operation: "reopen_task", error: result.error },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Reopened task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      details: {
        operation: "reopen_task",
        taskId: result.taskId,
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_task tool failed: ${msg}`, { tool: "gsd_task_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening task: ${msg}` }],
      details: { operation: "reopen_task", error: msg },
      isError: true,
    };
  }
}

export async function executeTaskRecoveryResume(
  params: TaskRecoveryResumeExecutorParams,
  basePath: string = process.cwd(),
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot resume task recovery." }],
      details: { operation: "task_recovery_resume", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = resumeTaskRecovery({ invocation, ...params });
    return {
      content: [{
        type: "text",
        text:
          `Authorized one repaired Task continuation for ${result.attemptId}. ` +
          `Queued durable continuation ${result.workCheckpointId} for recovery action ${result.recoveryActionId} — ` +
          "the next execute-task dispatch of this Task atomically claims the successor Attempt (one-shot); " +
          "re-enter `/gsd auto` to consume it.",
      }],
      details: { operation: "task_recovery_resume", ...result },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `task recovery resume failed: ${msg}`, {
      tool: "gsd_task_recovery_resume",
      error: String(err),
    });
    return {
      content: [{ type: "text", text: `Error resuming task recovery: ${msg}` }],
      details: { operation: "task_recovery_resume", error: msg },
      isError: true,
    };
  }
}

export async function executeTaskSettle(
  params: TaskSettleExecutorParams,
  basePath: string = process.cwd(),
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot settle task attempt." }],
      details: { operation: "task_settle", error: "db_unavailable" },
      isError: true,
    };
  }
  const task = {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
  };
  const unit = `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
  const settleOptions = { reconcileLifecycle: params.reconcileLifecycle === true };
  const blockerAccepted = params.settleDisposition === "blocker-accepted";
  if (blockerAccepted && settleOptions.reconcileLifecycle) {
    return {
      content: [{
        type: "text",
        text: "Error settling task attempt: settleDisposition 'blocker-accepted' and reconcileLifecycle are mutually exclusive — blocker-accepted closes the Task terminal without adopting ready/completed.",
      }],
      details: { operation: "task_settle", error: "conflicting-disposition" },
      isError: true,
    };
  }
  try {
    if (blockerAccepted) {
      if (!params.apply) {
        const plan = planBlockerAcceptedDisposition(task, params.reason);
        if (plan.alreadyAccepted) {
          return {
            content: [{ type: "text", text: `gsd_task_settle (dry run): ${unit} is already closed as blocker-accepted — nothing to do.` }],
            details: { operation: "task_settle", dryRun: true, settleDisposition: "blocker-accepted", rows: [], alreadyAccepted: true },
          };
        }
        const row = plan.rows[0];
        const lines = [
          `  lifecycle ${row.lifecycleFrom} → blocker-accepted (terminal; legacy tasks.status ${row.currentStatus} → blocker-accepted)`,
          `  attempt ${row.attemptId} Result ${row.resultId} preserved as history — route Kernel head consumed with a closeout decision`,
          `  provenance: ${row.blockerSummary || "(failed Result carries no summary)"}` +
            `${row.supersededRecoveryActionId ? `; supersedes Recovery Action ${row.supersededRecoveryActionId}` : ""}`,
          `  next: gsd_replan_slice with blockerTaskId ${task.taskId} — replan the remaining work without re-executing this Task`,
        ];
        return {
          content: [{
            type: "text",
            text: `gsd_task_settle (dry run) — blocker-accepted disposition, no changes made:\n${lines.join("\n")}\nRe-run with apply: true to accept the blocker.`,
          }],
          details: {
            operation: "task_settle",
            dryRun: true,
            settleDisposition: "blocker-accepted",
            rows: plan.rows,
          },
        };
      }
      const result = applyBlockerAcceptedDisposition({
        invocation,
        task,
        reason: params.reason,
      });
      if (result.alreadyAccepted) {
        return {
          content: [{ type: "text", text: `gsd_task_settle: ${unit} is already closed as blocker-accepted — nothing to do.` }],
          details: {
            operation: "task_settle",
            dryRun: false,
            settleDisposition: "blocker-accepted",
            accepted: false,
            alreadyAccepted: true,
          },
        };
      }
      return {
        content: [{
          type: "text",
          text:
            `Accepted blocker for ${unit}: Task closed as blocker-accepted; Attempt ${result.attemptId} and its failed Result remain history and the route head is consumed (no re-route). ` +
            `Replan with gsd_replan_slice (blockerTaskId ${task.taskId}) — the Task will not execute again.`,
        }],
        details: {
          operation: "task_settle",
          dryRun: false,
          settleDisposition: "blocker-accepted",
          accepted: true,
          attemptId: result.attemptId,
          resultId: result.resultId,
          routeConsumed: result.routeConsumed,
        },
      };
    }
    if (!params.apply) {
      const plan = planTaskSettle(task, params.reason, settleOptions);
      if (plan.rows.length === 0 && plan.lifecycleRows.length === 0) {
        return {
          content: [{ type: "text", text: `gsd_task_settle (dry run): ${unit} has no running Attempt — nothing to do.` }],
          details: { operation: "task_settle", dryRun: true, rows: [], lifecycleRows: [] },
        };
      }
      const lines = [
        ...plan.rows.map(
          (row) => `  attempt ${row.attemptId}: ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...plan.lifecycleRows.map(
          (row) => `  lifecycle ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...(plan.proof ? [`  proof: ${plan.proof.note}`] : []),
      ];
      return {
        content: [{
          type: "text",
          text: `gsd_task_settle (dry run) — no changes made:\n${lines.join("\n")}\nRe-run with apply: true to settle.`,
        }],
        details: {
          operation: "task_settle",
          dryRun: true,
          rows: plan.rows,
          lifecycleRows: plan.lifecycleRows,
        },
      };
    }
    const result = applyTaskSettle({
      invocation,
      task,
      reason: params.reason,
      ...settleOptions,
    });
    if (!result.settled && !result.reconciled) {
      return {
        content: [{ type: "text", text: `gsd_task_settle: ${unit} has no running Attempt — nothing to do.` }],
        details: {
          operation: "task_settle",
          dryRun: false,
          rows: [],
          lifecycleRows: [],
          settled: false,
          reconciled: false,
        },
      };
    }
    const parts: string[] = [];
    if (result.settled) {
      parts.push(`Settled Attempt ${result.rows[0].attemptId} as interrupted (${unit}).`);
    }
    if (result.reconciled) {
      const target = result.lifecycleRows[result.lifecycleRows.length - 1]?.targetStatus;
      parts.push(`Reconciled lifecycle to ${target} (${unit}) without deleting SUMMARYs.`);
    }
    if (result.proof) {
      parts.push(result.proof.note);
    }
    return {
      content: [{ type: "text", text: parts.join(" ") }],
      details: {
        operation: "task_settle",
        dryRun: false,
        settled: result.settled,
        reconciled: result.reconciled,
        ...(result.settled
          ? { attemptId: result.rows[0].attemptId, resultId: result.resultId }
          : {}),
        lifecycleRows: result.lifecycleRows,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `task settle failed: ${msg}`, {
      tool: "gsd_task_settle",
      error: String(err),
    });
    return {
      content: [{ type: "text", text: `Error settling task attempt: ${msg}` }],
      details: { operation: "task_settle", error: msg },
      isError: true,
    };
  }
}

export async function executeSliceReopen(
  params: ReopenSliceExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen slice." }],
      details: { operation: "reopen_slice", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = await handleReopenSlice(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening slice: ${result.error}` }],
        details: { operation: "reopen_slice", error: result.error },
        isError: true,
      };
    }
    if (result.superseded) {
      return {
        content: [{ type: "text", text: `Reused a historical reopen receipt for slice ${result.sliceId} (${result.milestoneId}); it is no longer current.` }],
        details: {
          operation: "reopen_slice",
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          tasksReset: result.tasksReset,
          duplicate: true,
          superseded: true,
        },
      };
    }
    const projectionNotice = result.stale ? " The readable status update is pending repair." : "";
    return {
      content: [{ type: "text", text: `Reopened slice ${result.sliceId} (${result.milestoneId}).${projectionNotice}` }],
      details: {
        operation: "reopen_slice",
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        tasksReset: result.tasksReset,
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.stale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_slice tool failed: ${msg}`, { tool: "gsd_slice_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening slice: ${msg}` }],
      details: { operation: "reopen_slice", error: msg },
      isError: true,
    };
  }
}

export async function executeSkipSlice(
  params: SkipSliceExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot skip slice." }],
      details: { operation: "skip_slice", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = handleSkipSlice(params, invocation);
    if (result.error) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        details: {
          operation: "skip_slice",
          error: result.error,
          errorCode: result.errorCode ?? "skip_failed",
        },
        isError: true,
      };
    }
    if (result.superseded) {
      return {
        content: [{ type: "text", text: `Reused a historical cancellation receipt for slice ${result.sliceId} (${result.milestoneId}); it is no longer current.` }],
        details: {
          operation: "skip_slice",
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          duplicate: true,
          superseded: true,
        },
      };
    }

    invalidateStateCache();
    let projectionStale = false;
    try {
      const { rebuildState } = await import("../doctor.js");
      await rebuildState(basePath);
    } catch (err) {
      projectionStale = true;
      logError("tool", `skip_slice rebuildState failed: ${(err as Error).message}`, { tool: "gsd_skip_slice" });
    }
    try {
      const flushed = await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      projectionStale ||= flushed.stale;
    } catch (err) {
      projectionStale = true;
      logError("tool", `skip_slice projection flush failed: ${(err as Error).message}`, { tool: "gsd_skip_slice" });
    }

    let suffix = ` Cascaded ${result.tasksSkipped} task(s) to skipped. Auto-mode will advance past this slice.`;
    if (result.wasAlreadySkipped) {
      if (result.tasksSkipped > 0) {
        suffix = ` (already skipped; cascaded ${result.tasksSkipped} leftover task(s) to skipped).`;
      } else {
        suffix = " (already skipped; no pending tasks to cascade).";
      }
    }
    const projectionNotice = projectionStale ? " The readable status update is pending repair." : "";
    return {
      content: [{
        type: "text",
        text: `Skipped slice ${params.sliceId} (${params.milestoneId}). Reason: ${params.reason ?? "User-directed skip"}.${suffix}${projectionNotice}`,
      }],
      details: {
        operation: "skip_slice",
        sliceId: params.sliceId,
        milestoneId: params.milestoneId,
        reason: params.reason,
        tasksSkipped: result.tasksSkipped,
        wasAlreadySkipped: result.wasAlreadySkipped,
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(projectionStale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `skip_slice tool failed: ${msg}`, { tool: "gsd_skip_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error skipping slice: ${msg}` }],
      details: { operation: "skip_slice", error: msg },
      isError: true,
    };
  }
}

export async function executeMilestoneReopen(
  params: ReopenMilestoneExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen milestone." }],
      details: { operation: "reopen_milestone", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = await handleReopenMilestone(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening milestone: ${result.error}` }],
        details: { operation: "reopen_milestone", error: result.error },
        isError: true,
      };
    }
    const historical = result.superseded || result.current === false;
    return {
      content: [{
        type: "text",
        text: historical
          ? `Milestone reopen receipt for ${result.milestoneId} has been superseded; current state was not changed.`
          : `Reopened milestone ${result.milestoneId}`,
      }],
      details: {
        operation: "reopen_milestone",
        milestoneId: result.milestoneId,
        slicesReset: result.slicesReset,
        tasksReset: result.tasksReset,
        ...(result.operationId ? { operationId: result.operationId } : {}),
        ...(result.resultingRevision !== undefined ? { resultingRevision: result.resultingRevision } : {}),
        ...(result.duplicate ? { duplicate: true, replayed: true } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
        ...(result.superseded ? { superseded: true } : {}),
        ...(result.stale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_milestone tool failed: ${msg}`, { tool: "gsd_milestone_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening milestone: ${msg}` }],
      details: { operation: "reopen_milestone", error: msg },
      isError: true,
    };
  }
}

export async function executeSliceComplete(
  params: SliceCompleteExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const unitGuard = blockIfWrongAutoUnit("complete-slice", "complete_slice");
  if (unitGuard) return unitGuard;

  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete slice." }],
      details: { operation: "complete_slice", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const splitPair = (s: string): [string, string] => {
      const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
      return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
    };
    const wrapOptionalArray = (v: unknown): unknown[] | undefined =>
      v == null ? undefined : Array.isArray(v) ? v : [v];
    const coerced = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    ) as CompleteSliceParams & Record<string, unknown>;
    const provides = wrapOptionalArray(params.provides);
    if (provides !== undefined) coerced.provides = provides as string[];
    const keyFiles = wrapOptionalArray(params.keyFiles);
    if (keyFiles !== undefined) coerced.keyFiles = keyFiles as string[];
    const keyDecisions = wrapOptionalArray(params.keyDecisions);
    if (keyDecisions !== undefined) coerced.keyDecisions = keyDecisions as string[];
    const patternsEstablished = wrapOptionalArray(params.patternsEstablished);
    if (patternsEstablished !== undefined) coerced.patternsEstablished = patternsEstablished as string[];
    const observabilitySurfaces = wrapOptionalArray(params.observabilitySurfaces);
    if (observabilitySurfaces !== undefined) coerced.observabilitySurfaces = observabilitySurfaces as string[];
    const requirementsSurfaced = wrapOptionalArray(params.requirementsSurfaced);
    if (requirementsSurfaced !== undefined) coerced.requirementsSurfaced = requirementsSurfaced as string[];
    const drillDownPaths = wrapOptionalArray(params.drillDownPaths);
    if (drillDownPaths !== undefined) coerced.drillDownPaths = drillDownPaths as string[];
    const affects = wrapOptionalArray(params.affects);
    if (affects !== undefined) coerced.affects = affects as string[];
    const filesModified = wrapOptionalArray(params.filesModified);
    if (filesModified !== undefined) coerced.filesModified = filesModified.map((f) => {
      if (typeof f !== "string") return f;
      const [path, description] = splitPair(f);
      return { path, description };
    }) as Array<{ path: string; description: string }>;
    const requires = wrapOptionalArray(params.requires);
    if (requires !== undefined) coerced.requires = requires.map((r) => {
      if (typeof r !== "string") return r;
      const [slice, provides] = splitPair(r);
      return { slice, provides };
    }) as Array<{ slice: string; provides: string }>;
    const requirementsAdvanced = wrapOptionalArray(params.requirementsAdvanced);
    if (requirementsAdvanced !== undefined) coerced.requirementsAdvanced = requirementsAdvanced.map((r) => {
      if (typeof r !== "string") return r;
      const [id, how] = splitPair(r);
      return { id, how };
    }) as Array<{ id: string; how: string }>;
    const requirementsValidated = wrapOptionalArray(params.requirementsValidated);
    if (requirementsValidated !== undefined) coerced.requirementsValidated = requirementsValidated.map((r) => {
      if (typeof r !== "string") return r;
      const [id, proof] = splitPair(r);
      return { id, proof };
    }).map((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return r;
      const record = r as Record<string, unknown>;
      if (typeof record.id === "string" && typeof record.proof !== "string" && typeof record.how === "string") {
        return { id: record.id, proof: record.how };
      }
      return r;
    }) as Array<{ id: string; proof: string }>;
    const requirementsInvalidated = wrapOptionalArray(params.requirementsInvalidated);
    if (requirementsInvalidated !== undefined) coerced.requirementsInvalidated = requirementsInvalidated.map((r) => {
      if (typeof r !== "string") return r;
      const [id, what] = splitPair(r);
      return { id, what };
    }).map((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return r;
      const record = r as Record<string, unknown>;
      if (typeof record.id === "string" && typeof record.what !== "string" && typeof record.how === "string") {
        return { id: record.id, what: record.how };
      }
      return r;
    }) as Array<{ id: string; what: string }>;

    const result = await handleCompleteSlice(coerced as CompleteSliceParams, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing slice: ${result.error}` }],
        details: { operation: "complete_slice", error: result.error },
      isError: true,
      };
    }
    if (result.superseded) {
      return {
        content: [{ type: "text", text: `Reused a historical completion receipt for slice ${result.sliceId} (${result.milestoneId}); it is no longer current.` }],
        details: {
          operation: "complete_slice",
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          summaryPath: result.summaryPath,
          uatPath: result.uatPath,
          duplicate: true,
          superseded: true,
        },
      };
    }
    const projectionNotice = result.stale ? " The readable status update is pending repair." : "";
    return {
      content: [{ type: "text", text: `Completed slice ${result.sliceId} (${result.milestoneId}).${projectionNotice}` }],
      details: {
        operation: "complete_slice",
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        uatPath: result.uatPath,
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.stale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_slice tool failed: ${msg}`, { tool: "gsd_slice_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing slice: ${msg}` }],
      details: { operation: "complete_slice", error: msg },
    isError: true,
      };
  }
}

export async function executeCompleteMilestone(
  params: CompleteMilestoneExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  const unitGuard = blockIfWrongAutoUnit("complete-milestone", "complete_milestone");
  if (unitGuard) return unitGuard;

  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete milestone." }],
      details: { operation: "complete_milestone", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const sanitized = sanitizeCompleteMilestoneParams(params);
    const result = await handleCompleteMilestone(sanitized, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing milestone: ${result.error}` }],
        details: { operation: "complete_milestone", error: result.error },
      isError: true,
      };
    }
    const historical = result.superseded || result.current === false;
    const message = historical
      ? `Milestone completion receipt for ${result.milestoneId} has been superseded; current state was not changed.`
      : result.stale
      ? `${result.alreadyComplete ? `Milestone ${result.milestoneId} is already complete.` : `Completed milestone ${result.milestoneId}.`} The readable status update is pending repair.`
      : result.alreadyComplete
        ? `Milestone ${result.milestoneId} is already complete. Summary available at ${result.summaryPath}`
        : `Completed milestone ${result.milestoneId}. Summary written to ${result.summaryPath}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        operation: "complete_milestone",
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        ...(result.alreadyComplete ? { alreadyComplete: true } : {}),
        ...(result.operationId ? { operationId: result.operationId } : {}),
        ...(result.resultingRevision !== undefined ? { resultingRevision: result.resultingRevision } : {}),
        ...(result.replayed ? { replayed: true } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
        ...(result.superseded ? { superseded: true } : {}),
        ...(result.stale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_milestone tool failed: ${msg}`, { tool: "gsd_complete_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing milestone: ${msg}` }],
      details: { operation: "complete_milestone", error: msg },
    isError: true,
      };
  }
}

export async function executeValidateMilestone(
  params: ValidateMilestoneExecutorParams,
  basePath: string = process.cwd(),
  opts?: ValidateMilestoneOptions,
): Promise<ToolExecutionResult> {
  const unitGuard = blockIfWrongAutoUnit("validate-milestone", "validate_milestone");
  if (unitGuard) return unitGuard;

  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot validate milestone." }],
      details: { operation: "validate_milestone", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const result = await handleValidateMilestone(params, basePath, opts);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error validating milestone: ${result.error}` }],
        details: { operation: "validate_milestone", error: result.error },
      isError: true,
      };
    }
    const historical = result.superseded || result.current === false;
    return {
      content: [{
        type: "text",
        text: historical
          ? `Milestone validation receipt for ${result.milestoneId} has been superseded; current state was not changed.`
          : `Validated milestone ${result.milestoneId} — verdict: ${result.verdict}. Written to ${result.validationPath}`,
      }],
      details: {
        operation: "validate_milestone",
        milestoneId: result.milestoneId,
        verdict: result.verdict,
        validationPath: result.validationPath,
        ...(result.operationId ? { operationId: result.operationId } : {}),
        ...(result.resultingRevision !== undefined ? { resultingRevision: result.resultingRevision } : {}),
        ...(result.attemptId ? { attemptId: result.attemptId } : {}),
        ...(result.resultId ? { resultId: result.resultId } : {}),
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
        ...(result.superseded ? { superseded: true } : {}),
        ...(result.stale ? { stale: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `validate_milestone tool failed: ${msg}`, { tool: "gsd_validate_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error validating milestone: ${msg}` }],
      details: { operation: "validate_milestone", error: msg },
    isError: true,
      };
  }
}

export async function executePrepareMilestoneSubjectiveUat(
  params: PrepareMilestoneSubjectiveUatExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  if (!await ensureDbOpen(basePath)) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot prepare subjective UAT." }],
      details: { operation: "prepare_milestone_subjective_uat", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = prepareMilestoneSubjectiveUat({ ...params, invocation });
    // The answer tool binds on these exact values, and the text channel is the
    // only surface the model sees — render the full binding verbatim (#2296).
    const optionLines = result.options
      .map((option) =>
        `  optionId: ${option.optionId} | disposition: ${option.disposition}` +
        `${option.recommended ? " | recommended" : ""} | label: "${option.label}"`
      )
      .join("\n");
    return {
      content: [{
        type: "text",
        text: [
          `Prepared subjective UAT for ${result.milestoneId}: ${params.focusedPrompt}`,
          "Answer binding for gsd_answer_milestone_subjective_uat:",
          `  criterionId: ${result.criterionId}`,
          `  questionId: ${result.questionId}`,
          `  interactionId: ${result.interactionId}`,
          `  testedSourceRevision: ${result.testedSourceRevision}`,
          "Options (verbatimResponse must equal the label text exactly — the double quotes below are delimiters, not part of the value):",
          optionLines,
        ].join("\n"),
      }],
      details: {
        operation: "prepare_milestone_subjective_uat",
        ...result,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error preparing subjective UAT: ${message}` }],
      details: { operation: "prepare_milestone_subjective_uat", error: message },
      isError: true,
    };
  }
}

export async function executeAnswerMilestoneSubjectiveUat(
  params: AnswerMilestoneSubjectiveUatExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  if (!await ensureDbOpen(basePath)) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot answer subjective UAT." }],
      details: { operation: "answer_milestone_subjective_uat", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = answerMilestoneSubjectiveUat({ ...params, invocation });
    return {
      content: [{
        type: "text",
        text: `Recorded the authenticated subjective UAT response as ${result.disposition}.`,
      }],
      details: {
        operation: "answer_milestone_subjective_uat",
        ...result,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error answering subjective UAT: ${message}` }],
      details: { operation: "answer_milestone_subjective_uat", error: message },
      isError: true,
    };
  }
}

export async function executeReassessRoadmap(
  params: ReassessRoadmapExecutorParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reassess roadmap." }],
      details: { operation: "reassess_roadmap", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const result = await handleReassessRoadmap(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reassessing roadmap: ${result.error}` }],
        details: { operation: "reassess_roadmap", error: result.error },
      isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Reassessed roadmap for milestone ${result.milestoneId} after ${result.completedSliceId}` }],
      details: {
        operation: "reassess_roadmap",
        milestoneId: result.milestoneId,
        completedSliceId: result.completedSliceId,
        assessmentPath: result.assessmentPath,
        roadmapPath: result.roadmapPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reassess_roadmap tool failed: ${msg}`, { tool: "gsd_reassess_roadmap", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reassessing roadmap: ${msg}` }],
      details: { operation: "reassess_roadmap", error: msg },
    isError: true,
      };
  }
}

export async function executeSaveGateResult(
  params: SaveGateResultParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const harnessAbort = blockIfHarnessAbortedUnit("save_gate_result", basePath);
  if (harnessAbort) return harnessAbort;

  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available." }],
      details: { operation: "save_gate_result", error: "db_unavailable" },
    isError: true,
      };
  }

  // Source of truth: gate-registry.ts. Every declared GateId is accepted,
  // so adding a new gate in one place automatically flows through here.
  const validGates = Object.keys(GATE_REGISTRY);
  if (!validGates.includes(params.gateId)) {
    return {
      content: [{ type: "text", text: `Error: Invalid gateId "${params.gateId}". Must be one of: ${validGates.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_gate_id" },
    isError: true,
      };
  }

  const validVerdicts = ["pass", "flag", "omitted"];
  if (!validVerdicts.includes(params.verdict)) {
    return {
      content: [{ type: "text", text: `Error: Invalid verdict "${params.verdict}". Must be one of: ${validVerdicts.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_verdict" },
    isError: true,
      };
  }

  try {
    saveGateResult({
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      gateId: params.gateId,
      taskId: params.taskId ?? "",
      verdict: params.verdict,
      rationale: params.rationale,
      findings: params.findings ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_save_gate_result database write failed: ${msg}`, { tool: "gsd_save_gate_result", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving gate result: ${msg}` }],
      details: { operation: "save_gate_result", error: msg },
      isError: true,
    };
  }

  let projectionStale = false;
  try {
    await renderPlanCheckboxes(basePath, params.milestoneId, params.sliceId);
  } catch (err) {
    projectionStale = true;
    logWarning(
      "projection",
      `gsd_save_gate_result plan projection failed for ${params.milestoneId}/${params.sliceId}; DB gate result remains committed`,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  invalidateStateCache();

  const projectionNotice = projectionStale ? ". The readable plan update is pending repair." : "";
  return {
    content: [{ type: "text", text: `Gate ${params.gateId} result saved: verdict=${params.verdict}${projectionNotice}` }],
    details: {
      operation: "save_gate_result",
      gateId: params.gateId,
      verdict: params.verdict,
      ...(projectionStale ? { stale: true } : {}),
    },
  };
}

function errorResult(operation: string, message: string, error: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { operation, error },
    isError: true,
  };
}

export async function executeUatResultSave(
  params: UatResultSaveParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const unitGuard = blockIfWrongAutoUnit("run-uat", "save_uat_result");
  if (unitGuard) return unitGuard;

  const harnessAbort = blockIfHarnessAbortedUnit("save_uat_result", basePath);
  if (harnessAbort) return harnessAbort;

  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) return errorResult("save_uat_result", "GSD database is not available.", "db_unavailable");

  const prepared = prepareUatRun(basePath, params);
  if (!prepared.ok) {
    return errorResult("save_uat_result", prepared.error.message, prepared.error.code);
  }
  const { run } = prepared;

  try {
    const summary = await executeSummarySave(
      {
        milestone_id: run.params.milestoneId,
        slice_id: run.params.sliceId,
        artifact_type: "ASSESSMENT",
        content: run.assessment,
      },
      basePath,
    );
    if (summary.isError) return summary;
    const assessmentPath = relSliceFile(basePath, run.params.milestoneId, run.params.sliceId, "ASSESSMENT");
    insertAssessment({
      path: assessmentPath,
      milestoneId: run.params.milestoneId,
      sliceId: run.params.sliceId,
      taskId: null,
      status: run.params.verdict.toLowerCase(),
      scope: "run-uat",
      fullContent: run.assessment,
    });
    const attemptPath = await saveUatAttemptArtifact(basePath, run);
    upsertQualityGate({
      milestoneId: run.params.milestoneId,
      sliceId: run.params.sliceId,
      gateId: "UAT",
      scope: "slice",
      taskId: "",
      status: "complete",
      verdict: run.gateVerdict,
      rationale: run.rationale,
      findings: run.assessment,
      evaluatedAt: run.evaluatedAt,
    });
    insertGateRun({
      traceId: `uat:${run.params.milestoneId}:${run.params.sliceId}`,
      turnId: run.runId,
      gateId: "UAT",
      gateType: "uat",
      unitType: "run-uat",
      unitId: `run-uat:${run.params.milestoneId}/${run.params.sliceId}`,
      milestoneId: run.params.milestoneId,
      sliceId: run.params.sliceId,
      outcome: run.gateOutcome,
      failureClass: run.params.verdict === "PASS" ? "none" : "verification",
      rationale: run.rationale,
      findings: run.assessment,
      attempt: run.attempt,
      maxAttempts: run.attempt,
      retryable: run.params.verdict !== "PASS",
      evaluatedAt: run.evaluatedAt,
    });
    invalidateStateCache();
    if (run.hasHuman) {
      appendNotification(
        `UAT for ${run.params.milestoneId}/${run.params.sliceId} has NEEDS-HUMAN checks awaiting human validation`,
        "warning",
        "notify",
        { kind: "uat-needs-human", scope: `${run.params.milestoneId}/${run.params.sliceId}` },
      );
    }
    const savedText = `UAT result saved for ${run.params.milestoneId}/${run.params.sliceId}: ${run.params.verdict}`;
    return {
      content: [{
        type: "text",
        text: run.manualGuidance ? `${savedText}\n\nManual validation needed:\n${run.manualGuidance}` : savedText,
      }],
      details: {
        operation: "save_uat_result",
        milestoneId: run.params.milestoneId,
        sliceId: run.params.sliceId,
        verdict: run.params.verdict,
        gateVerdict: run.gateVerdict,
        attempt: run.attempt,
        attemptPath,
        runId: run.runId,
        worktreeRoot: run.worktreeRoot,
        browserToolsPresented: run.browserToolsPresented,
        recommendedNextUnit: run.params.verdict === "PASS" ? null : "reactive-execute",
        ...(run.hasHuman
          ? { manualValidationPath: run.worktreeRoot }
          : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_uat_result_save failed: ${msg}`, { tool: "gsd_uat_result_save", error: String(err) });
    return errorResult("save_uat_result", `saving UAT result failed: ${msg}`, msg);
  }
}

export async function executePlanMilestone(
  params: PlanMilestoneExecutorParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan milestone." }],
      details: { operation: "plan_milestone", error: "db_unavailable" },
    isError: true,
      };
  }
  let workerId: string | null = null;
  let acquiredToken: number | null = null;
  let leaseRefreshTimer: ReturnType<typeof setInterval> | undefined;
  try {
    // Re-read at the gate so a peer-created milestone is not treated as fresh.
    const milestoneExists = getMilestone(params.milestoneId) !== null;
    if (milestoneExists) {
      const heldLease = getMilestoneLease(params.milestoneId);
      if (heldLease?.status === "held" && Date.parse(heldLease.expires_at) > Date.now()) {
        const holder = getAutoWorker(heldLease.worker_id);
        // Let one-shot and resumed-auto claim paths recover stale
        // same-process worker rows.
        const activeAutoWorkerId = isAutoActive() ? autoSession.workerId : null;
        const isOurAutoLease = !!activeAutoWorkerId && heldLease.worker_id === activeAutoWorkerId;
        const holderIsReentrantPeer = !!holder
          && holder.host === hostname()
          && holder.pid === process.pid;
        if (holder?.status === "active" && !isOurAutoLease) {
          if (!holderIsReentrantPeer) {
            return milestoneLeaseConflictResult(params.milestoneId, heldLease.worker_id, heldLease.expires_at);
          }

          if (isAutoActive()) {
            // Active auto without a worker row (e.g. after a setup-race pause
            // detached it) cannot reclaim here, and the one-shot claim path
            // below is skipped while auto is active. Fail closed instead of
            // planning against a lease we do not own.
            if (!activeAutoWorkerId) {
              return milestoneLeaseConflictResult(params.milestoneId, heldLease.worker_id, heldLease.expires_at);
            }
            const reclaimed = claimMilestoneLease(activeAutoWorkerId, params.milestoneId);
            if (!reclaimed.ok) {
              return milestoneLeaseConflictResult(params.milestoneId, reclaimed.byWorker, reclaimed.expiresAt);
            }
            autoSession.currentMilestoneId = params.milestoneId;
            autoSession.milestoneLeaseToken = reclaimed.token;
            markWorkerStopping(heldLease.worker_id);
          }
        }
      }
    }

    // Fresh creation cannot claim a lease because the FK row does not exist.
    // In-process auto already owns its lease; re-claiming would bump its token.
    if (!isAutoActive() && milestoneExists) {
      workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(basePath) });
      const lease = claimMilestoneLease(workerId, params.milestoneId);
      if (!lease.ok) {
        return milestoneLeaseConflictResult(params.milestoneId, lease.byWorker, lease.expiresAt);
      }
      acquiredToken = lease.token;

      const leaseRefreshMs = (milestoneLeaseTtlSeconds() / 2) * 1000;
      leaseRefreshTimer = setInterval(() => {
        if (acquiredToken !== null && workerId !== null) {
          refreshMilestoneLease(workerId, params.milestoneId, acquiredToken);
        }
      }, leaseRefreshMs);
    }

    const result = await handlePlanMilestone(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning milestone: ${result.error}` }],
        details: { operation: "plan_milestone", error: result.error },
      isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Planned milestone ${result.milestoneId}` }],
      details: {
        operation: "plan_milestone",
        milestoneId: result.milestoneId,
        roadmapPath: result.roadmapPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_milestone tool failed: ${msg}`, { tool: "gsd_plan_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning milestone: ${msg}` }],
      details: { operation: "plan_milestone", error: msg },
    isError: true,
      };
  }
  finally {
    if (leaseRefreshTimer !== undefined) {
      clearInterval(leaseRefreshTimer);
    }
    if (workerId !== null && acquiredToken !== null) {
      releaseMilestoneLease(workerId, params.milestoneId, acquiredToken);
    }
    if (workerId !== null) {
      markWorkerStopping(workerId);
    }
  }
}

export async function executePlanSlice(
  params: PlanSliceExecutorParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan slice." }],
      details: { operation: "plan_slice", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const result = await handlePlanSlice(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning slice: ${result.error}` }],
        details: { operation: "plan_slice", error: result.error },
      isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Planned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "plan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        planPath: result.planPath,
        taskPlanPaths: result.taskPlanPaths,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_slice tool failed: ${msg}`, { tool: "gsd_plan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning slice: ${msg}` }],
      details: { operation: "plan_slice", error: msg },
    isError: true,
      };
  }
}


export async function executeReplanTask(
  params: ReplanTaskExecutorParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot replan task." }],
      details: { operation: "replan_task", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = await handleReplanTask(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error replanning task: ${result.error}` }],
        details: { operation: "replan_task", error: result.error },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Replanned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      details: {
        operation: "replan_task",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        taskId: result.taskId,
        taskPlanPath: result.taskPlanPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `replan_task tool failed: ${msg}`, { tool: "gsd_replan_task", error: String(err) });
    return {
      content: [{ type: "text", text: `Error replanning task: ${msg}` }],
      details: { operation: "replan_task", error: msg },
      isError: true,
    };
  }
}

export async function executeReworkBriefSave(
  params: ReworkBriefSaveExecutorParams,
  basePath: string = process.cwd(),
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot save rework brief." }],
      details: { operation: "rework_brief_save", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = await handleReworkBriefSave(params);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error saving rework brief: ${result.error}` }],
        details: { operation: "rework_brief_save", error: result.error },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Saved rework brief ${result.briefId} with ${result.findingCount} finding(s)` }],
      details: {
        operation: "rework_brief_save",
        briefId: result.briefId,
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        taskId: result.taskId,
        findingCount: result.findingCount,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `rework_brief_save tool failed: ${msg}`, { tool: "gsd_rework_brief_save", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving rework brief: ${msg}` }],
      details: { operation: "rework_brief_save", error: msg },
      isError: true,
    };
  }
}

export async function executeReplanSlice(
  params: ReplanSliceExecutorParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ToolExecutionResult> {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot replan slice." }],
      details: { operation: "replan_slice", error: "db_unavailable" },
    isError: true,
      };
  }
  try {
    const result = await handleReplanSlice(params, basePath, invocation);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error replanning slice: ${result.error}` }],
        details: { operation: "replan_slice", error: result.error },
      isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Replanned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "replan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        replanPath: result.replanPath,
        planPath: result.planPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `replan_slice tool failed: ${msg}`, { tool: "gsd_replan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error replanning slice: ${msg}` }],
      details: { operation: "replan_slice", error: msg },
    isError: true,
      };
  }
}

export interface MilestoneStatusParams {
  milestoneId: string;
}

type MilestoneStatusReadInterleave = () => void;

let milestoneStatusReadInterleaveForTest: MilestoneStatusReadInterleave | null = null;

export function _setMilestoneStatusReadInterleaveForTest(
  hook: MilestoneStatusReadInterleave | null,
): void {
  milestoneStatusReadInterleaveForTest = hook;
}

export async function executeMilestoneStatus(
  params: MilestoneStatusParams,
  basePath: string = process.cwd(),
  observationContext?: MilestoneStatusObservationContext,
): Promise<ToolExecutionResult> {
  try {
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      const response = {
        content: [{ type: "text" as const, text: "Error: GSD database is not available." }],
        details: { operation: "milestone_status", error: "db_unavailable" },
        isError: true,
      };
      emitLifecycleShadowObservation(
        basePath,
        buildLifecycleShadowObservation(
          params.milestoneId,
          {
            projectRevision: 0,
            authorityEpoch: 0,
            items: [],
            queryError: new Error("GSD database is not available"),
          },
          observationContext,
        ),
      );
      return response;
    }

    const observedRead = readTransaction(() => {
      const milestone = getMilestone(params.milestoneId);
      if (!milestone) {
        const response = {
          content: [{ type: "text" as const, text: `Milestone ${params.milestoneId} not found in database.` }],
          details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false },
        };
        milestoneStatusReadInterleaveForTest?.();
        return {
          response,
          shadowSnapshot: getMilestoneLifecycleShadowSnapshot(params.milestoneId),
        };
      }

      const sliceStatuses = getSliceStatusSummary(params.milestoneId);
      const slices = sliceStatuses.map((s) => ({
        id: s.id,
        status: s.status,
        taskCounts: getSliceTaskCounts(params.milestoneId, s.id),
      }));

      const result = {
        milestoneId: milestone.id,
        title: milestone.title,
        status: milestone.status,
        createdAt: milestone.created_at,
        completedAt: milestone.completed_at,
        dependsOn: milestone.depends_on ?? [],
        sliceCount: slices.length,
        slices,
      };

      milestoneStatusReadInterleaveForTest?.();

      return {
        response: {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { operation: "milestone_status", ...result },
        },
        shadowSnapshot: getMilestoneLifecycleShadowSnapshot(params.milestoneId),
      };
    });
    const observation = buildLifecycleShadowObservation(
      params.milestoneId,
      observedRead.shadowSnapshot,
      observationContext,
    );
    emitLifecycleShadowObservation(basePath, observation);
    return observedRead.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("tool", `gsd_milestone_status tool failed: ${msg}`);
    emitLifecycleShadowObservation(
      basePath,
      buildLifecycleShadowObservation(
        params.milestoneId,
        {
          projectRevision: 0,
          authorityEpoch: 0,
          items: [],
          queryError: err,
        },
        observationContext,
      ),
    );
    return {
      content: [{ type: "text", text: `Error querying milestone status: ${msg}` }],
      details: { operation: "milestone_status", error: msg },
      isError: true,
    };
  }
}
