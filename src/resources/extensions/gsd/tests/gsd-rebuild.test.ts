import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleRebuild } from "../commands-maintenance.ts";
import {
  getCurrentProjectStateVersion,
  renderRoadmapFromDb,
  renderTaskPlanFromDb,
} from "../markdown-renderer.ts";
import { preserveProjectionChanges } from "../projection-worker.ts";
import { saveDecisionToDb, saveRequirementToDb } from "../db-writer.ts";
import { computeProjectionSha, readCompatMarker } from "../compat/compat-marker.ts";
import {
  closeDatabase,
  getArtifact,
  getTask,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  setSliceSummaryMd,
} from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import {
  describeArtifactDbDriftBlocker,
  detectArtifactDbDrift,
} from "../state-reconciliation/drift/artifact-db.ts";

type Note = { message: string; kind: string };

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-rebuild-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
    recursive: true,
  });
  return base;
}

function cleanup(base: string): void {
  closeDatabase();
  invalidateStateCache();
  rmSync(base, { recursive: true, force: true });
}

function makeCtx(): { ctx: any; notes: Note[] } {
  const notes: Note[] = [];
  return {
    ctx: {
      ui: {
        notify: (message: string, kind: string) => notes.push({ message, kind }),
      },
    },
    notes,
  };
}

function seedOpenTask(): void {
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "in_progress",
    risk: "low",
    depends: [],
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "pending",
  });
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out.sort();
}

test("handleRebuild quarantines stale completion projections without mutating DB state", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    writeFileSync(summaryPath, "# T01 Summary\n\nDisk-only completion.\n", "utf-8");

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base, "markdown");

    assert.equal(existsSync(summaryPath), false, "stale SUMMARY projection should be moved aside");
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending", "DB task status remains authoritative");
    assert.equal(task?.full_summary_md, "", "disk summary must not be imported into DB");

    const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
    assert.equal(quarantined.length, 1);
    assert.match(readFileSync(quarantined[0]!, "utf-8"), /Disk-only completion/);
    assert.match(notes.at(-1)?.message ?? "", /Quarantined:\s+1/);
    assert.equal(notes.at(-1)?.kind, "success");
  } finally {
    cleanup(base);
  }
});

test("handleRebuild keeps the SUMMARY artifact row when it quarantines the file on disk", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const artifactPath = "milestones/M001/slices/S01/tasks/T01-SUMMARY.md";
  insertArtifact({
    path: artifactPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# T01 Summary\n\nStored in the DB.\n",
  });
  const summaryPath = join(base, ".gsd", artifactPath);
  writeFileSync(summaryPath, "# T01 Summary\n\nHand-edited on disk.\n", "utf-8");

  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");

  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1, "the disk file is moved to quarantine");
  assert.equal(
    getArtifact(artifactPath)?.full_content,
    "# T01 Summary\n\nStored in the DB.\n",
    "a file on disk must not make rebuild delete DB content",
  );

  // The kept row is still an unproven completion claim on an open task, so
  // the drift stays fail-closed. The blocker must not send the user back to
  // the rebuild that cannot clear it.
  invalidateStateCache();
  const state = await deriveState(base);
  const drifts = detectArtifactDbDrift(state, { basePath: base, state });
  assert.deepEqual(
    drifts.map((drift) => drift.kind === "artifact-db-status-divergence" ? drift.reason : drift.kind),
    ["task S01/T01 has SUMMARY artifact while DB status is pending"],
  );
  const blocker = describeArtifactDbDriftBlocker(drifts[0]!, { basePath: base, state }) ?? "";
  assert.match(blocker, /keeps that row, so this blocker can remain after a rebuild/);
  assert.match(blocker, /`\/gsd recover` with exact Preview approval/);
  assert.doesNotMatch(blocker, /Run `\/gsd rebuild markdown`/);
});

test("a SUMMARY file on disk with no artifact row still points at /gsd rebuild markdown", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
    "# T01 Summary\n\nDisk-only completion.\n",
    "utf-8",
  );

  const state = await deriveState(base);
  const drifts = detectArtifactDbDrift(state, { basePath: base, state });
  assert.equal(drifts.length, 1);
  assert.match(
    describeArtifactDbDriftBlocker(drifts[0]!, { basePath: base, state }) ?? "",
    /Run `\/gsd rebuild markdown` after review to quarantine stale projections/,
  );

  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  invalidateStateCache();
  const after = await deriveState(base);
  assert.deepEqual(detectArtifactDbDrift(after, { basePath: base, state: after }), [], "the rebuild clears a file-only drift");
});

