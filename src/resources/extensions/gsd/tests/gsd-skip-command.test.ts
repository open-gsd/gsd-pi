// Project/App: gsd-pi
// File Purpose: /gsd skip cancels a Slice or Task through its Domain Operation with a Waiver.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleSkip } from "../commands-maintenance.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  _getAdapter,
  closeDatabase,
  getSlice,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

function makeCtx() {
  const notes: Array<{ message: string; level: string }> = [];
  return {
    notes,
    ctx: { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } } as any,
  };
}

function waivers(scope: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(`
    SELECT waiver.waiver_status, waiver.granted_by_actor_type, lifecycle.lifecycle_status
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = waiver.lifecycle_id
    WHERE waiver.scope = :scope
  `).all({ ":scope": scope }) as Array<Record<string, unknown>>;
}

describe("/gsd skip", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-skip-command-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task one", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task two", status: "pending" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Later task", status: "pending" });
    invalidateStateCache();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  test("a task skip records cancellation plus Waiver and dispatch moves past it", async () => {
    assert.equal((await deriveStateFromDb(base)).activeTask?.id, "T01");
    const { ctx, notes } = makeCtx();

    await handleSkip("M001/S01/T01", ctx, base);

    assert.equal(notes.at(-1)?.level, "success", notes.at(-1)?.message);
    assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
    assert.deepEqual(waivers("M001/S01/T01 cancellation"), [{
      waiver_status: "active",
      granted_by_actor_type: "user",
      lifecycle_status: "cancelled",
    }]);
    assert.equal(existsSync(join(base, ".gsd", "completed-units.json")), false);
    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.equal(state.activeSlice?.id, "S01");
    assert.equal(state.activeTask?.id, "T02");
  });

  test("a slice skip records cancellation plus Waiver and the dependent slice no longer waits for it", async () => {
    const { ctx, notes } = makeCtx();

    await handleSkip("M001/S01", ctx, base);

    assert.equal(notes.at(-1)?.level, "success", notes.at(-1)?.message);
    assert.equal(getSlice("M001", "S01")?.status, "skipped");
    assert.deepEqual(waivers("slice:M001/S01"), [{
      waiver_status: "active",
      granted_by_actor_type: "user",
      lifecycle_status: "cancelled",
    }]);
    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.equal(state.activeSlice?.id, "S02");
  });

  test("the milestone id keeps its lowercase suffix and the execute-task prefix names a task", async () => {
    insertMilestone({ id: "M002-abc123", title: "Unique", status: "queued" });
    insertSlice({ id: "S01", milestoneId: "M002-abc123", title: "First", status: "pending", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002-abc123", title: "Task one", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M002-abc123", title: "Task two", status: "pending" });
    const { ctx, notes } = makeCtx();

    await handleSkip("M002-abc123/s01/t01", ctx, base);
    assert.equal(notes.at(-1)?.level, "success", notes.at(-1)?.message);
    assert.equal(getTask("M002-abc123", "S01", "T01")?.status, "skipped");

    await handleSkip("execute-task/M002-abc123/S01/T02", ctx, base);
    assert.equal(notes.at(-1)?.level, "success", notes.at(-1)?.message);
    assert.equal(getTask("M002-abc123", "S01", "T02")?.status, "skipped");
  });

  for (const unit of ["plan-slice/M001/S01", "research-slice/M001/S01", "execute-task/M001/S01"]) {
    test(`${unit} is refused and the slice stays open`, async () => {
      const { ctx, notes } = makeCtx();
      const before = _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()!["count"];

      await handleSkip(unit, ctx, base);

      assert.equal(notes.at(-1)?.level, "warning");
      assert.ok(notes.at(-1)?.message.includes(`"${unit}" is not a slice or task path`), notes.at(-1)?.message);
      assert.equal(getSlice("M001", "S01")?.status, "active");
      assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()!["count"], before);
    });
  }

  test("an unknown unit fails loudly and writes nothing", async () => {
    const { ctx, notes } = makeCtx();
    const before = _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()!["count"];

    await handleSkip("M001/S01/T99", ctx, base);

    assert.equal(notes.at(-1)?.level, "error");
    assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()!["count"], before);
  });
});
