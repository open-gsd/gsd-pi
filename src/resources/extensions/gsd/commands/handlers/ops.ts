// Project/App: gsd-pi
// File Purpose: Handles operational /gsd subcommands.
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { enableDebug } from "../../debug-logger.js";
import { dispatchDirectPhase } from "../../auto-direct-dispatch.js";
import { handleConfig } from "../../commands-config.js";
import { handleDoctor, handleCapture, handleKnowledge, handleRunHook, handleSkillHealth, handleSteer, handleTriage, handleUpdate } from "../../commands-handlers.js";
import { handleInspect } from "../../commands-inspect.js";
import { handleLogs } from "../../commands-logs.js";
import { handleDebug } from "../../commands-debug.js";
import { handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleCleanupProjects, handleCleanupWorktrees, handleRecover, handleRebuild, handleSync, handleDbRestoreBackup } from "../../commands-maintenance.js";
import { handleExport } from "../../export.js";
import { handleHistory } from "../../history.js";
import { handleUndo } from "../../undo.js";
import { handleRemote } from "../../../remote-questions/mod.js";
import { handleShip } from "../../commands-ship.js";
import { handleSessionReport } from "../../commands-session-report.js";
import { handlePrBranch } from "../../commands-pr-branch.js";
import { currentDirectoryRoot, projectRoot } from "../context.js";
import { findUnmergedCompletedMilestones } from "../../unmerged-milestone-guard.js";
import { runMergeMilestoneBlocker } from "../../closeout-wizard.js";

