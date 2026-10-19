/**
 * GSD Queue Management — showQueue, reorder, add, and context builder.
 *
 * Self-contained queue UI extracted from guided-flow.ts.
 * Safe to run while auto-mode is executing — only writes to future milestone
 * directories (which auto-mode won't touch until it reaches them).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/tui.js";
import {
  isInteractiveCommandContext,
  notifyQueueHubNeedsInteractiveMenu,
} from "./command-feedback.js";
import { setQueuePhaseActive } from "./index.js";
import { loadFile } from "./files.js";
import { milestoneNarrative } from "./auto-prompts.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import {
  gsdRoot, resolveSliceFile,
  resolveGsdRootFile, relGsdRootFile, relSliceFile,
} from "./paths.js";
import { existsSync } from "node:fs";
import { nativeAddPaths, nativeCommit } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { loadQueueOrder, sortByQueueOrder, reorderMilestones } from "./queue-order.js";
import { findMilestoneIds, nextMilestoneId } from "./milestone-ids.js";
import { readListedMilestoneIds } from "./db/lifecycle-read.js";
import { isFutureMilestoneStatus } from "./status-guards.js";
import { renderStateProjection } from "./workflow-projections.js";

const QUEUE_ARTIFACT_EXCERPT_MAX_CHARS = 20_000;
const QUEUE_EXISTING_MILESTONES_CONTEXT_MAX_CHARS = 120_000;
const QUEUE_CONTEXT_SECTION_SEPARATOR = "\n\n---\n\n";

// ─── Queue Entry Point ──────────────────────────────────────────────────────

/**
 * Queue future milestones via conversational intake.
 *
 * Safe to run while auto-mode is executing — only writes to future milestone
 * directories (which auto-mode won't touch until it reaches them) and appends
 * to project.md / queue.md.
 *
 * The flow:
 * 1. Build context about all existing milestones (complete, active, pending)
 * 2. Dispatch the queue prompt — LLM discusses with the user, assesses scope
 * 3. LLM writes CONTEXT.md files for new milestones (no roadmaps — JIT)
 * 4. Auto-mode picks them up naturally when it advances past current work
 *
 * Root durable artifacts use uppercase names like PROJECT.md and QUEUE.md.
 */
export async function showQueue(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  // ── Ensure .gsd/ exists ─────────────────────────────────────────────
  const gsd = gsdRoot(basePath);
  if (!existsSync(gsd)) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }

  const state = await deriveState(basePath);
  const milestoneIds = readListedMilestoneIds();

  if (milestoneIds.length === 0) {
    ctx.ui.notify("No milestones exist yet. Run /gsd to create the first one.", "warning");
    return;
  }

  // ── Count pending milestones ────────────────────────────────────────
  const pendingMilestones = state.registry.filter(
    m => isFutureMilestoneStatus(m.status) || m.status === "active",
  );
  const completeCount = state.registry.filter(m => m.status === "complete").length;
  const parkedCount = state.registry.filter(m => m.status === "parked").length;

  // ── If multiple pending milestones, show queue management hub ──────
  if (pendingMilestones.length > 1) {
    if (!isInteractiveCommandContext(ctx)) {
      notifyQueueHubNeedsInteractiveMenu(ctx, "this session has no interactive menu");
      await showQueueAdd(ctx, pi, basePath, state);
      return;
    }

    const summaryParts = [`${completeCount} complete, ${pendingMilestones.length} pending.`];
    if (parkedCount > 0) summaryParts.push(`${parkedCount} parked.`);

    const choice = await showNextAction(ctx, {
      title: "GSD — Queue Management",
      summary: summaryParts,
      actions: [
        {
          id: "reorder",
          label: "Reorder queue",
          description: `Change execution order of ${pendingMilestones.length} pending milestones.`,
          recommended: true,
        },
        {
          id: "add",
          label: "Add new work",
          description: "Queue new milestones via discussion.",
        },
      ],
      notYetMessage: "Run /gsd queue when ready.",
    });

    if (choice === "reorder") {
      await handleQueueReorder(ctx, basePath, state);
      return;
    }
    if (choice === "not_yet") return;
    // "add" falls through to existing queue-add logic below
  }

  // ── Existing queue-add flow ─────────────────────────────────────────
  await showQueueAdd(ctx, pi, basePath, state);
}

// ─── Reorder ────────────────────────────────────────────────────────────────

