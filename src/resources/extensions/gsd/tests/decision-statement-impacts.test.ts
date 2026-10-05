// Project/App: gsd-pi
// File Purpose: Behavior tests for statement decision impacts — the
// workflow_decision_statement_impacts rows that gsd_decision_save writes
// through the decision.save Domain Operation, their readability through the
// decision tools, and the DECISIONS.md supersede cell they render.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = new URL(
  "../tools/workflow-tool-executors.ts",
  import.meta.url,
).pathname;

import { registerDbTools } from "../bootstrap/db-tools.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import {
  decisionsWithAmendsTargets,
  generateDecisionsMd,
  saveDecisionToDb,
} from "../db-writer.ts";
import {
  getAllDecisionsFromMemories,
  getDecisionByIdStrict,
  queryDecisionsWithLimit,
} from "../context-store.ts";
import { parseDecisionsTable } from "../decision-markdown-parser.ts";
import { captureLegacyImportSourceSet } from "../legacy-import-preview-source.ts";
import { interpretLegacyGsdCapture } from "../legacy-import-preview-gsd.ts";
import { invalidateAllCaches } from "../cache.ts";

function makeTmpBase(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-decision-statement-impacts-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function impactRows(base: string): Array<Record<string, unknown>> {
  void base;
  return _getAdapter()!.prepare(`
    SELECT decision_id, impact_ordinal, impact_kind, milestone_id, slice_id, task_id,
           target_scope, payload, created_operation_id, created_project_revision
    FROM workflow_decision_statement_impacts
    ORDER BY decision_id, impact_ordinal
  `).all() as Array<Record<string, unknown>>;
}

function decision(choice: string, supersedes?: string) {
  return {
    scope: "architecture",
    decision: "Session storage",
    choice,
    rationale: `Because ${choice}`,
    ...(supersedes ? { supersedes } : {}),
  };
}

function seedMilestone(id: string): void {
  insertMilestone({ id, title: "Storage", status: "active" });
}

test("a save without impacts writes no rows", async (t) => {
  const base = makeTmpBase(t);
  await saveDecisionToDb(decision("cookies"), base);
  await saveDecisionToDb({ ...decision("server sessions"), impacts: [] }, base);
  assert.equal(impactRows(base).length, 0, "omitted or empty impacts write no rows");
});

test("a save with scope and milestone impacts writes the rows in order", async (t) => {
  const base = makeTmpBase(t);
  seedMilestone("M001");
  const { id } = await saveDecisionToDb({
    ...decision("cookies"),
    impacts: [
      { kind: "revalidates", milestone_id: "M001", note: "sessions move into the database" },
      { kind: "blocks", scope: "auth", note: "token shape may change" },
    ],
  }, base);
  const rows = impactRows(base);
  assert.deepEqual(rows.map((row) => [row.decision_id, row.impact_ordinal, row.impact_kind]), [
    [id, 1, "revalidates"],
    [id, 2, "blocks"],
  ]);
  assert.deepEqual(rows.map((row) => [row.milestone_id, row.target_scope, row.payload]), [
    ["M001", null, "sessions move into the database"],
    [null, "auth", "token shape may change"],
  ]);
  const operation = _getAdapter()!.prepare(
    "SELECT operation_type, resulting_revision FROM workflow_operations WHERE operation_type = 'decision.save'",
  ).get() as Record<string, unknown>;
  assert.equal(operation["operation_type"], "decision.save");
  assert.equal(Number(rows[0]!["created_project_revision"]), Number(operation["resulting_revision"]));
});

test("a superseding save also writes the supersede row keyed on the new decision", async (t) => {
  const base = makeTmpBase(t);
  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);
  const rows = impactRows(base);
  assert.deepEqual(rows.map((row) => [row.decision_id, row.impact_ordinal, row.impact_kind, row.target_scope]), [
    [second.id, 1, "supersedes", first.id],
  ], "only the superseding save writes a row, naming the decision it amends");
});

