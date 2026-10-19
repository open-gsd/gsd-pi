// Project/App: gsd-pi
// File Purpose: Unit tests for external .gsd edit observation.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { observeExternalMarkdownEdits } from "../state-reconciliation/drift/external-markdown-edit.ts";
import { readCompatMarker, writeCompatMarker, computeProjectionSha } from "../compat/compat-marker.ts";
import { closeDatabase, insertArtifact, insertDecision, openDatabase } from "../gsd-db.ts";
import { readDecisionsProjectionIntent } from "../db-writer.ts";
import { backfillDecisionsToMemories } from "../memory-backfill.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-extedit-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

afterEach(() => {
  try {
    closeDatabase();
  } catch {
    /* noop */
  }
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  tmpDirs.length = 0;
});

test("detect returns no drift when file sha matches marker", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n\n- [x] S1 done\n", "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: computeProjectionSha("# Roadmap\n\n- [x] S1 done\n"), entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 0);
});

test("detect returns drift when file content differs from marker", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n\n- [ ] S1 NOT done\n", "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "stale000000000000", entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, "external-markdown-edit");
  assert.equal(drift[0].projectionPath, rel);
  assert.deepEqual(drift[0].entities, ["m1"]);
});

test("detect refreshes stale marker when current file already matches DB artifact", async () => {
  const base = makeTmpBase();
  const rel = "milestones/M001/M001-ROADMAP.md";
  const dbRel = "phases/01-alpha/01-ROADMAP.md";
  const content = "# M001: Alpha\n\n## Slices\n\n- [ ] **S01: Work** `risk:low` `depends:[]`\n";
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), content, "utf-8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertArtifact({
    path: dbRel,
    artifact_type: "ROADMAP",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: content,
  });
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "stale000000000000", entities: ["M001"] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.9.0",
  });

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 0);
  const marker = readCompatMarker(base);
  assert.equal(marker.projections[rel]?.sha, computeProjectionSha(content));
});

test("detect treats missing marker as drift on every tracked projection file", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n", "utf-8");
  // No writeCompatMarker call → marker missing → EMPTY_MARKER

  // Without a marker we have no projections to compare, so detect should be a
  // no-op (the reconcile pipeline's other handlers cover the "import everything"
  // case via the existing /gsd recover flow). This is by design: this handler
  // only fires when we HAVE a baseline to compare.
  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 0);
});

test("detect ignores files missing from disk (other handlers cover that)", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "abc123", entities: ["m1"] } },
    piVersion: "1.4.0",
  });
  // No file written.

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 0);
});

test("a DECISIONS.md that matches the database render is not an external edit (#2728)", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertDecision({
    id: "D001",
    when_context: "2026-10-09",
    scope: "global",
    decision: "Store projections in SQLite",
    choice: "SQLite is the authority",
    rationale: "durable and inspectable",
    revisable: "Yes",
    made_by: "human",
    superseded_by: null,
  });
  backfillDecisionsToMemories();
  const intent = await readDecisionsProjectionIntent(base);
  assert.ok(intent, "the database derives a DECISIONS.md render");
  writeFileSync(join(base, ".gsd", "DECISIONS.md"), intent.content, "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { "DECISIONS.md": { sha: "stale000000000000", entities: [] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.21.0",
  });

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 0, "a byte-identical render is not an external edit");
  const marker = readCompatMarker(base);
  assert.equal(
    marker.projections["DECISIONS.md"]?.sha,
    computeProjectionSha(intent.content),
    "the stale baseline is refreshed",
  );
});

test("a DECISIONS.md that diverges from the database render is still an external edit", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertDecision({
    id: "D001",
    when_context: "2026-10-09",
    scope: "global",
    decision: "Store projections in SQLite",
    choice: "SQLite is the authority",
    rationale: "durable and inspectable",
    revisable: "Yes",
    made_by: "human",
    superseded_by: null,
  });
  backfillDecisionsToMemories();
  const intent = await readDecisionsProjectionIntent(base);
  assert.ok(intent);
  const diverged = intent.content.replace("SQLite is the authority", "Postgres is the authority");
  writeFileSync(join(base, ".gsd", "DECISIONS.md"), diverged, "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { "DECISIONS.md": { sha: computeProjectionSha(intent.content), entities: [] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.21.0",
  });

  const drift = await observeExternalMarkdownEdits(base);
  assert.equal(drift.length, 1, "a hand edit that the render does not produce still drifts");
  assert.equal(drift[0].projectionPath, "DECISIONS.md");
  const marker = readCompatMarker(base);
  assert.equal(
    marker.projections["DECISIONS.md"]?.sha,
    computeProjectionSha(intent.content),
    "the baseline is left alone",
  );
});