export async function handleQueueReorder(
  ctx: ExtensionCommandContext,
  basePath: string,
  state: Awaited<ReturnType<typeof deriveState>>,
): Promise<void> {
  const { showQueueReorder: showReorderUI } = await import("./queue-reorder-ui.js");

  const completed = state.registry
    .filter(m => m.status === "complete")
    .map(m => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));

  const pending = state.registry
    .filter(m => m.status !== "complete" && m.status !== "parked")
    .map(m => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));

  const result = await showReorderUI(ctx, completed, pending);
  if (!result) {
    ctx.ui.notify("Queue reorder cancelled.", "info");
    return;
  }

  // One Domain Operation writes the order and drops the conflicting
  // depends_on edges; QUEUE-ORDER.json is rendered from the committed order.
  try {
    for (const warning of reorderMilestones(basePath, result.order, result.depsToRemove).warnings) {
      ctx.ui.notify(warning, "warning");
    }
  } catch (err) {
    ctx.ui.notify(`Queue reorder failed: ${(err as Error).message}`, "error");
    return;
  }
  invalidateAllCaches();
  // The order decides the registry and the active milestone in STATE.md.
  await renderStateProjection(basePath);

  try {
    nativeAddPaths(basePath, [".gsd/QUEUE-ORDER.json"]);
    nativeCommit(basePath, "docs: reorder queue");
  } catch {
    // Commit may fail if nothing changed or hooks block — non-fatal
  }

  const depInfo = result.depsToRemove.length > 0
    ? ` (removed ${result.depsToRemove.length} depends_on)`
    : "";
  ctx.ui.notify(`Queue reordered: ${result.order.join(" → ")}${depInfo}`, "info");
}

// ─── Queue Add ──────────────────────────────────────────────────────────────

