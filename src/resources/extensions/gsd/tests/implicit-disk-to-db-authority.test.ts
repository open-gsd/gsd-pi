// Project/App: gsd-pi
// File Purpose: ADR-046 gate (part of G2): no startup, derive, reconcile, dispatch, sync or query path writes the database from a file.

import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { runHeadlessQuery } from "../../../../headless-query.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import { openProjectDbIfPresent } from "../auto-start.ts";
import { handleSync } from "../commands-maintenance.ts";
import {
  _getAdapter,
  insertMilestone,
  insertSlice,
  setMilestoneQueueOrder,
} from "../gsd-db.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { relMilestoneFile, relSliceFile, relTaskFile } from "../paths.ts";
import { loadEffectiveGSDPreferences } from "../preferences.ts";
import { drainProjectionWork } from "../projection-worker.ts";
import { readAllSessionStatuses } from "../session-status-io.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation/index.ts";
import { snapshotWorkflowTables } from "./db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

// Fixture: M001 active; S01 complete (T01 complete); S02 pending with T01
// pending. Completed rows have completed_at = null.
let fixture: WorkflowAuthorityFixture;

afterEach(() => {
  fixture?.cleanup();
  invalidateStateCache();
});

function writeProjection(base: string, relPath: string, content: string): void {
  const path = join(base, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function totalChanges(): number {
  const adapter = _getAdapter();
  assert.ok(adapter, "database must be open");
  return Number(adapter.prepare("SELECT total_changes() AS n").get()?.["n"]);
}

/** Every path that could write the database from a file before this gate. */
async function runReadAndRepairPaths(base: string): Promise<void> {
  await openProjectDbIfPresent(base);
  invalidateStateCache();
  const state = await deriveState(base);
  await reconcileBeforeDispatch(base);
  await resolveDispatch({ basePath: base, mid: "M001", midTitle: "Authority Fixture", prefs: undefined, state });
  await handleSync({ ui: { notify: () => {} } } as never, base);
  invalidateStateCache();
  await runHeadlessQuery(
    base,
    { openProjectDbIfPresent, deriveState, resolveDispatch, readAllSessionStatuses, loadEffectiveGSDPreferences },
    () => {},
  );
}

interface Contradiction {
  artifact: string;
  /** Extra rows the contradicting file needs. */
  seed?: () => void;
  /** Write a file that states something the database does not. */
  contradict: (base: string) => void;
}

const PLAN_WITH_REAL_TASK = [
  "# S03: Sketch",
  "",
  "**Goal:** Refined on disk only.",
  "",
  "## Tasks",
  "",
  "- [x] **T01: Build the feature** `est:1h`",
  "  Implement it.",
  "",
].join("\n");

const CONTRADICTIONS: Contradiction[] = [
  {
    artifact: "QUEUE-ORDER.json",
    seed: () => {
      insertMilestone({ id: "M002", title: "Second", status: "queued" });
      setMilestoneQueueOrder(["M001", "M002"]);
    },
    contradict: (base) =>
      writeProjection(base, ".gsd/QUEUE-ORDER.json", JSON.stringify({ order: ["M002", "M001"] })),
  },
  {
    artifact: "PLAN",
    seed: () => insertSlice({
      id: "S03",
      milestoneId: "M001",
      title: "Sketch",
      status: "pending",
      depends: ["S02"],
      sequence: 3,
      isSketch: true,
      sketchScope: "limited",
    }),
    // A decomposed PLAN for a slice the database still marks as a sketch.
    contradict: (base) => writeProjection(base, relSliceFile(base, "M001", "S03", "PLAN"), PLAN_WITH_REAL_TASK),
  },
  {
    artifact: "SUMMARY mtime",
    // SUMMARY files with an old mtime for rows whose completed_at is null.
    contradict: (base) => {
      const longAgo = new Date("2020-01-01T00:00:00Z");
      for (const relPath of [
        relSliceFile(base, "M001", "S01", "SUMMARY"),
        relTaskFile(base, "M001", "S01", "T01", "SUMMARY"),
      ]) {
        writeProjection(base, relPath, "# Summary\n\nDone on disk.\n");
        utimesSync(join(base, relPath), longAgo, longAgo);
      }
    },
  },
  {
    artifact: "ASSESSMENT",
    // Every slice closed, so dispatch reaches milestone validation.
    seed: () => {
      // Fixture stamps on the unadopted milestone: raw SQL, the generic
      // status writer refuses rows without a canonical lifecycle row.
      _getAdapter()!.prepare("UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S02' AND id = 'T01'").run();
      _getAdapter()!.prepare("UPDATE slices SET status = 'complete' WHERE milestone_id = 'M001' AND id = 'S02'").run();
    },
    // S01 has an ASSESSMENT that no gsd_uat_result_save call produced; S02 has none.
    contradict: (base) => {
      for (const sliceId of ["S01", "S02"]) {
        writeProjection(base, relSliceFile(base, "M001", sliceId, "SUMMARY"), `# ${sliceId} Summary\n`);
      }
      writeProjection(
        base,
        relSliceFile(base, "M001", "S01", "ASSESSMENT"),
        "---\nverdict: PASS\n---\n\n# Assessment\n",
      );
    },
  },
  {
    artifact: "CONTEXT.md",
    // The database holds no CONTEXT artifact for M001.
    contradict: (base) =>
      writeProjection(base, relMilestoneFile(base, "M001", "CONTEXT"), "# M001: Written on disk only\n"),
  },
  {
    artifact: "state-manifest.json",
    contradict: (base) => writeProjection(base, ".gsd/state-manifest.json", JSON.stringify({
      version: 1,
      exported_at: new Date().toISOString(),
      milestones: [{ id: "M099", title: "Manifest only", status: "complete" }],
      slices: [{ id: "S02", milestone_id: "M001", status: "complete" }],
      tasks: [],
      decisions: [],
      verification_evidence: [],
    })),
  },
  {
    artifact: "event-log.jsonl",
    contradict: (base) => writeProjection(base, ".gsd/event-log.jsonl", [
      { cmd: "complete-milestone", params: { milestoneId: "M001" }, ts: "2026-01-01T00:00:00.000Z" },
      { cmd: "reopen-milestone", params: { milestoneId: "M001" }, ts: "2026-01-02T00:00:00.000Z" },
      { cmd: "complete-task", params: { milestoneId: "M001", sliceId: "S02", taskId: "T01" }, ts: "2026-01-03T00:00:00.000Z" },
    ].map((event) => JSON.stringify({ ...event, hash: "0", actor: "agent", session_id: "s" })).join("\n") + "\n"),
  },
];

describe("G2: no implicit disk-to-DB path", () => {
  for (const { artifact, seed, contradict } of CONTRADICTIONS) {
    test(`a contradicting ${artifact} changes no database row`, async () => {
      fixture = await createWorkflowAuthorityFixture();
      const base = fixture.root;
      seed?.();
      assert.deepEqual((await renderAllFromDb(base)).errors, []);
      // Settle the fixture's own Projection Work so only file-driven writes remain.
      assert.deepEqual((await drainProjectionWork(base)).errors, []);
      await runReadAndRepairPaths(base);

      contradict(base);
      const tablesBefore = snapshotWorkflowTables();
      const changesBefore = totalChanges();
      await runReadAndRepairPaths(base);

      assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "workflow tables are unchanged");
      assert.equal(totalChanges() - changesBefore, 0, "no row of any table was written");
    });
  }
});
