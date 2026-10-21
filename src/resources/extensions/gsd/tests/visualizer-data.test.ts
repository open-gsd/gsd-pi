// gsd-pi — Visualizer data behavior tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeCriticalPath,
  loadVisualizerData,
  type VisualizerMilestone,
} from "../visualizer-data.ts";
import { _getAdapter, closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { createMemory } from "../memory-store.ts";
import { generateHtmlReport } from "../export-html.ts";
import { resetMetrics, type UnitMetrics } from "../metrics.ts";

function makeMetricUnit(id: string, startedAt: number, finishedAt: number): UnitMetrics {
  return {
    type: id.split("/").length >= 3 ? "execute-task" : "complete-slice",
    id,
    model: "test-model",
    startedAt,
    finishedAt,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
  };
}

test("computeCriticalPath follows milestone dependencies", () => {
  const milestones: VisualizerMilestone[] = [
    {
      id: "M001",
      title: "Foundation",
      status: "active",
      dependsOn: [],
      slices: [{ id: "S01", title: "Foundation", done: false, active: false, risk: "low", depends: [], tasks: [] }],
    },
    {
      id: "M002",
      title: "Feature",
      status: "active",
      dependsOn: ["M001"],
      slices: [{ id: "S01", title: "Build", done: false, active: true, risk: "medium", depends: [], tasks: [] }],
    },
  ];

  const path = computeCriticalPath(milestones);
  assert.deepEqual(path.milestonePath, ["M001", "M002"]);
  assert.equal(path.milestoneSlack.has("M001"), true);
  assert.equal(path.milestoneSlack.has("M002"), true);
});

test("loadVisualizerData hydrates milestones, captures, stats, and health fields", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-data-"));
  try {
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    // Hierarchy is DB-authoritative post-cutover: seed the DB so M001/S01
    // derive from DB rows. loadVisualizerData reopens the project DB after it
    // is closed here.
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "M001: Visualizer", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Build UI", status: "pending", sequence: 1 });
    closeDatabase();
    writeFileSync(
      join(base, ".gsd", "CAPTURES.md"),
      [
        "# Captures",
        "",
        "### CAP-visual",
        "**Text:** Investigate visualizer state",
        "**Captured:** 2026-01-01T00:00:00.000Z",
        "**Status:** pending",
        "",
      ].join("\n"),
    );

    const data = await loadVisualizerData(base);

    assert.equal(data.milestones.length, 1);
    assert.equal(data.milestones[0]?.id, "M001");
    assert.equal(data.milestones[0]?.slices[0]?.id, "S01");
    assert.equal(data.remainingSliceCount, 1);
    assert.equal(data.captures.pendingCount, 1);
    assert.equal(data.stats.missingCount, 1);
    assert.ok(data.health);
    assert.ok(data.criticalPath.milestonePath.length >= 1);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadVisualizerData scopes ETA rate to active milestone units", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-eta-scope-"));
  try {
    resetMetrics();
    const m1Dir = join(base, ".gsd", "milestones", "M001");
    const m2Dir = join(base, ".gsd", "milestones", "M002");
    mkdirSync(m1Dir, { recursive: true });
    mkdirSync(m2Dir, { recursive: true });

    writeFileSync(
      join(m1Dir, "M001-ROADMAP.md"),
      [
        "# M001: Previous",
        "",
        "## Slices",
        "- [x] **S01: Done** `risk:low` `depends:[]`",
      ].join("\n"),
    );
    writeFileSync(join(m1Dir, "M001-SUMMARY.md"), "# M001 Summary\n\nDone.");
    writeFileSync(
      join(m2Dir, "M002-ROADMAP.md"),
      [
        "# M002: Active",
        "",
        "## Slices",
        "- [x] **S01: Done** `risk:low` `depends:[]`",
        "- [ ] **S02: Remaining** `risk:low` `depends:[]`",
      ].join("\n"),
    );

    // Milestone lifecycle is DB-authoritative: seed the DB so M001 derives as
    // complete and M002 as the active milestone. loadVisualizerData reopens the
    // project DB after it is closed here.
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Previous", status: "complete" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete", sequence: 1 });
    insertMilestone({ id: "M002", title: "Active", status: "active" });
    insertSlice({ milestoneId: "M002", id: "S01", title: "Done", status: "complete", sequence: 1 });
    insertSlice({ milestoneId: "M002", id: "S02", title: "Remaining", status: "pending", sequence: 2 });
    closeDatabase();

    const units = [
      makeMetricUnit("M001/S01/T01", 1_000, 61_000),
      makeMetricUnit("M001/S01/T02", 61_000, 121_000),
      makeMetricUnit("M001/S01/T03", 121_000, 181_000),
      makeMetricUnit("M002/S01/T01", 100_000_000, 100_900_000),
      makeMetricUnit("M002/S01/T02", 100_900_000, 101_800_000),
    ];
    writeFileSync(
      join(base, ".gsd", "metrics.json"),
      JSON.stringify({ version: 1, projectStartedAt: 1_000, units }),
    );

    const data = await loadVisualizerData(base);

    assert.equal(data.milestones.find(m => m.id === "M002")?.status, "active");
    assert.equal(data.agentActivity?.completionRate, 4);

    const html = generateHtmlReport(data, {
      projectName: "ETA scope",
      projectPath: base,
      gsdVersion: "test",
    });
    assert.ok(html.includes("4.0/hr"), "export HTML should use the scoped active-milestone rate");
  } finally {
    resetMetrics();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadVisualizerData includes active memory-store entries", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-memories-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(":memory:");

    createMemory({
      category: "gotcha",
      content: "Visualizer memory rows must come from the memory store",
      confidence: 0.92,
      scope: "M001/S01",
      tags: ["visualizer", "memory"],
    });
    createMemory({
      category: "pattern",
      content: "Superseded rows should stay out of the visualizer",
      confidence: 0.2,
    });

    const adapter = _getAdapter();
    adapter?.prepare("UPDATE memories SET superseded_by = 'MEM999' WHERE id = 'MEM002'").run();

    const data = await loadVisualizerData(base);

    assert.equal(data.memories.totalCount, 1);
    assert.equal(data.memories.entries[0]?.id, "MEM001");
    assert.equal(data.memories.entries[0]?.category, "gotcha");
    assert.equal(data.memories.entries[0]?.content, "Visualizer memory rows must come from the memory store");
    assert.equal(data.memories.entries[0]?.scope, "M001/S01");
    assert.deepEqual(data.memories.entries[0]?.tags, ["visualizer", "memory"]);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadVisualizerData opens the project DB for memory entries when none is open", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-memories-db-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    createMemory({
      category: "gotcha",
      content: "Browser visualizer child processes must open the project DB",
      confidence: 0.88,
      tags: ["browser", "visualizer"],
    });
    closeDatabase();

    const data = await loadVisualizerData(base);

    assert.equal(data.memories.totalCount, 1);
    assert.equal(data.memories.entries[0]?.id, "MEM001");
    assert.equal(data.memories.entries[0]?.content, "Browser visualizer child processes must open the project DB");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadVisualizerData caps memory content for visualizer payloads", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-memory-cap-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(":memory:");
    const largeContent = "A".repeat(2500);
    createMemory({
      category: "gotcha",
      content: largeContent,
      confidence: 0.9,
    });

    const data = await loadVisualizerData(base);

    const content = data.memories.entries[0]?.content ?? "";
    assert.equal(data.memories.totalCount, 1);
    assert.ok(content.length < largeContent.length);
    assert.ok(content.length <= 2003);
    assert.ok(content.endsWith("..."));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
