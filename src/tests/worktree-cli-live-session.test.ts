// gsd-pi — `gsd worktree clean|remove|merge` must not take a worktree that is in use.
//
// The CLI subcommands share the removal path of the in-session commands: a
// worktree a running auto-mode session works in is kept, and `remove --force`
// is the explicit override.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleClean, handleMerge, handleRemove } from "../worktree-cli.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(t: TestContext): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-worktree-cli-live-")));
  t.after(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  git(base, ["init", "-b", "main"]);
  git(base, ["config", "user.name", "Test User"]);
  git(base, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gitignore"), ".gsd/\n.gsd-worktrees/\n", "utf-8");
  writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "chore: init"]);
  return base;
}

function addMilestoneWorktree(base: string, milestoneId: string): string {
  const wtPath = join(base, ".gsd-worktrees", milestoneId);
  mkdirSync(join(base, ".gsd-worktrees"), { recursive: true });
  git(base, ["worktree", "add", "-b", `milestone/${milestoneId}`, wtPath]);
  return wtPath;
}

/** Write the project session lock of a running auto-mode session in another process. */
async function runSessionElsewhere(t: TestContext, base: string, unitId: string): Promise<number> {
  const session = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: tmpdir(),
    stdio: "ignore",
  });
  t.after(async () => {
    if (session.exitCode !== null || session.signalCode !== null) return;
    const exited = once(session, "exit");
    session.kill();
    await exited;
  });
  await once(session, "spawn");
  const now = new Date().toISOString();
  writeFileSync(
    join(base, ".gsd", "auto.lock"),
    JSON.stringify({ pid: session.pid, startedAt: now, unitType: "execute-task", unitId, unitStartedAt: now }),
    "utf-8",
  );
  return session.pid!;
}

class ExitCalled extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/** Run a CLI handler, capturing stderr and turning process.exit into a result. */
async function runCli(
  t: TestContext,
  argv: string[],
  handler: () => Promise<void>,
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = "";
  let exitCode: number | undefined;
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  });
  t.mock.method(process, "exit", (code?: number) => {
    throw new ExitCalled(code);
  });
  const originalArgv = process.argv;
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...argv];
  try {
    await handler();
  } catch (error) {
    if (!(error instanceof ExitCalled)) throw error;
    exitCode = error.code;
  } finally {
    process.argv = originalArgv;
    t.mock.restoreAll();
  }
  return { output, exitCode };
}

test("gsd worktree clean keeps a clean worktree a running session works in", async (t) => {
  const base = makeRepo(t);
  const busy = addMilestoneWorktree(base, "M007");
  const idle = addMilestoneWorktree(base, "M008");
  const pid = await runSessionElsewhere(t, base, "M007/S01/T01");

  const { output } = await runCli(t, ["worktree", "clean"], () => handleClean(base));

  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(idle), false);
  assert.match(output, new RegExp(`Kept .*M007.* \\(in use by a running auto-mode session, pid ${pid}`));
  assert.match(output, /Removed .*M008/);
  assert.match(output, /Cleaned 1 worktree\./);
});

test("gsd worktree remove refuses a worktree with a live session and --force overrides it", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  await runSessionElsewhere(t, base, "M007/S01/T01");

  const refused = await runCli(t, ["worktree", "remove", "M007"], () => handleRemove(base, ["M007"]));

  assert.equal(refused.exitCode, 1);
  assert.equal(existsSync(wtPath), true);
  assert.match(refused.output, /Worktree "M007" was not removed: in use by a running auto-mode session/);
  assert.match(refused.output, /--force/);

  const forced = await runCli(t, ["worktree", "remove", "M007", "--force"], () => handleRemove(base, ["M007"]));

  assert.equal(forced.exitCode, undefined);
  assert.equal(existsSync(wtPath), false);
  assert.match(forced.output, /Removed worktree .*M007/);
});

test("gsd worktree merge refuses a worktree with a live session", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  writeFileSync(join(wtPath, "work.txt"), "work\n", "utf-8");
  git(wtPath, ["add", "."]);
  git(wtPath, ["commit", "-m", "feat: work"]);
  await runSessionElsewhere(t, base, "M007/S01/T01");

  const { output, exitCode } = await runCli(t, ["worktree", "merge", "M007"], () => handleMerge(base, ["M007"]));

  assert.equal(exitCode, 1);
  assert.equal(existsSync(wtPath), true);
  assert.equal(existsSync(join(base, "work.txt")), false);
  assert.match(output, /Worktree "M007" is in use by a running auto-mode session/);
});

test("gsd worktree clean keeps a worktree whose branch has unmerged commits", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  writeFileSync(join(wtPath, "work.txt"), "work\n", "utf-8");
  git(wtPath, ["add", "."]);
  git(wtPath, ["commit", "-m", "feat: work"]);

  const { output } = await runCli(t, ["worktree", "clean"], () => handleClean(base));

  assert.equal(existsSync(wtPath), true);
  assert.match(output, /Kept .*M007.* \(1 changed files\)/);
  assert.match(output, /Cleaned 0 worktrees\./);
});
