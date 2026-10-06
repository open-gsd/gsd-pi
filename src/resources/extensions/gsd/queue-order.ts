/**
 * GSD Queue Order — Custom milestone execution ordering.
 *
 * The execution order lives in milestones.sequence and is changed only by the
 * milestone.reorder Domain Operation. `.gsd/QUEUE-ORDER.json` is its render.
 * When present, `findMilestoneIds()` uses this order instead of
 * the default numeric sort (milestoneIdSort).
 *
 * The file is committed to git (not gitignored) so ordering
 * survives branch switches and is shared across sessions.
 */

import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { milestoneIdSort } from "./milestone-ids.js";
import { loadJsonFileOrNull, saveJsonFile } from "./json-persistence.js";
import {
  executeDomainOperation,
  isDbAvailable,
  setMilestoneQueueOrder,
  upsertMilestonePlanning,
} from "./gsd-db.js";
import { readMilestone, readMilestones } from "./db/lifecycle-read.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { DomainOperationRequest } from "./db/domain-operation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueueOrderFile {
  order: string[];
  updatedAt: string;
}

export interface DependencyViolation {
  milestone: string;
  dependsOn: string;
  type: 'would_block' | 'circular' | 'missing_dep';
  message: string;
}

export interface DependencyRedundancy {
  milestone: string;
  dependsOn: string;
}

export interface DependencyValidation {
  valid: boolean;
  violations: DependencyViolation[];
  redundant: DependencyRedundancy[];
}

// ─── Path ────────────────────────────────────────────────────────────────────

