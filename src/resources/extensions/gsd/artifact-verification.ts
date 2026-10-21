// Project/App: gsd-pi
// File Purpose: Auto-mode artifact verification and worktree path fallbacks.

import { parseUnitId } from "./unit-id.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { clearParseCache } from "./files.js";
import { parseProjectionRoadmap, parseProjectionPlan } from "./schemas/parsers.js";
import {
  isDbAvailable,
  getSlice,
  getSliceTasks,
  getMilestoneSliceSummaries,
  getPendingGatesForTurn,
} from "./gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { isValidationTerminal } from "./state.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning, logError } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";
import {
  resolveSlicePath,
  resolveSliceFile,
  resolveTasksDir,
  resolveTaskFiles,
  resolveTaskFile,
  relSliceFile,
  clearPathCache,
  resolveGsdRootFile,
  phaseDirMatchesMilestoneId,
} from "./paths.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LAYOUT_SEGMENTS, milestoneIdToPhaseNum } from "./layout-policy.js";
import { basename, dirname, join, resolve } from "node:path";
import {
  resolveExpectedArtifactPath,
  resolveExistingSliceResearchPath,
} from "./auto-artifact-paths.js";
import { hasVerdict } from "./verdict-parser.js";
import { validateArtifact } from "./schemas/validate.js";
import { getProjectResearchStatus } from "./project-research-policy.js";
import { isGsdWorktreePath } from "./worktree-root.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import { loadAllCaptures, loadPendingCaptures } from "./captures.js";
import { proveMilestoneCloseout } from "./milestone-closeout-proof.js";
import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";
import {
  readPendingTaskRecoveryContext,
  readTaskRecoveryAttemptIds,
  readTaskRecoveryResumeEligibility,
  readTaskRecoveryRoute,
} from "./task-recovery-domain-operation.js";
import { readMilestoneValidationVerdict } from "./milestone-validation-verdict.js";

export type ExecuteTaskArtifactReadiness = "verify" | "route";

/** Return the next actionable stage only when the latest Task Attempt has a Result. */
export function readExecuteTaskArtifactReadiness(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): ExecuteTaskArtifactReadiness | null {
  const attempt = readLatestTaskAttempt({ milestoneId, sliceId, taskId });
  if (attempt?.state !== "settled" || !attempt.resultId) return null;
  if (attempt.nextStage === "verify" && attempt.outcome === "succeeded") return "verify";
  if (attempt.nextStage === "route") return "route";
  return null;
}

/**
 * The recovery action id when the newest agent-owned `abort` is not
 * resume-authorized.
 *
 * `readExecuteTaskArtifactReadiness` reports "route" for *any* settled Attempt
 * parked at the route stage — including one whose agent-owned recovery already
 * aborted. Re-dispatching that unit is a guaranteed dead end:
 * `runWithTaskExecutionAttempt` sees the same predecessor route and breaks with
 * `task-recovery-abort` before any work starts (#1622). Stuck recovery must
 * refuse instead of clearing the dispatch ring and re-dispatching.
 *
 * Detection is not limited to the latest Attempt: a resume-eligible abort on a
 * superseded Attempt remains operative when newer Attempts carry no agent abort
 * of their own (#1754 residual). Ineligible actions are historical evidence,
 * not sanctioned exits; consumed actions in particular must never advertise a
 * resume command that deterministically rejects (#1944). A newer agent-owned
 * non-abort route supersedes any older abort (#1908).
 */
export function readTerminalTaskRecoveryAbort(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): { recoveryActionId: string } | null {
  for (const attemptId of readTaskRecoveryAttemptIds({ milestoneId, sliceId, taskId })) {
    const route = readTaskRecoveryRoute(attemptId);
    if (!route || route.recoveryOwner !== "agent") continue;
    // The newest agent-owned route is authoritative: a non-abort action
    // (retry/repair/remediate) on a newer Attempt supersedes any older abort.
    if (route.action !== "abort") return null;
    const eligibility = readTaskRecoveryResumeEligibility(route.recoveryActionId);
    if (!eligibility.eligible) continue;
    return route.resumeAuthorized ? null : { recoveryActionId: route.recoveryActionId };
  }
  return null;
}

