// gsd-pi — /gsd worktree clean|remove|merge must not take a worktree that is in use.
//
// Regression coverage for the worktree removal commands deciding "safe to
// remove" from the wrong branch and without looking for a running session:
//   - a milestone worktree (`milestone/<MID>`) was diffed as `worktree/<MID>`,
//     a branch that does not exist, so it always looked clean;
//   - on Windows the listed name was lower-cased, so `M007` became `m007`;
//   - a worktree with a live auto-mode session was removed under that session.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handleWorktree } from "../commands-worktree.ts";
import { withCommandCwd } from "../commands/context.ts";
import { acquireSessionLock, releaseSessionLock, updateSessionLock } from "../session-lock.ts";
import { handleWorktreeCommand } from "../worktree-command.ts";
import { listWorktrees, worktreePath } from "../worktree-manager.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(t: TestContext): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-worktree-live-")));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
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

/** A milestone worktree as auto-mode creates it: branch `milestone/<MID>`. */
function addMilestoneWorktree(base: string, milestoneId: string): string {
  const wtPath = worktreePath(base, milestoneId);
  mkdirSync(dirname(wtPath), { recursive: true });
  git(base, ["worktree", "add", "-b", `milestone/${milestoneId}`, wtPath]);
  return wtPath;
}

function commitInWorktree(wtPath: string, file: string): void {
  writeFileSync(join(wtPath, file), `${file}\n`, "utf-8");
  git(wtPath, ["add", "."]);
  git(wtPath, ["commit", "-m", `feat: ${file}`]);
}

/** Hold the project session lock as a running auto-mode session does. */
function holdSessionLock(t: TestContext, base: string, unitType: string, unitId: string): void {
  const result = acquireSessionLock(base);
  assert.equal(result.acquired, true, "the test must be able to take the session lock");
  t.after(() => {
    releaseSessionLock(base);
  });
  updateSessionLock(base, unitType, unitId);
}

interface Notification {
  message: string;
  level: string;
}

async function run(base: string, command: string): Promise<Notification[]> {
  const notifications: Notification[] = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
  await withCommandCwd(base, async () => {
    await handleWorktree(command, ctx as any);
  });
  return notifications;
}

test("listWorktrees keeps the case of a milestone worktree name", (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");

  const names = listWorktrees(base).map((wt) => wt.name);

  assert.deepEqual(names, ["M007"]);
});

test("list shows a milestone worktree with its own branch and its unmerged work", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  commitInWorktree(wtPath, "work.txt");

  const [note] = await run(base, "list");

  assert.match(note.message, /M007 \(unmerged\)/);
  assert.match(note.message, /branch\s+milestone\/M007/);
  assert.match(note.message, /1 file, \+1 -0, 1 commit/);
});

test("clean keeps a milestone worktree whose branch has unmerged commits", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  commitInWorktree(wtPath, "work.txt");

  const [note] = await run(base, "clean");

  assert.equal(existsSync(wtPath), true, "the worktree with unmerged work must stay on disk");
  assert.match(git(base, ["worktree", "list"]), /milestone\/M007/);
  assert.match(note.message, /Cleaned 0 worktrees\./);
  assert.match(note.message, /Kept:\n\s+─ M007 \(1 changed file\)/);
});

test("clean removes a merged milestone worktree and deletes its milestone branch", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");

  const [note] = await run(base, "clean");

  assert.equal(existsSync(wtPath), false);
  assert.equal(git(base, ["branch", "--list", "milestone/M007"]), "");
  assert.match(note.message, /Cleaned 1 worktree\./);
  assert.match(note.message, /Removed:\n\s+✓ M007/);
});

test("clean keeps a clean worktree that a running auto-mode session works in", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  holdSessionLock(t, base, "execute-task", "M007/S01/T01");

  const [note] = await run(base, "clean");

  assert.equal(existsSync(wtPath), true, "the live session's worktree must stay on disk");
  assert.match(git(base, ["worktree", "list"]), /milestone\/M007/);
  assert.equal(git(base, ["branch", "--list", "milestone/M007"]).trim(), "+ milestone/M007");
  assert.match(note.message, /Cleaned 0 worktrees\./);
  assert.match(
    note.message,
    new RegExp(`─ M007 \\(in use by a running auto-mode session, pid ${process.pid}, execute-task M007/S01/T01\\)`),
  );
});

