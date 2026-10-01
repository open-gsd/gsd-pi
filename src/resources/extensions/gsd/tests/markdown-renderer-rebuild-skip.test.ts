// Project/App: gsd-pi
// File Purpose: #2349 — a zero-drift rebuild must skip unchanged projections
// (no saveFile, no artifact row rewrite, no cache invalidation) while still
// repairing disk drift, missing DB rows, and missing compat-marker entries.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import {
  closeDatabase,
  deleteArtifactByPath,
  getArtifact,
  getArtifactsByPathPrefix,
  getDbOrNull,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { computeProjectionSha, readCompatMarker, writeCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-rebuild-skip-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Rebuild Skip", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "First slice", status: "pending", risk: "low", depends: [] });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task one", status: "pending" });
  tmpDirs.push(base);
  return base;
}

interface FileSnapshot { mtimeMs: number; bytes: string }

function snapshotMarkdown(base: string): Map<string, FileSnapshot> {
  const out = new Map<string, FileSnapshot>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".md")) continue;
      out.set(p, { mtimeMs: statSync(p).mtimeMs, bytes: readFileSync(p, "utf-8") });
    }
  };
  walk(join(base, ".gsd"));
  return out;
}

function artifactRows(): Map<string, { full_content: string; imported_at: string }> {
  const out = new Map<string, { full_content: string; imported_at: string }>();
  for (const row of getArtifactsByPathPrefix("")) {
    out.set(row.path, { full_content: row.full_content, imported_at: row.imported_at });
  }
  return out;
}

function findSnapshotPath(files: Map<string, FileSnapshot>, suffix: string): string {
  const hit = [...files.keys()].find((p) => p.endsWith(suffix));
  assert.ok(hit, `expected a projection file ending in ${suffix}, got ${[...files.keys()].join(",")}`);
  return hit;
}

// First render writes the projections; the second render repairs any remaining
// baseline divergence (e.g. the PLAN artifact row keyed under a path spelling
// that only stabilizes once the file exists — see deriveCompatProjectionKey).
// From the third render on, a zero-drift rebuild must be a true no-op.
async function renderToConvergence(base: string): Promise<void> {
  const first = await renderAllFromDb(base);
  assert.deepEqual(first.errors, []);
  assert.ok(first.rendered > 0, "expected rendered count > 0 on the first pass");
  const second = await renderAllFromDb(base);
  assert.deepEqual(second.errors, []);
}

test("clean re-render skips unchanged projections (files and artifact rows untouched)", async () => {
  const base = makeProject();
  await renderToConvergence(base);

  const beforeFiles = snapshotMarkdown(base);
  const beforeRows = artifactRows();
  assert.ok(beforeFiles.size >= 2, `expected roadmap+plan projections, got ${[...beforeFiles.keys()].join(",")}`);
  assert.ok(beforeRows.size >= 2, `expected roadmap+plan artifact rows, got ${[...beforeRows.keys()].join(",")}`);

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  assert.deepEqual(snapshotMarkdown(base), beforeFiles, "unchanged projections must not be rewritten");
  assert.deepEqual(artifactRows(), beforeRows, "unchanged artifact rows must not be re-inserted");
});

test("rebuild repairs a drifted file without rewriting clean ones", async () => {
  const base = makeProject();
  await renderToConvergence(base);
  const before = snapshotMarkdown(base);
  const planPath = findSnapshotPath(before, "-PLAN.md");
  const roadmapPath = findSnapshotPath(before, "ROADMAP.md");

  appendFileSync(planPath, ["external drift", ""].join("\n"));

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  assert.equal(readFileSync(planPath, "utf-8"), before.get(planPath)!.bytes, "drift must be repaired to the canonical bytes");
  const after = snapshotMarkdown(base);
  assert.equal(after.get(roadmapPath)!.mtimeMs, before.get(roadmapPath)!.mtimeMs, "clean ROADMAP must take the skip path");
});

test("rebuild restores a deleted artifact row without rewriting clean files", async () => {
  const base = makeProject();
  await renderToConvergence(base);
  const before = snapshotMarkdown(base);
  const planPath = findSnapshotPath(before, "-PLAN.md");
  const roadmapPath = findSnapshotPath(before, "ROADMAP.md");
  const roadmapRow = getArtifactsByPathPrefix("").find((r) => r.artifact_type === "ROADMAP");
  assert.ok(roadmapRow, "expected a ROADMAP artifact row after the first render");

  deleteArtifactByPath(roadmapRow.path);

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  const restored = getArtifact(roadmapRow.path);
  assert.ok(restored, "deleted artifact row must be restored by the rebuild");
  assert.equal(restored.full_content, readFileSync(roadmapPath, "utf-8"), "restored row must hold the rendered bytes");
  const after = snapshotMarkdown(base);
  assert.equal(after.get(planPath)!.mtimeMs, before.get(planPath)!.mtimeMs, "clean PLAN must take the skip path");
});

