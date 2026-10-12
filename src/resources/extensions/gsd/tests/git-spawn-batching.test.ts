// Project/App: gsd-pi
// File Purpose: Behaviour and git child-process budget of the batched git
// calls on the `/gsd auto` path. Every synchronous `git` child process blocks
// the TUI event loop (50 to 85 ms each on Windows), so the merge-state drift
// check must resolve all of its git paths with one `git rev-parse`, and the
// runtime-file untracking must issue one `git rm --cached` for its whole list.

import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { GitServiceImpl } from "../git-service.ts";
import { untrackRuntimeFiles } from "../gitignore.ts";
import { nativeRmCached } from "../native-git-bridge.ts";
import {
  detectMergeStateDrift,
  repairMergeStateDrift,
} from "../state-reconciliation/drift/merge-state.ts";
import type { GSDState } from "../types.ts";
import { removeMergeStateFiles } from "../worktree-git-recovery.ts";

// ─── git child-process recorder ──────────────────────────────────────────────

const SYNC_SPAWN_APIS = ["execFileSync", "spawnSync", "execSync"] as const;
const patchable = childProcess as unknown as Record<string, (...args: any[]) => unknown>;
let originals: Record<string, (...args: any[]) => unknown> = {};
/** Argument lists of every synchronous `git` child process, in spawn order. */
let gitSpawns: string[][] = [];

beforeEach(() => {
  gitSpawns = [];
  originals = Object.fromEntries(SYNC_SPAWN_APIS.map((api) => [api, patchable[api]!]));
  for (const api of SYNC_SPAWN_APIS) {
    patchable[api] = (...args: any[]) => {
      if (args[0] === "git") gitSpawns.push(Array.isArray(args[1]) ? args[1].map(String) : []);
      else if (typeof args[0] === "string" && args[0].startsWith("git ")) gitSpawns.push(args[0].split(" ").slice(1));
      return originals[api]!(...args);
    };
  }
  syncBuiltinESMExports();
});

afterEach(() => {
  for (const [api, original] of Object.entries(originals)) patchable[api] = original;
  syncBuiltinESMExports();
});

