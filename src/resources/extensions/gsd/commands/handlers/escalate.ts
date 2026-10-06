// GSD Extension — /gsd escalate Command Handler (ADR-011 Phase 2)
// Surface and resolve mid-execution escalations from the CLI.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { projectRoot } from "../context.js";
import { getActiveMilestoneId } from "../../state.js";
import {
  readTaskEscalation,
  readLegacyEscalation,
  formatEscalationForDisplay,
  formatLegacyEscalationNotice,
  resolveEscalation,
  listActionableEscalations,
  listAllEscalations,
} from "../../escalation.js";
import { recordEscalationDecision } from "../../escalation-resolution.js";
import { loadEffectiveGSDPreferences } from "../../preferences.js";
import { renderStateProjection } from "../../workflow-projections.js";

function helpMessage(): string {
  return [
    "/gsd escalate — manage mid-execution escalations (ADR-011 Phase 2)",
    "",
    "Subcommands:",
    "  list [--all]           show pending escalations (use --all to include resolved)",
    "  show <taskId>          print the escalation artifact",
    "  resolve <taskId> <choice> [rationale...]",
    "                         resolve an escalation — choice is an option id,",
    "                         `accept` (use recommendation), or `reject-blocker`",
    "                         (convert to a blocker and trigger slice replan)",
    "",
    "Note: disabling `phases.mid_execution_escalation` does NOT clear pending",
    "escalations. If you need to drain them, re-enable the flag, resolve via",
    "`/gsd escalate resolve`, then disable.",
  ].join("\n");
}

function formatListEntries(
  rows: ReturnType<typeof listActionableEscalations>,
): string {
  if (rows.length === 0) return "No escalations.";
  return rows.map((t) => {
    const escalation = readTaskEscalation(t.milestone_id, t.slice_id, t.id);
    // A listed Task with no question row has an escalation from before the
    // database stored them: a pause, or a response that is not applied.
    if (!escalation) {
      return t.escalation_pending || t.escalation_awaiting_review
        ? `  ${t.slice_id}/${t.id}  [PENDING (paused)]  (question not in the database — run /gsd escalate show ${t.id})`
        : `  ${t.slice_id}/${t.id}  [resolved, NOT applied]  (response is not in the database and is not carried into the next task — run /gsd doctor --fix)`;
    }
    const status = escalation.respondedAt ? "resolved" : escalation.continueWithDefault ? "awaiting-review" : "PENDING (paused)";
    return `  ${t.slice_id}/${t.id}  [${status}]  ${escalation.question}`;
  }).join("\n");
}

export async function handleEscalateCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  void pi;

  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "help") {
    ctx.ui.notify(helpMessage(), "info");
    return;
  }

  const basePath = projectRoot();
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  if (prefs?.phases?.mid_execution_escalation !== true) {
    ctx.ui.notify(
      "Escalation is off. Enable with `phases: { mid_execution_escalation: true }` in your PREFERENCES.md.",
      "warning",
    );
    return;
  }

  const milestoneId = await getActiveMilestoneId(basePath);
  if (!milestoneId) {
    ctx.ui.notify("No active milestone — cannot list escalations.", "warning");
    return;
  }

  // ── list ────────────────────────────────────────────────────────────────
  if (trimmed === "list" || trimmed === "list --all" || trimmed === "--all") {
    const includeAll = trimmed.includes("--all");
    const rows = includeAll ? listAllEscalations(milestoneId) : listActionableEscalations(milestoneId);
    const body = formatListEntries(rows);
    ctx.ui.notify(
      `${includeAll ? "All escalations" : "Actionable escalations"} for ${milestoneId}:\n${body}`,
      "info",
    );
    return;
  }

  // Parse a possibly-slice-qualified task id: "Sxx/Tyy" or plain "Tyy".
  // Returns { sliceId?, taskId }.
  const parseTaskRef = (ref: string): { sliceId?: string; taskId: string } => {
    const slash = ref.indexOf("/");
    if (slash > 0) {
      return { sliceId: ref.slice(0, slash), taskId: ref.slice(slash + 1) };
    }
    return { taskId: ref };
  };

  // Resolve a task ref to a single row, surfacing ambiguity when a bare task
  // id matches more than one slice.
  const locateRow = (ref: string): ReturnType<typeof listAllEscalations>[number] | "ambiguous" | "not-found" => {
    const { sliceId, taskId } = parseTaskRef(ref);
    const rows = listAllEscalations(milestoneId).filter(
      (t) => t.id === taskId && (sliceId === undefined || t.slice_id === sliceId),
    );
    if (rows.length === 0) return "not-found";
    if (rows.length > 1) return "ambiguous";
    return rows[0]!;
  };

  // ── show <taskRef> ──────────────────────────────────────────────────────
  if (trimmed.startsWith("show ")) {
    const ref = trimmed.slice(5).trim();
    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found") {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const escalation = readTaskEscalation(milestoneId, row.slice_id, row.id) ?? readLegacyEscalation(basePath, row);
    if (!escalation) {
      ctx.ui.notify(formatLegacyEscalationNotice(row), "warning");
      return;
    }
    ctx.ui.notify(formatEscalationForDisplay(escalation), "info");
    return;
  }

  // ── resolve <taskRef> <choice> [rationale...] ───────────────────────────
  if (trimmed.startsWith("resolve ")) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const ref = parts[0];
    const choice = parts[1];
    const rationale = parts.slice(2).join(" ").trim();
    if (!ref || !choice) {
      ctx.ui.notify("Usage: /gsd escalate resolve <taskId|Sxx/Tyy> <choice> [rationale...]", "warning");
      return;
    }

    const row = locateRow(ref);
    if (row === "ambiguous") {
      ctx.ui.notify(`Task ${ref} matches multiple slices. Use Sxx/Tyy format.`, "warning");
      return;
    }
    if (row === "not-found") {
      ctx.ui.notify(`No escalation found for ${ref} in ${milestoneId}.`, "warning");
      return;
    }
    const taskId = row.id;

    const result = resolveEscalation(basePath, milestoneId, row.slice_id, taskId, choice, rationale);
    await renderStateProjection(basePath);

    if (result.status !== "resolved" && result.status !== "rejected-to-blocker") {
      ctx.ui.notify(result.message, result.status === "invalid-choice" ? "warning" : "error");
      return;
    }

    // Persist the user's choice as a decision (only for resolved, not reject-blocker).
    if (result.status === "resolved") {
      try {
        const decisionId = await recordEscalationDecision(
          basePath, { milestoneId, sliceId: row.slice_id, taskId }, choice, rationale, result.chosenOption,
        );

        ctx.ui.notify(
          `${result.message}\nDecision recorded as ${decisionId}. Run /gsd auto to continue.`,
          "success",
        );
      } catch (decErr) {
        ctx.ui.notify(
          `${result.message}\nWARN: decision persistence failed: ${(decErr as Error).message}`,
          "warning",
        );
      }
      return;
    }

    // rejected-to-blocker path
    ctx.ui.notify(`${result.message} Run /gsd auto to trigger the replan.`, "success");
    return;
  }

  ctx.ui.notify(`Unknown subcommand. ${helpMessage()}`, "warning");
}
