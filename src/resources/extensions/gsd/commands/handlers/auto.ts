import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { enableDebug } from "../../debug-logger.js";
import { getAutoDashboardData, isAutoActive, isAutoPaused, pauseAuto, startAutoDetached, stopAuto, stopAutoRemote } from "../../auto.js";
import { handleRate } from "../../commands-rate.js";
import { notifyPreferenceDiagnostics } from "../../preferences-diagnostics.js";
import { setSessionModelOverride } from "../../session-model-override.js";
import { guardRemoteSession, projectRoot } from "../context.js";
import { findMilestoneIds } from "../../milestone-ids.js";

async function hasUnresolvedCloseoutBlocker(ctx: ExtensionCommandContext, basePath: string): Promise<boolean> {
  const { ensureDbOpen } = await import("../../bootstrap/dynamic-tools.js");
  if (!(await ensureDbOpen(basePath))) return false;

  const {
    formatCloseoutAutoBlockMessage,
    listUnresolvedCloseoutFailures,
  } = await import("../../closeout-recovery.js");
  const failures = listUnresolvedCloseoutFailures();
  if (failures.length === 0) return false;

  ctx.ui.notify(formatCloseoutAutoBlockMessage(failures.length), "error");
  return true;
}

/**
 * Parse --yolo flag and optional file path from the auto command string.
 * Supports: `/gsd auto --yolo path/to/file.md` or `/gsd auto -y path/to/file.md`
 */
function parseYoloFlag(trimmed: string): { yoloSeedFile: string | null; rest: string } {
  const yoloRe = /(?:--yolo|-y)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/;
  const match = trimmed.match(yoloRe);
  if (!match) return { yoloSeedFile: null, rest: trimmed };

  // Strip quotes if present
  let filePath = match[1];
  if ((filePath.startsWith('"') && filePath.endsWith('"')) ||
      (filePath.startsWith("'") && filePath.endsWith("'"))) {
    filePath = filePath.slice(1, -1);
  }

  const rest = trimmed.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { yoloSeedFile: filePath, rest };
}

/**
 * Parse --model flag from the auto command string.
 * Supports: `/gsd auto --model provider/model` and `/gsd auto --model "provider/model"`
 */
export function parseModelFlag(input: string): { modelQuery: string | null; rest: string } {
  const modelRe = /(?:--model)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/;
  const match = input.match(modelRe);
  if (!match) return { modelQuery: null, rest: input };

  let modelQuery = match[1];
  if ((modelQuery.startsWith('"') && modelQuery.endsWith('"')) ||
      (modelQuery.startsWith("'") && modelQuery.endsWith("'"))) {
    modelQuery = modelQuery.slice(1, -1);
  }

  const rest = input.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { modelQuery: modelQuery.trim() || null, rest };
}

/**
 * Parse the ADR-047 `--resume-wedge <id>` flag from the auto command string.
 * Acknowledging a wedge is the one sanctioned re-entry after the liveness
 * backstop trips; it clears that signature's counter and lets auto start.
 */
export function parseResumeWedgeFlag(input: string): { resumeWedgeId: string | null; rest: string } {
  const match = input.match(/--resume-wedge\s+(\S+)/);
  if (!match) return { resumeWedgeId: null, rest: input };
  const rest = input.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { resumeWedgeId: match[1], rest };
}

/**
 * Extract a milestone ID (e.g. M016 or M001-a3b4c5) from the command string.
 * Returns the matched ID and the remaining string with the ID removed.
 * The milestone ID pattern matches the format used by findMilestoneIds: M\d+ with
 * an optional -[a-z0-9]{6} suffix for unique milestone IDs.
 */
export function parseMilestoneTarget(input: string): { milestoneId: string | null; rest: string } {
  const match = input.match(/\b(M\d+(?:-[a-z0-9]{6})?)\b/);
  if (!match) return { milestoneId: null, rest: input };
  const rest = input.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { milestoneId: match[1], rest };
}

