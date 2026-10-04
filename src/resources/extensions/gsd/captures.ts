// Project/App: gsd-pi
// File Purpose: Captures as Domain Operation events; CAPTURES.md is their render.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteSync } from "./atomic-write.js";
import { noteRenderedProjectionFile } from "./compat/compat-marker.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDbOrNull } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { executeDomainOperation, isDbAvailable } from "./gsd-db.js";
import { gsdRoot } from "./paths.js";
import { logWarning } from "./workflow-logger.js";
import { readActiveMilestoneId } from "./state.js";
import { projectRootFromWorktreePath } from "./worktree-root.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Classification = "quick-task" | "inject" | "defer" | "replan" | "note" | "stop" | "backtrack";

export interface CaptureEntry {
  id: string;
  text: string;
  timestamp: string;
  status: "pending" | "triaged" | "resolved";
  classification?: Classification;
  resolution?: string;
  rationale?: string;
  resolvedAt?: string;
  resolvedInMilestone?: string;
  executed?: boolean;
  executedAt?: string;
}

export interface TriageResult {
  captureId: string;
  classification: Classification;
  rationale: string;
  affectedFiles?: string[];
  targetSlice?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CAPTURES_FILENAME = "CAPTURES.md";
export const VALID_CLASSIFICATIONS: readonly string[] = [
  "quick-task", "inject", "defer", "replan", "note", "stop", "backtrack",
];

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Path of the CAPTURES.md render. A worktree base path resolves to the
 * project root's `.gsd/CAPTURES.md`, so there is one render per project.
 */
export function resolveCapturesPath(basePath: string): string {
  const projectRoot = projectRootFromWorktreePath(resolve(basePath));
  if (projectRoot) {
    return join(projectRoot, ".gsd", CAPTURES_FILENAME);
  }
  return join(gsdRoot(basePath), CAPTURES_FILENAME);
}

// ─── Domain Operations ────────────────────────────────────────────────────────

interface CaptureEvent {
  eventType: "capture.registered" | "capture.resolved" | "capture.executed";
  entityId: string;
  payload: DomainJsonValue;
}

/** Run one capture Domain Operation, then render CAPTURES.md from the committed rows. */
function runCaptureOperation(
  basePath: string,
  operationType: string,
  payload: DomainJsonValue,
  buildEvents: () => CaptureEvent[],
  invocation?: ExecutionInvocation,
): void {
  if (!isDbAvailable()) throw new Error(`${operationType} requires the GSD database`);
  const fence = readDomainOperationFence(invocation?.idempotencyKey);
  executeDomainOperation({
    operationType,
    idempotencyKey: invocation?.idempotencyKey ?? `${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation?.actorType ?? "operator",
    ...(invocation?.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation?.sourceTransport ?? "internal",
    ...(invocation?.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation?.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  }, () => ({
    events: buildEvents().map((event) => ({ ...event, entityType: "capture", destinations: ["projection"] })),
    projections: [{ projectionKey: "captures", projectionKind: "markdown", rendererVersion: "1" }],
  }));
  try {
    renderCapturesProjection(basePath);
  } catch (err) {
    // The operation is committed and its Projection Work row stays pending for the worker.
    logWarning("projection", `CAPTURES.md render failed: ${(err as Error).message}`);
  }
}

/** `/gsd capture`: record one pending capture in a capture.register Domain Operation. Returns its id. */
export function appendCapture(basePath: string, text: string): string {
  const id = `CAP-${randomUUID().slice(0, 8)}`;
  runCaptureOperation(basePath, "capture.register", { captureId: id, text }, () => [
    { eventType: "capture.registered", entityId: id, payload: { text } },
  ]);
  return id;
}

function requireCapture(captureId: string): void {
  if (!loadAllCaptures("").some((capture) => capture.id === captureId)) {
    throw new Error(`capture ${captureId} is not in the GSD database`);
  }
}

/**
 * Classify one capture in a capture.resolve Domain Operation. An unknown id
 * fails loud. With no `milestoneId`, the operation records the active
 * Milestone that the database holds in the same transaction.
 */
export function markCaptureResolved(
  basePath: string,
  captureId: string,
  classification: Classification,
  resolution: string,
  rationale: string,
  milestoneId?: string,
  invocation?: ExecutionInvocation,
): void {
  requireCapture(captureId);
  const payload = { captureId, classification, resolution, rationale, ...(milestoneId ? { milestoneId } : {}) };
  runCaptureOperation(basePath, "capture.resolve", payload, () => {
    const resolvedIn = milestoneId ?? readActiveMilestoneId();
    return [{
      eventType: "capture.resolved",
      entityId: captureId,
      payload: { ...payload, ...(resolvedIn ? { milestoneId: resolvedIn } : {}) },
    }];
  }, invocation);
}

/** Record that a capture's resolution was carried out, in a capture.execute Domain Operation. An unknown id fails loud. */
export function markCaptureExecuted(
  basePath: string,
  captureId: string,
  detail: { [key: string]: DomainJsonValue } = {},
  invocation?: ExecutionInvocation,
): void {
  requireCapture(captureId);
  const payload = { captureId, ...detail };
  runCaptureOperation(basePath, "capture.execute", payload, () => [
    { eventType: "capture.executed", entityId: captureId, payload },
  ], invocation);
}

// ─── Readers ──────────────────────────────────────────────────────────────────

/**
 * Every capture in registration order, read only from the database. Empty
 * when no database is open. The latest classification of a capture wins; an
 * event for an id that was never registered is ignored.
 */
export function loadAllCaptures(_basePath: string): CaptureEntry[] {
  const rows = getDbOrNull()?.prepare(`
    SELECT event_type, entity_id, payload_json, created_at
    FROM workflow_domain_events
    WHERE entity_type = 'capture'
    ORDER BY project_revision, event_index
  `).all() ?? [];
  const captures = new Map<string, CaptureEntry>();
  for (const row of rows) {
    const id = String(row["entity_id"]);
    const at = String(row["created_at"]);
    const payload = JSON.parse(String(row["payload_json"])) as Record<string, string | undefined>;
    if (row["event_type"] === "capture.registered") {
      captures.set(id, { id, text: payload.text ?? "", timestamp: payload.timestamp ?? at, status: "pending" });
      continue;
    }
    const capture = captures.get(id);
    if (!capture) continue;
    if (row["event_type"] === "capture.resolved") {
      capture.status = "resolved";
      capture.classification = payload.classification as Classification;
      capture.resolution = payload.resolution;
      capture.rationale = payload.rationale;
      capture.resolvedAt = payload.resolvedAt ?? at;
      if (payload.milestoneId) capture.resolvedInMilestone = payload.milestoneId;
      else delete capture.resolvedInMilestone;
    } else if (row["event_type"] === "capture.executed") {
      capture.executed = true;
      capture.executedAt = payload.executedAt ?? at;
    }
  }
  return [...captures.values()];
}

/**
 * Load only pending (unresolved) captures.
 */
export function loadPendingCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.status === "pending");
}

export function countPendingCaptures(basePath: string): number {
  return loadPendingCaptures(basePath).length;
}

export function hasPendingCaptures(basePath: string): boolean {
  return countPendingCaptures(basePath) > 0;
}

/**
 * Load resolved captures that have actionable classifications (inject, replan,
 * quick-task) but have NOT yet been executed.
 * These are captures whose resolutions need to be carried out.
 *
 * When `currentMilestoneId` is provided, captures resolved in a *different*
 * milestone are treated as stale and excluded.  This prevents quick-task
 * captures from a prior milestone re-executing after the underlying issues
 * were already fixed by planned milestone work (#2872).
 *
 * Captures that have no `resolvedInMilestone` (resolved with no active
 * milestone, or imported from an older CAPTURES.md) are always included.
 */
export function loadActionableCaptures(basePath: string, currentMilestoneId?: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(
    c =>
      c.status === "resolved" &&
      !c.executed &&
      (c.classification === "inject" ||
        c.classification === "replan" ||
        c.classification === "quick-task") &&
      // Staleness gate: exclude captures resolved in a different milestone (#2872)
      (!currentMilestoneId ||
        !c.resolvedInMilestone ||
        c.resolvedInMilestone === currentMilestoneId),
  );
}

/**
 * Load unexecuted stop captures — user directives to halt auto-mode.
 * These are checked in the pre-dispatch guard pipeline (runGuards) to
 * pause auto-mode before the next unit is dispatched.
 */
export function loadStopCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed &&
      (c.classification === "stop" || c.classification === "backtrack"),
  );
}

// ─── CAPTURES.md render and import ────────────────────────────────────────────

/**
 * The `### <id>` sections of CAPTURES.md whose id no database capture holds
 * (written by an older release, by hand, or by a teammate's commit). They are
 * not read as state: doctor reports them and `doctor --fix` imports them.
 */
export function unimportedFileCaptures(basePath: string): CaptureEntry[] {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return [];
  const knownIds = new Set(loadAllCaptures(basePath).map((capture) => capture.id));
  return parseCapturesContent(readFileSync(filePath, "utf-8")).filter((capture) => !knownIds.has(capture.id));
}

/**
 * doctor --fix: record file captures as capture events in one capture.import
 * Domain Operation. A file section marked resolved with no valid
 * classification was not triaged, so it is imported as pending.
 */
export function importFileCaptures(basePath: string, captures: readonly CaptureEntry[]): void {
  if (captures.length === 0) return;
  runCaptureOperation(basePath, "capture.import", { captureIds: captures.map((capture) => capture.id) },
    () => captures.flatMap((capture) => {
      const events: CaptureEvent[] = [{
        eventType: "capture.registered",
        entityId: capture.id,
        payload: { text: capture.text, timestamp: capture.timestamp },
      }];
      if (capture.status !== "resolved" || !capture.classification) return events;
      events.push({
        eventType: "capture.resolved",
        entityId: capture.id,
        payload: {
          classification: capture.classification,
          resolution: capture.resolution ?? "",
          rationale: capture.rationale ?? "",
          ...(capture.resolvedAt ? { resolvedAt: capture.resolvedAt } : {}),
          ...(capture.resolvedInMilestone ? { milestoneId: capture.resolvedInMilestone } : {}),
        },
      });
      if (capture.executedAt) {
        events.push({ eventType: "capture.executed", entityId: capture.id, payload: { executedAt: capture.executedAt } });
      }
      return events;
    }));
}

const FIELD_LINE_RE = /^\*\*(?:Text|Captured|Status|Classification|Resolution|Rationale|Resolved|Milestone|Executed):\*\*/;

/** One field line. The file holds one line per field, so a line break in a value is written as a space. */
function fieldLine(key: string, value: string): string {
  return `**${key}:** ${value.replace(/\s*\n\s*/g, " ")}`;
}

/**
 * Write CAPTURES.md from the database: the field lines under each database
 * capture's `### <id>` heading are set, and a new capture is appended. Every
 * other line of the file is kept as it is: free text, a note under a capture,
 * and a section that is not imported yet (doctor imports it).
 */
export function renderCapturesProjection(basePath: string): void {
  const rows = loadAllCaptures(basePath);
  if (rows.length === 0) return;
  const path = resolveCapturesPath(basePath);
  const lines = existsSync(path)
    ? readFileSync(path, "utf-8").split("\n")
    : ["# Captures", "", "Rendered from the GSD database; edits to the captures below are not read.", "", ""];
  for (const capture of rows) {
    const fields = [
      fieldLine("Text", capture.text),
      fieldLine("Captured", capture.timestamp),
      fieldLine("Status", capture.status),
      ...(capture.classification ? [fieldLine("Classification", capture.classification)] : []),
      ...(capture.resolution ? [fieldLine("Resolution", capture.resolution)] : []),
      ...(capture.rationale ? [fieldLine("Rationale", capture.rationale)] : []),
      ...(capture.resolvedAt ? [fieldLine("Resolved", capture.resolvedAt)] : []),
      ...(capture.resolvedInMilestone ? [fieldLine("Milestone", capture.resolvedInMilestone)] : []),
      ...(capture.executedAt ? [fieldLine("Executed", capture.executedAt)] : []),
    ];
    const header = lines.findIndex((line) => line.startsWith("### ") && line.slice(4).trim() === capture.id);
    if (header === -1) {
      // Append at the end of the file, with one blank line before the heading
      if (lines[lines.length - 1] === "") lines.pop();
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`### ${capture.id}`, ...fields, "");
      continue;
    }
    // The section ends at the next heading. Only its field lines are replaced.
    let end = header + 1;
    while (end < lines.length && !lines[end].startsWith("### ")) end++;
    const kept = lines.slice(header + 1, end).filter((line) => !FIELD_LINE_RE.test(line));
    lines.splice(header + 1, end - header - 1, ...fields, ...kept);
  }
  const content = lines.join("\n");
  atomicWriteSync(path, content, "utf-8");
  // Not registered in the compat marker: a worktree base path writes this
  // project-root file, and its own marker cannot hold a key outside its .gsd.
  noteRenderedProjectionFile(path, content);
}

/** Parse the `### <id>` sections of a CAPTURES.md file. Used only by the import. */
function parseCapturesContent(content: string): CaptureEntry[] {
  const entries: CaptureEntry[] = [];

  // Split on H3 headings
  const sections = content.split(/^### /m).slice(1); // skip content before first H3

  for (const section of sections) {
    const lines = section.split("\n");
    const id = lines[0]?.trim();
    if (!id) continue;

    const body = lines.slice(1).join("\n");
    const text = extractBoldField(body, "Text");
    const timestamp = extractBoldField(body, "Captured");
    const statusRaw = extractBoldField(body, "Status");
    const classification = extractBoldField(body, "Classification") as Classification | null;
    const resolution = extractBoldField(body, "Resolution");
    const rationale = extractBoldField(body, "Rationale");
    const resolvedAt = extractBoldField(body, "Resolved");
    const milestoneId = extractBoldField(body, "Milestone");
    const executedAt = extractBoldField(body, "Executed");

    if (!text || !timestamp) continue;

    const status = (statusRaw === "resolved" || statusRaw === "triaged")
      ? statusRaw
      : "pending";

    entries.push({
      id,
      text,
      timestamp,
      status,
      ...(classification && VALID_CLASSIFICATIONS.includes(classification) ? { classification } : {}),
      ...(resolution ? { resolution } : {}),
      ...(rationale ? { rationale } : {}),
      ...(resolvedAt ? { resolvedAt } : {}),
      ...(milestoneId ? { resolvedInMilestone: milestoneId } : {}),
      ...(executedAt ? { executed: true, executedAt } : {}),
    });
  }

  return entries;
}

/**
 * Extract value from a bold-prefixed line like "**Key:** Value".
 * Local copy of the pattern from files.ts to keep this module self-contained.
 */
function extractBoldField(text: string, key: string): string | null {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, "m");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Triage Output Parser ─────────────────────────────────────────────────────

/**
 * Parse LLM triage output into TriageResult array.
 *
 * Handles:
 * - Clean JSON array
 * - JSON wrapped in fenced code block (```json ... ```)
 * - JSON with leading/trailing prose
 * - Single object (not array) — wraps in array
 * - Malformed JSON — returns empty array (caller should fall back to note)
 * - Partial results — valid entries are kept, invalid skipped
 */
export function parseTriageOutput(llmResponse: string): TriageResult[] {
  if (!llmResponse || !llmResponse.trim()) return [];

  // Try to extract JSON from fenced code blocks first
  const fenced = llmResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = fenced ? fenced[1] : extractJsonSubstring(llmResponse);

  if (!jsonStr) return [];

  try {
    const parsed = JSON.parse(jsonStr);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter(isValidTriageResult)
      .map(normalizeTriageResult);
  } catch {
    return [];
  }
}

/**
 * Try to find a JSON array or object substring in prose text.
 * Looks for the first [ or { and finds its matching bracket.
 */
function extractJsonSubstring(text: string): string | null {
  // Find first [ or {
  const arrStart = text.indexOf("[");
  const objStart = text.indexOf("{");

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (arrStart === -1 && objStart === -1) return null;
  if (arrStart === -1) {
    start = objStart;
    openChar = "{";
    closeChar = "}";
  } else if (objStart === -1) {
    start = arrStart;
    openChar = "[";
    closeChar = "]";
  } else {
    start = Math.min(arrStart, objStart);
    openChar = start === arrStart ? "[" : "{";
    closeChar = start === arrStart ? "]" : "}";
  }

  // Find matching bracket
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function isValidTriageResult(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.captureId === "string" &&
    typeof o.classification === "string" &&
    VALID_CLASSIFICATIONS.includes(o.classification) &&
    typeof o.rationale === "string"
  );
}

function normalizeTriageResult(obj: Record<string, unknown>): TriageResult {
  return {
    captureId: obj.captureId as string,
    classification: obj.classification as Classification,
    rationale: obj.rationale as string,
    ...(Array.isArray(obj.affectedFiles) ? { affectedFiles: obj.affectedFiles as string[] } : {}),
    ...(typeof obj.targetSlice === "string" ? { targetSlice: obj.targetSlice } : {}),
  };
}