test("clean removes a clean worktree while the running session works on another milestone", async (t) => {
  const base = makeRepo(t);
  const idle = addMilestoneWorktree(base, "M007");
  const busy = addMilestoneWorktree(base, "M008");
  holdSessionLock(t, base, "execute-task", "M008/S01/T01");

  const [note] = await run(base, "clean");

  assert.equal(existsSync(idle), false);
  assert.equal(existsSync(busy), true);
  assert.match(note.message, /Removed:\n\s+✓ M007/);
  assert.match(note.message, /─ M008 \(in use by a running auto-mode session/);
});

test("remove refuses a worktree with a live session and --force overrides it", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  holdSessionLock(t, base, "execute-task", "M007/S01/T01");

  const [refused] = await run(base, "remove M007");

  assert.equal(existsSync(wtPath), true);
  assert.equal(refused.level, "warning");
  assert.match(refused.message, /Worktree "M007" is in use by a running auto-mode session/);
  assert.match(refused.message, /\/gsd worktree remove M007 --force/);

  const [forced] = await run(base, "remove M007 --force");

  assert.equal(existsSync(wtPath), false);
  assert.equal(forced.message, "Removed worktree M007.");
});

test("merge refuses a worktree with a live session", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  commitInWorktree(wtPath, "work.txt");
  holdSessionLock(t, base, "execute-task", "M007/S01/T01");

  const [note] = await run(base, "merge M007");

  assert.equal(existsSync(wtPath), true);
  assert.equal(existsSync(join(base, "work.txt")), false, "nothing may be merged under a live session");
  assert.equal(note.level, "warning");
  assert.match(note.message, /Worktree "M007" is in use by a running auto-mode session/);
});

test("merge of a milestone worktree merges its milestone branch", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  commitInWorktree(wtPath, "work.txt");

  const [note] = await run(base, "merge M007");

  assert.match(note.message, /Merged M007 → main/);
  assert.equal(existsSync(join(base, "work.txt")), true);
  assert.equal(existsSync(wtPath), false);
  assert.equal(git(base, ["branch", "--list", "milestone/M007"]), "");
});

// ─── Legacy /worktree remove ────────────────────────────────────────────────

/** Run the legacy `/worktree` command from the project root with every confirm accepted. */
async function runLegacy(t: TestContext, base: string, command: string): Promise<Notification[]> {
  const notifications: Notification[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => true,
    },
  };
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
  });
  process.chdir(base);
  await handleWorktreeCommand(command, ctx as never, { sendMessage: () => {} } as never, "worktree");
  process.chdir(cwd);
  return notifications;
}

test("/worktree remove deletes the milestone branch of a milestone worktree", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");

  const [note] = await runLegacy(t, base, "remove M007");

  assert.match(note.message, /Worktree .*M007.* removed/);
  assert.equal(existsSync(wtPath), false);
  assert.equal(git(base, ["branch", "--list", "milestone/M007"]), "");
});

test("/worktree remove keeps a worktree with a live session", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  holdSessionLock(t, base, "execute-task", "M007/S01/T01");

  const [note] = await runLegacy(t, base, "remove M007");

  assert.equal(existsSync(wtPath), true);
  assert.equal(note.level, "warning");
  assert.match(note.message, /was not removed: in use by a running auto-mode session/);
});

test("/worktree remove all keeps the live session's worktree and removes the others", async (t) => {
  const base = makeRepo(t);
  const idle = addMilestoneWorktree(base, "M007");
  const busy = addMilestoneWorktree(base, "M008");
  holdSessionLock(t, base, "execute-task", "M008/S01/T01");

  const [note] = await runLegacy(t, base, "remove all");

  assert.equal(existsSync(idle), false);
  assert.equal(existsSync(busy), true);
  assert.equal(note.level, "warning");
  assert.match(note.message, /Removed: .*M007/);
  assert.match(note.message, /Not removed: .*M008.* \(in use by a running auto-mode session/);
});
