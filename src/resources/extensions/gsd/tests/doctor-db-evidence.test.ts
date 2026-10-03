// Project/App: gsd-pi
// File Purpose: Doctor state checks use database rows as evidence and do not edit projection files.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, insertMilestone, insertRequirement, openDatabase } from "../gsd-db.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import type { Requirement } from "../types.ts";

function makeBase(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-evidence-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function requirement(fields: Partial<Requirement> & { id: string }): Requirement {
  return {
    class: "functional",
    status: "active",
    description: "A requirement",
    why: "",
    source: "user",
    primary_owner: "",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
    ...fields,
  };
}

test("doctor audits the requirement rows of the database, not REQUIREMENTS.md", async (t) => {
  const base = makeBase(t);
  insertRequirement(requirement({ id: "R001" }));
  insertRequirement(requirement({ id: "R002", primary_owner: "M001/S01" }));
  insertRequirement(requirement({ id: "R003", status: "blocked" }));
  insertRequirement(requirement({ id: "R004", status: "blocked", notes: "waits for the vendor" }));
  // The file says the opposite of the database for every requirement.
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), `# Requirements

### R001 — A requirement
- Status: active
- Primary owning slice: M001/S01

### R002 — A requirement
- Status: active
- Primary owning slice: none

### R003 — A requirement
- Status: blocked
- Notes: waits for the vendor

### R004 — A requirement
- Status: blocked
`, "utf-8");

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });

  assert.deepEqual(
    issues
      .filter((issue) => issue.code === "active_requirement_missing_owner" || issue.code === "blocked_requirement_missing_reason")
      .map((issue) => `${issue.code}:${issue.unitId}`),
    ["active_requirement_missing_owner:R001", "blocked_requirement_missing_reason:R003"],
  );
});

test("doctor --fix reports a delimiter in a milestone title and does not edit ROADMAP.md", async (t) => {
  const base = makeBase(t);
  insertMilestone({ id: "M001", title: "Alpha — Beta", status: "active" });
  const roadmapDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(roadmapDir, { recursive: true });
  const roadmapPath = join(roadmapDir, "M001-ROADMAP.md");
  const roadmap = "# M001: Alpha — Beta\n\n## Slices\n";
  writeFileSync(roadmapPath, roadmap, "utf-8");

  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkGsdStateHealth(base, issues, fixes, { fix: true, shouldFix: () => true });

  const issue = issues.find((candidate) => candidate.code === "delimiter_in_title" && candidate.unitId === "M001");
  assert.ok(issue, "the title problem is reported");
  assert.equal(issue.fixable, false);
  assert.equal(readFileSync(roadmapPath, "utf-8"), roadmap);
  assert.equal(fixes.some((fix) => fix.includes("sanitized")), false);
});
