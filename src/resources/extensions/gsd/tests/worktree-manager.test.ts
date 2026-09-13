import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  diffWorktreeGSD,
  diffWorktreeNumstat,
  getWorktreeGSDDiff,
  getWorktreeLog,
  mergeWorktreeToMain,
  worktreeBranchName,
  worktreePath,
  pruneEphemeralGhostWorktreeDirectories,
  removeStaleWorktreeDirectory,
  verifyBranchFreeForWorktreeAdd,
} from "../worktree-manager.ts";
import { nativeWorktreeList } from "../native-git-bridge.ts";
import { GSD_GIT_ERROR, GSD_LOCK_HELD, GSDError } from "../errors.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function makeBaseRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-wt-test-"));
  run("git init -b main", base);
  run('git config user.name "Test User"', base);
  run('git config user.email "test@example.com"', base);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Demo\n\n## Slices\n- [ ] **S01: First** `risk:low` `depends:[]`\n  > After this: it works\n",
    "utf-8",
  );
  run("git add .", base);
  run('git commit -m "chore: init"', base);
  return base;
}

function makeRepoWithWorktree(worktreeName: string): { base: string; wtPath: string } {
  const base = makeBaseRepo();
  createWorktree(base, worktreeName);
  return { base, wtPath: worktreePath(base, worktreeName) };
}

function makeRepoWithChanges(worktreeName: string): { base: string; wtPath: string } {
  const { base, wtPath } = makeRepoWithWorktree(worktreeName);
  mkdirSync(join(wtPath, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(wtPath, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
    "# M002: New Feature\n\n## Slices\n- [ ] **S01: Setup** `risk:low` `depends:[]`\n  > After this: new feature ready\n",
    "utf-8",
  );
  writeFileSync(
    join(wtPath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Demo (updated)\n\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n  > Done\n",
    "utf-8",
  );
  run("git add .", wtPath);
  run('git commit -m "feat: add M002 and update M001"', wtPath);
  return { base, wtPath };
}

// ─── worktreeBranchName ───────────────────────────────────────────────────────

test("worktreeBranchName formats branch name", () => {
  assert.strictEqual(
    worktreeBranchName("feature-x"),
    "worktree/feature-x",
    "should prefix with worktree/",
  );
});

// ─── createWorktree ───────────────────────────────────────────────────────────

describe("createWorktree", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("creates worktree with correct metadata", () => {
    const info = createWorktree(base, "feature-x");
    assert.strictEqual(info.name, "feature-x", "name should match");
    assert.strictEqual(info.branch, "worktree/feature-x", "branch should be prefixed");
    assert.ok(info.exists, "exists flag should be true");
    assert.ok(existsSync(info.path), "worktree path should exist on disk");
    assert.ok(existsSync(join(info.path, "README.md")), "README.md should be in worktree");
    assert.ok(
      existsSync(join(info.path, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
      ".gsd files should be in worktree",
    );
    const branches = run("git branch", base);
    assert.ok(branches.includes("worktree/feature-x"), "branch should be created in base repo");
  });

  test("rejects invalid name", () => {
    assert.throws(
      () => createWorktree(base, "bad name!"),
      (err: Error) => {
        assert.ok(
          err.message.includes("Invalid worktree name"),
          `expected "Invalid worktree name" in error, got: ${err.message}`,
        );
        return true;
      },
      "should throw on invalid worktree name",
    );
  });

  test("removes stale directory with standalone .git directory and recreates worktree", () => {
    const staleDir = worktreePath(base, "M010");
    mkdirSync(staleDir, { recursive: true });
    run("git init -b main", staleDir);
    writeFileSync(join(staleDir, "orphan.txt"), "stale leftover\n", "utf-8");
    assert.ok(existsSync(join(staleDir, ".git")), "stale directory has standalone .git directory");

    const info = createWorktree(base, "M010");
    assert.strictEqual(info.name, "M010");
    assert.ok(existsSync(info.path));
    assert.ok(existsSync(join(info.path, ".git")), "recovered worktree has .git marker");
    run("git rev-parse --git-dir", info.path);
    assert.ok(!existsSync(join(info.path, "orphan.txt")), "stale file removed by recovery");
  });

  test("removes stale worktree directory with .git file not registered with git and recreates", () => {
    // Simulate the scenario from issue #590: removeWorktree() failed to delete
    // the directory (e.g. EPERM on Windows) but git worktree prune cleaned up
    // the registry — leaving an orphaned directory with a .git *file* (not
    // directory) that git no longer knows about.
    const staleDir = worktreePath(base, "M010");
    mkdirSync(staleDir, { recursive: true });
    // Write a .git file (worktree gitdir pointer) — not a directory
    writeFileSync(join(staleDir, ".git"), "gitdir: ../../../../.git/worktrees/M010\n", "utf-8");
    writeFileSync(join(staleDir, "orphan.txt"), "stale leftover\n", "utf-8");

    // createWorktree must detect the orphan (not in git worktree list), clean it
    // up, and succeed — not throw GSD_STALE_STATE as if it were a live conflict.
    const info = createWorktree(base, "M010");
    assert.strictEqual(info.name, "M010");
    assert.ok(existsSync(info.path));
    assert.ok(existsSync(join(info.path, ".git")), "recovered worktree has .git marker");
    run("git rev-parse --git-dir", info.path);
    assert.ok(!existsSync(join(info.path, "orphan.txt")), "stale file removed by recovery");
  });

  test("removes stale canonical directory when legacy orphan is cleaned and canonical target is stale", () => {
    // Scenario: a stale .gsd-worktrees/M020 directory (no .git — aborted prior
    // creation) coexists with an orphaned .gsd/worktrees/M020 dir (.git file not
    // registered with git). worktreePathFor returns the legacy path (canonical has
    // no .git marker), so only the legacy path was previously cleaned — the stale
    // canonical blocked git worktree add. The fix ensures createWorktree also
    // removes the stale canonical before calling git worktree add.
    const canonicalDir = join(base, ".gsd-worktrees", "M020");
    const legacyDir = join(base, ".gsd", "worktrees", "M020");

    mkdirSync(canonicalDir, { recursive: true });  // stale canonical: exists, no .git
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, ".git"), "gitdir: ../../../../.git/worktrees/M020\n", "utf-8");

    const info = createWorktree(base, "M020");
    assert.strictEqual(info.name, "M020");
    assert.ok(existsSync(info.path), "worktree path should exist after creation");
    assert.ok(existsSync(join(info.path, ".git")), "new worktree has .git marker");
    run("git rev-parse --git-dir", info.path);
  });
});

test("stale worktree cleanup gives actionable guidance for EACCES", () => {
  const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });

  assert.throws(
    () => removeStaleWorktreeDirectory("/project/.gsd-worktrees/M010", "M010", () => {
      throw cause;
    }),
    (error: unknown) => {
      assert.ok(error instanceof GSDError);
      assert.equal(error.code, GSD_GIT_ERROR);
      assert.equal(error.cause, cause);
      assert.match(error.message, /EACCES/);
      assert.match(error.message, /owned by another user/);
      assert.match(error.message, /ownership or permissions/);
      return true;
    },
  );
});

