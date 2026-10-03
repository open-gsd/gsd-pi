// Project/App: gsd-pi
// File Purpose: Shared harness for the ADR-046 database-authority behavior gates (G1-G8).

import assert, { AssertionError } from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, sep } from "node:path";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { _getAdapter } from "../gsd-db.ts";

/**
 * Mark a gate check that the current code cannot pass yet. `passesWith` names
 * the cutover package that makes it pass. The check must fail with an
 * assertion error. When the check passes, this call fails, so the owner
 * package must delete the wrapper and the gate becomes enforced.
 */
export function expectedFail(passesWith: string, check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof AssertionError) return;
    throw error;
  }
  assert.fail(`gate passes now: delete expectedFail("${passesWith}") so the gate is enforced`);
}

const MANAGED_JSON = new Set(["QUEUE-ORDER.json", "state-manifest.json", "completed-units.json"]);

/** True for a file under `.gsd` that is rendered from, or was once read into, workflow state. */
export function isManagedProjectionPath(base: string, path: string): boolean {
  // Callers pass the base as given or resolved (macOS tmpdir is a symlink).
  const rel = [base, fs.realpathSync(base)]
    .map((root) => relative(join(root, ".gsd"), path))
    .find((candidate) => candidate !== "" && !candidate.startsWith(".."));
  if (!rel || rel.startsWith("gsd.db")) return false;
  const name = rel.split(sep).pop()!;
  if (MANAGED_JSON.has(name)) return true;
  return name.endsWith(".md") && name.toUpperCase() !== "PREFERENCES.MD";
}

function managedFiles(base: string): string[] {
  const root = join(fs.realpathSync(base), ".gsd");
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .map((entry) => join(root, entry))
    .filter((path) => fs.statSync(path).isFile() && isManagedProjectionPath(base, path));
}

/** Content of every managed projection file, for equality checks between two points in time. */
export function snapshotProjections(base: string): Record<string, string> {
  return Object.fromEntries(managedFiles(base).map((path) => [path, fs.readFileSync(path, "utf-8")]));
}

/** Delete everything under `.gsd` except the database files. */
export function deleteProjections(base: string): void {
  const root = join(base, ".gsd");
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith("gsd.db")) continue;
    fs.rmSync(join(root, entry), { recursive: true, force: true });
  }
}

/**
 * Overwrite every managed projection with content that contradicts the
 * database: every checkbox is flipped and every status word is inverted. Adds
 * the root files that older code read as state.
 */
export function poisonProjections(base: string): void {
  for (const path of managedFiles(base)) {
    const flipped = fs.readFileSync(path, "utf-8")
      .replace(/\[( |x)\]/gi, (_match, mark: string) => (mark === " " ? "[x]" : "[ ]"))
      .replace(/\b(complete|completed|done|pending|active)\b/gi, (word) =>
        /^(pending|active)$/i.test(word) ? "complete" : "pending");
    fs.writeFileSync(path, flipped);
  }
  const root = join(base, ".gsd");
  fs.writeFileSync(join(root, "STATE.md"), [
    "# GSD State",
    "",
    "**Active Milestone:** M099: Poisoned",
    "**Active Slice:** S99: Poisoned",
    "**Active Task:** T99: Poisoned",
    "**Phase:** complete",
    "",
  ].join("\n"));
  fs.writeFileSync(join(root, "PROJECT.md"), "# Project\n\n## Milestone Sequence\n\n- [ ] M099: Poisoned\n");
  fs.writeFileSync(join(root, "QUEUE-ORDER.json"), JSON.stringify({ order: ["M099"] }));
  fs.writeFileSync(join(root, "completed-units.json"), JSON.stringify(["execute-task/M001/S02/T01"]));
}

