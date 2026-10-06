// Project/App: gsd-pi
// File Purpose: Behavior tests for superseding a decision through gsd_decision_save.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _getAdapter, closeDatabase, insertDecision, openDatabase } from "../gsd-db.ts";
import { saveDecisionToDb } from "../db-writer.ts";
import { getAllDecisionsFromMemories, queryDecisionsFromMemories } from "../context-store.ts";
import { backfillDecisionsToMemories } from "../memory-backfill.ts";

function makeTmpBase(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-decision-supersede-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
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

const activeIds = (): string[] => queryDecisionsFromMemories().map((row) => row.id);
const supersededBy = (): Record<string, string | null> =>
  Object.fromEntries(getAllDecisionsFromMemories().map((row) => [row.id, row.superseded_by]));

test("a superseding decision leaves one active head in the chain", async (t) => {
  const base = makeTmpBase(t);

  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);
  assert.deepEqual(activeIds(), [second.id]);
  assert.deepEqual(supersededBy(), { [first.id]: second.id, [second.id]: null });

  const third = await saveDecisionToDb(decision("signed tokens", second.id), base);
  assert.deepEqual(activeIds(), [third.id], "the chain has one active head");
  assert.deepEqual(supersededBy(), { [first.id]: second.id, [second.id]: third.id, [third.id]: null });
});

test("only the active head can be superseded, and a refused save writes nothing", async (t) => {
  const base = makeTmpBase(t);
  const first = await saveDecisionToDb(decision("cookies"), base);
  const second = await saveDecisionToDb(decision("server sessions", first.id), base);

  await assert.rejects(
    saveDecisionToDb(decision("signed tokens", first.id), base),
    new RegExp(`${first.id}: it is already superseded by ${second.id}`),
  );
  await assert.rejects(
    saveDecisionToDb(decision("signed tokens", "D099"), base),
    /Cannot supersede D099: no such decision/,
  );

  assert.deepEqual(supersededBy(), { [first.id]: second.id, [second.id]: null }, "no decision row was added");
  assert.equal(
    Number(_getAdapter()!.prepare(
      "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'decision.save'",
    ).get()?.["count"]),
    2,
    "a refused supersede commits no operation",
  );
});

test("the session-start backfill keeps a supersede of a decision from the legacy table", async (t) => {
  const base = makeTmpBase(t);
  insertDecision({
    id: "D001",
    when_context: "M001",
    scope: "architecture",
    decision: "Session storage",
    choice: "cookies",
    rationale: "Legacy row",
    revisable: "Yes",
    made_by: "agent",
    source: "discussion",
    superseded_by: null,
  });
  backfillDecisionsToMemories();

  const replacement = await saveDecisionToDb(decision("server sessions", "D001"), base);
  backfillDecisionsToMemories();

  assert.deepEqual(activeIds(), [replacement.id], "the legacy row does not revive the superseded decision");
  assert.deepEqual(supersededBy(), { D001: replacement.id, [replacement.id]: null });
});