function queueOrderPath(basePath: string): string {
  return join(gsdRoot(basePath), "QUEUE-ORDER.json");
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

function isQueueOrderFile(data: unknown): data is QueueOrderFile {
  return data !== null && typeof data === "object" && "order" in data! && Array.isArray((data as QueueOrderFile).order);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

/**
 * Load the custom queue order. Returns null if no file exists or if
 * the file is corrupt/unreadable.
 */
export function loadQueueOrder(basePath: string): string[] | null {
  const data = loadJsonFileOrNull(queueOrderPath(basePath), isQueueOrderFile);
  return data?.order ?? null;
}

/**
 * Write QUEUE-ORDER.json. The file is a projection of milestones.sequence;
 * callers pass an order the database already holds.
 */
export function renderQueueOrder(basePath: string, order: string[]): void {
  const data: QueueOrderFile = {
    order,
    updatedAt: new Date().toISOString(),
  };
  saveJsonFile(queueOrderPath(basePath), data);
}

/** Render QUEUE-ORDER.json from milestones.sequence. Returns the file path. */
export function renderQueueOrderFromDb(basePath: string): string {
  renderQueueOrder(basePath, queueOrderFromDb());
  return queueOrderPath(basePath);
}

function queueOrderFromDb(): string[] {
  return readMilestones()
    .filter((milestone) => (milestone.sequence ?? 0) > 0 && !milestone.discarded)
    .map((milestone) => milestone.id);
}

/**
 * The operation identity of a queue change. A slash command has no call
 * identity, so its key is the project revision. A tool call passes its
 * invocation, and a retry of the same call replays the committed receipt.
 */
function queueOperationRequest(
  operationType: string,
  commandKey: string,
  payload: DomainOperationRequest["payload"],
  invocation?: ExecutionInvocation,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation?.idempotencyKey);
  return {
    operationType,
    idempotencyKey: invocation?.idempotencyKey ?? `command/${commandKey}/${fence.revision}`,
    // The caller's revision is a precondition of the first send only. A retry
    // can carry a newer revision, so a replay uses the recorded one.
    expectedRevision: fence.replay ? fence.revision : invocation?.expectedRevision ?? fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation?.actorType ?? "operator",
    ...(invocation?.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation?.sourceTransport ?? "internal",
    ...(invocation?.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation?.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  };
}

/** Dependency map and closed-milestone set of the database, for validateQueueOrder. */
function loadDependencyGraph(): { depsMap: Map<string, string[]>; closedIds: Set<string> } {
  const depsMap = new Map<string, string[]>();
  const closedIds = new Set<string>();
  for (const milestone of readMilestones()) {
    if (milestone.closed) closedIds.add(milestone.id);
    else if (milestone.depends_on.length > 0) depsMap.set(milestone.id, milestone.depends_on);
  }
  return { depsMap, closedIds };
}

/**
 * Reorder milestones in one milestone.reorder Domain Operation: write
 * milestones.sequence and drop the listed depends_on edges, then render
 * QUEUE-ORDER.json from the committed sequence.
 *
 * The effective order is the listed ids, then each open, non-parked milestone
 * the order does not list, in its current relative order. Returns the
 * committed queue order and one warning for each dependency of an open
 * milestone that has no database row; no order can fix such a dependency, so
 * it does not block the reorder.
 *
 * Throws when the order names an unknown or closed milestone, repeats an id,
 * or when the effective order puts a milestone before one it still depends
 * on or has a dependency cycle.
 */
export function reorderMilestones(
  basePath: string,
  order: string[],
  depsToRemove: ReadonlyArray<{ milestone: string; dep: string }> = [],
  invocation?: ExecutionInvocation,
): { order: string[]; warnings: string[] } {
  if (!isDbAvailable()) throw new Error("milestone reorder requires the GSD database");
  const request = queueOperationRequest(
    "milestone.reorder",
    "reorder",
    { order, depsToRemove: depsToRemove.map((edge) => ({ ...edge })) },
    invocation,
  );
  executeDomainOperation(request, () => {
    if (new Set(order).size !== order.length) throw new Error("queue order repeats a milestone id");
    const { depsMap, closedIds } = loadDependencyGraph();
    for (const id of order) {
      if (!readMilestone(id)) throw new Error(`milestone ${id} does not exist`);
      if (closedIds.has(id)) throw new Error(`milestone ${id} is closed and has no place in the queue`);
    }
    for (const edge of depsToRemove) {
      depsMap.set(edge.milestone, (depsMap.get(edge.milestone) ?? []).filter((dep) => dep !== edge.dep));
    }
    // A parked milestone that the order does not list is not in the queue, but
    // it is still a valid dependency.
    const listed = new Set(order);
    const outsideQueue = new Set(closedIds);
    const effectiveOrder = [...order];
    for (const milestone of readMilestones()) {
      if (listed.has(milestone.id) || closedIds.has(milestone.id)) continue;
      if (milestone.parked) outsideQueue.add(milestone.id);
      else effectiveOrder.push(milestone.id);
    }
    const violation = validateQueueOrder(effectiveOrder, depsMap, outsideQueue)
      .violations.find((entry) => entry.type !== "missing_dep");
    if (violation) throw new Error(violation.message);

    setMilestoneQueueOrder(effectiveOrder);
    for (const edge of depsToRemove) {
      const milestone = readMilestone(edge.milestone);
      if (!milestone) throw new Error(`milestone ${edge.milestone} does not exist`);
      upsertMilestonePlanning(edge.milestone, { depends_on: milestone.depends_on.filter((dep) => dep !== edge.dep) });
    }
    return {
      events: [{
        eventType: "milestone.reordered",
        entityType: "project",
        entityId: "queue",
        payload: { order, depsToRemove: depsToRemove.map((edge) => ({ ...edge })) },
        destinations: ["db"],
      }],
      projections: [{
        projectionKey: "queue-order",
        projectionKind: "queue-order",
        rendererVersion: "1",
      }],
    };
  });
  const committedOrder = queueOrderFromDb();
  renderQueueOrder(basePath, committedOrder);
  const milestones = readMilestones();
  const knownIds = new Set(milestones.map((milestone) => milestone.id));
  const warnings = milestones
    .filter((milestone) => !milestone.closed)
    .flatMap((milestone) => milestone.depends_on
      .filter((dep) => !knownIds.has(dep))
      .map((dep) => `${milestone.id} depends on ${dep}, but ${dep} does not exist.`));
  return { order: committedOrder, warnings };
}

/**
 * Replace the depends_on list of one open milestone in a
 * milestone.set_dependencies Domain Operation.
 *
 * Throws when the milestone is unknown or closed, when a dependency is
 * unknown, discarded or the milestone itself, or when the new list makes a
 * dependency cycle.
 */
export function setMilestoneDependencies(
  milestoneId: string,
  dependsOn: string[],
  invocation?: ExecutionInvocation,
): void {
  if (!isDbAvailable()) throw new Error("milestone dependency update requires the GSD database");
  const request = queueOperationRequest(
    "milestone.set_dependencies",
    `set-dependencies/${milestoneId}`,
    { milestoneId, dependsOn },
    invocation,
  );
  executeDomainOperation(request, () => {
    const milestone = readMilestone(milestoneId);
    if (!milestone) throw new Error(`milestone ${milestoneId} does not exist`);
    if (milestone.closed) {
      throw new Error(`milestone ${milestoneId} is closed (${milestone.status}); its dependencies cannot change`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error("depends_on repeats a milestone id");
    for (const depId of dependsOn) {
      if (depId === milestoneId) throw new Error(`milestone ${milestoneId} cannot depend on itself`);
      const dep = readMilestone(depId);
      if (!dep) throw new Error(`depends_on references unknown milestone: ${depId}`);
      if (dep.discarded) {
        throw new Error(`depends_on milestone ${depId} was discarded and can never be complete`);
      }
    }
    const { depsMap, closedIds } = loadDependencyGraph();
    depsMap.set(milestoneId, dependsOn);
    const cycle = validateQueueOrder([...depsMap.keys()], depsMap, closedIds)
      .violations.find((violation) => violation.type === "circular");
    if (cycle) throw new Error(cycle.message);

    upsertMilestonePlanning(milestoneId, { depends_on: dependsOn });
    return {
      events: [{
        eventType: "milestone.dependencies_set",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { milestoneId, dependsOn, previous: milestone.depends_on },
        destinations: ["db"],
      }],
      projections: [{
        projectionKey: `milestone/${milestoneId.toLowerCase()}/dependencies`,
        projectionKind: "milestone-status",
        rendererVersion: "1",
      }],
    };
  });
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

/**
 * Sort milestone IDs respecting a custom order.
 *
 * - IDs present in `customOrder` appear in that exact sequence.
 * - IDs on disk but NOT in `customOrder` are appended at the end,
 *   sorted by the default `milestoneIdSort` (numeric).
 * - IDs in `customOrder` but NOT on disk are silently skipped.
 * - When `customOrder` is null, falls back to `milestoneIdSort`.
 */
export function sortByQueueOrder(ids: string[], customOrder: string[] | null): string[] {
  if (!customOrder) return [...ids].sort(milestoneIdSort);

  const idSet = new Set(ids);
  const ordered: string[] = [];

  // First: IDs from customOrder that exist on disk
  for (const id of customOrder) {
    if (idSet.has(id)) {
      ordered.push(id);
      idSet.delete(id);
    }
  }

  // Then: remaining IDs not in customOrder, in default sort order
  const remaining = [...idSet].sort(milestoneIdSort);
  return [...ordered, ...remaining];
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

/**
 * Remove IDs from the queue order file that are no longer valid
 * (completed or deleted milestones). No-op if file doesn't exist.
 */
export function pruneQueueOrder(basePath: string, validIds: string[]): void {
  const order = loadQueueOrder(basePath);
  if (!order) return;

  const validSet = new Set(validIds);
  const pruned = order.filter(id => validSet.has(id));

  if (pruned.length !== order.length) {
    renderQueueOrder(basePath, pruned);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a proposed queue order against dependency constraints.
 *
 * Checks:
 * - would_block: A milestone is placed before one of its dependencies
 * - circular: Two or more milestones form a dependency cycle
 * - missing_dep: A milestone depends on an ID that doesn't exist
 * - redundant: A dependency is satisfied by queue position (dep comes earlier)
 */
export function validateQueueOrder(
  order: string[],
  depsMap: Map<string, string[]>,
  completedIds: Set<string>,
): DependencyValidation {
  const violations: DependencyViolation[] = [];
  const redundant: DependencyRedundancy[] = [];

  const positionMap = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    positionMap.set(order[i], i);
  }

  const allKnownIds = new Set([...order, ...completedIds]);

  for (const [mid, deps] of depsMap) {
    const midPos = positionMap.get(mid);
    if (midPos === undefined) continue; // not in pending order

    for (const dep of deps) {
      // Dep already completed — always satisfied
      if (completedIds.has(dep)) continue;

      // Dep doesn't exist anywhere
      if (!allKnownIds.has(dep)) {
        violations.push({
          milestone: mid,
          dependsOn: dep,
          type: 'missing_dep',
          message: `${mid} depends on ${dep}, but ${dep} does not exist.`,
        });
        continue;
      }

      const depPos = positionMap.get(dep);
      if (depPos === undefined) continue; // dep not in pending order (edge case)

      if (depPos > midPos) {
        // Dep comes AFTER this milestone in the order — violation
        violations.push({
          milestone: mid,
          dependsOn: dep,
          type: 'would_block',
          message: `${mid} cannot run before ${dep} — ${mid} depends_on: [${dep}].`,
        });
      } else {
        // Dep comes before — satisfied by position, redundant
        redundant.push({ milestone: mid, dependsOn: dep });
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);

    const deps = depsMap.get(node) ?? [];
    for (const dep of deps) {
      if (completedIds.has(dep)) continue;
      const cycle = hasCycle(dep, [...path, node]);
      if (cycle) return cycle;
    }

    inStack.delete(node);
    return null;
  }

  for (const mid of order) {
    if (!visited.has(mid)) {
      const cycle = hasCycle(mid, []);
      if (cycle) {
        const cycleStr = cycle.join(' → ');
        violations.push({
          milestone: cycle[0],
          dependsOn: cycle[cycle.length - 2],
          type: 'circular',
          message: `Circular dependency: ${cycleStr}`,
        });
        break; // one cycle report is enough
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    redundant,
  };
}
