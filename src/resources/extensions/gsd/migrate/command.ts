/**
 * /gsd migrate — one-shot migration from .planning to .gsd
 *
 * Thin UX orchestrator: resolves paths, runs the validate → parse → transform →
 * preview → write pipeline, and shows confirmation UI via showNextAction.
 * All business logic lives in the pipeline modules (S01–S03).
 *
 * After a successful write, offers a read-only review that audits the output
 * for gsd-pi standards compliance.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "../paths.js";
import { showNextAction } from "../../shared/tui.js";
import {
  notifyMigrateNeedsInteractiveMenu,
  requiresInteractiveMenu,
} from "../command-feedback.js";
import { executeMigrationWrite, migrationFailureMessage, type MigrationExecutionResult } from "./execution.js";
import { createMigrationPlan } from "./plan.js";
import { buildMigrationPreviewSummary, buildReviewPrompt } from "./presentation.js";
import type { MigrationPreview } from "./writer.js";
import type { LegacyImportForwardRepairChoice } from "../legacy-import-forward-repair-plan.js";

/**
 * `/gsd migrate` Forward Repair choice tokens intentionally differ from the
 * `gsd recover --choice=i:kind:key:decision:hash` form: the migrate resume
 * command embeds each token inside one free-form slash-command string next to
 * a quoted legacy path, so the evidence payload is opaque base64url JSON with
 * a visible `.decision` suffix. Both parsers are strict — a malformed token
 * throws instead of being silently dropped.
 */
export function parseMigrationRecoveryArgs(args: string): {
  sourceArgs: string;
  choices: LegacyImportForwardRepairChoice[];
} {
  const pattern = /(?:^|\s)--forward-choice=([A-Za-z0-9_-]+)\.(preserve-later|restore-backup)(?=\s|$)/gu;
  const choices: LegacyImportForwardRepairChoice[] = [];
  const identities = new Set<string>();
  for (const match of args.matchAll(pattern)) {
    let evidence: unknown;
    try {
      evidence = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
    } catch {
      throw new Error("migration Forward Repair choice token is invalid");
    }
    if (evidence === null
      || typeof evidence !== "object"
      || Object.keys(evidence).sort().join(",") !== "instructionIndex,reviewHash,targetKey,targetKind"
      || !Number.isSafeInteger((evidence as LegacyImportForwardRepairChoice).instructionIndex)
      || (evidence as LegacyImportForwardRepairChoice).instructionIndex < 0
      || typeof (evidence as LegacyImportForwardRepairChoice).targetKind !== "string"
      || (evidence as LegacyImportForwardRepairChoice).targetKind.length === 0
      || typeof (evidence as LegacyImportForwardRepairChoice).targetKey !== "string"
      || (evidence as LegacyImportForwardRepairChoice).targetKey.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test((evidence as LegacyImportForwardRepairChoice).reviewHash)) {
      throw new Error("migration Forward Repair choice token is invalid");
    }
    const choice = {
      ...(evidence as Omit<LegacyImportForwardRepairChoice, "decision">),
      decision: match[2] as LegacyImportForwardRepairChoice["decision"],
    };
    const identity = `${choice.instructionIndex}\0${choice.targetKind}\0${choice.targetKey}`;
    if (identities.has(identity)) throw new Error("migration Forward Repair choice target is duplicated");
    identities.add(identity);
    choices.push(choice);
  }
  const sourceArgs = args.replace(pattern, " ").trim().replace(/^"(.*)"$/u, "$1");
  if (sourceArgs.includes("--forward-choice=")) {
    throw new Error("migration Forward Repair choice token is invalid");
  }
  return { sourceArgs, choices };
}

