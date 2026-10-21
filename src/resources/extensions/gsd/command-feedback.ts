/**
 * User-visible feedback when GSD commands cannot run or defer without action.
 *
 * Use guidance messages when:
 *   - A command was accepted but could not show its interactive menu
 *   - A command needs a direct target in non-interactive sessions (RPC/headless)
 *   - State guards block the command (prefer specific messages at the guard site)
 *
 * Do NOT notify when the user explicitly chose "Not yet" from an interactive menu.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { isInteractiveCommandContext } from "../shared/next-action-ui.js";

export { isInteractiveCommandContext };

export interface PickerCommandGuidance {
  command: string;
  reason: string;
  alternatives?: string[];
  hints?: string[];
}

function formatPickerGuidance({
  command,
  reason,
  alternatives = [],
  hints = [],
}: PickerCommandGuidance): string {
  const lines = [`${command} did not start: ${reason}`, ""];
  if (alternatives.length > 0) {
    lines.push("Try one of:");
    lines.push(...alternatives.map((line) => `  • ${line}`));
  }
  if (hints.length > 0) {
    if (alternatives.length > 0) lines.push("");
    lines.push(...hints.map((line) => `  • ${line}`));
  }
  if (alternatives.length === 0 && hints.length === 0) {
    lines.push("Run the command again from the GSD TUI.");
  }
  return lines.join("\n");
}

/** Generic picker guidance for slash commands that need an interactive menu. */
export function notifyPickerCommandNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  guidance: PickerCommandGuidance,
): void {
  ctx.ui.notify(formatPickerGuidance(guidance), "warning");
}

/** Menu could not be rendered; surface the caller's defer hint. */
export function notifyCommandMenuUnavailable(
  ctx: ExtensionCommandContext,
  commandLabel: string,
  notYetMessage?: string,
): void {
  const hint = notYetMessage?.trim() || "Run the command again from the GSD TUI.";
  ctx.ui.notify(
    `${commandLabel} menu could not be shown in this session.\n${hint}`,
    "warning",
  );
}

/** Guard for picker-driven commands without a direct target arg. */
export function requiresInteractiveMenu(
  ctx: ExtensionCommandContext,
  hasDirectTarget: boolean,
): boolean {
  return !hasDirectTarget && !isInteractiveCommandContext(ctx);
}

const DISCUSS_ALTERNATIVES = [
  "/gsd discuss M001 — milestone-level discussion",
  "/gsd discuss M001/S01 — slice interview",
  "/gsd discuss --milestone M001 or --slice M001/S01",
];

const DISCUSS_HINTS = [
  "/gsd stop — stop auto-mode first (interactive discuss mutates .gsd/)",
  "/gsd status — see current phase and next step",
];

/** Bare /gsd discuss needs a picker; explain alternatives when that is unavailable. */
export function notifyDiscussNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  notifyPickerCommandNeedsInteractiveMenu(ctx, {
    command: "/gsd discuss",
    reason,
    alternatives: DISCUSS_ALTERNATIVES,
    hints: DISCUSS_HINTS,
  });
}

/**
 * Hub picker for /gsd queue (reorder vs add) is unavailable.
 *
 * Unlike the other picker-guidance notices, /gsd queue does NOT dead-end here:
 * the caller falls through to the add-work flow, which runs headlessly. So this
 * notice must avoid the "did not start:" picker-failure phrasing — the headless
 * host classifies that as a blocked dead-end (see stop-notice.ts / #1294) and
 * would exit 10 before the add-work run starts.
 */
export function notifyQueueHubNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  ctx.ui.notify(
    [
      `/gsd queue reorder menu needs an interactive session (${reason}).`,
      "Continuing headless with the add-work flow.",
      "",
      "  • /gsd queue — run from the GSD TUI to reorder pending milestones",
      "  • /gsd status — see milestone order and phase",
    ].join("\n"),
    "warning",
  );
}

/** /gsd, /gsd new-milestone, /gsd new-project wizard menus. */
export function notifySmartEntryNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  notifyPickerCommandNeedsInteractiveMenu(ctx, {
    command: "/gsd",
    reason,
    alternatives: [
      "/gsd status — current phase and next step",
      "/gsd auto — resume auto-mode",
      "/gsd next — step one unit",
      "/gsd quick <task> — bounded one-off work",
      "/gsd discuss M001 — discuss with a direct target",
    ],
    hints: [
      "/gsd new-milestone — run from the GSD TUI to open the planning wizard",
    ],
  });
}

/** /gsd init onboarding wizard. */
export function notifyInitNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  notifyPickerCommandNeedsInteractiveMenu(ctx, {
    command: "/gsd init",
    reason,
    hints: [
      "Run /gsd init from the GSD TUI to configure git, preferences, and bootstrap .gsd/",
    ],
  });
}

/** /gsd migrate confirmation step. */
export function notifyMigrateNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  notifyPickerCommandNeedsInteractiveMenu(ctx, {
    command: "/gsd migrate",
    reason,
    hints: [
      "Run /gsd migrate from the GSD TUI to review the preview and confirm the write",
    ],
  });
}

/** /gsd forensics when input or opt-in picker is required. */
export function notifyForensicsNeedsInteractiveMenu(
  ctx: ExtensionCommandContext,
  reason: string,
): void {
  notifyPickerCommandNeedsInteractiveMenu(ctx, {
    command: "/gsd forensics",
    reason,
    alternatives: [
      '/gsd forensics "describe what went wrong" — pass the problem inline',
    ],
    hints: [
      "Set forensics_dedup in .gsd/PREFERENCES.md to skip the duplicate-detection prompt",
    ],
  });
}
