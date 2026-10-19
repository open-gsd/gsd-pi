// Project/App: gsd-pi
// File Purpose: Tests for the opt-in .gsd/worktree-files.json allowlist copied
// into new worktrees (#2386).

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  copyWorktreeFilesIntoWorktree,
  createWorktree,
  readWorktreeFilesAllowlist,
  worktreePath,
} from "../worktree-manager.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function makeBaseRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-wt-files-"));
  run("git init -b main", base);
  run('git config user.name "Test User"', base);
  run('git config user.email "test@example.com"', base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
  run("git add .", base);
  run('git commit -m "chore: init"', base);
  return base;
}

function worktreeLogMessages(): string[] {
  return peekLogs()
    .filter((entry) => entry.component === "worktree")
    .map((entry) => entry.message);
}

describe("readWorktreeFilesAllowlist", () => {
  let base: string;

  beforeEach(() => {
    _resetLogs();
    base = makeBaseRepo();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("returns null when the allowlist file is absent", () => {
    assert.strictEqual(readWorktreeFilesAllowlist(base), null);
  });

  test("returns the entries for a valid allowlist", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), '["config/master.key", "config/credentials/development.yml"]\n', "utf-8");
    assert.deepStrictEqual(readWorktreeFilesAllowlist(base), ["config/master.key", "config/credentials/development.yml"]);
  });

  test("returns empty array and warns for invalid JSON", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), "{not json", "utf-8");
    assert.deepStrictEqual(readWorktreeFilesAllowlist(base), []);
    assert.ok(worktreeLogMessages().some((m) => m.includes("not valid JSON")));
  });

  test("returns empty array and warns for a non-array shape", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), '{"copy": ["x"]}', "utf-8");
    assert.deepStrictEqual(readWorktreeFilesAllowlist(base), []);
    assert.ok(worktreeLogMessages().some((m) => m.includes("must be an array")));
  });

  test("returns empty array and warns for a null document", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), "null", "utf-8");
    assert.deepStrictEqual(readWorktreeFilesAllowlist(base), []);
    assert.ok(worktreeLogMessages().some((m) => m.includes("must be an array")));
  });
});

describe("copyWorktreeFilesIntoWorktree", () => {
  let base: string;
  let wtPath: string;

  beforeEach(() => {
    _resetLogs();
    base = makeBaseRepo();
    mkdirSync(join(base, "config"), { recursive: true });
    wtPath = worktreePath(base, "wtcopy");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("copies existing sources byte-identical and creates nested directories", () => {
    mkdirSync(join(base, "config", "credentials"), { recursive: true });
    const keyContent = "secret-key-content-1234\n";
    writeFileSync(join(base, "config", "master.key"), keyContent, "utf-8");
    writeFileSync(join(base, "config", "credentials", "development.yml"), "stripe: sk_test_dummy\n", "utf-8");

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["config/master.key", "config/credentials/development.yml"]);

    assert.deepStrictEqual(outcome.copied, ["config/master.key", "config/credentials/development.yml"]);
    assert.deepStrictEqual(outcome.skipped, []);
    assert.strictEqual(readFileSync(join(wtPath, "config", "master.key"), "utf-8"), keyContent);
    assert.strictEqual(readFileSync(join(wtPath, "config", "credentials", "development.yml"), "utf-8"), "stripe: sk_test_dummy\n");
    assert.ok(worktreeLogMessages().filter((m) => m.includes("copied allowlisted file")).length === 2);
  });

  test("warns and skips missing sources while copying the rest", () => {
    writeFileSync(join(base, "config", "master.key"), "key\n", "utf-8");
    mkdirSync(join(wtPath, "config"), { recursive: true });

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["config/missing.key", "config/master.key"]);

    assert.deepStrictEqual(outcome.copied, ["config/master.key"]);
    assert.deepStrictEqual(outcome.skipped, [{ path: "config/missing.key", reason: "source missing" }]);
    assert.ok(existsSync(join(wtPath, "config", "master.key")));
    assert.ok(!existsSync(join(wtPath, "config", "missing.key")));
    assert.ok(worktreeLogMessages().some((m) => m.includes("source missing")));
  });

  test("skips entries that resolve outside the repository", () => {
    writeFileSync(join(base, "config", "master.key"), "key\n", "utf-8");

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["../outside.key", "config/master.key"]);

    assert.deepStrictEqual(outcome.copied, ["config/master.key"]);
    assert.deepStrictEqual(outcome.skipped, [{ path: "../outside.key", reason: "outside repository" }]);
    assert.ok(worktreeLogMessages().some((m) => m.includes("outside the repository")));
  });

  test("skips blank entries without warning", () => {
    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["   ", ""]);
    assert.deepStrictEqual(outcome.copied, []);
    assert.deepStrictEqual(outcome.skipped, []);
    assert.strictEqual(worktreeLogMessages().length, 0);
  });

  test("copy failure of one entry does not abort later entries", () => {
    writeFileSync(join(base, "config", "locked.key"), "locked\n", "utf-8");
    writeFileSync(join(base, "config", "master.key"), "key\n", "utf-8");
    chmodSync(join(base, "config", "locked.key"), 0o000);

    try {
      const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["config/locked.key", "config/master.key"]);

      assert.deepStrictEqual(outcome.copied, ["config/master.key"]);
      assert.strictEqual(outcome.skipped.length, 1);
      assert.match(outcome.skipped[0].reason, /^copy failed:/);
      assert.ok(existsSync(join(wtPath, "config", "master.key")));
      assert.ok(worktreeLogMessages().some((m) => m.includes("copy failed")));
    } finally {
      chmodSync(join(base, "config", "locked.key"), 0o644);
    }
  });

  test("skips symlinked sources instead of following them", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "gsd-wt-outside-"));
    try {
      const outsideFile = join(outsideDir, "outside.key");
      writeFileSync(outsideFile, "outside-secret\n", "utf-8");
      symlinkSync(outsideFile, join(base, "config", "linked.key"));

      const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["config/linked.key"]);

      assert.deepStrictEqual(outcome.copied, []);
      assert.deepStrictEqual(outcome.skipped, [{ path: "config/linked.key", reason: "symlinked source" }]);
      assert.ok(!existsSync(join(wtPath, "config", "linked.key")));
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects absolute path entries", () => {
    writeFileSync(join(base, "config", "master.key"), "key\n", "utf-8");

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, [join(base, "config", "master.key")]);

    assert.deepStrictEqual(outcome.copied, []);
    assert.deepStrictEqual(outcome.skipped, [{ path: join(base, "config", "master.key"), reason: "absolute path" }]);
  });

  test("rejects entries whose destination escapes the worktree even when the source resolves inside the repo", () => {
    // base = .../gsd-wt-files-XXXX; entry "../gsd-wt-files-XXXX/config/master.key"
    // resolves (lexically) back inside the repository but would write outside
    // the worktree directory.
    const rel = join("..", basename(base), "config", "master.key");
    writeFileSync(join(base, "config", "master.key"), "key\n", "utf-8");

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, [rel]);

    assert.deepStrictEqual(outcome.copied, []);
    assert.deepStrictEqual(outcome.skipped, [{ path: rel, reason: "outside repository" }]);
  });

  test("copies explicitly gitignored sources", () => {
    writeFileSync(join(base, ".gitignore"), "config/master.key\n", "utf-8");
    writeFileSync(join(base, "config", "master.key"), "ignored-but-required\n", "utf-8");
    run("git add .gitignore", base);
    run('git commit -m "chore: ignore master key"', base);

    const outcome = copyWorktreeFilesIntoWorktree(base, wtPath, ["config/master.key"]);

    assert.deepStrictEqual(outcome.copied, ["config/master.key"]);
    assert.strictEqual(readFileSync(join(wtPath, "config", "master.key"), "utf-8"), "ignored-but-required\n");
  });
});