test("handleRebuild re-renders missing task summary projections from DB", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "complete",
      oneLiner: "Task complete",
      narrative: "Finished through the DB.",
      verificationResult: "passed",
      fullSummaryMd: "# T01 Summary\n\nRendered from DB.\n",
    });

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    rmSync(summaryPath, { force: true });

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base);

    assert.equal(existsSync(summaryPath), true, "missing SUMMARY projection should be regenerated");
    // T008: rendered projections carry the state-version stamp line; assert the
    // exact stamped bytes (markdown-renderer.test.ts pattern) rather than
    // stripping the stamp, keeping this a byte-exact re-render check.
    const { revision, authorityEpoch } = getCurrentProjectStateVersion();
    assert.equal(
      readFileSync(summaryPath, "utf-8"),
      `# T01 Summary\n\nRendered from DB.\n<!-- gsd:state-version=${revision}:${authorityEpoch} -->\n`,
    );
    assert.match(notes.at(-1)?.message ?? "", /rebuilt markdown projections from the canonical DB/);
    assert.match(notes.at(-1)?.message ?? "", /Quarantined:\s+0/);
  } finally {
    cleanup(base);
  }
});

test("handleRebuild preserves an edited completed summary before restoring the DB projection", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "complete",
    oneLiner: "Task complete",
    narrative: "Canonical narrative.",
    verificationResult: "passed",
    fullSummaryMd: "# T01 Summary\n\nCanonical summary.\n",
  });

  const summaryPath = join(
    base,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "tasks",
    "T01-SUMMARY.md",
  );
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  writeFileSync(summaryPath, "# T01 Summary\n\nExternally edited evidence.\n", "utf-8");

  await handleRebuild(ctx, base, "markdown");

  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.equal(
    readFileSync(quarantined[0]!, "utf-8"),
    "# T01 Summary\n\nExternally edited evidence.\n",
  );
  assert.match(readFileSync(summaryPath, "utf-8"), /Canonical summary/);
});

test("handleRebuild preserves every unbaselined renderer-owned edit", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  setSliceSummaryMd(
    "M001",
    "S01",
    "# Canonical slice summary\n",
    "# Canonical slice UAT\n",
  );
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "complete",
    fullSummaryMd: "# Canonical task summary\n",
  });
  insertArtifact({
    path: "milestones/M001/M001-CONTEXT.md",
    artifact_type: "CONTEXT",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# Canonical stored context\n",
  });
  await saveDecisionToDb({
    scope: "architecture",
    decision: "Use canonical projection intent",
    choice: "Database authority",
    rationale: "Preserve durable state",
  }, base);

  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const editedFiles = new Map<string, string>([
    [
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# External task summary\n",
    ],
    [
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md"),
      "# External slice UAT\n",
    ],
    [
      join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
      "# External stored context\n",
    ],
    [join(base, ".gsd", "DECISIONS.md"), "# External decisions\n"],
  ]);
  for (const [path, content] of editedFiles) writeFileSync(path, content, "utf-8");
  rmSync(join(base, ".gsd", ".compat.json"), { force: true });

  await handleRebuild(ctx, base, "markdown");

  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"))
    .map((path) => readFileSync(path, "utf-8"));
  assert.deepEqual(new Set(quarantined), new Set(editedFiles.values()));
  for (const [path, edited] of editedFiles) {
    assert.notEqual(readFileSync(path, "utf-8"), edited);
  }
});

test("trusted marker baselines do not misclassify pending DB renders", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  const renderedBytes = readFileSync(roadmapPath);
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Updated canonical slice",
    status: "in_progress",
    risk: "low",
    depends: [],
  });

  const observation = await preserveProjectionChanges(base);

  assert.equal(observation.preserved.length, 0);
  assert.deepEqual(readFileSync(roadmapPath), renderedBytes);
  assert.equal(existsSync(join(base, ".gsd", "quarantine", "projections")), false);
});

