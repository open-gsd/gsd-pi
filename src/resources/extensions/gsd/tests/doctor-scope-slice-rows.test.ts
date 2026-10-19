// Project/App: gsd-pi
// File Purpose: Doctor scope selection reads slice rows, not the rendered ROADMAP file.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { selectDoctorScope } from "../doctor.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";

// No milestone is active: M001 is complete and M002 is parked.
function makeProject(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-scope-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done slice", status: "complete" });
  insertMilestone({ id: "M002", title: "Parked", status: "parked" });
  return base;
}

test("doctor scope is the milestone with an open slice row when no ROADMAP file exists", async (t) => {
  const base = makeProject(t);
  insertSlice({ id: "S01", milestoneId: "M002", title: "Open slice", status: "pending" });

  assert.equal(await selectDoctorScope(base), "M002");
});

test("a ROADMAP file does not make a milestone with no slice rows the doctor scope", async (t) => {
  const base = makeProject(t);
  mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
    ["# M002: Parked", "", "## Slices", "", "- [ ] **S01: Not in the database** `risk:low` `depends:[]`", ""].join("\n"),
  );
  insertMilestone({ id: "M003", title: "Parked with work", status: "parked" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Open slice", status: "pending" });

  assert.equal(await selectDoctorScope(base), "M003");
});
