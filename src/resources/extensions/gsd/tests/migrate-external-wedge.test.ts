// Project/App: gsd-pi
// File Purpose: Failed-migration wedge self-healing: a stale `.gsd.migrating`
// staging dir from a crashed attempt must never permanently block retry.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { migrateToExternalState } from "../migrate-external.ts";
import { externalGsdRoot } from "../repo-identity.ts";

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(remote: string): { base: string; stateDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-wedge-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-wedge-")));
  run("git init -b main", base);
  run('git config user.name "Test"', base);
  run('git config user.email "test@example.com"', base);
  run(`git remote add origin ${remote}`, base);
  writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
  run("git add README.md", base);
  run('git commit -m "init"', base);
  return { base, stateDir };
}

function withStateDir<T>(stateDir: string, fn: () => T): T {
  const previousStateDir = process.env.GSD_STATE_DIR;
  process.env.GSD_STATE_DIR = stateDir;
  try {
    return fn();
  } finally {
    if (previousStateDir === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = previousStateDir;
  }
}

test("a crashed attempt that left only .gsd.migrating self-heals and migrates on retry", () => {
  const { base, stateDir } = makeRepo("git@github.com:example/wedge-crash.git");
  try {
    withStateDir(stateDir, () => {
      // Crash window: `.gsd` was renamed to `.gsd.migrating`, then the process
      // died before the copy — `.gsd` is missing and only the staging dir
      // remains. Before the wedge fix this project was skipped forever by the
      // "doesn't exist" guard and required manual deletion to retry.
      mkdirSync(join(base, ".gsd.migrating"), { recursive: true });
      writeFileSync(join(base, ".gsd.migrating", "PREFERENCES.md"), "# prefs\n", "utf-8");
      writeFileSync(join(base, ".gsd.migrating", "STATE.md"), "# state\n", "utf-8");

      const result = migrateToExternalState(base);

      assert.equal(result.migrated, true, `stale staging must not block retry: ${result.error ?? ""}`);
      assert.equal(result.error, undefined);
      assert.ok(
        lstatSync(join(base, ".gsd")).isSymbolicLink(),
        ".gsd is replaced by the external junction",
      );
      const external = externalGsdRoot(base);
      assert.equal(readFileSync(join(external, "PREFERENCES.md"), "utf-8"), "# prefs\n");
      assert.equal(readFileSync(join(external, "STATE.md"), "utf-8"), "# state\n");
      assert.ok(
        !existsSync(join(base, ".gsd.migrating")),
        "staging dir is gone after the healed migration",
      );

      // The healed project is stable: a second call is a clean no-op.
      const again = migrateToExternalState(base);
      assert.equal(again.migrated, false);
      assert.equal(again.error, undefined);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an orphaned .gsd.migrating beside an intact .gsd is cleaned so migration completes", () => {
  const { base, stateDir } = makeRepo("git@github.com:example/wedge-orphan.git");
  try {
    withStateDir(stateDir, () => {
      // Intact current state: STATE.md + content-bearing milestones/ + a
      // non-empty gsd.db — this `.gsd` is the authoritative source.
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(base, ".gsd", "STATE.md"), "# state\n", "utf-8");
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n", "utf-8");
      writeFileSync(join(base, ".gsd", "gsd.db"), "state\n", "utf-8");
      // Orphaned staging from a crashed prior attempt whose contents must
      // never land in the external state root.
      mkdirSync(join(base, ".gsd.migrating"), { recursive: true });
      writeFileSync(join(base, ".gsd.migrating", "PREFERENCES.md"), "# stale staging\n", "utf-8");

      const result = migrateToExternalState(base);

      assert.equal(result.migrated, true, `orphaned staging must not block migration: ${result.error ?? ""}`);
      assert.equal(result.error, undefined);
      assert.ok(!existsSync(join(base, ".gsd.migrating")), "orphaned staging is removed");
      assert.ok(
        lstatSync(join(base, ".gsd")).isSymbolicLink(),
        ".gsd is replaced by the external junction",
      );
      const external = externalGsdRoot(base);
      assert.equal(readFileSync(join(external, "STATE.md"), "utf-8"), "# state\n");
      assert.equal(
        readFileSync(join(external, "milestones", "M001", "M001-CONTEXT.md"), "utf-8"),
        "# M001\n",
        "the migration source is the intact .gsd, not the stale staging copy",
      );
      assert.ok(
        !existsSync(join(external, "PREFERENCES.md")),
        "stale staging content never lands externally",
      );
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