async function handleCompletedMilestoneRecovery(
  phase: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<boolean> {
  const tokens = phase.split(/\s+/).filter(Boolean);
  const dispatchPhase = tokens[0] ?? "";
  if (dispatchPhase !== "complete" && dispatchPhase !== "complete-milestone") return false;

  const requestedMilestoneId = tokens[1];
  const blockers = await findUnmergedCompletedMilestones(basePath);
  const blocker = requestedMilestoneId
    ? blockers.find((candidate) => candidate.milestoneId === requestedMilestoneId)
    : blockers[0];
  if (!blocker) return false;

  await runMergeMilestoneBlocker(ctx, basePath, blocker);
  return true;
}

export function normalizeReportExportArgs(trimmed: string): string | null {
  if (trimmed === "report") return "--html --all";
  if (trimmed.startsWith("report ")) return trimmed.replace(/^report\s*/, "").trim();
  if (trimmed === "export") return "";
  if (trimmed.startsWith("export ")) return trimmed.replace(/^export\s*/, "").trim();
  return null;
}

export async function handleOpsCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  const directDispatchAlias = new Map<string, string>([
    ["research-milestone", "research"],
    ["research-slice", "research"],
    ["plan-milestone", "plan"],
    ["plan-slice", "plan"],
    ["execute-task", "execute"],
    ["complete-slice", "complete"],
    ["validate-milestone", "validate-milestone"],
    ["complete-milestone", "complete-milestone"],
  ]);
  const aliasPhase = directDispatchAlias.get(trimmed);
  if (aliasPhase) {
    await dispatchDirectPhase(ctx, pi, aliasPhase, projectRoot());
    return true;
  }

  if (trimmed === "init") {
    const { detectProjectState } = await import("../../detection.js");
    const { handleReinit, showProjectInit } = await import("../../init-wizard.js");
    const basePath = projectRoot();
    const detection = detectProjectState(basePath);
    if (detection.state === "v2-gsd" || detection.state === "v2-gsd-empty") {
      await handleReinit(ctx, detection);
    } else {
      await showProjectInit(ctx, pi, basePath, detection);
    }
    return true;
  }
  if (trimmed === "keys" || trimmed.startsWith("keys ")) {
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys(trimmed.replace(/^keys\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "doctor" || trimmed.startsWith("doctor ")) {
    await handleDoctor(trimmed.replace(/^doctor\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "copilot-models" || trimmed.startsWith("copilot-models ")) {
    const { handleCopilotModels } = await import("./copilot-models.js");
    await handleCopilotModels(trimmed.replace(/^copilot-models\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "logs" || trimmed.startsWith("logs ")) {
    await handleLogs(trimmed.replace(/^logs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "debug" || trimmed.startsWith("debug ")) {
    await handleDebug(trimmed.replace(/^debug\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "forensics" || trimmed.startsWith("forensics ")) {
    const { handleForensics } = await import("../../forensics.js");
    await handleForensics(trimmed.replace(/^forensics\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "changelog" || trimmed.startsWith("changelog ")) {
    const { handleChangelog } = await import("../../changelog.js");
    await handleChangelog(trimmed.replace(/^changelog\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "history" || trimmed.startsWith("history ")) {
    await handleHistory(trimmed.replace(/^history\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "undo-task" || trimmed.startsWith("undo-task ")) {
    const { handleUndoTask } = await import("../../undo.js");
    await handleUndoTask(trimmed.replace(/^undo-task\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "reset-slice" || trimmed.startsWith("reset-slice ")) {
    const { handleResetSlice } = await import("../../undo.js");
    await handleResetSlice(trimmed.replace(/^reset-slice\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "undo" || trimmed.startsWith("undo ")) {
    await handleUndo(trimmed.replace(/^undo\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "skip") {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  Example: /gsd skip M001/S01/T03", "warning");
    return true;
  }
  if (trimmed.startsWith("skip ")) {
    await handleSkip(trimmed.replace(/^skip\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "recover" || trimmed.startsWith("recover ")) {
    const args = trimmed.replace(/^recover\s*/, "").trim();
    if (args && !args.startsWith("--")) {
      const { handleTaskRecoveryResume } = await import("../../commands-task-recovery.js");
      await handleTaskRecoveryResume(args, ctx, projectRoot());
    } else {
      await handleRecover(ctx, projectRoot(), args);
    }
    return true;
  }
  if (trimmed === "rebuild" || trimmed.startsWith("rebuild ")) {
    // Projection destination is the invocation root (worktree-local inside an
    // active worktree); DB authority stays with the open project-scoped DB (#2232).
    await handleRebuild(ctx, currentDirectoryRoot(), trimmed.replace(/^rebuild\s*/, "").trim());
    return true;
  }
  if (trimmed === "db restore-backup" || trimmed.startsWith("db restore-backup ")) {
    await handleDbRestoreBackup(ctx, projectRoot(), trimmed.replace(/^db restore-backup\s*/, "").trim());
    return true;
  }
  if (trimmed === "task settle" || trimmed.startsWith("task settle ")) {
    const { handleTaskSettle } = await import("../../commands-task-settle.js");
    await handleTaskSettle(trimmed.replace(/^task settle\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "sync" || trimmed.startsWith("sync ")) {
    await handleSync(ctx, projectRoot(), trimmed.replace(/^sync\s*/, "").trim());
    return true;
  }
  if (trimmed === "closeout" || trimmed.startsWith("closeout ")) {
    const { handleCloseout } = await import("../../commands-closeout.js");
    await handleCloseout(trimmed.replace(/^closeout\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  const reportExportArgs = normalizeReportExportArgs(trimmed);
  if (reportExportArgs !== null) {
    await handleExport(reportExportArgs, ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup projects" || trimmed.startsWith("cleanup projects ")) {
    await handleCleanupProjects(trimmed.replace(/^cleanup projects\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cleanup worktrees") {
    await handleCleanupWorktrees(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup") {
    await handleCleanupBranches(ctx, projectRoot());
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup branches") {
    await handleCleanupBranches(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup snapshots") {
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed.startsWith("capture ") || trimmed === "capture") {
    await handleCapture(trimmed.replace(/^capture\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "triage") {
    await handleTriage(ctx, pi, currentDirectoryRoot());
    return true;
  }
  if (trimmed === "config") {
    await handleConfig(ctx);
    return true;
  }
  if (trimmed === "hooks") {
    const { formatHookStatus } = await import("../../post-unit-hooks.js");
    ctx.ui.notify(formatHookStatus(), "info");
    return true;
  }
  if (trimmed === "skill-health" || trimmed.startsWith("skill-health ")) {
    await handleSkillHealth(trimmed.replace(/^skill-health\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed.startsWith("run-hook ")) {
    await handleRunHook(trimmed.replace(/^run-hook\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "run-hook") {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return true;
  }
  if (trimmed.startsWith("steer ")) {
    await handleSteer(trimmed.replace(/^steer\s+/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "steer") {
    ctx.ui.notify("Usage: /gsd steer <description of change>. Example: /gsd steer Use Postgres instead of SQLite", "warning");
    return true;
  }
  if (trimmed.startsWith("knowledge ")) {
    await handleKnowledge(trimmed.replace(/^knowledge\s+/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "knowledge") {
    ctx.ui.notify("Usage: /gsd knowledge <rule|pattern|lesson> <description>. Example: /gsd knowledge rule Use real DB for integration tests", "warning");
    return true;
  }
  if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "remote" || trimmed.startsWith("remote ")) {
    await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "dispatch" || trimmed.startsWith("dispatch ")) {
    const phase = trimmed.replace(/^dispatch\s*/, "").trim();
    if (!phase) {
      ctx.ui.notify(
        "Usage: /gsd dispatch <phase>  (research|plan|execute|complete|complete-milestone|validate|reassess|uat|replan)",
        "warning",
      );
      return true;
    }
    const basePath = projectRoot();
    if (await handleCompletedMilestoneRecovery(phase, ctx, basePath)) {
      return true;
    }
    await dispatchDirectPhase(ctx, pi, phase, basePath);
    return true;
  }
  if (trimmed === "verdict" || trimmed.startsWith("verdict ")) {
    const { handleVerdict } = await import("../../commands-verdict.js");
    await handleVerdict(trimmed.replace(/^verdict\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "notifications" || trimmed.startsWith("notifications ")) {
    const { handleNotificationsCommand } = await import("./notifications-handler.js");
    await handleNotificationsCommand(trimmed.replace(/^notifications\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "escalate" || trimmed.startsWith("escalate ")) {
    const { handleEscalateCommand } = await import("./escalate.js");
    await handleEscalateCommand(trimmed.replace(/^escalate\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "inspect") {
    await handleInspect(ctx);
    return true;
  }
  if (trimmed === "update" || trimmed.startsWith("update ") || trimmed === "upgrade" || trimmed.startsWith("upgrade ")) {
    await handleUpdate(ctx, trimmed.replace(/^(?:update|upgrade)\s*/, "").trim());
    return true;
  }
  if (trimmed === "fast" || trimmed.startsWith("fast ")) {
    const { handleFast } = await import("../../service-tier.js");
    await handleFast(trimmed.replace(/^fast\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "mcp" || trimmed.startsWith("mcp ")) {
    const { handleMcpStatus } = await import("../../commands-mcp-status.js");
    await handleMcpStatus(trimmed.replace(/^mcp\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "extensions" || trimmed.startsWith("extensions ")) {
    const { handleExtensions } = await import("../../commands-extensions.js");
    await handleExtensions(trimmed.replace(/^extensions\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "rethink") {
    const { handleRethink } = await import("../../rethink.js");
    await handleRethink(trimmed, ctx, pi);
    return true;
  }
  if (trimmed === "codebase" || trimmed.startsWith("codebase ")) {
    const { handleCodebase } = await import("../../commands-codebase.js");
    await handleCodebase(trimmed.replace(/^codebase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ship" || trimmed.startsWith("ship ")) {
    await handleShip(trimmed.replace(/^ship\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "session-report" || trimmed.startsWith("session-report ")) {
    await handleSessionReport(trimmed.replace(/^session-report\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "pr-branch" || trimmed.startsWith("pr-branch ")) {
    await handlePrBranch(trimmed.replace(/^pr-branch\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "add-tests" || trimmed.startsWith("add-tests ")) {
    const { handleAddTests } = await import("../../commands-add-tests.js");
    await handleAddTests(trimmed.replace(/^add-tests\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "eval-review" || trimmed.startsWith("eval-review ")) {
    const { handleEvalReview } = await import("../../commands-eval-review.js");
    await handleEvalReview(trimmed.replace(/^eval-review\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "extract-learnings" || trimmed.startsWith("extract-learnings ")) {
    const { handleExtractLearnings } = await import("../../commands-extract-learnings.js");
    await handleExtractLearnings(trimmed.replace(/^extract-learnings\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "memory" || trimmed.startsWith("memory ") || trimmed === "memory help") {
    const { handleMemory } = await import("../../commands-memory.js");
    await handleMemory(trimmed.replace(/^memory\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "scan" || trimmed.startsWith("scan ")) {
    const { handleScan } = await import("../../commands-scan.js");
    // \s* (not \s+) is intentional: handles both /gsd scan (no args) and /gsd scan --focus X
    await handleScan(trimmed.replace(/^scan\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (
    trimmed === "worktree" ||
    trimmed.startsWith("worktree ") ||
    trimmed === "wt" ||
    trimmed.startsWith("wt ")
  ) {
    const { handleWorktree } = await import("../../commands-worktree.js");
    await handleWorktree(trimmed.replace(/^(worktree|wt)\s*/, "").trim(), ctx);
    return true;
  }
  // Additional commands — ideation/exploration workflows (implemented, not aliased).
  if (trimmed === "explore" || trimmed.startsWith("explore ")) {
    const { handleExplore } = await import("../../commands-gsd-core.js");
    await handleExplore(trimmed.replace(/^explore\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "spike" || trimmed.startsWith("spike ")) {
    const { handleSpike } = await import("../../commands-gsd-core.js");
    await handleSpike(trimmed.replace(/^spike\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "sketch" || trimmed.startsWith("sketch ")) {
    const { handleSketch } = await import("../../commands-gsd-core.js");
    await handleSketch(trimmed.replace(/^sketch\s*/, "").trim(), ctx, pi);
    return true;
  }
  // Additional commands — codebase intelligence workflows (implemented, not aliased).
  if (trimmed === "map-codebase" || trimmed.startsWith("map-codebase ")) {
    const { handleMapCodebase } = await import("../../commands-gsd-core.js");
    await handleMapCodebase(trimmed.replace(/^map-codebase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "docs-update" || trimmed.startsWith("docs-update ")) {
    const { handleDocsUpdate } = await import("../../commands-gsd-core.js");
    await handleDocsUpdate(trimmed.replace(/^docs-update\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "graphify" || trimmed.startsWith("graphify ")) {
    const { handleGraphify } = await import("../../commands-gsd-core.js");
    await handleGraphify(trimmed.replace(/^graphify\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "stats") {
    const { handleStats } = await import("../../commands-gsd-core.js");
    await handleStats("", ctx, pi);
    return true;
  }
  if (trimmed === "progress" || trimmed.startsWith("progress ")) {
    const { handleProgress } = await import("../../commands-gsd-core.js");
    await handleProgress(trimmed.replace(/^progress\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "health" || trimmed.startsWith("health ")) {
    const { handleHealth } = await import("../../commands-gsd-core.js");
    await handleHealth(trimmed.replace(/^health\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "surface" || trimmed.startsWith("surface ")) {
    const { handleSurface } = await import("../../commands-gsd-core.js");
    await handleSurface(trimmed.replace(/^surface\s*/, "").trim(), ctx, pi);
    return true;
  }
  // Additional commands — review / audit workflows (implemented, not aliased).
  if (trimmed === "code-review" || trimmed.startsWith("code-review ")) {
    const { handleCodeReview } = await import("../../commands-gsd-core.js");
    await handleCodeReview(trimmed.replace(/^code-review\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "review" || trimmed.startsWith("review ")) {
    const { handleReview } = await import("../../commands-gsd-core.js");
    await handleReview(trimmed.replace(/^review\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "audit-milestone" || trimmed.startsWith("audit-milestone ")) {
    const { handleAuditMilestone } = await import("../../commands-gsd-core.js");
    await handleAuditMilestone(trimmed.replace(/^audit-milestone\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "audit-uat" || trimmed.startsWith("audit-uat ")) {
    const { handleAuditUat } = await import("../../commands-gsd-core.js");
    await handleAuditUat(trimmed.replace(/^audit-uat\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "audit-fix" || trimmed.startsWith("audit-fix ")) {
    const { handleAuditFix } = await import("../../commands-gsd-core.js");
    await handleAuditFix(trimmed.replace(/^audit-fix\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ui-review" || trimmed.startsWith("ui-review ")) {
    const { handleUiReview } = await import("../../commands-gsd-core.js");
    await handleUiReview(trimmed.replace(/^ui-review\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "secure-phase" || trimmed.startsWith("secure-phase ")) {
    const { handleSecurePhase } = await import("../../commands-gsd-core.js");
    await handleSecurePhase(trimmed.replace(/^secure-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "validate-phase" || trimmed.startsWith("validate-phase ")) {
    const { handleValidatePhase } = await import("../../commands-gsd-core.js");
    await handleValidatePhase(trimmed.replace(/^validate-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "verify-work" || trimmed.startsWith("verify-work ")) {
    const { handleVerifyWork } = await import("../../commands-gsd-core.js");
    await handleVerifyWork(trimmed.replace(/^verify-work\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "plan-review-convergence" || trimmed.startsWith("plan-review-convergence ")) {
    const { handlePlanReviewConvergence } = await import("../../commands-gsd-core.js");
    await handlePlanReviewConvergence(trimmed.replace(/^plan-review-convergence\s*/, "").trim(), ctx, pi);
    return true;
  }
  // Additional commands — workflow phase commands (implemented, not aliased).
  if (trimmed === "discuss-phase" || trimmed.startsWith("discuss-phase ")) {
    const { handleDiscussPhase } = await import("../../commands-gsd-core.js");
    await handleDiscussPhase(trimmed.replace(/^discuss-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "plan-phase" || trimmed.startsWith("plan-phase ")) {
    const { handlePlanPhase } = await import("../../commands-gsd-core.js");
    await handlePlanPhase(trimmed.replace(/^plan-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "execute-phase" || trimmed.startsWith("execute-phase ")) {
    const { handleExecutePhase } = await import("../../commands-gsd-core.js");
    await handleExecutePhase(trimmed.replace(/^execute-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "spec-phase" || trimmed.startsWith("spec-phase ")) {
    const { handleSpecPhase } = await import("../../commands-gsd-core.js");
    await handleSpecPhase(trimmed.replace(/^spec-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "mvp-phase" || trimmed.startsWith("mvp-phase ")) {
    const { handleMvpPhase } = await import("../../commands-gsd-core.js");
    await handleMvpPhase(trimmed.replace(/^mvp-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ui-phase" || trimmed.startsWith("ui-phase ")) {
    const { handleUiPhase } = await import("../../commands-gsd-core.js");
    await handleUiPhase(trimmed.replace(/^ui-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ai-integration-phase" || trimmed.startsWith("ai-integration-phase ")) {
    const { handleAiIntegrationPhase } = await import("../../commands-gsd-core.js");
    await handleAiIntegrationPhase(trimmed.replace(/^ai-integration-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ultraplan-phase" || trimmed.startsWith("ultraplan-phase ")) {
    const { handleUltraplanPhase } = await import("../../commands-gsd-core.js");
    await handleUltraplanPhase(trimmed.replace(/^ultraplan-phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "autonomous" || trimmed.startsWith("autonomous ")) {
    const { handleAutonomous } = await import("../../commands-gsd-core.js");
    await handleAutonomous(trimmed.replace(/^autonomous\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "pause-work" || trimmed.startsWith("pause-work ")) {
    const { handlePauseWork } = await import("../../commands-gsd-core.js");
    await handlePauseWork(trimmed.replace(/^pause-work\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "resume-work" || trimmed.startsWith("resume-work ")) {
    const { handleResumeWork } = await import("../../commands-gsd-core.js");
    await handleResumeWork(trimmed.replace(/^resume-work\s*/, "").trim(), ctx, pi);
    return true;
  }
  // Additional commands — project management commands (implemented, not aliased).
  if (trimmed === "manager" || trimmed.startsWith("manager ")) {
    const { handleManager } = await import("../../commands-gsd-core.js");
    await handleManager(trimmed.replace(/^manager\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "phase" || trimmed.startsWith("phase ")) {
    const { handlePhase } = await import("../../commands-gsd-core.js");
    await handlePhase(trimmed.replace(/^phase\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "thread" || trimmed.startsWith("thread ")) {
    const { handleThread } = await import("../../commands-gsd-core.js");
    await handleThread(trimmed.replace(/^thread\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "workstreams" || trimmed.startsWith("workstreams ")) {
    const { handleWorkstreams } = await import("../../commands-gsd-core.js");
    await handleWorkstreams(trimmed.replace(/^workstreams\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "workspace" || trimmed.startsWith("workspace ")) {
    const { handleWorkspace } = await import("../../commands-gsd-core.js");
    await handleWorkspace(trimmed.replace(/^workspace\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "milestone-summary" || trimmed.startsWith("milestone-summary ")) {
    const { handleMilestoneSummary } = await import("../../commands-gsd-core.js");
    await handleMilestoneSummary(trimmed.replace(/^milestone-summary\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "review-backlog" || trimmed.startsWith("review-backlog ")) {
    const { handleReviewBacklog } = await import("../../commands-gsd-core.js");
    await handleReviewBacklog(trimmed.replace(/^review-backlog\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "inbox" || trimmed.startsWith("inbox ")) {
    const { handleInbox } = await import("../../commands-gsd-core.js");
    await handleInbox(trimmed.replace(/^inbox\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "import" || trimmed.startsWith("import ")) {
    const { handleImport } = await import("../../commands-gsd-core.js");
    await handleImport(trimmed.replace(/^import\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "ingest-docs" || trimmed.startsWith("ingest-docs ")) {
    const { handleIngestDocs } = await import("../../commands-gsd-core.js");
    await handleIngestDocs(trimmed.replace(/^ingest-docs\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "profile-user" || trimmed.startsWith("profile-user ")) {
    const { handleProfileUser } = await import("../../commands-gsd-core.js");
    await handleProfileUser(trimmed.replace(/^profile-user\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "settings" || trimmed.startsWith("settings ")) {
    const { handleSettings } = await import("../../commands-gsd-core.js");
    await handleSettings(trimmed.replace(/^settings\s*/, "").trim(), ctx, pi);
    return true;
  }
  return false;
}