/** Run `fn` and return its result with the git child processes it spawned. */
function recordGit<T>(fn: () => T): { result: T; spawns: string[][] } {
  const before = gitSpawns.length;
  const result = fn();
  return { result, spawns: gitSpawns.slice(before) };
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function write(base: string, relPath: string, content = `${relPath}\n`): void {
  mkdirSync(dirname(join(base, relPath)), { recursive: true });
  writeFileSync(join(base, relPath), content);
}

function makeRepo(t: TestContext): string {
  const repo = join(makeTempDir(t, "gsd-git-batching-"), "repo");
  mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@test.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "core.autocrlf", "false");
  write(repo, "README.md");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

/** A repository with one linked worktree: `cwd` is the checkout under test, `sibling` the other one. */
interface Checkouts {
  cwd: string;
  sibling: string;
}

const LAYOUTS: Array<{ label: string; make: (t: TestContext) => Checkouts }> = [
  {
    label: "normal repo",
    make: (t) => {
      const repo = makeRepo(t);
      const worktree = join(dirname(repo), "linked");
      git(repo, "worktree", "add", "-b", "linked", worktree, "main");
      return { cwd: repo, sibling: worktree };
    },
  },
  {
    label: "linked worktree",
    make: (t) => {
      const repo = makeRepo(t);
      const worktree = join(dirname(repo), "linked");
      git(repo, "worktree", "add", "-b", "linked", worktree, "main");
      return { cwd: worktree, sibling: repo };
    },
  },
];

function gitPath(cwd: string, name: string): string {
  const raw = git(cwd, "rev-parse", "--git-path", name);
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

const LEFTOVER_MARKERS = [
  "MERGE_HEAD",
  "SQUASH_MSG",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
] as const;
const MERGE_STATE_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "SQUASH_MSG", "AUTO_MERGE"] as const;
const DIRECTORY_MARKERS = new Set<string>(["rebase-merge", "rebase-apply"]);

/** Create a leftover marker where git keeps it for `cwd`; returns its path. */
function plant(cwd: string, name: string, content = `${name}\n`): string {
  const path = gitPath(cwd, name);
  if (DIRECTORY_MARKERS.has(name)) mkdirSync(path, { recursive: true });
  else writeFileSync(path, content);
  return path;
}

function detect(basePath: string) {
  const state = {} as GSDState;
  return detectMergeStateDrift(state, { basePath, state });
}

// ─── merge-state drift detection ─────────────────────────────────────────────

for (const layout of LAYOUTS) {
  describe(`merge-state drift detection (${layout.label})`, () => {
    test("clean checkout reports no drift and costs one git child process", (t) => {
      const { cwd } = layout.make(t);

      const { result, spawns } = recordGit(() => detect(cwd));

      assert.deepEqual(result, []);
      assert.equal(spawns.length, 1, `git child processes: ${JSON.stringify(spawns)}`);
    });

    for (const marker of LEFTOVER_MARKERS) {
      test(`${marker} is detected while present and not after it is gone`, (t) => {
        const { cwd } = layout.make(t);
        const markerPath = plant(cwd, marker);

        const present = recordGit(() => detect(cwd));
        assert.deepEqual(present.result, [{ kind: "unmerged-merge-state", basePath: cwd }]);
        assert.equal(present.spawns.length, 1, `git child processes: ${JSON.stringify(present.spawns)}`);

        rmSync(markerPath, { recursive: true, force: true });
        assert.deepEqual(detect(cwd), []);
      });
    }

    test("a marker in the other checkout's git dir is not this checkout's drift", (t) => {
      const { cwd, sibling } = layout.make(t);
      for (const marker of LEFTOVER_MARKERS) plant(sibling, marker);

      assert.deepEqual(detect(cwd), []);
      assert.deepEqual(detect(sibling), [{ kind: "unmerged-merge-state", basePath: sibling }]);
    });
  });

  describe(`merge-state drift repair (${layout.label})`, () => {
    test("stale merge-state files are all cleared, the other checkout's are left alone", (t) => {
      const { cwd, sibling } = layout.make(t);
      const head = git(cwd, "rev-parse", "HEAD");
      const stale = MERGE_STATE_FILES.map((file) =>
        plant(cwd, file, file === "MERGE_HEAD" ? `${head}\n` : `${file}\n`),
      );
      const siblingSquashMsg = plant(sibling, "SQUASH_MSG");

      repairMergeStateDrift({ kind: "unmerged-merge-state", basePath: cwd });

      assert.deepEqual(stale.filter((path) => existsSync(path)), []);
      assert.ok(existsSync(siblingSquashMsg), "the other checkout's SQUASH_MSG must survive");
      assert.equal(git(cwd, "rev-parse", "HEAD"), head, "no commit for marker-only state");
      assert.deepEqual(detect(cwd), []);
    });

    test("an interrupted cherry-pick is aborted", (t) => {
      const { cwd } = layout.make(t);
      const branch = git(cwd, "branch", "--show-current");
      git(cwd, "checkout", "-b", `${branch}-pick`);
      write(cwd, "conflict.txt", "theirs\n");
      git(cwd, "add", ".");
      git(cwd, "commit", "-m", "theirs");
      git(cwd, "checkout", branch);
      write(cwd, "conflict.txt", "ours\n");
      git(cwd, "add", ".");
      git(cwd, "commit", "-m", "ours");
      assert.throws(() => git(cwd, "cherry-pick", `${branch}-pick`), "pre: cherry-pick must conflict");
      const cherryPickHead = gitPath(cwd, "CHERRY_PICK_HEAD");
      assert.ok(existsSync(cherryPickHead), "pre: CHERRY_PICK_HEAD exists");
      assert.equal(detect(cwd).length, 1);

      repairMergeStateDrift({ kind: "unmerged-merge-state", basePath: cwd });

      assert.equal(existsSync(cherryPickHead), false);
      assert.equal(git(cwd, "status", "--porcelain"), "");
      assert.deepEqual(detect(cwd), []);
    });
  });

  describe(`removeMergeStateFiles (${layout.label})`, () => {
    test("removes every merge-state file with one git child process", (t) => {
      const { cwd, sibling } = layout.make(t);
      const planted = MERGE_STATE_FILES.map((file) => plant(cwd, file));
      const siblingMergeMsg = plant(sibling, "MERGE_MSG");

      const { spawns } = recordGit(() => removeMergeStateFiles(cwd, "test"));

      assert.deepEqual(planted.filter((path) => existsSync(path)), []);
      assert.ok(existsSync(siblingMergeMsg), "the other checkout's MERGE_MSG must survive");
      assert.equal(spawns.length, 1, `git child processes: ${JSON.stringify(spawns)}`);
    });

    test("removes only the files that exist", (t) => {
      const { cwd } = layout.make(t);
      const squashMsg = plant(cwd, "SQUASH_MSG");

      removeMergeStateFiles(cwd, "test");
      assert.equal(existsSync(squashMsg), false);

      // Nothing left: a second pass is a no-op.
      removeMergeStateFiles(cwd, "test");
      assert.deepEqual(MERGE_STATE_FILES.filter((file) => existsSync(gitPath(cwd, file))), []);
    });
  });
}

describe("merge-state drift detection without a usable git dir", () => {
  test("falls back to <basePath>/.git when git cannot resolve the paths", (t) => {
    const base = makeTempDir(t, "gsd-git-batching-norepo-");
    assert.deepEqual(detect(base), []);

    // Not a repository git can open, but the marker sits where the fallback looks.
    write(base, ".git/MERGE_HEAD");
    assert.deepEqual(detect(base), [{ kind: "unmerged-merge-state", basePath: base }]);
  });

  test("a GSD worktree path that is not a git worktree is an integrity failure", (t) => {
    const base = join(makeTempDir(t, "gsd-git-batching-broken-"), ".gsd-worktrees", "M001");
    mkdirSync(base, { recursive: true });

    assert.throws(() => detect(base), /Worktree integrity failure/);
  });
});

// ─── git rm --cached batching ────────────────────────────────────────────────

const TRACKED_RUNTIME_FILES = [
  ".gsd-backups/migrate-old/marker.txt",
  ".gsd-migration-import-abc123/import.json",
  ".gsd/activity/log.jsonl",
  ".gsd/runtime/data.json",
  ".gsd/journal/2026-10-10.jsonl",
  ".gsd/STATE.md",
  ".gsd/metrics.json",
  ".gsd/completed-units.json",
  ".gsd/completed-units-M001.json",
  ".gsd/gsd.db",
  ".gsd/gsd.db-wal",
  ".gsd/milestones/M001/slices/S01/S01-CONTINUE.md",
];
const TRACKED_DURABLE_FILES = [".gsd/PROJECT.md", "README.md", "src/index.ts"];

function makeRepoTrackingRuntimeFiles(t: TestContext): string {
  const repo = makeRepo(t);
  for (const file of [...TRACKED_RUNTIME_FILES, ...TRACKED_DURABLE_FILES]) write(repo, file);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "track runtime files");
  return repo;
}

