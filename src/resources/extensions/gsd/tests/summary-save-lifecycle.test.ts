// #2994 — a slice-scoped SUMMARY is a completion artifact: saving one against
// a non-terminal slice wedged auto-mode on artifact_db_status_divergence with
// no sanctioned clear. The tool must reject it, and doctor --fix must be able
// to clear existing rows (quarantine file + prune row) after review.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { executeSummarySave } from "../tools/workflow-tool-executors.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  _getAdapter,
} from "../gsd-db.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-summary-lifecycle-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* best-effort */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function seedPendingSlice(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M009", title: "Next", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M009", title: "Pending slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M009", sliceId: "S01", title: "Task", status: "pending", sequence: 1 });
}

test("gsd_summary_save rejects slice-scoped SUMMARY on a pending slice (#2994)", async () => {
  const base = makeBase();
  try {
    seedPendingSlice(base);

    const result = await executeSummarySave(
      { artifact_type: "SUMMARY", milestone_id: "M009", slice_id: "S01", content: "# S01 Summary\n\nDone work." },
      base,
    );

    assert.equal(result.isError, true, "the save must be rejected");
    const text = result.content[0]!.type === "text" ? result.content[0].text : "";
    assert.match(text, /summary_slice_not_terminal|terminal slice|completion artifact/i);
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS n FROM artifacts").get()!.n,
      0,
      "no artifact row may be persisted",
    );
    assert.equal(
      existsSync(join(base, ".gsd", "milestones", "M009", "slices", "S01", "S01-SUMMARY.md")),
      false,
      "no SUMMARY file may be written",
    );
  } finally {
    cleanup(base);
  }
});

test("gsd_summary_save still allows task-scoped SUMMARY staging and terminal slices", async () => {
  const base = makeBase();
  try {
    seedPendingSlice(base);

    // Task-scoped SUMMARY keeps its staging path on a pending task.
    const taskScoped = await executeSummarySave(
      { artifact_type: "SUMMARY", milestone_id: "M009", slice_id: "S01", task_id: "T01", content: "# T01 Summary\n\nStaged." },
      base,
    );
    assert.notEqual(taskScoped.isError, true, `task-scoped staging must stay allowed: ${JSON.stringify(taskScoped.content)}`);

    // Complete the slice, then the slice-scoped SUMMARY is legitimate.
    _getAdapter()!.prepare("UPDATE slices SET status = 'complete' WHERE id = 'S01'").run();
    const sliceScoped = await executeSummarySave(
      { artifact_type: "SUMMARY", milestone_id: "M009", slice_id: "S01", content: "# S01 Summary\n\nDone work." },
      base,
    );
    assert.notEqual(sliceScoped.isError, true, `terminal-slice SUMMARY must stay allowed: ${JSON.stringify(sliceScoped.content)}`);
  } finally {
    cleanup(base);
  }
});

test("gsd_summary_save rejects slice-scoped SUMMARY for unknown and deferred slices (#2994)", async () => {
  const base = makeBase();
  try {
    seedPendingSlice(base);

    const unknown = await executeSummarySave(
      { artifact_type: "SUMMARY", milestone_id: "M009", slice_id: "S99", content: "# S99" },
      base,
    );
    assert.equal(unknown.isError, true, "unknown slice must be rejected");
    const unknownText = unknown.content[0]!.type === "text" ? unknown.content[0].text : "";
    assert.match(unknownText, /not found/);

    _getAdapter()!.prepare("UPDATE slices SET status = 'deferred' WHERE id = 'S01'").run();
    const deferred = await executeSummarySave(
      { artifact_type: "SUMMARY", milestone_id: "M009", slice_id: "S01", content: "# S01" },
      base,
    );
    assert.equal(deferred.isError, true, "deferred slice must be rejected (done but not closed pre-cutover)");
    const deferredText = deferred.content[0]!.type === "text" ? deferred.content[0].text : "";
    assert.match(deferredText, /completion artifact|terminal slice/);
  } finally {
    cleanup(base);
  }
});

test("doctor repairs a rebuild-leftover row-only divergence (file already gone) (#2994)", async () => {
  const base = makeBase();
  try {
    seedPendingSlice(base);

    // The post-rebuild state: /gsd rebuild markdown quarantined the file but
    // the row remains, and the runtime row-record guard keeps flagging it.
    const relPath = "milestones/M009/slices/S01/S01-SUMMARY.md";
    insertArtifact({
      path: relPath,
      artifact_type: "SUMMARY",
      milestone_id: "M009",
      slice_id: "S01",
      task_id: null,
      full_content: "# S01 Summary\n\nDone work.",
    });

    const detectIssues: any[] = [];
    await checkEngineHealth(base, detectIssues, []);
    const divergence = detectIssues.find(
      (issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === "M009/S01",
    );
    assert.ok(divergence, "doctor must report the row-only divergence");
    assert.equal(divergence.fixable, true);
    assert.match(divergence.message, /rebuild markdown/);

    const repairIssues: any[] = [];
    const fixes: string[] = [];
    await checkEngineHealth(base, repairIssues, fixes, { repair: true });
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE path = :p").get({ ":p": relPath })!.n,
      0,
      "the leftover row must be pruned",
    );
    assert.equal(
      fixes.some((fix) => fix.includes("no file on disk")),
      true,
      `fix message must name the row-only prune: ${JSON.stringify(fixes)}`,
    );
  } finally {
    cleanup(base);
  }
});

test("doctor reports slice-scoped SUMMARY divergence as fixable and --fix quarantines the file and prunes the row (#2994)", async () => {
  const base = makeBase();
  try {
    seedPendingSlice(base);

    // The pre-fix wedge state: SUMMARY file + row on a pending slice.
    const relPath = "milestones/M009/slices/S01/S01-SUMMARY.md";
    mkdirSync(join(base, ".gsd", "milestones", "M009", "slices", "S01"), { recursive: true });
    writeFileSync(join(base, ".gsd", relPath), "# S01 Summary\n\nDone work.", "utf-8");
    insertArtifact({
      path: relPath,
      artifact_type: "SUMMARY",
      milestone_id: "M009",
      slice_id: "S01",
      task_id: null,
      full_content: "# S01 Summary\n\nDone work.",
    });

    const detectIssues: any[] = [];
    await checkEngineHealth(base, detectIssues, []);
    const divergence = detectIssues.find(
      (issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === "M009/S01",
    );
    assert.ok(divergence, "doctor must report the divergence");
    assert.equal(divergence.fixable, true, "the slice-scoped SUMMARY class must be fixable");

    const repairIssues: any[] = [];
    const fixes: string[] = [];
    await checkEngineHealth(base, repairIssues, fixes, { repair: true });

    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE path = :p").get({ ":p": relPath })!.n,
      0,
      "the divergent row must be pruned",
    );
    assert.equal(
      existsSync(join(base, ".gsd", relPath)),
      false,
      "the divergent file must leave its original path",
    );
    const quarantineRoot = join(base, ".gsd", "quarantine", "artifacts");
    assert.ok(existsSync(quarantineRoot), "quarantine directory must exist");
    const quarantined: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else quarantined.push(p);
      }
    };
    walk(quarantineRoot);
    assert.equal(quarantined.length, 1, "exactly one quarantined file");
    assert.equal(readFileSync(quarantined[0]!, "utf-8").includes("# S01 Summary"), true, "evidence preserved");
    assert.equal(
      fixes.some((fix) => fix.includes("Quarantined divergent slice SUMMARY")),
      true,
      `fix message must name the quarantine: ${JSON.stringify(fixes)}`,
    );
  } finally {
    cleanup(base);
  }
});