test("the external-edit observer never moves an edited STATE.md", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const statePath = join(base, ".gsd", "STATE.md");
  const rendered = readFileSync(statePath, "utf-8");
  const markerPath = join(base, ".gsd", ".compat.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
  marker.projections["STATE.md"] = { sha: computeProjectionSha(rendered), entities: [] };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  const edited = "# GSD State\n\nExternal edit\n";
  writeFileSync(statePath, edited);

  const observation = await preserveProjectionChanges(base);

  assert.deepEqual(observation.preserved.map((entry) => entry.sourcePath), []);
  assert.equal(readFileSync(statePath, "utf-8"), edited);
  assert.equal(existsSync(join(base, ".gsd", "quarantine", "projections")), false);
});

test("projection writer preserves edited bytes at the mutation boundary", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  const editedBytes = Buffer.from("# External roadmap evidence\n");
  writeFileSync(roadmapPath, editedBytes);

  await renderRoadmapFromDb(base, "M001");

  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(readFileSync(quarantined[0]!), editedBytes);
  assert.notDeepEqual(readFileSync(roadmapPath), editedBytes);
});

test("projection baselines retain the exact rendered intent", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  const rendered = await renderRoadmapFromDb(base, "M001");
  assert.ok("content" in rendered);
  const edited = "# Edit after the atomic render\n";
  writeFileSync(roadmapPath, edited);

  const projectionPath = "milestones/M001/M001-ROADMAP.md";
  const baseline = readCompatMarker(base).projections[projectionPath]?.sha;

  assert.equal(baseline, computeProjectionSha(rendered.content));
  assert.notEqual(baseline, computeProjectionSha(edited));
});

test("unbaselined roadmap removal preserves existing bytes", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "", status: "queued" });
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  const editedBytes = Buffer.from("# External unplanned roadmap\n");
  writeFileSync(roadmapPath, editedBytes);

  const result = await renderRoadmapFromDb(base, "M001");

  assert.deepEqual(result, { skipped: "unplanned-milestone" });
  assert.equal(existsSync(roadmapPath), false);
  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(readFileSync(quarantined[0]!), editedBytes);
});

test("unbaselined legacy task plan writes preserve existing bytes", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seedOpenTask();
  const planPath = join(
    base,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "tasks",
    "T01-PLAN.md",
  );
  const editedBytes = Buffer.from("# External legacy task plan\n");
  writeFileSync(planPath, editedBytes);

  await renderTaskPlanFromDb(base, "M001", "S01", "T01");

  assert.notDeepEqual(readFileSync(planPath), editedBytes);
  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(readFileSync(quarantined[0]!), editedBytes);
});

test("unbaselined root requirement writes preserve existing bytes", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  await saveRequirementToDb({
    class: "core-capability",
    description: "Canonical requirement",
    why: "Required behavior",
    source: "review",
  }, base);
  const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
  const editedBytes = Buffer.from("# External requirements evidence\n");
  writeFileSync(requirementsPath, editedBytes);
  rmSync(join(base, ".gsd", ".compat.json"), { force: true });

  await saveRequirementToDb({
    class: "core-capability",
    description: "Second canonical requirement",
    why: "Changes render intent",
    source: "review",
  }, base);

  assert.notDeepEqual(readFileSync(requirementsPath), editedBytes);
  const quarantined = listFiles(join(base, ".gsd", "quarantine", "projections"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(readFileSync(quarantined[0]!), editedBytes);
});

test("handleRebuild has no database target: it shows usage and does not import markdown", async () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    seedOpenTask();

    const summaryPath = join(
      base,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "tasks",
      "T01-SUMMARY.md",
    );
    writeFileSync(summaryPath, "# T01 Summary\n\nShould not import.\n", "utf-8");

    const { ctx, notes } = makeCtx();
    await handleRebuild(ctx, base, "database");

    assert.equal(existsSync(summaryPath), true, "an unknown rebuild target must not move projection files");
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending", "an unknown rebuild target must not mutate task status");
    assert.equal(task?.full_summary_md, "", "an unknown rebuild target must not import markdown");
    assert.equal(notes.length, 1);
    assert.match(notes[0]?.message ?? "", /^Usage:\n {2}\/gsd rebuild markdown /);
    assert.doesNotMatch(notes[0]?.message ?? "", /database/i);
    assert.equal(notes[0]?.kind, "warning");
  } finally {
    cleanup(base);
  }
});
