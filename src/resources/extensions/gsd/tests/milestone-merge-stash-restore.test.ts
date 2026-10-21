// gsd-pi + src/resources/extensions/gsd/tests/milestone-merge-stash-restore.test.ts
// Regression: postflight stash pop must run even when mergeAndExit throws.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _runMilestoneMergeOnceWithStashRestore,
  _runMilestoneMergeWithStashRestore,
} from "../auto/closeout.js";
import type { IterationContext } from "../auto/types.js";
import { MergeConflictError } from "../git-service.js";
import { closeDatabase, insertDecision, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.js";
import { renderAllFromDb } from "../markdown-renderer.js";
import { resolveMilestoneFile } from "../paths.js";
import type {
  PostflightResult,
  PreflightResult,
} from "../clean-root-preflight.js";

interface CallLog {
  preflightCalls: number;
  mergeCalls: number;
  postflightCalls: number;
  stopAutoCalls: Array<string | undefined>;
  stopAutoOptions: Array<{ preserveCompletedMilestoneBranch?: boolean; preserveCloseoutTranscript?: boolean } | undefined>;
  pauseAutoCalls: Array<string | undefined>;
  notifyCalls: Array<{ message: string; level: string }>;
  milestoneMergedInPhases: boolean;
}

function buildIc(opts: {
  preflightResult: PreflightResult;
  mergeBehavior: "succeed" | (() => never);
  postflightResult: PostflightResult;
}): { ic: IterationContext; log: CallLog } {
  const log: CallLog = {
    preflightCalls: 0,
    mergeCalls: 0,
    postflightCalls: 0,
    stopAutoCalls: [],
    stopAutoOptions: [],
    pauseAutoCalls: [],
    notifyCalls: [],
    milestoneMergedInPhases: false,
  };

  const session = {
    basePath: "/tmp/proj",
    originalBasePath: "/tmp/proj",
    get milestoneMergedInPhases() {
      return log.milestoneMergedInPhases;
    },
    set milestoneMergedInPhases(v: boolean) {
      log.milestoneMergedInPhases = v;
    },
  };

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        log.notifyCalls.push({ message, level });
      },
    },
  };

  const plainExitMilestone = (exitOpts: { merge: boolean }) => {
    log.mergeCalls += 1;
    if (opts.mergeBehavior === "succeed") {
      return { ok: true, merged: exitOpts.merge, codeFilesChanged: false } as const;
    }
    try {
      opts.mergeBehavior();
      return { ok: true, merged: exitOpts.merge, codeFilesChanged: false } as const;
    } catch (err) {
      // Mirror Lifecycle's typed-result wrapping of MergeConflictError
      // and other thrown values per worktree-lifecycle.exitMilestone.
      const isMergeConflict =
        err !== null &&
        typeof err === "object" &&
        err !== undefined &&
        (err as { name?: string }).name === "MergeConflictError";
      return {
        ok: false,
        reason: isMergeConflict ? "merge-conflict" : "teardown-failed",
        cause: err,
      } as const;
    }
  };

  const deps = {
    preflightCleanRoot: () => {
      log.preflightCalls += 1;
      return opts.preflightResult;
    },
    postflightPopStash: () => {
      log.postflightCalls += 1;
      return opts.postflightResult;
    },
    resolver: {
      mergeAndExit: () => {
        log.mergeCalls += 1;
        if (opts.mergeBehavior !== "succeed") {
          opts.mergeBehavior();
        }
      },
    },
    lifecycle: {
      exitMilestone: (
        _mid: string,
        exitOpts: {
          merge: boolean;
          guardedMerge?: {
            projectRoot: string;
            preflightCleanRoot: (
              basePath: string,
              milestoneId: string,
              notify: (message: string, level: "info" | "warning" | "error") => void,
            ) => PreflightResult;
            postflightPopStash: (
              basePath: string,
              milestoneId: string,
              stashMarker: string | undefined,
              notify: (message: string, level: "info" | "warning" | "error") => void,
            ) => PostflightResult;
          };
        },
        exitCtx?: { notify: (message: string, level: "info" | "warning" | "error") => void },
      ) => {
        const notify = exitCtx?.notify ?? (() => {});
        const guarded = exitOpts.guardedMerge;
        if (exitOpts.merge && guarded) {
          const preflight = guarded.preflightCleanRoot(guarded.projectRoot, _mid, notify);
          if (preflight.blocked) {
            return {
              ok: false,
              reason: preflight.blockedReason?.startsWith("unmerged-conflicts")
                ? "preflight-unmerged-conflicts"
                : "preflight-dirty-overlap",
            } as const;
          }

          const mergeResult = plainExitMilestone({ merge: true });
          const postflight = preflight.stashPushed
            ? guarded.postflightPopStash(
                guarded.projectRoot,
                _mid,
                preflight.stashMarker,
                notify,
              )
            : undefined;

          if (!mergeResult.ok) {
            if (mergeResult.reason === "merge-conflict") {
              return { ...mergeResult, postflight } as const;
            }
            return {
              ok: false,
              reason: "merge-failed",
              cause: mergeResult.cause,
              postflight,
            } as const;
          }
          if (postflight?.needsManualRecovery) {
            return {
              ok: false,
              reason: "postflight-stash-restore-failed",
              postflight,
            } as const;
          }
          return mergeResult;
        }

        return plainExitMilestone(exitOpts);
      },
    },
    stopAuto: async (
      _c?: unknown,
      _p?: unknown,
      reason?: string,
      options?: { preserveCompletedMilestoneBranch?: boolean; preserveCloseoutTranscript?: boolean },
    ) => {
      log.stopAutoCalls.push(reason);
      log.stopAutoOptions.push(options);
    },
    pauseAuto: async (
      _c?: unknown,
      _p?: unknown,
      errorContext?: { message: string },
    ) => {
      log.pauseAutoCalls.push(errorContext?.message);
    },
  };

  const ic = {
    ctx,
    pi: {},
    s: session,
    deps,
  } as unknown as IterationContext;

  return { ic, log };
}

