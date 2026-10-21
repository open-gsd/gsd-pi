// Project/App: gsd-pi
// File Purpose: Direct confirmed /gsd discard routing contract.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleWorkflowCommand } from "../commands/handlers/workflow.ts";
import { withCommandCwd } from "../commands/context.ts";
import { closeDatabase, getMilestone, insertMilestone, openDatabase } from "../gsd-db.ts";

test("/gsd discard confirms and calls the primitive directly", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-command-"));
  const notifications: string[] = [];
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: base, stdio: "ignore" });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", status: "queued" });

  const ctx = {
    cwd: base,
    hasUI: true,
    ui: {
      custom: async () => true,
      notify: (message: string) => notifications.push(message),
    },
  };
  const handled = await withCommandCwd(base, () => handleWorkflowCommand("discard M001", ctx as any, {} as any));

  assert.equal(handled, true);
  assert.equal(getMilestone("M001"), null);
  assert.ok(notifications.includes("Discarded M001."));
});

test("/gsd discard leaves the milestone when confirmation is declined", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-command-cancel-"));
  const notifications: string[] = [];
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", status: "queued" });

  const ctx = {
    cwd: base,
    hasUI: true,
    ui: {
      custom: async () => false,
      notify: (message: string) => notifications.push(message),
    },
  };
  const handled = await withCommandCwd(base, () => handleWorkflowCommand("discard M001", ctx as any, {} as any));

  assert.equal(handled, true);
  assert.notEqual(getMilestone("M001"), null);
  assert.ok(notifications.includes("Discard of M001 cancelled."));
});
