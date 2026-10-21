// Project/App: gsd-pi
// File Purpose: Public corpus eligibility gate for pure legacy import Application compilation.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { closeDatabase, insertDecision, openDatabase } from "../gsd-db.ts";
import { LegacyImportApplicationError } from "../legacy-import-application.ts";
import { compileLegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import {
  createLegacyImportPreview,
  type LegacyImportPreviewCreateInput,
} from "../legacy-import-preview.ts";
import {
  createLegacyImportCorpusSourceRoots,
  type LegacyImportCorpusManifest,
} from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const CORPUS_PATH = fileURLToPath(CORPUS_ROOT);
const MANIFEST = JSON.parse(
  readFileSync(join(CORPUS_PATH, "corpus.json"), "utf8"),
) as LegacyImportCorpusManifest;

const ELIGIBLE_CASES = new Set([
  "action-matrix",
  "custom-workflow",
  "gsd-nested",
  "jsonl-history",
  "knowledge-graph",
  "planning-flat-complete",
  "planning-multi-milestone-completed-range",
  "planning-multi-milestone-details",
  "planning-multi-milestone-emoji-range",
  "planning-multi-milestone-heading",
  "planning-multi-milestone-summary",
  "root-external-boundaries",
  "synthetic-smoke",
]);

function seedActionMatrixBase(source: string): void {
  const fixture = new DatabaseSync(join(source, ".gsd", "gsd.db"), { readOnly: true });
  try {
    const decisions = fixture.prepare(`
      SELECT id, when_context, scope, decision, choice, rationale, revisable,
             made_by, source, superseded_by
      FROM decisions
      WHERE id IN ('D002', 'D003', 'D004')
      ORDER BY id
    `).all() as unknown as Array<Parameters<typeof insertDecision>[0]>;
    decisions.forEach(insertDecision);
  } finally {
    fixture.close();
  }
}

test("public corpus compiles 13 eligible Previews and refuses 13 unresolved Previews", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gsd-application-plan-corpus-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const compiled = new Map<string, number>();
  const refused: string[] = [];

  for (const entry of MANIFEST.cases) {
    const caseRoot = join(directory, entry.name);
    const source = join(caseRoot, "source");
    cpSync(join(CORPUS_PATH, entry.name, "source"), source, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    assert.equal(openDatabase(join(caseRoot, "canonical.db")), true, entry.name);
    try {
      if (entry.name === "action-matrix") seedActionMatrixBase(source);
      const input: LegacyImportPreviewCreateInput = {
        roots: createLegacyImportCorpusSourceRoots(source),
        ...(entry.name === "custom-workflow" ? { bundledDefinitionNames: ["bugfix"] } : {}),
      };
      const preview = createLegacyImportPreview(input);
      if (ELIGIBLE_CASES.has(entry.name)) {
        const plan = compileLegacyImportApplicationPlan(preview);
        compiled.set(entry.name, plan.instructions.length);
        assert.equal(plan.receiptCounts.unresolved, 0, entry.name);
        continue;
      }
      let error: unknown;
      try {
        compileLegacyImportApplicationPlan(preview);
      } catch (cause) {
        error = cause;
      }
      assert.ok(error instanceof LegacyImportApplicationError, entry.name);
      assert.equal(error.stage, "preview", entry.name);
      assert.equal(error.code, "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED", entry.name);
      refused.push(entry.name);
    } finally {
      closeDatabase();
    }
  }

  assert.deepEqual([...compiled.keys()].sort(), [...ELIGIBLE_CASES].sort());
  assert.equal(compiled.size, 13);
  assert.equal(refused.length, 13);
  assert.equal(compiled.get("planning-flat-complete"), 8);
  assert.equal(compiled.get("gsd-nested"), 45);
  assert.equal(compiled.get("custom-workflow"), 18);
  assert.equal(compiled.get("jsonl-history"), 14);
  assert.equal(compiled.get("knowledge-graph"), 3);
  assert.equal(compiled.get("root-external-boundaries"), 3);
  assert.equal(compiled.get("synthetic-smoke"), 1);
});