function trackedFiles(repo: string): string[] {
  return git(repo, "ls-files").split("\n").filter(Boolean).sort();
}

function rmSpawns(spawns: string[][]): string[][] {
  return spawns.filter((args) => args[0] === "rm");
}

describe("untrackRuntimeFiles", () => {
  test("untracks every tracked runtime path with one git child process", (t) => {
    const repo = makeRepoTrackingRuntimeFiles(t);

    const { spawns } = recordGit(() => untrackRuntimeFiles(repo));

    assert.deepEqual(trackedFiles(repo), [...TRACKED_DURABLE_FILES].sort());
    for (const file of TRACKED_RUNTIME_FILES) {
      assert.ok(existsSync(join(repo, file)), `${file} must stay on disk`);
    }
    assert.equal(spawns.length, 1, `git child processes: ${JSON.stringify(spawns)}`);
  });

  test("tolerates runtime paths that are absent or already untracked", (t) => {
    const repo = makeRepo(t);
    write(repo, ".gsd/STATE.md");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "track one runtime file");

    untrackRuntimeFiles(repo);
    assert.deepEqual(trackedFiles(repo), ["README.md"]);

    // Idempotent: nothing left to untrack.
    const { spawns } = recordGit(() => untrackRuntimeFiles(repo));
    assert.deepEqual(trackedFiles(repo), ["README.md"]);
    assert.equal(spawns.length, 1, `git child processes: ${JSON.stringify(spawns)}`);
  });

  test("a path git refuses to untrack does not keep the others tracked", (t) => {
    const repo = makeRepoTrackingRuntimeFiles(t);
    // Staged content that differs from both HEAD and the working tree makes
    // `git rm --cached` refuse this path (and with it a whole batch).
    write(repo, ".gsd/STATE.md", "staged\n");
    git(repo, "add", ".gsd/STATE.md");
    write(repo, ".gsd/STATE.md", "working tree\n");

    untrackRuntimeFiles(repo);

    assert.deepEqual(trackedFiles(repo), [".gsd/STATE.md", ...TRACKED_DURABLE_FILES].sort());
  });

  test("external .gsd state behind a link still costs one git child process", (t) => {
    const repo = makeRepo(t);
    const external = join(dirname(repo), "external-state");
    write(external, "activity/log.jsonl");
    write(external, "STATE.md");
    // A junction on Windows, a symlink elsewhere.
    symlinkSync(external, join(repo, ".gsd"), "junction");
    write(repo, ".gitignore", ".gsd\n");
    write(repo, ".gsd-backups/migrate-old/marker.txt");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "external state");

    const { spawns } = recordGit(() => untrackRuntimeFiles(repo));

    assert.deepEqual(trackedFiles(repo), [".gitignore", "README.md"]);
    assert.equal(spawns.length, 1, `git child processes: ${JSON.stringify(spawns)}`);
  });

  test("does not throw outside a git repository", (t) => {
    const base = makeTempDir(t, "gsd-git-batching-norepo-");
    assert.doesNotThrow(() => untrackRuntimeFiles(base));
  });
});

