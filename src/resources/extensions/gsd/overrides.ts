// Project/App: gsd-pi
// File Purpose: Steer overrides as Domain Operation events; OVERRIDES.md is their render.

import { existsSync, readFileSync } from "node:fs";

import { atomicWriteSync } from "./atomic-write.js";
import { noteRenderedProjectionFile } from "./compat/compat-marker.js";
import { getDbOrNull } from "./db/engine.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { Override } from "./files.js";
import { executeDomainOperation, isDbAvailable } from "./gsd-db.js";
import { resolveGsdRootFile } from "./paths.js";
import { logWarning } from "./workflow-logger.js";

interface OverrideEvent {
  eventType: string;
  entityId: string;
  payload: DomainJsonValue;
}

/** Run one override Domain Operation, then render OVERRIDES.md from the committed rows. */
function runOverrideOperation(
  basePath: string,
  operationType: string,
  payload: DomainJsonValue,
  events: (revision: number) => OverrideEvent[],
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
  }, (context) => ({
    events: events(context.resultingRevision).map((event) => ({
      ...event,
      entityType: "override",
      destinations: ["projection"],
    })),
    projections: [{ projectionKey: "overrides", projectionKind: "markdown", rendererVersion: "1" }],
  }));
  try {
    renderOverridesProjection(basePath);
  } catch (err) {
    // The operation is committed and its Projection Work row stays pending for the worker.
    logWarning("projection", `OVERRIDES.md render failed: ${(err as Error).message}`);
  }
}

interface OverrideRow extends Override {
  id: string;
  /** rewrite-docs dispatches recorded for this override. */
  rewriteAttempts: number;
}

/** Every registered override in registration order, with its resolution state. */
function readOverrides(): OverrideRow[] {
  const rows = getDbOrNull()?.prepare(`
    SELECT registered.entity_id AS id,
           COALESCE(json_extract(registered.payload_json, '$.timestamp'), registered.created_at) AS created_at,
           json_extract(registered.payload_json, '$.change') AS change,
           json_extract(registered.payload_json, '$.appliedAt') AS applied_at,
           EXISTS (
             SELECT 1 FROM workflow_domain_events resolved
             WHERE resolved.event_type = 'override.resolved'
               AND resolved.entity_type = 'override'
               AND resolved.entity_id = registered.entity_id
           ) AS resolved,
           (
             SELECT COUNT(*) FROM workflow_domain_events attempt
             WHERE attempt.event_type = 'override.rewrite_attempted'
               AND attempt.entity_type = 'override'
               AND attempt.entity_id = registered.entity_id
           ) AS rewrite_attempts
    FROM workflow_domain_events registered
    WHERE registered.event_type = 'override.registered' AND registered.entity_type = 'override'
    ORDER BY registered.project_revision, registered.event_index
  `).all() ?? [];
  return rows.map((row) => ({
    id: String(row["id"]),
    timestamp: String(row["created_at"]),
    change: String(row["change"] ?? ""),
    appliedAt: String(row["applied_at"] ?? ""),
    scope: Number(row["resolved"]) ? "resolved" : "active",
    rewriteAttempts: Number(row["rewrite_attempts"]),
  }));
}

function activeOverrides(): OverrideRow[] {
  return readOverrides().filter((row) => row.scope === "active");
}

/**
 * Import bridge, for one release: the `## Override:` blocks of OVERRIDES.md
 * whose timestamp no database override holds. An older release kept overrides
 * only in this file, and in team mode a teammate's commit brings new blocks.
 * A block the database holds is never read: the database row wins.
 */
function unimportedFileOverrides(basePath: string, known: readonly Override[]): Override[] {
  const path = resolveGsdRootFile(basePath, "OVERRIDES");
  if (!existsSync(path)) return [];
  const knownTimestamps = new Set(known.map((override) => override.timestamp));
  return readFileSync(path, "utf-8").split(/^## Override: /m).slice(1).flatMap((block): Override[] => {
    const field = (name: string) => block.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    const timestamp = block.split("\n", 1)[0]!.trim();
    const change = field("Change");
    if (!change || knownTimestamps.has(timestamp)) return [];
    const scope = (field("Scope") || "active") === "active" ? "active" : "resolved";
    return [{ timestamp, change, scope, appliedAt: field("Applied-at") }];
  });
}