const STASH_PUSHED: PreflightResult = {
  stashPushed: true,
  stashMarker: "gsd-preflight-stash:M002:42:1700000000000:abc",
  summary: "Stashed uncommitted changes before merge (milestone M002).",
};

const STASH_NOT_PUSHED: PreflightResult = {
  stashPushed: false,
  summary: "",
};

const PREFLIGHT_BLOCKED: PreflightResult = {
  stashPushed: false,
  blocked: true,
  blockedReason: "dirty-overlap",
  overlappingPaths: ["todo.js", "test-todo-cli.js"],
  summary: "Working tree has uncommitted files that overlap milestone M002 changes.",
};

const PREFLIGHT_UNMERGED: PreflightResult = {
  stashPushed: false,
  blocked: true,
  blockedReason: "unmerged-conflicts",
  conflictedPaths: ["todo.js", "test-todo-cli.js"],
  summary: "Working tree has unresolved Git conflicts before milestone M002 merge.",
};

const PREFLIGHT_UNMERGED_EVAL_FAILED: PreflightResult = {
  stashPushed: false,
  blocked: true,
  blockedReason: "unmerged-conflicts-eval-failed",
  conflictedPaths: ["todo.js"],
  summary: "Unable to fully evaluate unresolved Git conflicts before milestone M002 merge.",
};

function git(basePath: string, args: string[], stdio: "ignore" | "pipe" = "pipe"): void {
  execFileSync("git", args, { cwd: basePath, stdio });
}

