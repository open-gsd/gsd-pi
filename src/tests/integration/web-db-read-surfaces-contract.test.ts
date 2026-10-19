// Project/App: gsd-pi
// File Purpose: Web project-kind detection and /api/inspect answer from .gsd/gsd.db, not from directories or JSON files.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProjectKind } from "../../web/bridge-service.ts";
import { collectInspectData } from "../../web/inspect-service.ts";
import { closeDatabase, insertDecision, insertMilestone, openDatabase } from "../../resources/extensions/gsd/gsd-db.ts";
import { saveRequirementToDb } from "../../resources/extensions/gsd/db-writer.ts";

function makeProject(t: { after(fn: () => void): void }): { root: string; gsdDir: string } {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-db-read-"));
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  const gsdDir = join(root, ".gsd");
  mkdirSync(gsdDir);
  return { root, gsdDir };
}

describe("detectProjectKind", () => {
  test("a project whose milestones exist only in the database is active-gsd", (t) => {
    const { root, gsdDir } = makeProject(t);
    assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Database only", status: "active" });
    closeDatabase();

    const detection = detectProjectKind(root);
    assert.equal(detection.kind, "active-gsd");
    assert.deepEqual(detection.readMetadata, { source: "database", authority: "db-authoritative" });
  });

  test("a flat-phase project with no database is active-gsd", (t) => {
    const { root, gsdDir } = makeProject(t);
    mkdirSync(join(gsdDir, "phases", "01-foundation"), { recursive: true });

    const detection = detectProjectKind(root);
    assert.equal(detection.kind, "active-gsd");
    assert.deepEqual(detection.readMetadata, { source: "projection", authority: "projection-fallback" });
    assert.deepEqual(readdirSync(gsdDir), ["phases"], "the read creates no database");
  });

  test("the database wins over a leftover milestone directory", (t) => {
    const { root, gsdDir } = makeProject(t);
    mkdirSync(join(gsdDir, "milestones", "M001"), { recursive: true });
    assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Dropped", status: "cancelled" });
    closeDatabase();

    assert.equal(detectProjectKind(root).kind, "empty-gsd");
  });

  test("a .gsd folder with no database and no hierarchy directory is empty-gsd", (t) => {
    const { root } = makeProject(t);

    assert.equal(detectProjectKind(root).kind, "empty-gsd");
  });
});

describe("collectInspectData", () => {
  test("returns database rows and ignores a gsd-db.json file", async (t) => {
    const { root, gsdDir } = makeProject(t);
    writeFileSync(join(gsdDir, "gsd-db.json"), JSON.stringify({
      schema_version: 1,
      decisions: [{ id: "D999", decision: "From JSON", choice: "stale" }],
      requirements: [],
      artifacts: [],
    }));
    assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
    // The same table as the TUI `/gsd inspect` query.
    insertDecision({
      id: "D001",
      when_context: "M001",
      scope: "architecture",
      decision: "Read authority",
      choice: "database",
      rationale: "ADR-046",
      revisable: "yes",
      made_by: "agent",
      source: "discussion",
      superseded_by: null,
    });
    const requirement = await saveRequirementToDb({
      class: "core-capability",
      status: "active",
      description: "Inspect reads the database",
      why: "The JSON file is never written.",
      source: "test",
    }, root);
    closeDatabase();

    const data = await collectInspectData(root);

    assert.deepEqual(data.readMetadata, { source: "database", authority: "db-authoritative" });
    assert.equal(typeof data.schemaVersion, "number");
    assert.equal(data.counts.decisions, 1);
    assert.equal(data.counts.requirements, 1);
    assert.deepEqual(data.recentDecisions, [{ id: "D001", decision: "Read authority", choice: "database" }]);
    assert.deepEqual(data.recentRequirements, [
      { id: requirement.id, status: "active", description: "Inspect reads the database" },
    ]);
  });

  test("returns the empty state when the project has no database", async (t) => {
    const { root } = makeProject(t);

    assert.deepEqual(await collectInspectData(root), {
      schemaVersion: null,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: [],
      readMetadata: { source: "projection", authority: "projection-fallback" },
    });
  });
});
