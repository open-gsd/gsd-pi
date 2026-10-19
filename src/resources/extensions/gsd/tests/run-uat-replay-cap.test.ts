/**
 * Regression test for #3624 — cap run-uat dispatch attempts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import {
  getUatRetryAttempts as getUatCount,
  incrementUatRetryAttempts as incrementUatCount,
} from "../db/writers/runtime-control.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
  setSliceUatMd,
} from "../gsd-db.ts";

/**
 * Seed the slice rows the run-uat dispatch gate reads. The gate derives
 * completed-slice candidates and the UAT spec from DB rows only, so the
 * ROADMAP checkboxes this fixture writes are projection context; these rows
 * are the dispatch input. No UAT file is written.
 */
function seedSliceRows(): void {
  openDatabase(":memory:");
  assert.ok(isDbAvailable(), "fixture must have an open DB");
  insertMilestone({ id: "M001", title: "UAT Cap", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Completed slice",
    status: "complete",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  setSliceUatMd("M001", "S01", "# UAT\n\nRun the checks. No verdict has been recorded yet.\n");
  insertSlice({
    milestoneId: "M001",
    id: "S02",
    title: "Remaining slice",
    status: "pending",
    risk: "low",
    depends: ["S01"],
    sequence: 2,
  });
}

function makeUatProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-cap-"));
  const milestone = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(milestone, "slices", "S01"), { recursive: true });
  mkdirSync(join(milestone, "slices", "S02"), { recursive: true });
  writeFileSync(
    join(milestone, "M001-ROADMAP.md"),
    [
      "# M001: UAT Cap",
      "",
      "## Slices",
      "- [x] **S01: Completed slice** `risk:low`",
      "  Demo: done.",
      "- [ ] **S02: Remaining slice** `risk:low`",
      "  Demo: pending.",
    ].join("\n"),
    "utf-8",
  );
  return base;
}

test("run-uat dispatch stops after three attempts without a verdict", async () => {
  const basePath = makeUatProject();
  seedSliceRows();
  const rule = DISPATCH_RULES.find((r) => r.name === "run-uat (post-completion)");
  assert.ok(rule, "run-uat dispatch rule is registered");

  const ctx = {
    state: { phase: "planning", activeSlice: null },
    mid: "M001",
    midTitle: "UAT Cap",
    basePath,
    prefs: { uat_dispatch: true },
  };

  try {
    for (let i = 1; i <= 3; i++) {
      const action = await rule.match(ctx as any);
      assert.equal(action?.action, "dispatch");
      assert.equal(action?.unitType, "run-uat");
      assert.equal(getUatCount("M001", "S01"), i);
    }

    // The cap is a database row. Deleting .gsd/runtime does not reset it.
    rmSync(join(basePath, ".gsd", "runtime"), { recursive: true, force: true });

    const capped = await rule.match(ctx as any);
    assert.equal(capped?.action, "stop");
    assert.match(capped?.reason ?? "", /retry limit reached/);
    assert.equal(getUatCount("M001", "S01"), 3);

    const stillCapped = await rule.match(ctx as any);
    assert.equal(stillCapped?.action, "stop");
    assert.equal(getUatCount("M001", "S01"), 3);
  } finally {
    // The fixture seeds slice rows in an in-memory DB; close it so the next
    // test starts from a clean singleton.
    try { closeDatabase(); } catch { /* no DB open for this fixture */ }
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("run-uat counter is a database row and a counter file is not read", (t) => {
  const projectRoot = makeUatProject();
  openDatabase(":memory:");
  t.after(() => {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // A counter file left by an older build must not count as attempts.
  mkdirSync(join(projectRoot, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".gsd", "runtime", "uat-count-M001-S01.json"),
    JSON.stringify({ count: 3 }) + "\n",
    "utf-8",
  );

  assert.equal(getUatCount("M001", "S01"), 0);
  assert.equal(incrementUatCount("M001", "S01"), 1);
  assert.equal(incrementUatCount("M001", "S01"), 2);
  assert.equal(getUatCount("M001", "S01"), 2);
  assert.equal(getUatCount("M001", "S02"), 0, "the counter is per slice");
});