async function withProjectionBackedProject<T>(
  fn: (basePath: string, roadmapPath: string) => Promise<T>,
  options: { gitInit?: boolean } = {},
): Promise<T> {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-postflight-projection-"));
  try {
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({
      id: "M002",
      title: "Postflight Guard",
      status: "active",
    });
    insertSlice({
      id: "S01",
      milestoneId: "M002",
      title: "Slice",
      status: "pending",
      risk: "medium",
      depends: [],
      demo: "demo",
      sequence: 1,
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M002",
      title: "Task",
      status: "pending",
    });
    await renderAllFromDb(basePath);
    if (options.gitInit !== false) {
      git(basePath, ["init"], "ignore");
      git(basePath, ["config", "user.email", "test@example.invalid"]);
      git(basePath, ["config", "user.name", "Test"]);
      git(basePath, ["add", ".gsd"]);
      git(basePath, ["commit", "-m", "initial projections"], "ignore");
    }
    const roadmapPath = resolveMilestoneFile(basePath, "M002", "ROADMAP");
    assert.ok(roadmapPath, "expected rendered M002 roadmap path");
    return await fn(basePath, roadmapPath);
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
}

function insertFreshDbSlice(): void {
  insertSlice({
    id: "S02",
    milestoneId: "M002",
    title: "Fresh DB Slice",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "demo",
    sequence: 2,
  });
}

const POP_OK: PostflightResult = {
  restored: true,
  needsManualRecovery: false,
  message: "Restored stashed changes after milestone M002 merge.",
  stashRef: "stash@{0}",
};

const POP_NEEDS_RECOVERY: PostflightResult = {
  restored: false,
  needsManualRecovery: true,
  message: "git stash pop stash@{0} failed: conflict in lib/models.ts",
};

test("happy path: merge succeeds and stash is popped", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.equal(result, null, "happy path returns null (loop continues)");
  assert.equal(log.preflightCalls, 1);
  assert.equal(log.mergeCalls, 1);
  assert.equal(log.postflightCalls, 1, "postflight pop must run on success");
  assert.equal(log.stopAutoCalls.length, 0, "no stopAuto on happy path");
  assert.equal(log.milestoneMergedInPhases, true, "merge flag set");
});

test("regression #5538-followup: postflight pop runs even when mergeAndExit throws non-conflict error", async () => {
  // The original bug: when mergeAndExit threw, the catch block called
  // stopAuto + return break BEFORE postflight pop ran. The user's
  // gsd-preflight-stash:M00x stash was orphaned. This test exercises that
  // exact scenario and asserts the pop is now invoked.
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: () => {
      throw new Error("native git merge failed: index lock present");
    },
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, { action: "break", reason: "merge-failed" });
  assert.equal(log.mergeCalls, 1);
  assert.equal(
    log.postflightCalls,
    1,
    "postflight pop must run even on merge failure (was the bug)",
  );
  // A non-conflict merge failure is recoverable — pause (resumable), do not
  // hard-stop and re-run the failed merge in stopAuto's teardown.
  assert.equal(log.stopAutoCalls.length, 0, "merge failure must not hard-stop");
  assert.equal(log.pauseAutoCalls.length, 1);
  assert.match(log.pauseAutoCalls[0] ?? "", /Merge error on milestone M002/);
  assert.equal(
    log.milestoneMergedInPhases,
    false,
    "merge flag must NOT be set when merge throws",
  );
});

test("regression #5538-followup: postflight pop runs even when mergeAndExit throws MergeConflictError", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: () => {
      throw new MergeConflictError(
        ["lib/models.ts", "app/page.tsx"],
        "squash",
        "milestone/M002",
        "main",
      );
    },
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, { action: "break", reason: "merge-conflict" });
  assert.equal(log.mergeCalls, 1);
  assert.equal(
    log.postflightCalls,
    1,
    "postflight pop must run on merge conflict (was the bug)",
  );
  // A merge conflict is a recoverable human checkpoint: auto-mode must PAUSE
  // (resumable, stays in the TUI), not STOP (full session teardown + a
  // duplicate worktree re-merge in stopAuto's cleanup step, then drops the
  // user onto a "stopped" surface).
  assert.equal(log.stopAutoCalls.length, 0, "merge conflict must not hard-stop");
  assert.equal(log.pauseAutoCalls.length, 1);
  assert.match(log.pauseAutoCalls[0] ?? "", /Merge conflict on milestone M002/);
  assert.match(log.pauseAutoCalls[0] ?? "", /lib\/models\.ts/);
});

test("clean tree: no stash to pop, merge succeeds, no pop attempted", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_NOT_PUSHED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.equal(result, null);
  assert.equal(log.postflightCalls, 0, "no pop when nothing was stashed");
  assert.equal(log.milestoneMergedInPhases, true);
});