describe("createWorktree — duplicate rejection", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("rejects duplicate name", () => {
    assert.throws(
      () => createWorktree(base, "feature-x"),
      (err: Error) => {
        assert.ok(
          err.message.includes("already exists"),
          `expected "already exists" in error, got: ${err.message}`,
        );
        return true;
      },
      "should throw on duplicate worktree name",
    );
  });

});

describe("createWorktree — stale worktree registration (#2317)", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("fails loudly naming branch, path, and remediation when a stale registration still claims the branch after prune", () => {
    // Issue #2317: the reconcile path removes an orphaned worktree directory,
    // but git's .git/worktrees/<name> admin metadata can survive the prune
    // (e.g. a locked entry). The next createWorktree then hit "branch already
    // in use" and the caller silently degraded to project-root. The fix must
    // retry the prune once, then fail loudly — never fall back silently.
    const info = createWorktree(base, "M011");
    run(`git worktree lock "${info.path}"`, base);
    rmSync(info.path, { recursive: true, force: true });

    const stalePath = nativeWorktreeList(base).find((e) => e.branch === "worktree/M011")?.path;
    assert.ok(stalePath, "fixture precondition: git still lists the stale locked entry");

    assert.throws(
      () => createWorktree(base, "M011"),
      (err: unknown) => {
        assert.ok(err instanceof GSDError, "should throw GSDError");
        assert.equal(err.code, GSD_LOCK_HELD, "error code must be GSD_LOCK_HELD");
        assert.match(err.message, /worktree\/M011/, "error must name the branch");
        assert.match(err.message, new RegExp(escapeRegExp(stalePath!)), "error must name the stale path");
        assert.match(err.message, /git worktree unlock/, "error must give the unlock remediation (locked entries survive /worktree remove)");
        assert.match(err.message, /git worktree prune/, "error must give the prune remediation");
        return true;
      },
    );
  });

  test("guidance is actionable: unlock plus prune permits recreation", () => {
    // Following the error message's remediation sequence must actually clear
    // the stale registration and let createWorktree succeed.
    const info = createWorktree(base, "M011");
    run(`git worktree lock "${info.path}"`, base);
    rmSync(info.path, { recursive: true, force: true });

    assert.throws(() => createWorktree(base, "M011"), /stale worktree registration/, "precondition: creation blocked by stale registration");
    const stalePath = nativeWorktreeList(base).find((e) => e.branch === "worktree/M011")?.path;
    assert.ok(stalePath, "fixture precondition: stale locked entry is listed");

    run(`git worktree unlock "${stalePath}"`, base);
    run("git worktree prune", base);

    const recreated = createWorktree(base, "M011");
    assert.strictEqual(recreated.name, "M011");
    assert.ok(existsSync(join(recreated.path, ".git")), "recreated worktree has .git marker");
  });

  test("fails loud for a surviving stale registration at a legacy path with undeterminable branch (native mode)", () => {
    // With GSD_ENABLE_NATIVE_GSD_GIT=1, libgit2's worktree list reports an
    // empty branch for a registration whose directory is missing, so the
    // stale registration claims neither our branch nor our canonical path.
    // It sits inside the GSD worktrees containers — it must still fail loud.
    const legacyStalePath = join(base, ".gsd", "worktrees", "M014");
    assert.ok(!existsSync(legacyStalePath), "fixture precondition: legacy stale dir is missing");
    assert.throws(
      () =>
        verifyBranchFreeForWorktreeAdd(base, "M014", "worktree/M014", worktreePath(base, "M014"), {
          list: () => [{ path: legacyStalePath, branch: "", isBare: false }],
          prune: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof GSDError, "should throw GSDError");
        assert.equal(err.code, GSD_LOCK_HELD, "error code must be GSD_LOCK_HELD");
        assert.match(err.message, /worktree\/M014/, "error must name the branch");
        assert.match(err.message, new RegExp(escapeRegExp(legacyStalePath)), "error must name the stale legacy path");
        assert.match(err.message, /git worktree unlock/, "error must give the unlock remediation");
        assert.match(err.message, /git worktree prune/, "error must give the prune remediation");
        return true;
      },
    );
  });

  test("stale registration outside the worktrees root triggers the prune retry but does not block", () => {
    let pruneCalls = 0;
    assert.doesNotThrow(() =>
      verifyBranchFreeForWorktreeAdd(base, "M015", "worktree/M015", worktreePath(base, "M015"), {
        list: () => [{ path: "/opt/unrelated/wt", branch: "", isBare: false }],
        prune: () => { pruneCalls += 1; },
      }),
    );
    assert.strictEqual(pruneCalls, 1, "the broad stale-registration trigger must still retry the prune once");
  });

  test("recreates cleanly when the registration is already gone (no false fail-loud)", () => {
    const info = createWorktree(base, "M012");
    rmSync(info.path, { recursive: true, force: true });
    run("git worktree prune", base);

    const recreated = createWorktree(base, "M012");
    assert.strictEqual(recreated.name, "M012");
    assert.ok(existsSync(join(recreated.path, ".git")), "recreated worktree has .git marker");
    run("git rev-parse --git-dir", recreated.path);
  });
});