test("rebuild rewrites a projection whose compat-marker entry is missing", async () => {
  const base = makeProject();
  await renderAllFromDb(base);
  const roadmapPath = findSnapshotPath(snapshotMarkdown(base), "ROADMAP.md");
  const marker = readCompatMarker(base);
  const roadmapKey = Object.keys(marker.projections).find((k) => k.endsWith("ROADMAP.md"));
  assert.ok(roadmapKey, `expected a ROADMAP marker entry, got ${JSON.stringify(Object.keys(marker.projections))}`);

  delete marker.projections[roadmapKey];
  writeCompatMarker(base, marker);
  assert.ok(!readCompatMarker(base).projections[roadmapKey], "marker entry should be gone before the rebuild");

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  const refreshed = readCompatMarker(base).projections[roadmapKey];
  assert.ok(refreshed, "write path must re-seed the missing marker entry");
  assert.equal(refreshed.sha, computeProjectionSha(readFileSync(roadmapPath, "utf-8")));
});

test("rebuild repairs an artifact row whose scope metadata is wrong", async () => {
  const base = makeProject();
  await renderToConvergence(base);
  const before = snapshotMarkdown(base);
  const planPath = findSnapshotPath(before, "-PLAN.md");
  const roadmapPath = findSnapshotPath(before, "ROADMAP.md");
  // The stable-key PLAN row (render 1 can leave a ..-escaped ghost row behind;
  // see deriveCompatProjectionKey's fallback for not-yet-existing files).
  const planRow = getArtifactsByPathPrefix("").find((r) => r.artifact_type === "PLAN" && !r.path.includes(".."));
  assert.ok(planRow, "expected a stable PLAN artifact row after convergence");

  getDbOrNull()!.prepare("UPDATE artifacts SET slice_id = :sid WHERE path = :path").run({ ":sid": "S09", ":path": planRow.path });
  assert.equal(getArtifact(planRow.path)?.slice_id, "S09", "row scope should be corrupted before the rebuild");

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  const repaired = getArtifact(planRow.path);
  assert.ok(repaired, "row must survive the rebuild");
  assert.equal(repaired.slice_id, "S01", "wrong slice scope must be repaired by the write path");
  assert.equal(repaired.full_content, readFileSync(planPath, "utf-8"), "repaired row keeps the rendered bytes");
  const after = snapshotMarkdown(base);
  assert.equal(after.get(roadmapPath)!.mtimeMs, before.get(roadmapPath)!.mtimeMs, "clean ROADMAP must take the skip path");
});

test("rebuild repairs a marker entry whose entity scope is wrong", async () => {
  const base = makeProject();
  await renderToConvergence(base);
  const before = snapshotMarkdown(base);
  const planPath = findSnapshotPath(before, "-PLAN.md");
  const roadmapPath = findSnapshotPath(before, "ROADMAP.md");
  const planKey = relative(join(base, ".gsd"), planPath);
  const marker = readCompatMarker(base);
  const entry = marker.projections[planKey];
  assert.ok(entry, `expected a marker entry for ${planKey}`);
  assert.deepEqual(entry.entities, ["M001", "M001/S01"]);

  marker.projections[planKey] = { sha: entry.sha, entities: ["M001"] };
  writeCompatMarker(base, marker);

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  const refreshed = readCompatMarker(base).projections[planKey];
  assert.ok(refreshed, "marker entry must survive the rebuild");
  assert.deepEqual(refreshed.entities, ["M001", "M001/S01"], "wrong entity scope must be repaired by the write path");
  assert.equal(refreshed.sha, computeProjectionSha(readFileSync(planPath, "utf-8")));
  const after = snapshotMarkdown(base);
  assert.equal(after.get(roadmapPath)!.mtimeMs, before.get(roadmapPath)!.mtimeMs, "clean ROADMAP must take the skip path");
});

test("rebuild repairs an artifact row whose content_hash is wrong", async () => {
  const base = makeProject();
  await renderToConvergence(base);
  const before = snapshotMarkdown(base);
  const planPath = findSnapshotPath(before, "-PLAN.md");
  const roadmapPath = findSnapshotPath(before, "ROADMAP.md");
  const planKey = relative(join(base, ".gsd"), planPath);

  getDbOrNull()!.prepare("UPDATE artifacts SET content_hash = :h WHERE path = :p")
    .run({ ":h": "deadbeef", ":p": planKey });

  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, []);

  const repaired = getArtifact(planKey);
  assert.ok(repaired, "repaired row must exist");
  assert.equal(repaired.full_content, readFileSync(planPath, "utf-8"), "repaired row keeps the rendered bytes");
  const storedHash = getDbOrNull()!.prepare("SELECT content_hash FROM artifacts WHERE path = :p")
    .get({ ":p": planKey }) as Record<string, unknown>;
  assert.notEqual(storedHash["content_hash"], "deadbeef", "wrong content_hash must be repaired by the write path");
  assert.equal(storedHash["content_hash"], createHash("sha256").update(repaired.full_content).digest("hex"));
  const after = snapshotMarkdown(base);
  assert.equal(after.get(roadmapPath)!.mtimeMs, before.get(roadmapPath)!.mtimeMs, "clean ROADMAP must take the skip path");
});
