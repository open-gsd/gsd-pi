// Project/App: gsd-pi
// File Purpose: Backlog items as Domain Operation events; BACKLOG.md is their render.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";
import { noteRenderedProjectionFile } from "./compat/compat-marker.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDbOrNull } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { executeDomainOperation, isDbAvailable } from "./gsd-db.js";
import { gsdRoot } from "./paths.js";
import { logWarning } from "./workflow-logger.js";

export interface BacklogItem {
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

/** Item header lines of BACKLOG.md. Used only by the import and the render. */
function parseBacklogFile(basePath: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const line of readBacklogLines(basePath) ?? []) {
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

// ─── Database rows ────────────────────────────────────────────────────────

interface BacklogRow extends BacklogItem {
  removed: boolean;
}

/** Every backlog item the database holds, removed ones included, in registration order. */
function readBacklogRows(): BacklogRow[] {
  const events = getDbOrNull()?.prepare(`
    SELECT event_type, entity_id, payload_json
    FROM workflow_domain_events
    WHERE entity_type = 'backlog_item'
    ORDER BY project_revision, event_index
  `).all() ?? [];
  const rows = new Map<string, BacklogRow>();
  for (const event of events) {
    const id = String(event["entity_id"]);
    const payload = JSON.parse(String(event["payload_json"])) as Record<string, string | undefined>;
    if (event["event_type"] === "backlog.registered") {
      rows.set(id, { id, title: payload.title ?? "", note: payload.note ?? "", done: false, removed: false });
      continue;
    }
    const row = rows.get(id);
    if (!row) continue;
    if (event["event_type"] === "backlog.promoted") {
      row.done = true;
      row.note = payload.note ?? "";
    } else if (event["event_type"] === "backlog.removed") {
      row.removed = true;
    }
  }
  return [...rows.values()];
}

/** The backlog items, read only from the database. Empty when no database is open. */
export function loadBacklogItems(): BacklogItem[] {
  return readBacklogRows()
    .filter((row) => !row.removed)
    .map(({ removed: _removed, ...item }) => item);
}

interface BacklogEvent {
  eventType: "backlog.registered" | "backlog.promoted" | "backlog.removed";
  entityId: string;
  payload: DomainJsonValue;
}

/** Run one backlog Domain Operation, then render BACKLOG.md from the committed rows. */
function runBacklogOperation(
  basePath: string,
  operationType: string,
  payload: DomainJsonValue,
  events: BacklogEvent[],
): void {
  if (!isDbAvailable()) throw new Error(`${operationType} requires the GSD database`);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey: `${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "operator",
    sourceTransport: "internal",
    payload,
  }, () => ({
    events: events.map((event) => ({ ...event, entityType: "backlog_item", destinations: ["projection"] })),
    projections: [{ projectionKey: "backlog", projectionKind: "markdown", rendererVersion: "1" }],
  }));
  try {
    renderBacklogProjection(basePath);
  } catch (err) {
    // The operation is committed and its Projection Work row stays pending for the worker.
    logWarning("projection", `BACKLOG.md render failed: ${(err as Error).message}`);
  }
}

/**
 * Item header lines of BACKLOG.md whose id no database item holds (written
 * by an older release, by hand, or by a teammate's commit). They are not read
 * as state: doctor reports them and `doctor --fix` imports them.
 */
export function unimportedFileBacklogItems(basePath: string): BacklogItem[] {
  const knownIds = new Set(readBacklogRows().map((row) => row.id));
  return parseBacklogFile(basePath).filter((item) => !knownIds.has(item.id));
}

/** doctor --fix: record file items as backlog events in one backlog.import Domain Operation. */
export function importFileBacklogItems(basePath: string, items: readonly BacklogItem[]): void {
  if (items.length === 0) return;
  runBacklogOperation(basePath, "backlog.import", { itemIds: items.map((item) => item.id) },
    items.flatMap((item): BacklogEvent[] => [
      { eventType: "backlog.registered", entityId: item.id, payload: { title: item.title, note: item.note } },
      ...(item.done
        ? [{ eventType: "backlog.promoted" as const, entityId: item.id, payload: { note: item.note } }]
        : []),
    ]));
}

/**
 * Write BACKLOG.md from the database: each database item's header line is
 * set (or appended), and a removed item's lines are deleted. Every other
 * line of the file is kept as it is.
 */
export function renderBacklogProjection(basePath: string): void {
  const rows = readBacklogRows();
  if (rows.length === 0) return;
  const lines = readBacklogLines(basePath) ?? ["# Backlog", "", ""];
  for (const row of rows) {
    const index = findItemHeader(lines, row.id);
    if (row.removed) {
      // Delete the header line and its continuation lines (up to the next item header)
      if (index !== -1) lines.splice(index, itemEnd(lines, index) - index);
      continue;
    }
    const line = `- [${row.done ? "x" : " "}] ${row.id} — ${row.title}${row.note ? ` (${row.note})` : ""}`;
    if (index !== -1) {
      lines[index] = line;
    } else {
      // Insert before the trailing empty line produced by the final newline
      const insertAt = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      lines.splice(insertAt, 0, line);
    }
  }
  const content = lines.join("\n");
  const path = backlogPath(basePath);
  atomicWriteSync(path, content, "utf-8");
  noteRenderedProjectionFile(path, content);
}

/**
 * Next id = max 999.N in the database and in the raw file lines, +1. Scanning
 * every line (not just parseable headers) avoids colliding with a file entry
 * that is not imported yet.
 */
function nextBacklogId(basePath: string): string {
  let maxNum = 0;
  const texts = [...readBacklogRows().map((row) => row.id), ...(readBacklogLines(basePath) ?? [])];
  for (const text of texts) {
    const match = text.match(/999\.(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `999.${maxNum + 1}`;
}

/** Record one new item in a backlog.add Domain Operation. Returns its id. */
export function addBacklogItem(basePath: string, title: string): string {
  const id = nextBacklogId(basePath);
  const note = `added ${new Date().toISOString().slice(0, 10)}`;
  runBacklogOperation(basePath, "backlog.add", { itemId: id, title }, [
    { eventType: "backlog.registered", entityId: id, payload: { title, note } },
  ]);
  return id;
}

/** Record that an item became the given milestone, in a backlog.promote Domain Operation. */
export function promoteBacklogItem(basePath: string, itemId: string, milestoneId: string): void {
  const note = `promoted ${new Date().toISOString().slice(0, 10)} as ${milestoneId}`;
  runBacklogOperation(basePath, "backlog.promote", { itemId, milestoneId }, [
    { eventType: "backlog.promoted", entityId: itemId, payload: { milestoneId, note } },
  ]);
}

/** Remove an item in a backlog.remove Domain Operation. */
export function removeBacklogItem(basePath: string, itemId: string): void {
  runBacklogOperation(basePath, "backlog.remove", { itemId }, [
    { eventType: "backlog.removed", entityId: itemId, payload: {} },
  ]);
}