function dispatchReview(
  pi: ExtensionAPI,
  sourcePath: string,
  gsdPath: string,
  preview: MigrationPreview,
): void {
  const prompt = buildReviewPrompt({ sourcePath, gsdPath, preview });

  pi.sendMessage(
    {
      customType: "gsd-migrate-review",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

export async function handleMigrate(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  let recovery;
  try {
    recovery = parseMigrationRecoveryArgs(args);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const plan = await createMigrationPlan(recovery.sourceArgs);
  const { sourcePath, targetRoot } = plan;

  if (plan.status === "missing-source") {
    ctx.ui.notify(
      `Directory not found: ${sourcePath}\n\n` +
      "Migration converts a .planning/ directory (from older GSD versions) into .gsd/ format.\n" +
      "If you are starting a new project, use /gsd:new-project instead.\n" +
      "If migrating, ensure the path contains a .planning/ directory.",
      "error",
    );
    return;
  }

  for (const warning of plan.warnings) {
    ctx.ui.notify(`⚠ ${warning.message} (${warning.file})`, "warning");
  }
  for (const fatal of plan.fatals) {
    ctx.ui.notify(`✖ ${fatal.message} (${fatal.file})`, "error");
  }

  if (plan.status === "invalid") {
    ctx.ui.notify(
      "Migration blocked — fix the fatal issues above before retrying.",
      "error",
    );
    return;
  }

  if (plan.status === "blocked") {
    ctx.ui.notify(plan.message, "error");
    return;
  }

  const { project, preview } = plan;

  // ── Build preview text ─────────────────────────────────────────────────────
  const lines = buildMigrationPreviewSummary(preview, targetRoot);

  // ── Confirmation via showNextAction ────────────────────────────────────────
  if (requiresInteractiveMenu(ctx, false)) {
    notifyMigrateNeedsInteractiveMenu(ctx, "migration confirmation needs an interactive menu");
    return;
  }

  const choice = await showNextAction(ctx, {
    title: "Migration preview",
    summary: lines,
    actions: [
      {
        id: "confirm",
        label: "Write .gsd directory",
        description: `Migrate ${preview.milestoneCount} milestone(s) to ${gsdRoot(targetRoot)}`,
        recommended: true,
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Exit without writing anything",
      },
    ],
    notYetMessage: "Run /gsd migrate again when ready.",
  });

  if (choice !== "confirm") {
    ctx.ui.notify("Migration cancelled — no files were written.", "info");
    return;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  ctx.ui.notify("Writing .gsd directory and importing DB state…", "info");

  let execution: MigrationExecutionResult;
  try {
    execution = await executeMigrationWrite(sourcePath, targetRoot, project, preview, undefined, recovery.choices);
  } catch (err) {
    ctx.ui.notify(
      migrationFailureMessage(err),
      "error",
    );
    return;
  }

  const gsdPath = gsdRoot(targetRoot);
  const { written, imported } = execution;

  ctx.ui.notify(
    `✓ Migration complete — ${written.paths.length} file(s) written to .gsd/, ${imported.hierarchy.milestones}M/${imported.hierarchy.slices}S/${imported.hierarchy.tasks}T imported to the database, and ${execution.audit.importedArtifacts} audit artifact(s) recorded`,
    "info",
  );

  // ── Post-write review offer ────────────────────────────────────────────────
  const reviewChoice = await showNextAction(ctx, {
    title: "Migration written",
    summary: [
      `${written.paths.length} files written to .gsd/`,
      `${imported.hierarchy.milestones} milestone(s), ${imported.hierarchy.slices} slice(s), and ${imported.hierarchy.tasks} task(s) imported to gsd.db`,
      `Legacy source archived at ${execution.legacyArchive.archivePath}`,
      `Migration audit written at ${execution.audit.migrationPath}`,
      "",
      "The agent can now review the migrated output against gsd-pi standards —",
      "checking structure, content quality, deriveState() round-trip, and",
      "requirement statuses. The review is read-only by default.",
    ],
    actions: [
      {
        id: "review",
        label: "Review migration",
        description: "Agent audits the .gsd output and reports PASS/FAIL per category",
        recommended: true,
      },
      {
        id: "skip",
        label: "Skip review",
        description: "Trust the migration output as-is",
      },
    ],
    notYetMessage: "Run /gsd migrate again to re-migrate, or review .gsd manually.",
  });

  if (reviewChoice === "review") {
    dispatchReview(pi, sourcePath, gsdPath, preview);
  }
}
