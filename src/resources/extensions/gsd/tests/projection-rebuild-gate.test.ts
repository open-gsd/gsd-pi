// Project/App: gsd-pi
// File Purpose: ADR-046 gate G1 for projections: a rebuild from the database alone restores every projection file.
//
// The fixture stores each projection kind in the database the way its tool
// does, then deletes every file under .gsd except the database.
//
// A check wrapped in expectedFail("P12") cannot pass on current code (see
// db-authority-gate.ts). Kinds with no check here: the milestone SUMMARY (its
// source is the milestone completion event) and the task PLAN file (legacy
// layout only; the full rebuild does not write it).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, test } from "node:test";

import { _setManagedMutationBoundaryForTest } from "../atomic-write.ts";
import { readCompatMarker, writeCompatMarker } from "../compat/compat-marker.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { saveArtifactToDb } from "../db-writer.ts";
import {
  _getAdapter,
  insertArtifact,
  insertAssessment,
  insertMilestone,
  insertSlice,
  setSliceSummaryMd,
} from "../gsd-db.ts";
import {
  detectProjectionDrift,
  renderMilestoneValidation,
  renderRoadmapAssessment,
  renderSliceReplan,
} from "../markdown-renderer.ts";
import { parkMilestone } from "../milestone-actions.ts";
import { relSliceFile } from "../paths.ts";
import { rebuildMarkdownProjectionsFromDb } from "../projection-worker.ts";
import { invalidateStateCache } from "../state.ts";
import { renderAllProjections } from "../workflow-projections.ts";
import { deleteProjections, expectedFail } from "./db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

// Fixture (workflow-authority-fixture.ts): M001 active; S01 complete (T01
// complete); S02 pending with T01 pending; one requirement; one decision.
let fixture: WorkflowAuthorityFixture;

afterEach(() => {
  _setManagedMutationBoundaryForTest(null);
  fixture?.cleanup();
  invalidateStateCache();
});

const PHASE = "phases/01-authority-fixture";
const SLICE_ASSESSMENT = `${PHASE}/01-01-ASSESSMENT.md`;
const VALIDATION_MD = "---\nverdict: pass\n---\n\n# M001 Validation\n\nAll slices verified.\n";
const PROJECT_MD = "# Project\n\nNarrative that only the database holds.\n";

// One row per projection kind: the file that a rebuild must write for it.
const MATRIX: ReadonlyArray<readonly [kind: string, file: string]> = [
  ["QUEUE", "QUEUE.md"],
  ["root ROADMAP", "ROADMAP.md"],
  ["REQUIREMENTS", "REQUIREMENTS.md"],
  ["PROJECT", "PROJECT.md"],
  ["DECISIONS", "DECISIONS.md"],
  ["STATE", "STATE.md"],
  ["milestone ROADMAP", `${PHASE}/01-ROADMAP.md`],
  ["VALIDATION", `${PHASE}/01-VALIDATION.md`],
  ["ROADMAP-ASSESSMENT", `${PHASE}/01-ROADMAP-ASSESSMENT.md`],
  ["ASSESSMENT", SLICE_ASSESSMENT],
  ["REPLAN", `${PHASE}/01-02-REPLAN.md`],
  ["PLAN", `${PHASE}/01-02-PLAN.md`],
  ["task SUMMARY", `${PHASE}/S01-T01-SUMMARY.md`],
  ["slice SUMMARY", `${PHASE}/01-01-SUMMARY.md`],
  ["UAT", `${PHASE}/01-01-UAT.md`],
  ["PARKED", "phases/03-parked-milestone/03-PARKED.md"],
];

interface FileState {
  bytes: string;
  mtimeMs: number;
}

/** Every markdown file under `root`, by relative path. Quarantine copies are evidence, not projections. */
function markdownFiles(root: string): Map<string, FileState> {
  const files = new Map<string, FileState>();
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, entry);
    const rel = relative(root, path).split(sep).join("/");
    if (!rel.endsWith(".md") || rel.startsWith("quarantine/") || !statSync(path).isFile()) continue;
    files.set(rel, { bytes: readFileSync(path, "utf-8"), mtimeMs: statSync(path).mtimeMs });
  }
  return files;
}

function bytesOf(files: Map<string, FileState>): Record<string, string> {
  return Object.fromEntries([...files].map(([rel, state]) => [rel, state.bytes]));
}