describe("verifyBranchFreeForWorktreeAdd (#2317)", () => {
  const staleEntry = { path: "/repo/.gsd-worktrees/M013", branch: "worktree/M013", isBare: false };

  test("retries prune once and passes when the stale registration clears", () => {
    let listCalls = 0;
    let pruneCalls = 0;
    verifyBranchFreeForWorktreeAdd("/repo", "M013", "worktree/M013", "/repo/.gsd-worktrees/M013", {
      list: () => (listCalls++ === 0 ? [staleEntry] : []),
      prune: () => { pruneCalls += 1; },
    });
    assert.strictEqual(listCalls, 2, "must recheck the worktree list after the retry prune");
    assert.strictEqual(pruneCalls, 1, "must retry the prune exactly once");
  });

  test("throws naming branch, path, and remediation when the registration survives the retry", () => {
    assert.throws(
      () => verifyBranchFreeForWorktreeAdd("/repo", "M013", "worktree/M013", "/repo/.gsd-worktrees/M013", {
        list: () => [staleEntry],
        prune: () => {},
      }),
      (err: unknown) => {
        assert.ok(err instanceof GSDError, "should throw GSDError");
        assert.equal(err.code, GSD_LOCK_HELD, "error code must be GSD_LOCK_HELD");
        assert.match(err.message, /worktree\/M013/, "error must name the branch");
        assert.match(err.message, /\/repo\/\.gsd-worktrees\/M013/, "error must name the stale path");
        assert.match(err.message, /git worktree unlock/, "error must give the unlock remediation");
        assert.match(err.message, /git worktree prune/, "error must give the prune remediation");
        return true;
      },
    );
  });
});

