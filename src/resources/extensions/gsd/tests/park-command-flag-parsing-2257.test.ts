// Regression test for #2257 — /gsd park swallowed flags into the milestone id.
//
// The handler used `let targetId = arg`, so `/gsd park M001 --flag reason`
// looked up the milestone id "M001 --flag reason" and failed silently. Args
// are now parsed: `--flag` tokens are extracted, the first positional is the
// id, and the remaining positionals form the reason.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _parseParkArgsForTest, handleWorkflowCommand } from "../commands/handlers/workflow.ts";
import { withCommandCwd } from "../commands/context.ts";
import { getParkedReason, isParked } from "../milestone-actions.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { clearPathCache } from "../paths.ts";

describe("park command arg parsing (#2257)", () => {
  test("resolves the id and passes the reason through past a flag", () => {
    assert.deepEqual(_parseParkArgsForTest("M001 --flag reason"), { id: "M001", reason: "reason" });
  });

  test("extracts value-style flags and strips wrapping quotes from the reason", () => {
    assert.deepEqual(
      _parseParkArgsForTest('M001 --rationale "Remaining gaps"'),
      { id: "M001", reason: "Remaining gaps" },
    );
  });

  test("keeps plain reason text after the id", () => {
    assert.deepEqual(
      _parseParkArgsForTest("M001 waiting on vendor"),
      { id: "M001", reason: "waiting on vendor" },
    );
  });

  test("id-only input yields an empty reason", () => {
    assert.deepEqual(_parseParkArgsForTest("M001"), { id: "M001", reason: "" });
  });

  test("empty input resolves to the no-id path", () => {
    assert.deepEqual(_parseParkArgsForTest(""), { id: null, reason: "" });
  });

  test("flag-only input does not become the id", () => {
    assert.deepEqual(_parseParkArgsForTest("--flag"), { id: null, reason: "" });
  });

  test("a positional after a flag is still the id per the documented form", () => {
    assert.deepEqual(_parseParkArgsForTest("--flag deferred"), { id: "deferred", reason: "" });
  });
});

describe("park dispatch via handleWorkflowCommand (#2257)", () => {
  const cleanupFns: Array<() => void> = [];

  afterEach(() => {
    while (cleanupFns.length) cleanupFns.pop()!();
  });

  function makeFixture(): string {
    const base = mkdtempSync(join(tmpdir(), "gsd-park-command-"));
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    // resolveMilestonePath ignores metadata-only milestone dirs; a content file
    // marks the legacy-layout directory as a real milestone.
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: base, stdio: "ignore" });
    writeFileSync(join(base, "README.md"), "# Test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: base, stdio: "ignore" });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test milestone", status: "active" });
    clearPathCache();
    invalidateStateCache();
    cleanupFns.push(() => {
      closeDatabase();
      clearPathCache();
      invalidateStateCache();
      rmSync(base, { recursive: true, force: true });
    });
    return base;
  }

  function makeCtx() {
    const notifications: Array<{ message: string; level?: string }> = [];
    return {
      notifications,
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
      },
    };
  }

  test("park <id> --flag reason resolves <id> and stores the reason", async () => {
    const base = makeFixture();
    const ctx = makeCtx();
    const handled = await withCommandCwd(
      base,
      () => handleWorkflowCommand("park M001 --flag waiting on vendor", ctx as any, {} as any),
    );

    assert.equal(handled, true);
    assert.ok(isParked(base, "M001"), "M001 is parked");
    assert.equal(getParkedReason(base, "M001"), "waiting on vendor");
    assert.ok(
      ctx.notifications.some((n) => n.message === "Parked M001. Run /gsd unpark M001 to reactivate."),
      "expected success notification for M001",
    );
    assert.ok(
      !ctx.notifications.some((n) => /Could not park/.test(n.message)),
      "expected no could-not-park failure",
    );
  });

  test("park with no id parks the active milestone with the default reason", async () => {
    const base = makeFixture();
    const ctx = makeCtx();
    const handled = await withCommandCwd(
      base,
      () => handleWorkflowCommand("park --flag", ctx as any, {} as any),
    );

    assert.equal(handled, true);
    assert.ok(isParked(base, "M001"), "active milestone M001 is parked");
    assert.equal(getParkedReason(base, "M001"), "Parked via /gsd park");
    assert.ok(
      !ctx.notifications.some((n) => /Could not park/.test(n.message)),
      "expected no could-not-park failure",
    );
  });
});