/** Commit the durable event that gsd_replan_slice records, with the Projection Work of the slice. */
function commitReplanEvent(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "projection-rebuild-gate.replan",
    idempotencyKey: "projection-rebuild-gate/replan",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "projection-rebuild-gate",
    sourceTransport: "test",
    payload: {},
  }, () => ({
    events: [{
      eventType: "workflow.slice.replanned",
      entityType: "slice",
      entityId: "M001/S02",
      payload: {
        blockerTaskId: "T01",
        blockerDescription: "The interface changed.",
        whatChanged: "T01 now targets the new interface.",
      },
      destinations: ["projection"],
    }],
    projections: [{ projectionKey: "planning/m001/s02", projectionKind: "markdown", rendererVersion: "v1" }],
  }));
}

/**
 * Store every projection kind in the database, then write the files the way
 * the tools do after their commit. Returns the files that exist at that point.
 */
async function seedMatrix(base: string): Promise<Map<string, FileState>> {
  const db = _getAdapter();
  assert.ok(db, "database must be open");

  insertMilestone({ id: "M002", title: "Queued milestone" });
  insertMilestone({ id: "M003", title: "Parked milestone", status: "active", planning: { vision: "Park me." } });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Parked slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  db.prepare("UPDATE tasks SET full_summary_md = :md WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'")
    .run({ ":md": "---\nid: T01\nparent: S01\nmilestone: M001\n---\n\n# T01: Completed task\n" });
  setSliceSummaryMd("M001", "S01", "# S01: Completed prerequisite\n\nSummary.\n", "# S01 UAT\n\nSteps.\n");
  insertAssessment({
    path: `${PHASE}/01-VALIDATION.md`,
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: VALIDATION_MD,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  insertAssessment({
    path: `${PHASE}/01-ROADMAP-ASSESSMENT.md`,
    milestoneId: "M001",
    sliceId: "S01",
    status: "roadmap-confirmed",
    scope: "roadmap",
    fullContent: "The roadmap holds after S01.",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(await parkMilestone(base, "M003", "waiting for a decision", { fromAutoLoop: true }), true);
  commitReplanEvent();

  // Every Domain Operation is committed. The writes below are the ones the
  // tools make after their commit, so they carry the final state version.
  // The roadmap is rendered first, as it is when a milestone is planned.
  for (const milestoneId of ["M001", "M003"]) {
    assert.deepEqual(await renderAllProjections(base, milestoneId), { stale: false });
  }
  await saveArtifactToDb({ path: "PROJECT.md", artifact_type: "PROJECT", content: PROJECT_MD }, base);
  await saveArtifactToDb({
    path: relSliceFile(base, "M001", "S01", "ASSESSMENT").replace(/^\.gsd\//, ""),
    artifact_type: "ASSESSMENT",
    content: "# S01 Assessment\n\n**Verdict:** PASS\n",
    milestone_id: "M001",
    slice_id: "S01",
  }, base);
  assert.equal(await renderMilestoneValidation(base, "M001"), true);
  assert.ok(await renderRoadmapAssessment(base, "M001"));
  assert.ok(await renderSliceReplan(base, "M001", "S02"));
  return markdownFiles(join(base, ".gsd"));
}

describe("G1: projection rebuild from the database alone", () => {
  test("every projection kind is restored with the bytes the tools wrote, and a second rebuild writes nothing", async () => {
    fixture = await createWorkflowAuthorityFixture();
    const base = fixture.root;
    const gsd = join(base, ".gsd");
    const written = await seedMatrix(base);
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const control = markdownFiles(gsd);

    deleteProjections(base);
    assert.deepEqual([...markdownFiles(gsd).keys()], [], "every projection file is deleted");
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const restored = markdownFiles(gsd);

    for (const [kind, file] of MATRIX) {
      assert.ok(restored.has(file), `${kind}: the rebuild writes ${file}; it wrote ${[...restored.keys()].join(", ")}`);
    }
    assert.deepEqual(bytesOf(restored), bytesOf(control), "a rebuild with no files equals a rebuild over the files");
    // gsd_summary_save writes a milestone or slice artifact with no state-version
    // stamp; the rebuild writes the same artifact with the stamp.
    const { [SLICE_ASSESSMENT]: toolAssessment, ...toolFiles } = bytesOf(written);
    for (const [file, bytes] of Object.entries(toolFiles)) {
      assert.equal(restored.get(file)?.bytes, bytes, `${file}: the rebuild writes the bytes the tool wrote`);
    }
    expectedFail("P12", () => assert.equal(restored.get(SLICE_ASSESSMENT)?.bytes, toolAssessment));
    assert.equal(restored.get(`${PHASE}/01-VALIDATION.md`)?.bytes, VALIDATION_MD);
    assert.equal(restored.get("PROJECT.md")?.bytes, PROJECT_MD);
    assert.match(restored.get("QUEUE.md")!.bytes, /\*\*M002: Queued milestone\*\*/);
    assert.match(restored.get(`${PHASE}/01-02-REPLAN.md`)!.bytes, /T01 now targets the new interface\./);
    assert.match(restored.get(`${PHASE}/01-ROADMAP-ASSESSMENT.md`)!.bytes, /The roadmap holds after S01\./);
    assert.match(restored.get("phases/03-parked-milestone/03-PARKED.md")!.bytes, /waiting for a decision/);

    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    assert.deepEqual(markdownFiles(gsd), restored, "a second rebuild rewrites no projection file");
  });

  test("a rebuild does not use the content of an existing projection file", async () => {
    fixture = await createWorkflowAuthorityFixture();
    const base = fixture.root;
    const gsd = join(base, ".gsd");
    await seedMatrix(base);
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const control = bytesOf(markdownFiles(gsd));

    for (const file of Object.keys(control)) {
      writeFileSync(join(gsd, file), `# Text that is not in the database\n\n${file}\n`);
    }
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const rebuilt = bytesOf(markdownFiles(gsd));

    // KNOWLEDGE.md keeps the text above its first section from the file.
    const { "KNOWLEDGE.md": knowledge, ...others } = rebuilt;
    const { "KNOWLEDGE.md": controlKnowledge, ...controlOthers } = control;
    assert.deepEqual(others, controlOthers);
    expectedFail("P11", () => assert.equal(knowledge, controlKnowledge));
  });

  test("an artifact row is not replayed for a kind that has a structured source", async () => {
    fixture = await createWorkflowAuthorityFixture();
    const base = fixture.root;
    const gsd = join(base, ".gsd");
    await seedMatrix(base);
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const control = bytesOf(markdownFiles(gsd));

    // Artifact rows that hold other content than the structured source, as an
    // import or an older render leaves them.
    insertArtifact({
      path: `${PHASE}/01-VALIDATION.md`,
      artifact_type: "VALIDATION",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "# Validation text of an older row\n",
    });
    const db = _getAdapter();
    assert.ok(db, "database must be open");
    db.prepare(
      "UPDATE artifacts SET full_content = '# Text of an older row' WHERE artifact_type IN ('REPLAN', 'ROADMAP-ASSESSMENT')",
    ).run();
    const older = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE full_content = '# Text of an older row'").get();
    assert.equal(Number(older?.["n"]), 2, "the REPLAN and ROADMAP-ASSESSMENT rows exist");

    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);

    assert.deepEqual(bytesOf(markdownFiles(gsd)), control);
    assert.deepEqual(
      detectProjectionDrift(base).filter((entry) => entry.path.includes("VALIDATION")),
      [],
      "the older VALIDATION row is not render intent",
    );
  });

  test("the .planning projection has no wall-clock field, and is not restored without the marker file", async () => {
    fixture = await createWorkflowAuthorityFixture();
    const base = fixture.root;
    const planning = join(base, ".planning");
    await seedMatrix(base);
    const marker = readCompatMarker(base);
    marker.planning = { active: true, layout: "flat-phases", projections: {}, passthrough: {} };
    writeCompatMarker(base, marker);

    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    const first = bytesOf(markdownFiles(planning));
    assert.ok(first["STATE.md"], ".planning/STATE.md is rendered");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    assert.deepEqual(bytesOf(markdownFiles(planning)), first, "a second rebuild renders the same .planning bytes");

    // The flag that turns the .planning projection on is in .gsd/.compat.json, not in the database.
    deleteProjections(base);
    rmSync(planning, { recursive: true, force: true });
    assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
    expectedFail("P12", () => assert.deepEqual(bytesOf(markdownFiles(planning)), first));
  });
});
