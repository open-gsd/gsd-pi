// GSD Extension — Regression test for #4996: doctor orphan milestone dir check
// Verifies that checkRuntimeHealth reports orphan_milestone_dir for empty stub
// dirs with no DB row, does not report populated dirs, and does not report
// legitimate in-flight worktree-only milestone dirs.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import type { DoctorIssue, DoctorIssueCode } from "../doctor-types.ts";

function makeBase(prefix = "gsd-doctor-orphan-"): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function stubDir(base: string, mid: string): void {
  mkdirSync(join(base, ".gsd", "milestones", mid, "slices"), { recursive: true });
}

function populateDir(base: string, mid: string): void {
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", mid, `${mid}-CONTEXT.md`), `# ${mid}\n`);
}

describe("gsd_doctor orphan milestone directory check (#4996)", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("(a) empty stub dir with no DB row is reported as orphan_milestone_dir", async () => {
    base = makeBase();
    stubDir(base, "M003");

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(orphan, "should report orphan_milestone_dir for empty stub");
    assert.equal(orphan?.severity, "warning");
    assert.equal(orphan?.fixable, true);
    assert.ok(orphan?.message.includes("M003"), "message should name the milestone");
  });

  it("removes an empty stub orphan milestone dir safely when the fix is approved", async () => {
    base = makeBase();
    stubDir(base, "M003");
    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];

    await checkRuntimeHealth(base, issues, fixes, code => code === "orphan_milestone_dir");

    assert.equal(
      fixes.includes("removed orphan milestone directory: M003"),
      true,
      JSON.stringify({ issues, fixes }),
    );
    assert.equal(existsSync(join(base, ".gsd", "milestones", "M003")), false);
  });

  it("(b) populated milestone dir is NOT reported", async () => {
    base = makeBase();
    populateDir(base, "M001");

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_dir" && i.unitId === "M001");
    assert.ok(!orphan, "populated milestone dir must not be reported as orphan");
  });

  it("(c) worktree-only milestone (no content files, no DB row, but worktree exists) is NOT reported", async () => {
    base = makeBase();
    stubDir(base, "M003");
    // Simulate a legitimate in-flight worktree
    mkdirSync(join(base, ".gsd", "worktrees", "M003"), { recursive: true });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(!orphan, "milestone with a worktree must not be reported as orphan");
  });

  it("(d) queued DB row (in-flight ID) is NOT reported as orphan", async () => {
    base = makeBase();
    stubDir(base, "M003");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M003", status: "queued" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_dir" && i.unitId === "M003");
    assert.ok(!orphan, "queued DB row must block orphan report (in-flight race protection)");
  });

  it("(e) DB milestone row with missing milestone directory is reported as orphan_milestone_db", async () => {
    base = makeBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M004", status: "active" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_db" && i.unitId === "M004");
    assert.ok(orphan, "missing milestone directory with DB row should be reported");
    assert.equal(orphan?.severity, "warning");
    assert.equal(orphan?.fixable, false);
  });

  it("(f) phantom queued DB row with no content files is reported as orphan_milestone_db (#1524)", async () => {
    base = makeBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    // Phantom: queued row, no directory, no CONTEXT/ROADMAP/SUMMARY on disk.
    insertMilestone({ id: "M015", status: "queued" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_db" && i.unitId === "M015");
    assert.ok(orphan, "phantom queued row with no content must be reported as orphan");
    assert.equal(orphan?.severity, "warning");
  });

  it("(g) queued DB row WITH content files is NOT reported as orphan_milestone_db (#1524)", async () => {
    base = makeBase();
    populateDir(base, "M005");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    // Legitimate in-flight planning: queued row with a CONTEXT file on disk.
    insertMilestone({ id: "M005", status: "queued" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_db" && i.unitId === "M005");
    assert.ok(!orphan, "queued row with content files is legitimate in-flight planning, not an orphan");
  });

  it("(h) queued DB row with an empty on-disk milestone dir is NOT reported as orphan_milestone_db (#1524)", async () => {
    base = makeBase();
    // Discuss/queue flows create the milestone dir (e.g. `mkdir -p
    // .gsd/milestones/<ID>/slices`) before any CONTEXT/ROADMAP is written, so
    // the dir exists but is not yet content-bearing. resolveMilestonePath
    // returns null for such a legacy scaffold, so the check must use directory
    // presence, not content, or it warns during normal in-flight planning.
    stubDir(base, "M006");
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M006", status: "queued" });

    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkRuntimeHealth(base, issues, fixes, () => false);

    const orphan = issues.find(i => i.code === "orphan_milestone_db" && i.unitId === "M006");
    assert.ok(!orphan, "queued row with an existing (empty) milestone dir must not be flagged as a missing-directory orphan");
  });
});
