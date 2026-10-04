/**
 * GSD Command — /gsd backlog
 *
 * Structured backlog management with 999.x numbering.
 * Items are database rows (see backlog.ts); `.gsd/BACKLOG.md` is their render.
 * Promote registers a queued milestone for the item.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  addBacklogItem,
  loadBacklogItems,
  promoteBacklogItem,
  removeBacklogItem,
  unimportedFileBacklogItems,
} from "./backlog.js";
import { invalidateAllCaches } from "./cache.js";
import { nextMilestoneIdReserved } from "./milestone-id-reservation.js";
import { findMilestoneIds, releaseMilestoneId } from "./milestone-ids.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { renderStateProjection } from "./workflow-projections.js";

// ─── Command ──────────────────────────────────────────────────────────────

async function listBacklog(basePath: string, ctx: ExtensionCommandContext): Promise<void> {
  const items = loadBacklogItems();
  const unimported = unimportedFileBacklogItems(basePath).length;
  const importHint = unimported > 0
    ? `\n${unimported} item(s) in BACKLOG.md are not in the database. Run /gsd doctor --fix to import them.`
    : "";
  if (items.length === 0) {
    ctx.ui.notify(`Backlog is empty. Add items with /gsd backlog add <title>${importHint}`, "info");
    return;
  }

  const lines = ["Backlog:\n"];
  for (const item of items) {
    const status = item.done ? "✓" : "○";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`  ${status} ${item.id} — ${item.title}${note}`);
  }
  const pending = items.filter((i) => !i.done).length;
  lines.push(`\n${pending} pending, ${items.length - pending} promoted/done${importHint}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAdd(basePath: string, title: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!title) {
    ctx.ui.notify("Usage: /gsd backlog add <title>", "warning");
    return;
  }

  const id = addBacklogItem(basePath, title.replace(/^['"]|['"]$/g, ""));

  ctx.ui.notify(`Added ${id}: "${title}"`, "success");
}

async function handlePromote(
  basePath: string,
  itemId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog promote <id>\nExample: /gsd backlog promote 999.1", "warning");
    return;
  }

  const item = loadBacklogItems().find((entry) => entry.id === itemId);
  if (!item) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }
  if (item.done) {
    ctx.ui.notify(`${itemId} is already promoted/done.`, "info");
    return;
  }

  // One backlog.promote Domain Operation registers a queued milestone for the
  // item and records the promotion with the milestone id.
  // The id is a new one: an id that another flow reserved (a new-milestone
  // discussion that showed it to the user) is not taken. This command
  // registers the id at once, so it does not stay reserved.
  const uniqueEnabled = !!loadEffectiveGSDPreferences(basePath)?.preferences?.unique_milestone_ids;
  const milestoneId = nextMilestoneIdReserved(findMilestoneIds(basePath), uniqueEnabled, basePath);
  releaseMilestoneId(milestoneId);
  promoteBacklogItem(basePath, item, milestoneId);
  invalidateAllCaches();
  await renderStateProjection(basePath);

  ctx.ui.notify(`Promoted ${itemId}: "${item.title}" — queued as milestone ${milestoneId}.`, "info");
}

async function handleRemove(basePath: string, itemId: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog remove <id>", "warning");
    return;
  }

  const item = loadBacklogItems().find((entry) => entry.id === itemId);
  if (!item) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  removeBacklogItem(basePath, itemId);
  ctx.ui.notify(`Removed ${itemId}: "${item.title}"`, "success");
}

export async function handleBacklog(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");

  // Backlog items are database rows; BACKLOG.md is their render.
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  if (!(await ensureDbOpen(basePath))) {
    ctx.ui.notify("Backlog is not available: the GSD database could not be opened.", "error");
    return;
  }

  switch (sub) {
    case "":
      return listBacklog(basePath, ctx);
    case "add":
      return handleAdd(basePath, rest, ctx);
    case "promote":
      return handlePromote(basePath, rest.trim(), ctx);
    case "remove":
      return handleRemove(basePath, rest.trim(), ctx);
    default:
      // Treat as implicit add
      return handleAdd(basePath, args, ctx);
  }
}