test("dirty overlap: preflight stops before merge and postflight restore", async () => {
  const { ic, log } = buildIc({
    preflightResult: PREFLIGHT_BLOCKED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, {
    action: "break",
    reason: "preflight-dirty-overlap",
  });
  assert.equal(log.mergeCalls, 0, "blocked preflight must not start milestone merge");
  assert.equal(log.postflightCalls, 0, "blocked preflight must not attempt stash restore");
  assert.equal(log.stopAutoCalls.length, 1);
  assert.match(
    log.stopAutoCalls[0] ?? "",
    /Pre-merge dirty working tree overlaps milestone M002/,
  );
  assert.equal(
    log.stopAutoOptions[0]?.preserveCompletedMilestoneBranch,
    true,
    "stopAuto cleanup must preserve the branch instead of merging after preflight blocks",
  );
});

test("dirty overlap after closeout preserves the visible closeout transcript", async () => {
  const { ic, log } = buildIc({
    preflightResult: PREFLIGHT_BLOCKED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002", {
    preserveCloseoutTranscript: true,
  });

  assert.deepEqual(result, {
    action: "break",
    reason: "preflight-dirty-overlap",
  });
  assert.equal(log.mergeCalls, 0, "blocked preflight must not start milestone merge");
  assert.equal(log.stopAutoOptions[0]?.preserveCompletedMilestoneBranch, true);
  assert.equal(
    log.stopAutoOptions[0]?.preserveCloseoutTranscript,
    true,
    "post-closeout merge blocks must not replace the closeout transcript with a stop widget",
  );
});

test("unmerged conflicts: preflight stops before merge and postflight restore", async () => {
  const { ic, log } = buildIc({
    preflightResult: PREFLIGHT_UNMERGED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, {
    action: "break",
    reason: "preflight-unmerged-conflicts",
  });
  assert.equal(log.mergeCalls, 0, "unmerged conflict preflight must not start milestone merge");
  assert.equal(log.postflightCalls, 0, "unmerged conflict preflight must not attempt stash restore");
  assert.equal(log.stopAutoCalls.length, 1);
  assert.match(
    log.stopAutoCalls[0] ?? "",
    /Pre-merge unresolved Git conflicts block milestone M002/,
  );
  assert.equal(
    log.stopAutoOptions[0]?.preserveCompletedMilestoneBranch,
    true,
    "stopAuto cleanup must preserve the branch instead of merging after preflight blocks",
  );
});

test("unmerged conflict evaluation failure stops as preflight-unmerged-conflicts", async () => {
  const { ic, log } = buildIc({
    preflightResult: PREFLIGHT_UNMERGED_EVAL_FAILED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, {
    action: "break",
    reason: "preflight-unmerged-conflicts",
  });
  assert.equal(
    log.mergeCalls,
    0,
    "failed conflict evaluation must not start milestone merge",
  );
  assert.equal(log.postflightCalls, 0, "blocked preflight must not attempt stash restore");
  assert.equal(log.stopAutoCalls.length, 1);
  assert.match(
    log.stopAutoCalls[0] ?? "",
    /Pre-merge unresolved Git conflicts block milestone M002/,
  );
});

test("already-merged milestone skips guarded merge to terminate duplicate closeout loops", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: "succeed",
    postflightResult: POP_OK,
  });
  log.milestoneMergedInPhases = true;

  const result = await _runMilestoneMergeOnceWithStashRestore(ic, "M002");

  assert.equal(result, null);
  assert.equal(log.preflightCalls, 0, "already-merged guard must not re-trigger preflight");
  assert.equal(log.mergeCalls, 0, "already-merged guard must not re-trigger merge");
  assert.equal(
    log.postflightCalls,
    0,
    "already-merged guard must not re-trigger stash restore",
  );
});


test("postflight-restored projection edits survive successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      writeFileSync(roadmapPath, "# local projection edit restored from stash\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.equal(
      readFileSync(roadmapPath, "utf8"),
      "# local projection edit restored from stash\n",
      "projection rebuild must not overwrite user edits restored by postflight stash pop",
    );
  });
});

test("untracked markdown under a new generated .gsd projection directory suppresses successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      const restoredDir = join(basePath, ".gsd", "milestones", "M002", "slices", "S99");
      mkdirSync(restoredDir, { recursive: true });
      writeFileSync(join(restoredDir, "S99-SUMMARY.md"), "# restored local markdown\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.doesNotMatch(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "untracked markdown projections inside generated .gsd directories must suppress rebuild",
    );
  });
});

test("ignored untracked markdown under .gsd suppresses successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    writeFileSync(join(basePath, ".gitignore"), ".gsd\n", "utf8");
    git(basePath, ["add", ".gitignore"]);
    git(basePath, ["commit", "-m", "ignore gsd projections"], "ignore");
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      const restoredDir = join(basePath, ".gsd", "milestones", "M002", "ignored-restored-projections");
      mkdirSync(restoredDir, { recursive: true });
      writeFileSync(join(restoredDir, "S99-SUMMARY.md"), "# ignored restored local markdown\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.doesNotMatch(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "ignored .gsd markdown projections restored by postflight must suppress rebuild",
    );
  });
});