describe("createWorktree allowlist integration", () => {
  let base: string;

  beforeEach(() => {
    _resetLogs();
    base = makeBaseRepo();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("copies allowlisted files into the freshly created worktree (#2386)", () => {
    mkdirSync(join(base, "config"), { recursive: true });
    const keyContent = "integration-secret-key\n";
    writeFileSync(join(base, "config", "master.key"), keyContent, "utf-8");
    writeFileSync(join(base, ".gsd", "worktree-files.json"), '["config/master.key"]\n', "utf-8");

    const info = createWorktree(base, "allowlisted");
    const wtPath = worktreePath(base, info.name);

    assert.ok(existsSync(join(wtPath, "config", "master.key")));
    assert.strictEqual(readFileSync(join(wtPath, "config", "master.key"), "utf-8"), keyContent);
  });

  test("no allowlist file means no behavior change", () => {
    mkdirSync(join(base, "config"), { recursive: true });
    writeFileSync(join(base, "config", "master.key"), "secret-present-but-not-allowlisted\n", "utf-8");

    const info = createWorktree(base, "plain");
    const wtPath = worktreePath(base, info.name);

    assert.ok(existsSync(join(wtPath, "README.md")));
    assert.ok(!existsSync(join(wtPath, "config", "master.key")));
    assert.strictEqual(worktreeLogMessages().filter((m) => m.includes("allowlist")).length, 0);
  });

  test("empty allowlist array means no copies", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), "[]\n", "utf-8");

    const info = createWorktree(base, "emptylist");
    const wtPath = worktreePath(base, info.name);

    assert.ok(existsSync(join(wtPath, "README.md")));
    assert.strictEqual(worktreeLogMessages().filter((m) => m.includes("copied allowlisted file")).length, 0);
  });

  test("missing allowlisted source warns but worktree creation still succeeds", () => {
    writeFileSync(join(base, ".gsd", "worktree-files.json"), '["config/does-not-exist.key"]\n', "utf-8");

    const info = createWorktree(base, "missingsource");
    const wtPath = worktreePath(base, info.name);

    assert.ok(existsSync(join(wtPath, "README.md")));
    assert.ok(worktreeLogMessages().some((m) => m.includes("source missing")));
  });
});