/**
 * Optional override for the roadmap parser used by plan-milestone verification.
 * That parse reads the artifact's own content (does it declare any slices?), not
 * workflow authority, so it survives the DB cutover. Production leaves this null
 * so the real parseProjectionRoadmap runs; tests inject a throwing function to
 * deterministically exercise the parse-failure catch.
 * @internal
 */
let _roadmapParserFn: ((content: string) => { slices: Array<{ id: string; done: boolean; depends?: string[] }> }) | null = null;

/**
 * Inject an override for the legacy roadmap parser, returning a function that
 * restores the default (real parser) behavior. No production caller.
 * @internal
 */
export function _setRoadmapParserFnForTests(
  fn: ((content: string) => { slices: Array<{ id: string; done: boolean; depends?: string[] }> }) | null,
): () => void {
  const previous = _roadmapParserFn;
  _roadmapParserFn = fn;
  return () => { _roadmapParserFn = previous; };
}

function parseRoadmapForRecovery(content: string): ReturnType<NonNullable<typeof _roadmapParserFn>> {
  if (_roadmapParserFn) return _roadmapParserFn(content);
  return parseProjectionRoadmap(content) as unknown as ReturnType<NonNullable<typeof _roadmapParserFn>>;
}

/** Slice count for plan-milestone verification; shared by scoped and legacy paths. */
export function countPlanMilestoneRoadmapSlices(content: string): number {
  return parseRoadmapForRecovery(content).slices.length;
}

export function diagnoseWorktreeIntegrityFailure(basePath: string): string | null {
  if (!isGsdWorktreePath(basePath)) return null;
  if (!existsSync(basePath)) {
    return `Worktree integrity failure: ${basePath} does not exist. Repair or recreate the worktree before retrying.`;
  }

  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (.git missing). Repair or recreate the worktree before retrying.`;
  }

  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return null;
  } catch (err) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (git rev-parse failed: ${getErrorMessage(err).split("\n")[0]}). Repair or recreate the worktree before retrying.`;
  }
}

export function resolveArtifactVerificationBase(unitId: string, base: string): string {
  const { milestone } = parseUnitId(unitId);
  if (!MILESTONE_ID_RE.test(milestone)) return base;
  return resolveCanonicalMilestoneRoot(base, milestone);
}