/** Record the un-imported file blocks as override events, so that a rewrite attempt counts against them and resolution covers them. */
function importFileOverrides(basePath: string): void {
  if (!isDbAvailable()) return;
  const overrides = unimportedFileOverrides(basePath, readOverrides());
  if (overrides.length === 0) return;
  const timestamps = overrides.map((override) => override.timestamp);
  runOverrideOperation(basePath, "override.import", { timestamps }, (revision) =>
    overrides.flatMap(({ timestamp, change, scope, appliedAt }, index) => {
      const entityId = `override-${revision}-${index}`;
      const events: OverrideEvent[] = [
        { eventType: "override.registered", entityId, payload: { change, appliedAt, timestamp } },
      ];
      if (scope === "resolved") events.push({ eventType: "override.resolved", entityId, payload: {} });
      return events;
    }));
}

/** Overrides not yet resolved, with the file blocks not imported yet. Empty when no database is open. */
export function loadActiveOverrides(basePath: string): Override[] {
  if (!isDbAvailable()) return [];
  const rows = readOverrides();
  return [
    ...rows.map(({ id: _id, rewriteAttempts: _attempts, ...override }) => override),
    ...unimportedFileOverrides(basePath, rows),
  ].filter((override) => override.scope === "active");
}

/** Write OVERRIDES.md from the database. A file block that is not imported yet is kept. */
export function renderOverridesProjection(basePath: string): void {
  const rows = readOverrides();
  if (rows.length === 0) return;
  const overrides = [
    ...rows,
    ...unimportedFileOverrides(basePath, rows).map((override) => ({ ...override, rewriteAttempts: 0 })),
  ];
  const content = [
    "# GSD Overrides",
    "",
    "User-issued overrides that supersede plan document content.",
    "Rendered from the GSD database; edits to the overrides below are not read.",
    "",
    "---",
    "",
    ...overrides.flatMap((override) => [
      `## Override: ${override.timestamp}`,
      "",
      `**Change:** ${override.change}`,
      `**Scope:** ${override.scope}`,
      `**Applied-at:** ${override.appliedAt}`,
      ...(override.rewriteAttempts > 0 ? [`**Rewrite-attempts:** ${override.rewriteAttempts}`] : []),
      "",
      "---",
      "",
    ]),
  ].join("\n");
  const path = resolveGsdRootFile(basePath, "OVERRIDES");
  atomicWriteSync(path, content, "utf-8");
  // Not registered in the compat marker: a worktree base path writes this
  // project-root file, and its own marker cannot hold a key outside its .gsd.
  noteRenderedProjectionFile(path, content);
}

/** /gsd steer: record one override in an override.register Domain Operation. */
export function registerOverride(basePath: string, change: string, appliedAt: string): void {
  runOverrideOperation(basePath, "override.register", { change, appliedAt }, (revision) => [
    { eventType: "override.registered", entityId: `override-${revision}`, payload: { change, appliedAt } },
  ]);
}

/** Resolve every active override in one override.resolve Domain Operation. No-op when none is active. */
export function resolveAllOverrides(basePath: string): void {
  const overrideIds = activeOverrides().map((row) => row.id);
  if (overrideIds.length === 0) return;
  runOverrideOperation(basePath, "override.resolve", { overrideIds }, () =>
    overrideIds.map((id) => ({ eventType: "override.resolved", entityId: id, payload: {} })));
}

/** Count one rewrite-docs dispatch against every active override (the rewrite circuit breaker). */
export function recordRewriteAttempt(basePath: string): void {
  importFileOverrides(basePath);
  const overrideIds = activeOverrides().map((row) => row.id);
  if (overrideIds.length === 0) return;
  runOverrideOperation(basePath, "override.rewrite_attempt", { overrideIds }, () =>
    overrideIds.map((id) => ({ eventType: "override.rewrite_attempted", entityId: id, payload: {} })));
}

/** The most rewrite-docs dispatches recorded for any active override. */
export function getRewriteCount(): number {
  return Math.max(0, ...activeOverrides().map((row) => row.rewriteAttempts));
}