test("preexisting ignored markdown under .gsd does not suppress successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    writeFileSync(join(basePath, ".gitignore"), ".gsd\n", "utf8");
    git(basePath, ["add", ".gitignore"]);
    git(basePath, ["commit", "-m", "ignore gsd projections"], "ignore");
    mkdirSync(join(basePath, ".gsd", "milestones", "M002", "ignored-existing-projections"), { recursive: true });
    writeFileSync(
      join(basePath, ".gsd", "milestones", "M002", "ignored-existing-projections", "S99-SUMMARY.md"),
      "# already ignored local markdown\n",
      "utf8",
    );
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.match(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "stable preexisting ignored .gsd markdown must not block the required projection rebuild",
    );
  });
});

test("failed pre-merge ignored snapshot still suppresses rebuild over restored ignored markdown", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      // Git only becomes available AFTER the pre-merge ignored-markdown
      // snapshot was attempted, so `before` is null. Postflight then restores
      // ignored `.gsd` markdown that plain `git status` cannot see. With no
      // baseline to diff against, the guard must fail closed and refuse to
      // rebuild over the restored edit.
      git(basePath, ["init"], "ignore");
      git(basePath, ["config", "user.email", "test@example.invalid"]);
      git(basePath, ["config", "user.name", "Test"]);
      writeFileSync(join(basePath, ".gitignore"), ".gsd\n", "utf8");
      git(basePath, ["add", ".gitignore"]);
      git(basePath, ["commit", "-m", "ignore gsd projections"], "ignore");
      writeFileSync(roadmapPath, "# ignored projection edit restored from stash\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.equal(
      readFileSync(roadmapPath, "utf8"),
      "# ignored projection edit restored from stash\n",
      "a null pre-merge ignored snapshot must fail closed and preserve restored ignored .gsd markdown",
    );
  }, { gitInit: false });
});

test("non-projection .gsd markdown does not suppress successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), "# local preferences note\n", "utf8");
      mkdirSync(join(basePath, ".gsd", "milestones", "M002"), { recursive: true });
      writeFileSync(join(basePath, ".gsd", "milestones", "M002", "NOTES.md"), "# local milestone note\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.match(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "non-generated .gsd markdown must not block the required projection rebuild",
    );
  });
});

test("three-digit flat-phase projection restored by postflight suppresses successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      const restoredDir = join(basePath, ".gsd", "phases", "999-db-backed-planning");
      mkdirSync(restoredDir, { recursive: true });
      writeFileSync(join(restoredDir, "999-ROADMAP.md"), "# restored 3-digit projection\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.doesNotMatch(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "three-digit flat-phase projections restored by postflight must suppress rebuild",
    );
  });
});

test("root DECISIONS projection restored by postflight suppresses successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();
    insertDecision({
      id: "D001",
      when_context: "closeout",
      scope: "global",
      decision: "Regenerate decisions from DB",
      choice: "Use database projection",
      rationale: "Exercise root decision projection rebuild",
      revisable: "Yes",
      made_by: "agent",
      superseded_by: null,
    });

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      writeFileSync(
        join(basePath, ".gsd", "DECISIONS.md"),
        "# local decisions edit restored from stash\n",
        "utf8",
      );
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.doesNotMatch(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "root generated DECISIONS.md restored by postflight must suppress rebuild",
    );
    assert.equal(
      readFileSync(join(basePath, ".gsd", "DECISIONS.md"), "utf8"),
      "# local decisions edit restored from stash\n",
      "rebuild must not overwrite restored root DECISIONS.md edits",
    );
  });
});

test("non-projection .gsd dirt does not suppress successful merge rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();
    mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      writeFileSync(join(basePath, ".gsd", "runtime", "restored.json"), "{}\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.match(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "non-projection .gsd dirt must not block the required projection rebuild",
    );
  });
});

