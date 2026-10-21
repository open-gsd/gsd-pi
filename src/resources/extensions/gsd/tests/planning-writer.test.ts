// Project/App: gsd-pi
// File Purpose: Tests for the DB → .planning/ projection writer.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { writePlanningDirectory } from "../migrate/planning-writer.ts";
import { applyPlanningProjectionWrites } from "../compat/planning-compat.ts";
import { readCompatMarker, writeCompatMarker } from "../compat/compat-marker.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, updateSliceStatus, updateTaskStatus } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pw-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
    planning: { estimate: "30m" },
  });
  tmpDirs.push(base);
  return base;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...listFiles(path));
    else paths.push(path);
  }
  return paths;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("writePlanningDirectory emits flat-phases layout: ROADMAP.md + phases/NN-slug/", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");

  assert.ok(existsSync(join(base, ".planning", "ROADMAP.md")), "ROADMAP.md missing");
  assert.ok(existsSync(join(base, ".planning", "STATE.md")), "STATE.md missing");
  assert.ok(existsSync(join(base, ".planning", "PROJECT.md")), "PROJECT.md missing");

  const phaseDirs = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(phaseDirs.length >= 1, `expected ≥1 phase dir, got ${JSON.stringify(phaseDirs)}`);
  assert.ok(/^01-/.test(phaseDirs[0]!), `phase dir should start with 01-, got ${phaseDirs[0]}`);
});

test("writePlanningDirectory emits phase plan file with XML structure", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");

  const phaseDir = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)[0]!;
  const planFiles = readdirSync(join(base, ".planning", "phases", phaseDir))
    .filter((f) => f.endsWith("PLAN.md"));
  assert.ok(planFiles.length >= 1, "expected ≥1 plan file");
  const plan = readFileSync(join(base, ".planning", "phases", phaseDir, planFiles[0]!), "utf-8");
  // Planning plans use XML tags per parsers.ts extractXmlTag
  assert.match(plan, /<objective>/);
  assert.match(plan, /<tasks>/);
});

test("writePlanningDirectory renders completed task checkboxes as [x] (#1276)", async () => {
  const base = makeTmp();
  updateTaskStatus("M001", "S01", "T01", "complete");
  await writePlanningDirectory(base, "flat-phases");

  const phaseDir = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)[0]!;
  const planFile = readdirSync(join(base, ".planning", "phases", phaseDir))
    .filter((f) => f.endsWith("PLAN.md"))[0]!;
  const plan = readFileSync(join(base, ".planning", "phases", phaseDir, planFile), "utf-8");
  assert.match(plan, /- \[x\] \*\*T01\*\*/, "completed task should project as [x], not [ ]");

  const roadmap = readFileSync(join(base, ".planning", "ROADMAP.md"), "utf-8");
  assert.match(roadmap, /- \[x\] 01 —/, "phase with all tasks complete should be [x] in ROADMAP");
});

test("writePlanningDirectory is idempotent: writing twice produces stable content", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");
  const snap = (p: string) => readFileSync(p, "utf-8").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  const roadmap1 = snap(join(base, ".planning", "ROADMAP.md"));
  await writePlanningDirectory(base, "flat-phases");
  const roadmap2 = snap(join(base, ".planning", "ROADMAP.md"));
  assert.equal(roadmap2, roadmap1);
});

test("writePlanningDirectory preserves modeled edits with an empty active baseline", async () => {
  const base = makeTmp();
  const roadmapPath = join(base, ".planning", "ROADMAP.md");
  mkdirSync(join(base, ".planning"), { recursive: true });
  const edited = "# External planning roadmap\n";
  writeFileSync(roadmapPath, edited, "utf-8");
  const marker = readCompatMarker(base);
  marker.planning = {
    active: true,
    layout: "flat-phases",
    projections: {},
    passthrough: {},
  };
  writeCompatMarker(base, marker);

  await writePlanningDirectory(base, "flat-phases");

  assert.notEqual(readFileSync(roadmapPath, "utf-8"), edited);
  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.equal(readFileSync(quarantined[0]!, "utf-8"), edited);
});

test("writePlanningDirectory does not quarantine stable matching unbaselined output", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");
  const roadmapContent = readFileSync(join(base, ".planning", "ROADMAP.md"), "utf-8");
  const marker = readCompatMarker(base);
  marker.planning = {
    active: true,
    layout: "flat-phases",
    projections: {},
    passthrough: {},
  };
  writeCompatMarker(base, marker);

  await writePlanningDirectory(base, "flat-phases");

  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(
    quarantined.some((path) => readFileSync(path, "utf-8") === roadmapContent),
    false,
  );
});

