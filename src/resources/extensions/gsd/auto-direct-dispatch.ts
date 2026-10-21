/**
 * Direct phase dispatch — handles manual /gsd dispatch commands.
 * Resolves phase name → unit type + prompt, creates a session, and sends the message.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";

import { deriveState } from "./state.js";
import { loadFile } from "./files.js";
import { isDbAvailable, getClosedSliceIds } from "./gsd-db.js";
import {
  resolveSliceFile, relSliceFile,
} from "./paths.js";
import {
  buildResearchSlicePrompt,
  buildResearchMilestonePrompt,
  buildPlanSlicePrompt,
  buildPlanMilestonePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildValidateMilestonePrompt,
  buildReassessRoadmapPrompt,
  buildRunUatPrompt,
  buildReplanSlicePrompt,
} from "./auto-prompts.js";
import { loadEffectiveGSDPreferences, renderLanguageDirectiveForPrompt } from "./preferences.js";
import type { MinimalModelRegistry } from "./context-budget.js";
import { pauseAuto } from "./auto.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { getUnitWorkflowDispatchReadinessErrorForModel } from "./tool-contract.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";

export function parseDirectDispatchPhase(raw: string): { phase: string; milestoneId?: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { phase: "" };
  const phase = tokens[0].toLowerCase();
  const milestoneToken = tokens.find((token, index) => index > 0 && /^M\d/i.test(token));
  return {
    phase,
    milestoneId: milestoneToken?.replace(/[.,;:!?]+$/, ""),
  };
}

export async function dispatchDirectPhase(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  phase: string,
  base: string,
  opts: { milestoneId?: string } = {},
): Promise<void> {
  const parsed = parseDirectDispatchPhase(phase);
  const state = await deriveState(base);
  const mid = opts.milestoneId ?? parsed.milestoneId ?? state.activeMilestone?.id;
  const midTitle = state.activeMilestone?.title ?? "";

  if (!mid) {
    ctx.ui.notify("Cannot dispatch: no active milestone.", "warning");
    return;
  }

  const projectRoot = base;

  // Switch the dispatch base to the canonical milestone worktree if one
  // exists. Without this, /gsd dispatch invoked from the project root would
  // build prompts and create a session anchored to the project root even
  // though the milestone's actual code lives in the worktree.
  const dispatchBase = resolveCanonicalMilestoneRoot(base, mid);

  const normalized = parsed.phase;
  let unitType: string;
  let unitId: string;
  let prompt: string;

  switch (normalized) {
    case "research":
    case "research-milestone":
    case "research-slice": {
      const isSlice = normalized === "research-slice" || (normalized === "research" && state.phase !== "pre-planning");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch research-slice: no active slice.", "warning");
          return;
        }

        // When require_slice_discussion is enabled, pause auto-mode before
        // each new slice so the user can discuss requirements first (#789).
        const sliceContextFile = resolveSliceFile(dispatchBase, mid, sid, "CONTEXT");
        const requireDiscussion = loadEffectiveGSDPreferences()?.preferences?.phases?.require_slice_discussion;
        if (requireDiscussion && !sliceContextFile) {
          ctx.ui.notify(
            `Slice ${sid} requires discussion before planning. Run /gsd discuss to discuss this slice, then /gsd auto to resume.`,
            "info",
          );
          await pauseAuto(ctx, pi);
          return;
        }

        unitType = "research-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildResearchSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase, {
          sessionProvider: ctx.model?.provider,
        });
      } else {
        unitType = "research-milestone";
        unitId = mid;
        prompt = await buildResearchMilestonePrompt(mid, midTitle, dispatchBase);
      }
      break;
    }

    case "plan":
    case "plan-milestone":
    case "plan-slice": {
      const isSlice = normalized === "plan-slice" || (normalized === "plan" && state.phase !== "pre-planning");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch plan-slice: no active slice.", "warning");
          return;
        }
        unitType = "plan-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildPlanSlicePrompt(
          mid, midTitle, sid, sTitle, dispatchBase, undefined,
          {
            sessionContextWindow: ctx.model?.contextWindow,
            modelRegistry: ctx.modelRegistry as MinimalModelRegistry | undefined,
            sessionProvider: ctx.model?.provider,
          },
        );
      } else {
        unitType = "plan-milestone";
        unitId = mid;
        prompt = await buildPlanMilestonePrompt(
          mid,
          midTitle,
          dispatchBase,
          scopeMilestone(createWorkspace(dispatchBase), mid),
        );
      }
      break;
    }

    case "execute":
    case "execute-task": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      const tid = state.activeTask?.id;
      const tTitle = state.activeTask?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active slice.", "warning");
        return;
      }
      if (!tid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active task.", "warning");
        return;
      }
      unitType = "execute-task";
      unitId = `${mid}/${sid}/${tid}`;
      prompt = await buildExecuteTaskPrompt(
        mid, sid, sTitle, tid, tTitle, dispatchBase,
        {
          sessionContextWindow: ctx.model?.contextWindow,
          modelRegistry: ctx.modelRegistry as MinimalModelRegistry | undefined,
          sessionProvider: ctx.model?.provider,
        },
      );
      break;
    }

    case "complete":
    case "complete-slice":
    case "complete-milestone": {
      const isSlice = normalized === "complete-slice" || (normalized === "complete" && state.phase === "summarizing");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch complete-slice: no active slice.", "warning");
          return;
        }
        unitType = "complete-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase);
      } else {
        unitType = "complete-milestone";
        unitId = mid;
        prompt = await buildCompleteMilestonePrompt(mid, midTitle, dispatchBase);
      }
      break;
    }

    case "reassess":
    case "reassess-roadmap": {
      // DB-authoritative read (ADR-017) — markdown projections are never
      // consulted for dispatch decisions. No DB rows means no completed slices.
      const completedSliceIds = isDbAvailable() ? getClosedSliceIds(mid) : [];
      if (completedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch reassess-roadmap: no completed slices.", "warning");
        return;
      }
      const completedSliceId = completedSliceIds[completedSliceIds.length - 1];
      unitType = "reassess-roadmap";
      unitId = `${mid}/${completedSliceId}`;
      prompt = await buildReassessRoadmapPrompt(mid, midTitle, completedSliceId, dispatchBase);
      break;
    }

    case "validate":
    case "validate-milestone": {
      unitType = "validate-milestone";
      unitId = mid;
      prompt = await buildValidateMilestonePrompt(mid, midTitle, dispatchBase);
      break;
    }

    case "uat":
    case "run-uat": {
      // UAT targets the most recently completed slice, not the active (next
      // incomplete) slice. After slice completion, state.activeSlice advances
      // to the next incomplete slice, so we find the last done slice from the
      // roadmap instead (#1693).
      // DB-authoritative read (ADR-017) — no markdown fallback for dispatch
      // decisions.
      const uatCompletedSliceIds = isDbAvailable() ? getClosedSliceIds(mid) : [];
      if (uatCompletedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch run-uat: no completed slices.", "warning");
        return;
      }
      const sid = uatCompletedSliceIds[uatCompletedSliceIds.length - 1];
      const uatFile = resolveSliceFile(dispatchBase, mid, sid, "UAT");
      if (!uatFile) {
        ctx.ui.notify("Cannot dispatch run-uat: no UAT file found.", "warning");
        return;
      }
      const uatContent = await loadFile(uatFile);
      if (!uatContent) {
        ctx.ui.notify("Cannot dispatch run-uat: UAT file is empty.", "warning");
        return;
      }
      const uatPath = relSliceFile(dispatchBase, mid, sid, "UAT");
      unitType = "run-uat";
      unitId = `${mid}/${sid}`;
      prompt = await buildRunUatPrompt(mid, sid, uatPath, uatContent, dispatchBase);
      break;
    }

    case "replan":
    case "replan-slice": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch replan-slice: no active slice.", "warning");
        return;
      }
      unitType = "replan-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildReplanSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase);
      break;
    }

    default:
      ctx.ui.notify(
        `Unknown phase "${phase}". Valid phases: research, plan, execute, complete, validate, reassess, uat, replan.`,
        "warning",
      );
      return;
  }

  const compatibilityError = getUnitWorkflowDispatchReadinessErrorForModel({
    model: ctx.model,
    getProviderAuthMode: (provider) => ctx.modelRegistry.getProviderAuthMode(provider),
    projectRoot,
    surface: "direct phase dispatch",
    unitType,
    activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [],
  });
  if (compatibilityError) {
    ctx.ui.notify(compatibilityError, "error");
    return;
  }

  ctx.ui.notify(`Dispatching ${unitType} for ${unitId}...`, "info");

  const result = await ctx.newSession({ workspaceRoot: dispatchBase });
  if (result.cancelled) {
    ctx.ui.notify("Session creation cancelled.", "warning");
    return;
  }
  // Inject the configured response language into the dispatched prompt content
  // — the new session's system prompt does not carry the preferences block, so
  // the language setting would otherwise never reach the unit (#1210).
  const languageDirective = renderLanguageDirectiveForPrompt(
    loadEffectiveGSDPreferences(dispatchBase)?.preferences,
  );
  const dispatchContent = languageDirective ? `${languageDirective}\n\n${prompt}` : prompt;
  pi.sendMessage(
    { customType: "gsd-dispatch", content: dispatchContent, display: false },
    { triggerTurn: true },
  );
}