export async function handleAutoCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (trimmed === "next" || trimmed.startsWith("next ")) {
    if (trimmed.includes("--dry-run")) {
      const { handleDryRun } = await import("../../commands-maintenance.js");
      await handleDryRun(ctx, projectRoot());
      return true;
    }
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(trimmed);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!(await guardRemoteSession(ctx, pi))) return true;
    const basePath = projectRoot();
    if (await hasUnresolvedCloseoutBlocker(ctx, basePath)) return true;
    notifyPreferenceDiagnostics(ctx, basePath, { surface: "auto-preflight" });

    // Validate the milestone target exists and is not already complete.
    if (milestoneId) {
      const allIds = findMilestoneIds(basePath);
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }

    startAutoDetached(ctx, pi, basePath, verboseMode, {
      step: true,
      milestoneLock: milestoneId,
    });
    return true;
  }

  if (trimmed === "auto" || trimmed.startsWith("auto ")) {
    const { resumeWedgeId, rest: afterWedge } = parseResumeWedgeFlag(trimmed);
    const { modelQuery, rest: afterModel } = parseModelFlag(afterWedge);
    const { yoloSeedFile, rest: afterYolo } = parseYoloFlag(afterModel);
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(afterYolo);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!(await guardRemoteSession(ctx, pi))) return true;
    const basePath = projectRoot();

    if (await hasUnresolvedCloseoutBlocker(ctx, basePath)) return true;
    notifyPreferenceDiagnostics(ctx, basePath, { surface: "auto-preflight" });

    // Validate the milestone target exists and is not already complete.
    if (milestoneId) {
      const allIds = findMilestoneIds(basePath);
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }

    if (modelQuery) {
      const { resolveModelId } = await import("../../auto-model-selection.js");
      const availableModels = ctx.modelRegistry.getAvailable();
      const targetModel = resolveModelId(modelQuery, availableModels, ctx.model?.provider);
      if (!targetModel) {
        ctx.ui.notify(`Model "${modelQuery}" not found. Use an exact provider/model or model ID.`, "warning");
        return true;
      }

      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) {
        setSessionModelOverride(sessionId, {
          provider: targetModel.provider,
          id: targetModel.id,
        });
      }
    }

    if (resumeWedgeId && yoloSeedFile) {
      ctx.ui.notify("--resume-wedge cannot be combined with --yolo; resume the existing workflow separately.", "error");
      return true;
    }

    if (yoloSeedFile) {
      const resolved = resolve(basePath, yoloSeedFile);
      if (!existsSync(resolved)) {
        ctx.ui.notify(`Yolo seed file not found: ${resolved}`, "error");
        return true;
      }
      const seedContent = readFileSync(resolved, "utf-8").trim();
      if (!seedContent) {
        ctx.ui.notify(`Yolo seed file is empty: ${resolved}`, "error");
        return true;
      }
      // Headless path: bootstrap project, dispatch non-interactive discuss,
      // then auto-mode starts automatically via checkAutoStartAfterDiscuss
      // when the LLM says "Milestone X ready."
      const { showHeadlessMilestoneCreation } = await import("../../guided-flow.js");
      await showHeadlessMilestoneCreation(ctx, pi, basePath, seedContent);
    } else if (milestoneId) {
      startAutoDetached(ctx, pi, basePath, verboseMode, {
        milestoneLock: milestoneId,
        resumeWedgeId,
      });
    } else {
      startAutoDetached(ctx, pi, basePath, verboseMode, { resumeWedgeId });
    }
    return true;
  }

  if (trimmed === "stop") {
    if (!isAutoActive() && !isAutoPaused()) {
      const result = stopAutoRemote(projectRoot());
      if (result.found) {
        ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
      } else if (result.error) {
        ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await stopAuto(ctx, pi, "User requested stop");
    return true;
  }

  if (trimmed === "pause") {
    if (!isAutoActive()) {
      if (isAutoPaused()) {
        ctx.ui.notify("Auto-mode is already paused. /gsd auto to resume.", "info");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await pauseAuto(ctx, pi, undefined, { abortActiveTurn: true });
    return true;
  }

  if (trimmed === "rate" || trimmed.startsWith("rate ")) {
    await handleRate(trimmed.replace(/^rate\s*/, "").trim(), ctx, projectRoot());
    return true;
  }

  if (trimmed === "") {
    if (!(await guardRemoteSession(ctx, pi))) return true;
    const basePath = projectRoot();
    // Cold start after /quit lands at the project root, not the worktree. If the
    // active milestone has a live worktree, chdir back into it now so the agent
    // doesn't have to search for it. Best-effort; resolves to a no-op otherwise.
    try {
      const { reenterActiveWorktreeIfNeeded } = await import("../../worktree-reentry.js");
      await reenterActiveWorktreeIfNeeded(basePath, {
        notify: (message) => ctx.ui.notify(message, "info"),
      });
    } catch { /* non-fatal */ }
    const { hasGsdBootstrapArtifacts } = await import("../../detection.js");
    const { gsdRoot } = await import("../../paths.js");
    if (!hasGsdBootstrapArtifacts(gsdRoot(basePath))) {
      const { showSmartEntry } = await import("../../guided-flow.js");
      await showSmartEntry(ctx, pi, basePath, { step: true });
      return true;
    }
    if (await hasUnresolvedCloseoutBlocker(ctx, basePath)) return true;
    const { showGsdHome } = await import("../../gsd-command-home.js");
    await showGsdHome(ctx, pi, projectRoot());
    return true;
  }

  return false;
}