test("an unknown impact kind is refused loud and writes nothing", async (t) => {
  const base = makeTmpBase(t);
  await assert.rejects(
    saveDecisionToDb({
      ...decision("cookies"),
      impacts: [{ kind: "invalidates", scope: "auth" }],
    }, base),
    /unknown kind "invalidates"/,
  );
  assert.equal(impactRows(base).length, 0);
  assert.equal(
    Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM memories WHERE category = 'architecture'").get()?.["count"]),
    0,
    "the refused save leaves no decision row",
  );
  assert.equal(
    Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'decision.save'").get()?.["count"]),
    0,
    "the refused save commits no operation",
  );
});

test("an impact target that names no existing unit is refused loud", async (t) => {
  const base = makeTmpBase(t);
  await assert.rejects(
    saveDecisionToDb({
      ...decision("cookies"),
      impacts: [{ kind: "revalidates", milestone_id: "M099" }],
    }, base),
    /targets unknown milestone M099/,
  );
  await assert.rejects(
    saveDecisionToDb({
      ...decision("cookies"),
      impacts: [{ kind: "revalidates", slice_id: "S01", scope: "auth" }],
    }, base),
    /needs milestone_id when slice_id is set/,
  );
  assert.equal(impactRows(base).length, 0);
});

test("decision get and list read the impacts back", async (t) => {
  const base = makeTmpBase(t);
  seedMilestone("M001");
  const { id } = await saveDecisionToDb({
    ...decision("cookies"),
    impacts: [{ kind: "revalidates", milestone_id: "M001", note: "sessions move" }],
  }, base);

  const got = getDecisionByIdStrict(id, false);
  assert.equal(got?.impacts?.length, 1);
  assert.equal(got.impacts![0]!.impact_kind, "revalidates");
  assert.equal(got.impacts![0]!.milestone_id, "M001");
  assert.equal(got.impacts![0]!.payload, "sessions move");

  const listed = queryDecisionsWithLimit({ includeSuperseded: true });
  const row = listed.find((decision) => decision.id === id);
  assert.equal(row?.impacts?.length, 1);

  const untouched = await saveDecisionToDb(decision("server sessions"), base);
  const plain = getDecisionByIdStrict(untouched.id, false);
  assert.equal(plain?.impacts, undefined, "a decision without impacts keeps the legacy shape");
});

test("the DECISIONS render emits the '(amends D###)' cell the parsers understand", async (t) => {
  const base = makeTmpBase(t);
  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);

  const rendered = readFileSync(join(base, ".gsd", "DECISIONS.md"), "utf-8");
  const secondRow = rendered.split("\n").find((line) => line.includes(`| ${second.id} |`));
  assert.ok(secondRow, "the superseding decision row is rendered");
  assert.match(secondRow!, /\(amends D001\)/);
  const firstRow = rendered.split("\n").find((line) => line.includes(`| ${first.id} |`));
  assert.ok(firstRow && !/\(amends/.test(firstRow), "the superseded row carries no amends suffix");

  const parsed = parseDecisionsTable(rendered);
  const firstParsed = parsed.find((row) => row.id === first.id);
  const secondParsed = parsed.find((row) => row.id === second.id);
  assert.equal(firstParsed?.superseded_by, second.id);
  assert.equal(
    secondParsed?.decision,
    "Session storage (amends D001)",
    "the legacy table parser reads the cell verbatim and still infers the supersede",
  );
  assert.equal(secondParsed?.superseded_by, null);
});