describe("createWorktree — branch cleanup on add failure", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("deletes force-reset branch when worktree add fails", () => {
    // Pre-create a branch at worktree/cleanup-test so createWorktree enters
    // the force-reset path (branch exists, reuseExistingBranch not set).
    run("git branch worktree/cleanup-test", base);

    // Make the worktrees parent directory non-writable so `git worktree add`
    // fails after the branch has already been force-reset.
    const parentDir = join(base, ".gsd-worktrees");
    mkdirSync(parentDir, { recursive: true });
    run(`chmod 555 "${parentDir}"`, base);

    try {
      assert.throws(
        () => createWorktree(base, "cleanup-test"),
        "should throw when worktree add cannot create worktree directory",
      );

      // The force-reset branch must not be left as an orphan.
      const branches = run("git branch", base);
      assert.ok(
        !branches.includes("worktree/cleanup-test"),
        "force-reset branch should be deleted after failed worktree add",
      );
    } finally {
      run(`chmod 755 "${parentDir}"`, base);
    }
  });
});

// ─── listWorktrees ────────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("returns active worktrees", () => {
    const list = listWorktrees(base);
    assert.strictEqual(list.length, 1, "should list exactly one worktree");
    assert.strictEqual(list[0]!.name, "feature-x", "name should match");
    assert.strictEqual(list[0]!.branch, "worktree/feature-x", "branch should match");
    assert.ok(list[0]!.exists, "exists flag should be true");
  });

  test("returns empty after removal", () => {
    removeWorktree(base, "feature-x");
    const list = listWorktrees(base);
    assert.strictEqual(list.length, 0, "should have no worktrees after removal");
  });

  test("surfaces orphan milestone branches not in registered worktrees", () => {
    run("git branch milestone/M003", base);
    const list = listWorktrees(base);
    const orphan = list.find((wt) => wt.branch === "milestone/M003");
    assert.ok(orphan, "expected orphan milestone branch to be listed");
    assert.strictEqual(orphan?.name, "M003", "orphan name should be derived from branch");
    assert.strictEqual(orphan?.exists, false, "orphan should be marked missing on disk");
    assert.strictEqual(orphan?.orphan, true, "orphan should be explicitly flagged");
  });
});

// ─── diffWorktreeGSD ─────────────────────────────────────────────────────────

describe("diffWorktreeGSD and getWorktreeGSDDiff", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithChanges("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("detects added and modified GSD files", () => {
    const diff = diffWorktreeGSD(base, "feature-x");
    assert.ok(diff.added.length > 0, "should have added files");
    assert.ok(
      diff.added.some((f) => f.includes("M002")),
      "M002 roadmap should be in added files",
    );
    assert.ok(diff.modified.length > 0, "should have modified files");
    assert.ok(
      diff.modified.some((f) => f.includes("M001")),
      "M001 roadmap should be in modified files",
    );
    assert.strictEqual(diff.removed.length, 0, "should have no removed files");
  });

  test("returns patch content", () => {
    const fullDiff = getWorktreeGSDDiff(base, "feature-x");
    assert.ok(fullDiff.includes("M002"), "diff should mention M002");
    assert.ok(fullDiff.includes("updated"), "diff should mention the update");
  });
});