export async function showQueueAdd(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  state: Awaited<ReturnType<typeof deriveState>>,
): Promise<void> {
  // ── Build existing milestones context for the prompt ────────────────
  const existingContext = await buildExistingMilestonesContext(basePath, readListedMilestoneIds(), state);

  // ── Determine next milestone ID ─────────────────────────────────────
  // Note: the LLM will use the gsd_milestone_generate_id tool to get IDs
  // at creation time, but we still mention the next ID in the preamble
  // for context about where the sequence is.
  const uniqueEnabled = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  const nextId = nextMilestoneId(findMilestoneIds(basePath), uniqueEnabled);

  // ── Build preamble ──────────────────────────────────────────────────
  const activePart = state.activeMilestone
    ? `Currently executing: ${state.activeMilestone.id} — ${state.activeMilestone.title} (phase: ${state.phase}).`
    : "No milestone currently active.";

  const pendingCount = state.registry.filter(m => isFutureMilestoneStatus(m.status)).length;
  const completeCount = state.registry.filter(m => m.status === "complete").length;

  const preamble = [
    `Queuing new work onto an existing GSD project.`,
    activePart,
    `${completeCount} milestone(s) complete, ${pendingCount} pending.`,
    `Next available milestone ID: ${nextId}.`,
  ].join(" ");

  // ── Dispatch the queue prompt ───────────────────────────────────────
  // Activate the queue phase so the write-gate applies to CONTEXT.md writes
  setQueuePhaseActive(true, basePath);

  const queueInlinedTemplates = inlineTemplate("context", "Context");
  const prompt = loadPrompt("queue", {
    preamble,
    existingMilestonesContext: existingContext,
    inlinedTemplates: queueInlinedTemplates,
    commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
  });

  pi.sendMessage(
    {
      customType: "gsd-queue",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

// ─── Existing Milestones Context Builder ────────────────────────────────────

/**
 * Build a context block describing all existing milestones for the queue prompt.
 * Gives the LLM enough information to dedup, sequence, and dependency-check.
 */
export async function buildExistingMilestonesContext(
  basePath: string,
  milestoneIds: string[],
  state: import("./types.js").GSDState,
): Promise<string> {
  const sections: string[] = [];

  // Include PROJECT.md if it exists — it has the milestone sequence and project description
  const projectPath = resolveGsdRootFile(basePath, "PROJECT");
  if (existsSync(projectPath)) {
    const projectContent = await loadFile(projectPath);
    if (projectContent) {
      sections.push(`### Project Overview\nSource: \`${relGsdRootFile("PROJECT")}\`\n\n${projectContent.trim()}`);
    }
  }

  // Include DECISIONS.md if it exists — architectural decisions inform new milestone scoping
  const decisionsPath = resolveGsdRootFile(basePath, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      sections.push(`### Decisions Register\nSource: \`${relGsdRootFile("DECISIONS")}\`\n\n${decisionsContent.trim()}`);
    }
  }

  // For each milestone, include context and status.
  // Completed milestones get a compact summary line only — loading their full
  // CONTEXT.md + SUMMARY.md files is expensive and triggers 429 rate limits on
  // projects with many completed milestones (#2379).
  for (const mid of milestoneIds) {
    const registryEntry = state.registry.find(m => m.id === mid);
    const status = registryEntry?.status ?? "unknown";
    const title = registryEntry?.title ?? mid;

    // Completed milestones: emit a one-liner — the LLM only needs to know
    // they exist for dedup/dependency purposes, not their full content.
    if (status === "complete") {
      sections.push(`### ${mid}: ${title}\n**Status:** complete`);
      continue;
    }

    const parts: string[] = [];
    parts.push(`### ${mid}: ${title}\n**Status:** ${status}`);

    // Include the saved context — this is the primary content for understanding scope.
    // Narrative comes from artifact rows, never from the projection files.
    const context = milestoneNarrative(basePath, mid, "CONTEXT");
    if (context.content) {
      parts.push(`\n**Context:**\n${summarizeArtifactForQueue(context.content, context.relPath)}`);
    } else {
      // No full CONTEXT — check for a CONTEXT-DRAFT (draft seed from prior discussion)
      const draft = milestoneNarrative(basePath, mid, "CONTEXT-DRAFT");
      if (draft.content) {
        parts.push(`\n**Draft context available:**\n${summarizeArtifactForQueue(draft.content, draft.relPath)}`);
      }
    }

    // For active/pending/parked milestones, include the roadmap if it exists
    // (shows what's planned but not yet built)
    if (status === "active" || isFutureMilestoneStatus(status) || status === "parked") {
      const roadmap = milestoneNarrative(basePath, mid, "ROADMAP");
      if (roadmap.content) {
        parts.push(`\n**Roadmap:**\n${summarizeArtifactForQueue(roadmap.content, roadmap.relPath)}`);
      }
    }

    sections.push(parts.join("\n"));
  }

  // Include queue log if it exists — shows what's been queued before
  const queuePath = resolveGsdRootFile(basePath, "QUEUE");
  if (existsSync(queuePath)) {
    const queueContent = await loadFile(queuePath);
    if (queueContent) {
      sections.push(`### Previous Queue Entries\nSource: \`${relGsdRootFile("QUEUE")}\`\n\n${queueContent.trim()}`);
    }
  }

  return capExistingMilestonesContext(sections);
}

function summarizeArtifactForQueue(
  content: string,
  sourcePath: string,
  cap = QUEUE_ARTIFACT_EXCERPT_MAX_CHARS,
): string {
  const trimmed = content.trim();
  if (trimmed.length <= cap) {
    return `Source: \`${sourcePath}\`\n\n${trimmed}`;
  }

  const excerpt = trimmed.slice(0, cap).trimEnd();
  const omittedChars = trimmed.length - excerpt.length;
  return [
    `Source: \`${sourcePath}\``,
    "",
    excerpt,
    "",
    `[Truncated ${omittedChars} chars. Read \`${sourcePath}\` for full content.]`,
  ].join("\n");
}

function capExistingMilestonesContext(
  sections: string[],
  cap = QUEUE_EXISTING_MILESTONES_CONTEXT_MAX_CHARS,
): string {
  const fullContext = sections.join(QUEUE_CONTEXT_SECTION_SEPARATOR);
  if (fullContext.length <= cap) return fullContext;

  const notice = `[Existing milestones context truncated to ${cap} chars. Read source paths in this prompt or the corresponding .gsd artifacts for full details.]`;
  const noticeSuffix = `${QUEUE_CONTEXT_SECTION_SEPARATOR}${notice}`;

  const selected: string[] = [];
  for (const section of sections) {
    const candidate = [...selected, section].join(QUEUE_CONTEXT_SECTION_SEPARATOR) + noticeSuffix;
    if (candidate.length <= cap) {
      selected.push(section);
      continue;
    }
    break;
  }

  if (selected.length === sections.length) {
    return selected.join(QUEUE_CONTEXT_SECTION_SEPARATOR) + noticeSuffix;
  }

  const compactTail = sections.slice(selected.length).map(compactSectionForQueueBudget);
  const hybrid = [...selected, ...compactTail].join(QUEUE_CONTEXT_SECTION_SEPARATOR) + noticeSuffix;
  if (hybrid.length <= cap) return hybrid;

  const compact = sections.map(compactSectionForQueueBudget);
  const compactContext = compact.join(QUEUE_CONTEXT_SECTION_SEPARATOR) + noticeSuffix;
  if (compactContext.length <= cap) return compactContext;

  return `${compactContext.slice(0, Math.max(0, cap - notice.length - 2)).trimEnd()}\n\n${notice}`;
}

function compactSectionForQueueBudget(section: string): string {
  const lines = section.split("\n");
  const compact: string[] = [];

  if (lines[0]) compact.push(lines[0]);

  const statusLine = lines.find(line => line.startsWith("**Status:**"));
  if (statusLine) compact.push(statusLine);

  const sourceLines = lines.filter(line => line.startsWith("Source: `"));
  if (sourceLines.length > 0) {
    compact.push("", "**Sources:**", ...sourceLines);
    compact.push("", "[Artifact excerpts omitted due to total queue/rethink context budget.]");
  }

  return compact.join("\n");
}