/** Record every file read while `run` executes; returns the managed projection paths that were read. */
export async function recordProjectionReads(base: string, run: () => unknown): Promise<string[]> {
  const reads: string[] = [];
  const mutableFs = fs as { readFileSync: typeof fs.readFileSync };
  const mutablePromises = fs.promises as { readFile: typeof fs.promises.readFile };
  const originalReadFileSync = fs.readFileSync;
  const originalReadFile = fs.promises.readFile;
  mutableFs.readFileSync = ((path: fs.PathLike, ...args: unknown[]) => {
    reads.push(String(path));
    return (originalReadFileSync as (...a: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync;
  mutablePromises.readFile = ((path: fs.PathLike, ...args: unknown[]) => {
    reads.push(String(path));
    return (originalReadFile as unknown as (...a: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    mutablePromises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
  return reads.filter((path) => isManagedProjectionPath(base, path));
}

// Workflow state per owner decision 5. Coordination and telemetry tables
// (runtime_kv, unit_dispatches, workers, leases, audit_events, gate_runs) are exempt.
export const WORKFLOW_TABLES = [
  "milestones",
  "slices",
  "tasks",
  "requirements",
  "decisions",
  "memories",
  "artifacts",
  "assessments",
  "quality_gates",
  "verification_evidence",
] as const;

/** Row content of every workflow table, for equality checks between runs. */
export function snapshotWorkflowTables(): Record<string, unknown[]> {
  const db = _getAdapter();
  assert.ok(db, "database must be open");
  return Object.fromEntries(WORKFLOW_TABLES.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

/**
 * Commit one Domain Operation that sets a canonical lifecycle row and enqueues
 * one Projection Work row of `projectionKind` under `projectionKey`.
 */
export function seedLifecycle(
  input: Parameters<typeof adoptOrTransitionLifecycle>[1],
  key: string,
  projectionKind = "markdown",
  projectionKey = `db-authority-gate/${key.toLowerCase()}`,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "db-authority-gate.seed",
    idempotencyKey: `db-authority-gate/${key}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "db-authority-gate",
    sourceTransport: "test",
    payload: { key },
  }, (context) => {
    adoptOrTransitionLifecycle(context, input);
    return {
      events: [{
        eventType: "db-authority-gate.seeded",
        entityType: input.itemKind,
        entityId: [input.milestoneId, input.sliceId, input.taskId].filter(Boolean).join("/"),
        payload: { lifecycleStatus: input.lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey,
        projectionKind,
        rendererVersion: "v1",
      }],
    };
  });
}

// Scans the whole text, so it also finds a write after a WITH clause and each
// statement of a multi-statement exec(). A match that is not a table name
// (for example "DO UPDATE SET") is harmless: only workflow tables are fenced.
const WRITE_TARGET = /\b(?:(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/gi;

/**
 * Wrap the open adapter so that a write to a workflow table throws unless the
 * same transaction already inserted its `workflow_operations` row (the first
 * write of executeDomainOperation). Violations are also collected, because a
 * tool handler can catch the throw. Call the returned function to unwrap.
 */
export function fenceWorkflowWrites(): { violations: string[]; restore: () => void } {
  const db = _getAdapter();
  assert.ok(db, "database must be open");
  const workflowTables = new Set<string>(WORKFLOW_TABLES);
  const violations: string[] = [];
  let operationOpen = false;
  const originalExec = db.exec;
  const originalPrepare = db.prepare;

  // Throws on the first workflow-table write that has no open Domain Operation.
  const check = (sql: string): void => {
    for (const match of sql.matchAll(WRITE_TARGET)) {
      const table = match[1].toLowerCase();
      if (table === "workflow_operations") operationOpen = true;
      if (workflowTables.has(table) && !operationOpen) {
        violations.push(table);
        throw new Error(`write to workflow table "${table}" outside a Domain Operation`);
      }
    }
  };

  db.exec = function exec(sql: string) {
    if (/^\s*(COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) operationOpen = false;
    check(sql);
    return originalExec.call(db, sql);
  };
  db.prepare = function prepare(sql: string) {
    const statement = originalPrepare.call(db, sql);
    // The adapter caches statements, so wrap instead of patching the shared object.
    return {
      get: (...params: unknown[]) => statement.get(...params),
      all: (...params: unknown[]) => statement.all(...params),
      run(...params: unknown[]) {
        check(sql);
        return statement.run(...params);
      },
    };
  };

  return {
    violations,
    restore() {
      // A reopened database has a new adapter that this fence never observed.
      assert.equal(_getAdapter(), db, "the fenced database connection was replaced during the call");
      db.exec = originalExec;
      db.prepare = originalPrepare;
    },
  };
}