describe("worktree diff target branch override", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithChanges("feature-x");
    base = repo.base;

    run("git checkout -b integration main", base);
    writeFileSync(join(base, "TARGET_ONLY.md"), "target branch only\n", "utf-8");
    run("git add TARGET_ONLY.md", base);
    run('git commit -m "chore: target branch only"', base);
    run("git checkout main", base);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("uses supplied main branch for merge preview helper overrides", () => {
    const defaultStats = diffWorktreeNumstat(base, "feature-x", undefined, "main");
    const overrideStats = diffWorktreeNumstat(base, "feature-x", undefined, "integration");
    const selfLog = getWorktreeLog(base, "feature-x", worktreeBranchName("feature-x"));

    assert.ok(!defaultStats.some(s => s.file === "TARGET_ONLY.md"), "default main stats should not include target-only file");
    assert.ok(overrideStats.some(s => s.file === "TARGET_ONLY.md"), "override stats should use the supplied target branch");
    assert.strictEqual(selfLog, "", "override log should use the supplied branch");
  });
});

// ─── getWorktreeLog ───────────────────────────────────────────────────────────

describe("getWorktreeLog", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithChanges("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("shows commits", () => {
    const log = getWorktreeLog(base, "feature-x");
    assert.ok(log.includes("add M002"), "log should include the commit message");
  });
});

// ─── mergeWorktreeToMain ─────────────────────────────────────────────────────

describe("mergeWorktreeToMain", () => {
  let base: string;
  let wtPath: string;

  beforeEach(() => {
    base = makeBaseRepo();
    wtPath = worktreePath(base, "M900");
    mkdirSync(join(base, ".gsd-worktrees"), { recursive: true });
    run(`git worktree add -b milestone/M900 "${wtPath}"`, base);
  });

  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("cleans failed milestone squash state and deletes orphan branch", () => {
    writeFileSync(join(wtPath, "README.md"), "# Milestone change\n", "utf-8");
    run("git add README.md", wtPath);
    run('git commit -m "feat: milestone change"', wtPath);

    writeFileSync(join(base, "README.md"), "# Main change\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "feat: main change"', base);

    assert.throws(
      () => mergeWorktreeToMain(base, "M900", "feat: merge M900", "milestone/M900"),
      /Merge conflicts detected/,
    );

    assert.equal(run("git status --porcelain", base), "", "failed squash cleanup should leave main clean");
    assert.ok(!existsSync(wtPath), "failed milestone worktree should be removed");
    assert.ok(
      !run("git branch", base).includes("milestone/M900"),
      "failed milestone branch should be deleted after worktree removal",
    );
  });
});

// ─── removeWorktree ───────────────────────────────────────────────────────────

describe("removeWorktree", () => {
  let base: string;
  let wtPath: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
    wtPath = repo.wtPath;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("removes directory and branch", () => {
    removeWorktree(base, "feature-x", { deleteBranch: true });
    assert.ok(!existsSync(wtPath), "worktree directory should be gone");
    const branches = run("git branch", base);
    assert.ok(!branches.includes("worktree/feature-x"), "branch should be deleted");
  });
});

describe("removeWorktree — missing worktree", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("on missing worktree does not throw", () => {
    assert.doesNotThrow(
      () => removeWorktree(base, "nonexistent"),
      "should not throw when worktree does not exist",
    );
  });

  test("deleteBranch is quiet when the branch is already gone", () => {
    assert.doesNotThrow(
      () => removeWorktree(base, "nonexistent", { deleteBranch: true }),
      "missing branch should be treated as already cleaned up",
    );
  });
});

describe("pruneEphemeralGhostWorktreeDirectories", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("removes bg-shell-only ghost milestone directories", () => {
    const ghostDir = join(base, ".gsd-worktrees", "M009");
    mkdirSync(join(ghostDir, ".bg-shell"), { recursive: true });
    writeFileSync(join(ghostDir, ".bg-shell", "manifest.json"), "[]\n", "utf-8");

    const removed = pruneEphemeralGhostWorktreeDirectories(base);
    assert.deepEqual(removed, [ghostDir]);
    assert.ok(!existsSync(ghostDir));
  });

  test("preserves registered git worktrees", () => {
    createWorktree(base, "M001");
    const livePath = worktreePath(base, "M001");

    const removed = pruneEphemeralGhostWorktreeDirectories(base);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(livePath));
  });

  test("preserves unregistered dirs with source content", () => {
    const staleDir = join(base, ".gsd-worktrees", "M020");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "orphan.txt"), "salvage me\n", "utf-8");

    const removed = pruneEphemeralGhostWorktreeDirectories(base);
    assert.deepEqual(removed, []);
    assert.ok(existsSync(staleDir));
  });
});