test("guarded merge stash restore and rebuild target the same canonical project root", async () => {
  await withProjectionBackedProject(async (realRoot, roadmapPath) => {
    insertFreshDbSlice();
    let postflightProjectRoot: string | undefined;

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    // originalBasePath empty + basePath diverging from canonicalProjectRoot is
    // the exact condition where the guard (snapshot / dirty check / rebuild)
    // could run against a different tree than the postflight stash restore.
    // The postflight restore must land on the same canonical root the guard
    // inspects and the rebuild writes, otherwise restored edits are missed.
    (ic.s as unknown as {
      basePath: string;
      originalBasePath: string;
      canonicalProjectRoot: string;
    }).basePath = "/tmp/gsd-decoy-basepath-not-the-project-root";
    (ic.s as unknown as { originalBasePath: string }).originalBasePath = "";
    (ic.s as unknown as { canonicalProjectRoot: string }).canonicalProjectRoot = realRoot;
    (ic.deps as unknown as { postflightPopStash: (projectRoot: string) => PostflightResult }).postflightPopStash =
      (projectRoot: string) => {
        postflightProjectRoot = projectRoot;
        writeFileSync(roadmapPath, "# projection edit restored from stash\n", "utf8");
        return POP_OK;
      };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.equal(
      postflightProjectRoot,
      realRoot,
      "postflight stash restore must run at the canonical project root the guard and rebuild use",
    );
    assert.equal(
      readFileSync(roadmapPath, "utf8"),
      "# projection edit restored from stash\n",
      "restored projection edits on the canonical root must suppress the rebuild",
    );
  });
});

test("git-quoted special-character .gsd markdown paths still suppress rebuild", async () => {
  await withProjectionBackedProject(async (basePath, roadmapPath) => {
    insertFreshDbSlice();

    const { ic } = buildIc({
      preflightResult: STASH_PUSHED,
      mergeBehavior: "succeed",
      postflightResult: POP_OK,
    });
    (ic.s as { basePath: string; originalBasePath: string }).basePath = basePath;
    (ic.s as { basePath: string; originalBasePath: string }).originalBasePath = basePath;
    (ic.deps as unknown as { postflightPopStash: () => PostflightResult }).postflightPopStash = () => {
      const restoredDir = join(basePath, ".gsd", "milestones", "M002", "restoréd");
      mkdirSync(restoredDir, { recursive: true });
      // A non-ASCII generated projection path that `git status --porcelain`
      // C-quotes without -z; a naive line.endsWith(".md") check would miss the
      // quoted path. NUL-delimited (-z) parsing sees the raw path and still
      // detects it as generated projection dirt.
      writeFileSync(join(restoredDir, "S99-SUMMARY.md"), "# restored local markdown\n", "utf8");
      return POP_OK;
    };

    const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

    assert.equal(result, null);
    assert.doesNotMatch(
      readFileSync(roadmapPath, "utf8"),
      /Fresh DB Slice/,
      "special-character generated .gsd markdown restored by postflight must suppress the rebuild",
    );
  });
});

test("merge succeeds but stash pop needs manual recovery -> postflight-stash-restore-failed break", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: "succeed",
    postflightResult: POP_NEEDS_RECOVERY,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, {
    action: "break",
    reason: "postflight-stash-restore-failed",
  });
  assert.equal(log.postflightCalls, 1);
  assert.equal(
    log.milestoneMergedInPhases,
    true,
    "successful merge must set the flag before postflight recovery stops auto-mode",
  );
  assert.equal(log.stopAutoCalls.length, 1);
  assert.match(
    log.stopAutoCalls[0] ?? "",
    /Post-merge stash restore failed for milestone M002/,
  );
});

test("merge error is reported even when stash pop also failed (merge-error takes priority)", async () => {
  const { ic, log } = buildIc({
    preflightResult: STASH_PUSHED,
    mergeBehavior: () => {
      throw new Error("network unreachable during push");
    },
    postflightResult: POP_NEEDS_RECOVERY,
  });

  const result = await _runMilestoneMergeWithStashRestore(ic, "M002");

  assert.deepEqual(result, { action: "break", reason: "merge-failed" });
  assert.equal(log.postflightCalls, 1, "postflight pop still attempted");
  assert.equal(log.stopAutoCalls.length, 0, "merge failure must not hard-stop");
  assert.equal(log.pauseAutoCalls.length, 1, "pauseAuto called once, not twice");
  assert.match(
    log.pauseAutoCalls[0] ?? "",
    /Merge error/,
    "pause message reflects merge error, not stash failure",
  );
});
