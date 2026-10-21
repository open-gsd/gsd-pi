// Project/App: gsd-pi
// File Purpose: Unit tests for the external-markdown-edit drift handler.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import { readCompatMarker, writeCompatMarker, computeProjectionSha } from "../compat/compat-marker.ts";
import { closeDatabase, insertArtifact, openDatabase } from "../gsd-db.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-extedit-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

const stubState = { phase: "idle" } as unknown as GSDState;

function ctx(base: string): DriftContext {
  return { basePath: base, state: stubState };
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

  const drift = await externalMarkdownEditHandler.detect(stubState, ctx(base));
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

  const drift = await externalMarkdownEditHandler.detect(stubState, ctx(base));
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

  const drift = await externalMarkdownEditHandler.detect(stubState, ctx(base));
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
  const drift = await externalMarkdownEditHandler.detect(stubState, ctx(base));
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

  const drift = await externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);
});

test("modeled drift blocks with an explicit route and cannot run repair", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  const content = "# Roadmap\n\n- [x] S1 done\n";
  writeFileSync(join(base, ".gsd", rel), content, "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "stale000000000000", entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift1 = await externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift1.length, 1);
  const sourceBefore = readFileSync(join(base, ".gsd", rel));
  const markerBefore = readCompatMarker(base);

  const blocker = await externalMarkdownEditHandler.blocker?.(drift1[0], ctx(base));
  assert.match(blocker ?? "", /database is authoritative/i);
  assert.match(blocker ?? "", /\/gsd rebuild markdown/);
  assert.match(blocker ?? "", /\/gsd recover/);
  assert.throws(
    () => externalMarkdownEditHandler.repair(drift1[0], ctx(base)),
    /modeled projection repair must remain blocked/,
  );
  assert.deepEqual(readFileSync(join(base, ".gsd", rel)), sourceBefore);
  assert.deepEqual(readCompatMarker(base), markerBefore);
});