function hasCapturedWorkflowPrefs(base: string): boolean {
  const prefsPath = resolveExpectedArtifactPath("workflow-preferences", "WORKFLOW-PREFS", base);
  if (!prefsPath || !existsSync(prefsPath)) return false;
  const content = readFileSync(prefsPath, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!match && /^workflow_prefs_captured:\s*true\s*$/m.test(match[1]);
}

function hasValidResearchDecision(base: string): boolean {
  const decisionPath = resolveExpectedArtifactPath("research-decision", "RESEARCH-DECISION", base);
  if (!decisionPath || !existsSync(decisionPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(decisionPath, "utf-8")) as Record<string, unknown>;
    return cfg.decision === "research" || cfg.decision === "skip";
  } catch {
    return false;
  }
}

function hasCompleteProjectResearch(base: string): boolean {
  return getProjectResearchStatus(base).complete;
}

function findExistingSiblingPhaseArtifact(
  absPath: string,
  unitId: string,
): string | null {
  const { milestone } = parseUnitId(unitId);
  if (!MILESTONE_ID_RE.test(milestone)) return null;

  const expectedDir = dirname(absPath);
  const phasesDir = dirname(expectedDir);
  if (basename(phasesDir) !== LAYOUT_SEGMENTS.level1) return null;

  const expectedFile = basename(absPath);
  const expectedDirName = basename(expectedDir);
  const phaseNum = milestoneIdToPhaseNum(milestone);
  const phasePrefix = `${String(phaseNum).padStart(2, "0")}-`;
  if (!expectedDirName.startsWith(phasePrefix)) return null;

  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === expectedDirName) continue;
      // The team-suffix projection fallback that used to widen this match was
      // enabled only for `execute-task`, whose verification no longer resolves
      // an artifact path at all (DB-authoritative, ADR-017). It was removed by
      // T036 rather than left as an unreachable branch.
      if (!phaseDirMatchesMilestoneId(entry.name, milestone, phaseNum)) continue;
      const candidate = join(phasesDir, entry.name, expectedFile);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Check whether the expected artifact(s) for a unit exist on disk.
 * Returns true if all required artifacts exist, or if the unit type has no
 * single verifiable artifact (e.g., replan-slice).
 */
export function verifyExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): boolean {
  if (unitType.startsWith("hook/")) return true;

  clearPathCache();
  clearParseCache();

  if (unitType === "rewrite-docs") {
    const overridesPath = resolveGsdRootFile(base, "OVERRIDES");
    if (!existsSync(overridesPath)) return true;
    const content = readFileSync(overridesPath, "utf-8");
    return !content.includes("**Scope:** active");
  }

  if (unitType === "workflow-preferences") {
    return hasCapturedWorkflowPrefs(base);
  }

  if (unitType === "replan-task") {
    const { milestone, slice, task } = parseUnitId(unitId);
    if (!milestone || !slice || !task) return false;
    const recovery = readPendingTaskRecoveryContext({
      milestoneId: milestone,
      sliceId: slice,
      taskId: task,
    });
    return recovery?.action === "replan" && recovery.replanCompleted;
  }

  if (unitType === "triage-captures") {
    const pending = loadPendingCaptures(base);
    if (pending.length === 0) return true;
    logWarning("recovery", `verify-fail triage-captures ${unitId}: ${pending.length} pending capture(s) remain in CAPTURES.md`);
    return false;
  }

  if (unitType === "quick-task") {
    const { slice: captureId } = parseUnitId(unitId);
    const capture = captureId ? loadAllCaptures(base).find((entry) => entry.id === captureId) : undefined;
    if (capture?.executed === true) return true;
    logWarning("recovery", `verify-fail quick-task ${unitId}: capture ${captureId ?? "(missing capture id)"} not found or not marked executed`);
    return false;
  }

  if (unitType === "discuss-project") {
    const projectPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!projectPath && existsSync(projectPath) && validateArtifact(projectPath, "project").ok;
  }

  if (unitType === "discuss-requirements") {
    const requirementsPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!requirementsPath && existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok;
  }

  if (unitType === "research-decision") {
    return hasValidResearchDecision(base);
  }

  if (unitType === "research-project") {
    return hasCompleteProjectResearch(base);
  }

  if (unitType === "reactive-execute") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const blockerPath = resolveExpectedArtifactPath(unitType, unitId, base);
    if (blockerPath && existsSync(blockerPath)) {
      logWarning("recovery", `reactive-execute blocker is diagnostic only for ${unitId}: ${blockerPath}`);
    }
    const slicePath = resolveSlicePath(base, mid, sid);
    if (!slicePath) return false;

    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) {
      const tDir = resolveTasksDir(base, mid, sid) ?? slicePath;
      const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
      return summaryFiles.length > 0;
    }

    const batchIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (batchIds.length === 0) return false;

    for (const tid of batchIds) {
      const summaryPath = resolveTaskFile(base, mid, sid, tid, "SUMMARY");
      if (!summaryPath || !existsSync(summaryPath)) return false;
    }
    return true;
  }

  if (unitType === "gate-evaluate") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;

    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) return true;

    const gateIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (gateIds.length === 0) return true;

    try {
      if (!isDbAvailable()) return false;
      const pending = getPendingGatesForTurn(mid, sid, "gate-evaluate");
      const pendingIds = new Set<string>(pending.map((g) => g.gate_id));
      for (const gid of gateIds) {
        if (pendingIds.has(gid)) return false;
      }
    } catch (err) {
      logWarning("recovery", `gate-evaluate DB check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (unitType === "research-slice" && unitId.endsWith("/parallel-research")) {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) return false;

    const blockerPath = resolveExpectedArtifactPath(unitType, unitId, base);
    if (blockerPath && existsSync(blockerPath)) {
      return true;
    }

    const roadmapFile = resolveExpectedArtifactPath("plan-milestone", mid, base);
    if (!roadmapFile || !existsSync(roadmapFile)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap missing`);
      return false;
    }
    // Fail closed: slice state is DB-authoritative (ADR-017). Without the DB
    // there is nothing to verify against, and an empty slice list would
    // silently turn this verify-fail into a verify-pass.
    if (!isDbAvailable()) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: DB unavailable, cannot verify slice RESEARCH coverage`);
      return false;
    }
    try {
      const slices = getMilestoneSliceSummaries(mid);
      const milestoneResearchFile = resolveExpectedArtifactPath("research-milestone", mid, base);
      const hasMilestoneResearch = !!milestoneResearchFile && existsSync(milestoneResearchFile);
      for (const slice of slices) {
        if (slice.done) continue;
        if (hasMilestoneResearch && slice.id === "S01") continue;
        const depsComplete = (slice.depends ?? []).every((depId) => {
          const summaryPath = resolveExpectedArtifactPath("complete-slice", `${mid}/${depId}`, base);
          return !!summaryPath && existsSync(summaryPath);
        });
        if (!depsComplete) continue;
        if (!resolveExistingSliceResearchPath(base, mid, slice.id)) {
          logWarning("recovery", `verify-fail ${unitType} ${unitId}: slice ${slice.id} missing RESEARCH`);
          return false;
        }
      }
      return true;
    } catch (err) {
      logWarning("recovery", `parallel-research verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  if (unitType === "execute-task" && isDbAvailable()) {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (!mid || !sid || !tid) return false;
    try {
      return readExecuteTaskArtifactReadiness(mid, sid, tid) !== null;
    } catch (err) {
      logWarning("recovery", `execute-task Attempt readiness failed for ${unitId}: ${getErrorMessage(err)}`);
      return false;
    }
  }

  if (unitType === "validate-milestone" && isDbAvailable()) {
    const { milestone } = parseUnitId(unitId);
    if (!milestone) return false;
    try {
      return readMilestoneValidationVerdict(milestone) !== undefined;
    } catch (err) {
      logWarning("recovery", `validate-milestone DB verification failed for ${unitId}: ${getErrorMessage(err)}`);
      return false;
    }
  }

  const artifactBase = resolveArtifactVerificationBase(unitId, base);
  let absPath = resolveExpectedArtifactPath(unitType, unitId, artifactBase);
  if (!absPath || !existsSync(absPath)) {
    const projectRoot = resolve(resolveWorktreeProjectRoot(artifactBase));
    if (projectRoot && projectRoot !== artifactBase) {
      const projectPath = resolveExpectedArtifactPath(unitType, unitId, projectRoot);
      if (projectPath && existsSync(projectPath)) {
        absPath = projectPath;
      } else if (projectPath) {
        const siblingPath = findExistingSiblingPhaseArtifact(projectPath, unitId);
        if (siblingPath) absPath = siblingPath;
      }
    }
  }
  if (!absPath) {
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: resolveExpectedArtifactPath returned null (no artifact contract registered for this unit type)`);
    return false;
  }
  if (!existsSync(absPath)) {
    const siblingPath = findExistingSiblingPhaseArtifact(absPath, unitId);
    if (siblingPath) absPath = siblingPath;
  }
  if (!existsSync(absPath)) {
    const worktreeFailure = diagnoseWorktreeIntegrityFailure(artifactBase);
    if (worktreeFailure) {
      logError("recovery", `${worktreeFailure} Unit: ${unitType} ${unitId}.`);
      return false;
    }
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: existsSync false for ${absPath}`);
    return false;
  }

  if (unitType === "validate-milestone") {
    const validationContent = readFileSync(absPath, "utf-8");
    if (!isValidationTerminal(validationContent)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: validation not terminal (len=${validationContent.length}) at ${absPath}`);
      return false;
    }
  }

  if (unitType === "run-uat") {
    const assessmentContent = readFileSync(absPath, "utf-8");
    if (!hasVerdict(assessmentContent)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: assessment missing verdict at ${absPath}`);
      return false;
    }
  }

  if (unitType === "plan-milestone") {
    try {
      if (countPlanMilestoneRoadmapSlices(readFileSync(absPath, "utf-8")) === 0) {
        logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap has zero slices at ${absPath}`);
        return false;
      }
    } catch (err) {
      logWarning("recovery", `plan-milestone roadmap verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  if (unitType === "plan-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      try {
        let taskIds: string[] | null = null;
        let dbPrimary = false;
        const planContent = readFileSync(absPath, "utf-8");
        let parsedTaskIds: string[] | null = null;
        const getParsedTaskIds = (): string[] => {
          if (parsedTaskIds) return parsedTaskIds;
          parsedTaskIds = parseProjectionPlan(planContent).tasks.map((t: { id: string }) => t.id);
          return parsedTaskIds;
        };
        const tasksBlockMatch = planContent.match(/<tasks>([\s\S]*?)<\/tasks>/i);
        const tasksBlock = tasksBlockMatch?.[1] ?? "";
        const hasEmbeddedTaskEntries =
          tasksBlock.length > 0 &&
          (/^\s*- \[[xX ]\] \*\*T\d+/m.test(tasksBlock) ||
            /^\s*#{2,4}\s+T\d+\s*(?:--|—|:)/m.test(tasksBlock));
        if (isDbAvailable()) {
          const refreshed = refreshWorkflowDatabaseFromDisk();
          if (refreshed) {
            const tasks = getSliceTasks(mid, sid);
            if (tasks.length > 0) {
              taskIds = tasks.map(t => t.id);
              dbPrimary = true;
            }
          }
        }

        if (!taskIds) {
          const hasCheckboxTask = /^\s*- \[[xX ]\] \*\*T\d+/m.test(planContent);
          const hasHeadingTask = /^\s*#{2,4}\s+T\d+\s*(?:--|—|:)/m.test(planContent);
          if (!hasCheckboxTask && !hasHeadingTask) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: plan has no task checkbox/heading (len=${planContent.length}) at ${absPath}`);
            return false;
          }
          const parsedIds = getParsedTaskIds();
          if (parsedIds.length > 0) taskIds = parsedIds;
        }

        if (taskIds && taskIds.length > 0 && !hasEmbeddedTaskEntries) {
          const tasksDir = join(dirname(absPath), "tasks");
          if (existsSync(tasksDir)) {
            for (const tid of taskIds) {
              const taskPlanFile = join(tasksDir, `${tid}-PLAN.md`);
              const taskSummaryFile = join(tasksDir, `${tid}-SUMMARY.md`);
              if (!existsSync(taskPlanFile) && !existsSync(taskSummaryFile)) {
                logWarning("recovery", `verify-fail ${unitType} ${unitId}: task artifact missing for ${tid}`);
                return false;
              }
            }
          } else if (!dbPrimary && !absPath.replace(/\\/g, "/").includes(`.gsd/${LAYOUT_SEGMENTS.level1}`)) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: tasks dir missing at ${tasksDir}`);
            return false;
          }
        }
      } catch (err) {
        logWarning("recovery", `plan-slice task plan verification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (unitType === "execute-task") {
    // Fail closed: Task completion is DB-authoritative (ADR-017). Reaching
    // here means the DB-backed readiness read above did not run or did not
    // confirm the Attempt, and a `- [x] **T0N:` checkbox in a PLAN projection
    // is not evidence of completion — accepting it turned a verify-fail into a
    // verify-pass whenever the DB was unavailable.
    logWarning(
      "recovery",
      `verify-fail ${unitType} ${unitId}: ${isDbAvailable() ? "no settled Task Attempt in the DB" : "DB unavailable"}, cannot confirm task completion`,
    );
    return false;
  }

  if (unitType === "complete-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      const uatPath = resolveSliceFile(base, mid, sid, "UAT")
        ?? join(base, relSliceFile(base, mid, sid, "UAT"));
      if (!existsSync(uatPath)) return false;

      const dbSlice = getSlice(mid, sid);
      if (dbSlice) {
        if (dbSlice.status !== "complete") return false;
      } else {
        // Fail closed: slice completion is DB-authoritative (ADR-017). A
        // missing row (or an unavailable DB) is not evidence of completion,
        // so never fall through to a pass here.
        logWarning(
          "recovery",
          `verify-fail ${unitType} ${unitId}: ${isDbAvailable() ? "no slice row in the DB" : "DB unavailable"}, cannot confirm slice completion`,
        );
        return false;
      }
    }
  }

  if (unitType === "complete-milestone") {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) return false;
    const closeoutProof = proveMilestoneCloseout(mid, {
      refreshFromDisk: true,
      summaryArtifactBasePath: artifactBase,
      implementationEvidence: {
        basePath: base,
        requirement: "not-absent",
      },
    });
    if (!closeoutProof.ok) {
      // Fail closed: milestone closeout is DB-authoritative (ADR-017). A failed
      // proof stays failed — SUMMARY content plus implementation artifacts are
      // not a substitute for the canonical state, and rescuing on them turned a
      // closeout-proof failure into a verify-pass whenever the DB was
      // unavailable.
      logWarning(
        "recovery",
        `verify-fail ${unitType} ${unitId}: closeout proof failed (${closeoutProof.reason})${closeoutProof.reason === "db-unavailable" ? ", DB unavailable" : ""}, cannot confirm milestone closeout`,
      );
      return false;
    }
  }

  return true;
}