describe("nativeRmCached", () => {
  test("reports each removed file and nothing when no path matched", (t) => {
    const repo = makeRepoTrackingRuntimeFiles(t);

    const removed = nativeRmCached(repo, [".gsd/activity", ".gsd/STATE.md", ".gsd/absent.json"]);
    assert.deepEqual([...removed].sort(), ["rm '.gsd/STATE.md'", "rm '.gsd/activity/log.jsonl'"]);

    assert.deepEqual(nativeRmCached(repo, [".gsd/activity", ".gsd/absent.json"]), []);
  });

  test("an empty path list spawns nothing", (t) => {
    const repo = makeRepo(t);

    const { result, spawns } = recordGit(() => nativeRmCached(repo, []));

    assert.deepEqual(result, []);
    assert.deepEqual(spawns, []);
  });
});

describe("GitServiceImpl.commit one-time runtime cleanup", () => {
  test("untracks tracked runtime files in a dedicated commit with one git rm", (t) => {
    const repo = makeRepoTrackingRuntimeFiles(t);
    write(repo, "src/index.ts", "export const changed = true;\n");

    const { result, spawns } = recordGit(() =>
      new GitServiceImpl(repo).commit({ message: "feat: change source" }),
    );

    assert.equal(result, "feat: change source");
    assert.deepEqual(git(repo, "log", "--format=%s", "-2").split("\n"), [
      "feat: change source",
      "chore: untrack .gsd/ runtime files from git index",
    ]);
    // RUNTIME_EXCLUSION_PATHS has no CONTINUE.md entry, so that file stays tracked.
    assert.deepEqual(
      trackedFiles(repo),
      [".gsd/milestones/M001/slices/S01/S01-CONTINUE.md", ...TRACKED_DURABLE_FILES].sort(),
    );
    assert.equal(rmSpawns(spawns).length, 1, `git rm child processes: ${JSON.stringify(rmSpawns(spawns))}`);
  });

  test("makes no cleanup commit when no runtime file is tracked", (t) => {
    const repo = makeRepo(t);
    write(repo, "src/index.ts");

    const { spawns } = recordGit(() => new GitServiceImpl(repo).commit({ message: "feat: add source" }));

    assert.deepEqual(git(repo, "log", "--format=%s").split("\n"), ["feat: add source", "initial"]);
    assert.equal(rmSpawns(spawns).length, 1, `git rm child processes: ${JSON.stringify(rmSpawns(spawns))}`);

    // The cleanup is once per repository, not once per service instance.
    write(repo, "src/second.ts");
    const second = recordGit(() => new GitServiceImpl(repo).commit({ message: "feat: add more source" }));
    assert.deepEqual(rmSpawns(second.spawns), []);
  });
});