test("the render derives the amends target from the stored supersede, not from text", async (t) => {
  const base = makeTmpBase(t);
  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);

  const all = decisionsWithAmendsTargets(getAllDecisionsFromMemories());
  const secondDecision = all.find((row) => row.id === second.id);
  assert.equal(secondDecision?.amends, first.id);
  assert.equal(secondDecision?.decision, "Session storage", "the stored text stays clean");
  // generateDecisionsMd over the amends-annotated rows reproduces the cell.
  const regenerated = generateDecisionsMd(all);
  assert.match(regenerated, /\(amends D001\)/);
  // A stored text that already names the target is not suffixed twice.
  const alreadyNamed = decisionsWithAmendsTargets([
    { ...all.find((row) => row.id === second.id)!, decision: "Session storage (amends D001)" },
  ]);
  assert.equal(
    generateDecisionsMd(alreadyNamed).match(/\(amends D001\)/g)?.length,
    1,
    "the suffix is not doubled",
  );
});

test("the registries import reads the rendered supersede cell back into clean decision text", async (t) => {
  const base = makeTmpBase(t);
  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);
  const rendered = readFileSync(join(base, ".gsd", "DECISIONS.md"), "utf-8");

  const stage = mkdtempSync(join(tmpdir(), "gsd-decision-impact-import-"));
  try {
    const physicalRoot = join(stage, ".gsd");
    mkdirSync(physicalRoot, { recursive: true });
    writeFileSync(join(physicalRoot, "DECISIONS.md"), rendered);
    const capture = captureLegacyImportSourceSet({
      roots: [{ id: "gsd", kind: "project", physical_path: physicalRoot, logical_path: ".gsd", presence: "required" }],
    });
    const interpretation = interpretLegacyGsdCapture(capture);
    const candidates = interpretation.candidates.filter(
      (candidate) => candidate.target.kind === "decision",
    );
    const secondCandidate = candidates.find((candidate) => candidate.target.key === second.id);
    assert.ok(secondCandidate, "the superseding decision is a candidate");
    assert.equal(
      (secondCandidate.normalized as Record<string, unknown>)["decision"],
      "Session storage",
      "the rendered '(amends D###)' suffix is stripped, so the candidate equals the stored text",
    );
    const firstCandidate = candidates.find((candidate) => candidate.target.key === first.id);
    assert.ok(firstCandidate);
    assert.equal(
      (firstCandidate.normalized as Record<string, unknown>)["superseded_by"],
      second.id,
      "the supersede survives as structured data",
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

type NativeTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<Record<string, unknown>>;
};

function nativeTool(name: string): NativeTool {
  const tools: NativeTool[] = [];
  registerDbTools({
    registerTool(tool: NativeTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function textContent(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  const text = content?.find((entry) => entry.type === "text")?.text;
  assert.ok(typeof text === "string", "result must carry a text content entry");
  return text;
}

test("gsd_decision_save records impacts; decision get and list surface them", async (t) => {
  const base = makeTmpBase(t);
  seedMilestone("M001");
  invalidateAllCaches();

  const save = await nativeTool("gsd_decision_save").execute(
    "call-save-impacts-1",
    {
      scope: "architecture",
      decision: "Session storage",
      choice: "cookies",
      rationale: "Because cookies",
      impacts: [
        { kind: "revalidates", milestone_id: "M001", note: "sessions move" },
        { kind: "blocks", scope: "auth" },
      ],
    },
    undefined,
    undefined,
    { cwd: base },
  );
  const saveDetails = (save.structuredContent ?? save.details) as Record<string, unknown>;
  assert.equal(saveDetails.error, undefined);
  const id = String(saveDetails.id);

  const got = await nativeTool("gsd_decision_get").execute(
    `call-get-${id}`,
    { id },
    undefined,
    undefined,
    { cwd: base },
  );
  const gotText = textContent(got);
  assert.match(gotText, /Impact: revalidates M001 — sessions move/);
  assert.match(gotText, /Impact: blocks auth/);

  const listed = await nativeTool("gsd_decision_list").execute(
    "call-list-impacts-1",
    { includeSuperseded: true },
    undefined,
    undefined,
    { cwd: base },
  );
  const listedText = textContent(listed);
  assert.match(listedText, /impacts: revalidates M001; blocks auth/);
});
