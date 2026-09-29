/**
 * GSD Command — /gsd backlog
 *
 * Structured backlog management with 999.x numbering.
 * Items stored in .gsd/BACKLOG.md as markdown checklist.
 * Items can be promoted to active slices via add-slice.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";

interface BacklogItem {
  id: string;
  title: string;
  done: boolean;
  note: string;
}

const ITEM_HEADER_RE = /^- \[([ x])\] (999\.\d+) — (.+?)(?:\s*\((.+)\))?$/;

function backlogPath(basePath: string): string {
  return join(gsdRoot(basePath), "BACKLOG.md");
}

/** Raw file lines, or null when the file does not exist. */
function readBacklogLines(basePath: string): string[] | null {
  const filePath = backlogPath(basePath);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8").split("\n");
}

function writeBacklogLines(basePath: string, lines: string[]): void {
  atomicWriteSync(backlogPath(basePath), lines.join("\n"), "utf-8");
}

function parseBacklog(basePath: string): BacklogItem[] {
  const lines = readBacklogLines(basePath);
  if (!lines) return [];

  const items: BacklogItem[] = [];
  for (const line of lines) {
    const match = line.match(ITEM_HEADER_RE);
    if (match) {
      items.push({
        id: match[2],
        title: match[3].trim(),
        done: match[1] === "x",
        note: match[4] ?? "",
      });
    }
  }

  return items;
}

/** Index of the item header line with the given id, or -1. */
function findItemHeader(lines: string[], itemId: string): number {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ITEM_HEADER_RE);
    if (match && match[2] === itemId) return i;
  }
  return -1;
}

/**
 * End (exclusive) of an item's lines: the following blank or whitespace-indented
 * lines, stopping at the first non-blank line that starts at column 0
 * (hyphen-dash entries, separators, free text) or at EOF.
 */
function itemEnd(lines: string[], headerIndex: number): number {
  // Keep the trailing empty line produced by the final newline
  const limit = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  let end = headerIndex + 1;
  while (end < limit) {
    const line = lines[end];
    if (line !== "" && !/^\s/.test(line)) break;
    end++;
  }
  return end;
}

/**
 * Next id = max 999.N found in the raw file lines, +1. Scanning every line
 * (not just parseable headers) avoids colliding with nonconforming entries.
 */
function nextBacklogId(lines: string[]): string {
  let maxNum = 0;
  for (const line of lines) {
    const match = line.match(/999\.(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `999.${maxNum + 1}`;
}

async function listBacklog(basePath: string, ctx: ExtensionCommandContext): Promise<void> {
  const items = parseBacklog(basePath);
  if (items.length === 0) {
    ctx.ui.notify("Backlog is empty. Add items with /gsd backlog add <title>", "info");
    return;
  }

  const lines = ["Backlog:\n"];
  for (const item of items) {
    const status = item.done ? "✓" : "○";
    const note = item.note ? ` (${item.note})` : "";
    lines.push(`  ${status} ${item.id} — ${item.title}${note}`);
  }
  const pending = items.filter((i) => !i.done).length;
  lines.push(`\n${pending} pending, ${items.length - pending} promoted/done`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function addBacklogItem(basePath: string, title: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!title) {
    ctx.ui.notify("Usage: /gsd backlog add <title>", "warning");
    return;
  }

  const lines = readBacklogLines(basePath);
  const id = nextBacklogId(lines ?? []);
  const date = new Date().toISOString().slice(0, 10);
  const itemLine = `- [ ] ${id} — ${title.replace(/^['"]|['"]$/g, "")} (added ${date})`;

  if (lines === null) {
    writeBacklogLines(basePath, ["# Backlog", "", itemLine, ""]);
  } else {
    // Lossless append — insert before the trailing empty line produced by the final newline
    const insertAt = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(insertAt, 0, itemLine);
    writeBacklogLines(basePath, lines);
  }

  ctx.ui.notify(`Added ${id}: "${title}"`, "success");
}

async function promoteBacklogItem(
  basePath: string,
  itemId: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog promote <id>\nExample: /gsd backlog promote 999.1", "warning");
    return;
  }

  const lines = readBacklogLines(basePath);
  if (lines === null) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  const idx = findItemHeader(lines, itemId);
  if (idx === -1) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  const item = lines[idx].match(ITEM_HEADER_RE)!;
  if (item[1] === "x") {
    ctx.ui.notify(`${itemId} is already promoted/done.`, "info");
    return;
  }

  // Promote — currently requires single-writer engine (not yet available)
  // Mark as promoted in backlog for now; slice creation will be available with the engine.
  const title = item[3].trim();
  lines[idx] = `- [x] ${itemId} — ${title} (promoted ${new Date().toISOString().slice(0, 10)})`;
  writeBacklogLines(basePath, lines);
  ctx.ui.notify(`Promoted ${itemId}: "${title}" — add it to the roadmap manually or wait for engine slice commands.`, "info");
}

async function removeBacklogItem(basePath: string, itemId: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!itemId) {
    ctx.ui.notify("Usage: /gsd backlog remove <id>", "warning");
    return;
  }

  const lines = readBacklogLines(basePath);
  const idx = lines ? findItemHeader(lines, itemId) : -1;

  if (!lines || idx === -1) {
    ctx.ui.notify(`Backlog item ${itemId} not found.`, "warning");
    return;
  }

  const title = lines[idx].match(ITEM_HEADER_RE)![3].trim();

  // Delete the header line and its continuation lines (up to the next item header)
  lines.splice(idx, itemEnd(lines, idx) - idx);
  writeBacklogLines(basePath, lines);
  ctx.ui.notify(`Removed ${itemId}: "${title}"`, "success");
}

export async function handleBacklog(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "":
      return listBacklog(basePath, ctx);
    case "add":
      return addBacklogItem(basePath, rest, ctx);
    case "promote":
      return promoteBacklogItem(basePath, rest.trim(), ctx, pi);
    case "remove":
      return removeBacklogItem(basePath, rest.trim(), ctx);
    default:
      // Treat as implicit add
      return addBacklogItem(basePath, args, ctx);
  }
}
