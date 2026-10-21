// gsd-pi — Recovery GitHub-finalize detached-promise log coverage.
//
// refreshRecoveryDbForArtifact fires a detached GitHub milestone finalize after
// a complete-milestone DB closeout (auto-recovery.ts finalize block). Its catch
// logs `GitHub milestone finalize failed after DB closeout` (:232, formerly
// :203). The catch is otherwise reachable only with a real GitHub remote +
// network failure, so we drive the real complete-milestone recovery path
// (seeded closed milestone + proven closeout) and inject a throwing finalize
// via the sanctioned _setGithubFinalizeFnForTests seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { refreshRecoveryDbForArtifact, _setGithubFinalizeFnForTests } from "../auto-recovery.ts";
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("refreshRecoveryDbForArtifact logs a recovery warning when the detached GitHub finalize throws (auto-recovery.ts:232)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-recovery-finalize-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    // Real git repo with an implementation change on a milestone branch so
    // hasImplementationArtifacts(base, "M001") returns "present" — required for
    // proveMilestoneCloseout to pass and the recovery to reach the finalize block.
    git(base, ["init", "-b", "main"]);
    git(base, ["config", "user.email", "test@test.com"]);
    git(base, ["config", "user.name", "Test"]);
    writeFileSync(join(base, "README.md"), "# init\n");
    git(base, ["add", "."]);
    git(base, ["commit", "-m", "init"]);
    git(base, ["checkout", "-b", "milestone/M001"]);
    writeFileSync(join(base, "src.ts"), "export const x = 1;\n");
    git(base, ["add", "."]);
    git(base, ["commit", "-m", "impl"]);

    invalidateAllCaches();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      verificationResult: "passed",
    });
    insertAssessment({
      path: ".gsd/milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass\n",
    });

    // Proven closeout SUMMARY artifact so proveMilestoneCloseout passes and the
    // recovery reaches the finalize block.
    const summaryPath = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(summaryPath, "complete-milestone summary path must resolve");
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, "# Milestone One\n\nComplete.\n", "utf-8");

    // Inject a throwing finalize so the detached-promise catch fires. The
    // detached promise resolves on a microtask, so we await one before draining.
    const restoreFinalize = _setGithubFinalizeFnForTests(() => {
      throw new Error("forced github finalize failure");
    });

    const previous = setStderrLoggingEnabled(false);
    _resetLogs();
    let logs: LogEntry[] = [];
    try {
      const result = refreshRecoveryDbForArtifact("complete-milestone", "M001", base);
      assert.equal(result.ok, true, "DB closeout must succeed before the detached finalize");
      // Drain detached-promise queue so the catch's logWarning lands.
      await new Promise((resolve) => setImmediate(resolve));
      logs = drainLogs();
    } finally {
      _resetLogs();
      setStderrLoggingEnabled(previous);
      restoreFinalize();
    }

    const warn = logs.find(
      (e) => e.component === "recovery" && /GitHub milestone finalize failed after DB closeout/u.test(e.message),
    );
    assert.ok(
      warn,
      "a recovery warning must be logged when the detached GitHub finalize throws (got: " +
        logs.filter((e) => e.component === "recovery").map((e) => e.message).join(" | ") + ")",
    );
    assert.match(warn!.message, /forced github finalize failure/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