test("writePlanningDirectory does not emit an ingestible PLAN.md for a task-less (sketch) slice", async () => {
  // Regression for #1285: a milestone-level sketch slice has zero DB tasks.
  // The projection must not write a placeholder NN-01-PLAN.md — the reverse
  // transform maps one task per plan file, so a placeholder would materialize
  // a phantom "Plan NN" task and make auto-mode skip planning.
  const base = makeTmp();
  insertSlice({
    milestoneId: "M001", id: "S02", title: "Sketch slice", status: "pending",
    risk: "medium", depends: ["S01"], demo: "designed", sequence: 2,
  });
  // S02 intentionally has no tasks.

  await writePlanningDirectory(base, "flat-phases");

  const phaseDirs = readdirSync(join(base, ".planning", "phases"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const sketchDir = phaseDirs.find((d) => /^02-/.test(d));
  assert.ok(sketchDir, `expected a 02- phase dir for the sketch slice, got ${JSON.stringify(phaseDirs)}`);

  const planFiles = readdirSync(join(base, ".planning", "phases", sketchDir!))
    .filter((f) => f.endsWith("PLAN.md"));
  assert.equal(planFiles.length, 0, `sketch slice should have no PLAN.md, got ${JSON.stringify(planFiles)}`);

  // The slice remains discoverable via ROADMAP.md.
  const roadmap = readFileSync(join(base, ".planning", "ROADMAP.md"), "utf-8");
  assert.match(roadmap, /Sketch slice/);
});

test("writePlanningDirectory removes cancelled modeled plans while preserving passthrough files", async () => {
  const base = makeTmp();
  insertSlice({
    milestoneId: "M001", id: "S02", title: "Second slice", status: "pending",
    risk: "low", depends: [], demo: "second demo", sequence: 2,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S02", id: "T02", title: "Second task",
    status: "pending", sequence: 1,
  });
  await writePlanningDirectory(base, "flat-phases");

  const phasesRoot = join(base, ".planning", "phases");
  const phaseDirs = readdirSync(phasesRoot).sort();
  const stalePlanPaths = phaseDirs.map((phaseDir) =>
    join(phasesRoot, phaseDir, readdirSync(join(phasesRoot, phaseDir)).find((name) => name.endsWith("-PLAN.md"))!),
  );
  const modeledSummaryPath = join(phasesRoot, phaseDirs[0]!, "01-01-SUMMARY.md");
  const modeledSummaryContent = "# Completed work\n\nThis completion evidence must survive plan cleanup.\n";
  writeFileSync(modeledSummaryPath, modeledSummaryContent, "utf8");
  const modeledSummaryRelPath = `phases/${phaseDirs[0]}/01-01-SUMMARY.md`;
  applyPlanningProjectionWrites(base, [{
    relPath: modeledSummaryRelPath,
    entities: ["M001/S01/T01"],
  }]);
  const passthroughPath = join(phasesRoot, phaseDirs[0]!, "01-RESEARCH.md");
  writeFileSync(passthroughPath, "# Preserve this research\n", "utf8");
  applyPlanningProjectionWrites(base, [{
    relPath: `phases/${phaseDirs[0]}/01-RESEARCH.md`,
    entities: [],
    passthrough: true,
  }]);

  updateSliceStatus("M001", "S01", "skipped");
  updateTaskStatus("M001", "S02", "T02", "skipped");
  await writePlanningDirectory(base, "flat-phases");

  for (const stalePlanPath of stalePlanPaths) {
    assert.equal(existsSync(stalePlanPath), false, `obsolete modeled plan remains: ${stalePlanPath}`);
  }
  assert.equal(
    readFileSync(modeledSummaryPath, "utf8"),
    modeledSummaryContent,
    "modeled completion summary must survive obsolete plan cleanup",
  );
  assert.equal(existsSync(passthroughPath), true, "passthrough research must survive projection cleanup");
  const marker = readCompatMarker(base);
  for (const stalePlanPath of stalePlanPaths) {
    const relPath = stalePlanPath.slice(join(base, ".planning").length + 1).replace(/\\/g, "/");
    assert.equal(marker.planning?.projections[relPath], undefined);
  }
  assert.ok(marker.planning?.projections[modeledSummaryRelPath]);
  assert.ok(marker.planning?.passthrough[`phases/${phaseDirs[0]}/01-RESEARCH.md`]);
});

test("writePlanningDirectory preserves an externally edited obsolete plan", async () => {
  const base = makeTmp();
  await writePlanningDirectory(base, "flat-phases");

  const phasesRoot = join(base, ".planning", "phases");
  const phaseDir = readdirSync(phasesRoot)[0]!;
  const planName = readdirSync(join(phasesRoot, phaseDir)).find((name) => name.endsWith("-PLAN.md"))!;
  const planPath = join(phasesRoot, phaseDir, planName);
  const planRelPath = `phases/${phaseDir}/${planName}`;
  const editedContent = "# User-owned plan\n\nKeep this external edit.\n";
  writeFileSync(planPath, editedContent, "utf8");

  updateSliceStatus("M001", "S01", "skipped");
  await writePlanningDirectory(base, "flat-phases");

  assert.equal(readFileSync(planPath, "utf8"), editedContent);
  assert.ok(
    readCompatMarker(base).planning?.projections[planRelPath],
    "the stale ownership marker must remain so reconciliation can observe the edit",
  );
});

test("writePlanningDirectory throws for unsupported layouts", async () => {
  const base = makeTmp();
  await assert.rejects(() => writePlanningDirectory(base, "multi-milestone"), /not yet supported/);
  await assert.rejects(() => writePlanningDirectory(base, "legacy-milestone-dir"), /not yet supported/);
});
