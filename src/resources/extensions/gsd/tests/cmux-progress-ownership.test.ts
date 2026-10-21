// Project/App: gsd-pi
// File Purpose: Tests for cmux sidebar status and shared-progress coordination across coexisting GSD sessions (issue #2926).
//
// Drives the real sync/clear wiring through a fake `cmux` CLI on PATH that
// logs every invocation to a JSONL file, so coordination, fold values, and
// cleanup scoping are asserted against actual CLI calls. The registry is
// redirected to a per-test temp dir; each test simulates a different session
// by swapping CMUX_SURFACE_ID (the existing per-session identity). One test
// uses a real second process to prove cross-process pid liveness.

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  clearCmuxSidebar,
  setCmuxProgressRegistryDirForTests,
  syncCmuxSidebar,
} from "../../cmux/index.ts";
import {
  aggregateProgress,
  cmuxProgressRegistryDir,
  hasSessionEntry,
  isPidAlive,
  listLiveEntries,
  removeSessionEntry,
  writeSessionEntry,
} from "../../cmux/progress-registry.ts";
import type { CmuxPreferencesInput, CmuxStateInput } from "../../shared/cmux-events.ts";

type CliCall = string[];

interface Harness {
  binDir: string;
  registryDir: string;
  socketPath: string;
  logPath: string;
  calls: () => CliCall[];
}

const SIDEBAR_ON: CmuxPreferencesInput = { cmux: { enabled: true, sidebar: true, notifications: true } };
const WORKSPACE = "workspace:1000";

function writeFakeCmuxCli(binDir: string, logPath: string): void {
  const cmuxPath = path.join(binDir, "cmux");
  fs.writeFileSync(
    cmuxPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "if (process.argv.includes('--help')) process.exit(0);",
      "process.stdout.write('ok');",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(cmuxPath, 0o755);
}

function makeHarness(): Harness {
  const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-ownership-bin-"));
  const registryDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-ownership-reg-"));
  const socketPath = path.join(registryDir, "cmux.sock");
  // Sidebar availability requires an existing socket file.
  fs.writeFileSync(socketPath, "");
  const logPath = path.join(binDir, "calls.jsonl");
  writeFakeCmuxCli(binDir, logPath);
  return {
    binDir,
    registryDir,
    socketPath,
    logPath,
    calls: () =>
      fs
        .readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CliCall),
  };
}

function cleanup(h: Harness, originalPath: string | undefined): void {
  process.env.PATH = originalPath;
  fs.rmSync(h.binDir, { recursive: true, force: true });
  fs.rmSync(h.registryDir, { recursive: true, force: true });
}

/** Point the environment at one simulated session inside the harness workspace. */
function asSession(h: Harness, surfaceId: string): void {
  process.env.CMUX_WORKSPACE_ID = WORKSPACE;
  process.env.CMUX_SURFACE_ID = surfaceId;
  process.env.CMUX_SOCKET_PATH = h.socketPath;
}

function withFakeCli(t: import("node:test").TestContext): Harness {
  const h = makeHarness();
  const originalPath = process.env.PATH;
  process.env.PATH = `${h.binDir}:${originalPath ?? ""}`;
  t.after(() => cleanup(h, originalPath));
  setCmuxProgressRegistryDirForTests(h.registryDir);
  return h;
}

function stateWith(progress: CmuxStateInput["progress"] | null, phase = "executing"): CmuxStateInput {
  return { phase, activeMilestone: { id: "M001" }, progress: progress ?? undefined };
}

const TASKS = (done: number, total: number): CmuxStateInput["progress"] => ({
  milestones: { done: 0, total: 1 },
  tasks: { done, total },
});

function progressCalls(h: Harness): CliCall[] {
  return h.calls().filter((call) => call[0] === "set-progress" || call[0] === "clear-progress");
}

/** Assert the argv of a set-progress call: `set-progress <value> --label <label>`. */
function assertProgress(call: CliCall | undefined, value: string, label: string): void {
  assert.ok(call, "expected a set-progress call");
  assert.equal(call[0], "set-progress");
  assert.equal(call[1], value);
  const labelIndex = call.indexOf("--label");
  assert.ok(labelIndex !== -1, "set-progress carries a --label");
  assert.equal(call[labelIndex + 1], label);
}

/** The live member entries for the harness workspace. */
function entries(h: Harness): ReturnType<typeof listLiveEntries>["live"] {
  return listLiveEntries(cmuxProgressRegistryDir(WORKSPACE, h.registryDir)).live;
}

function entryKeys(h: Harness): string[] {
  return Object.keys(entries(h)).sort();
}

/** The pid recorded for a "remote" (foreign-process) session in a preseeded registry. */
const FOREIGN_ALIVE_PID = 1; // pid 1 is always alive
const DEAD_PID = 2 ** 24; // far above any real pid on this machine

beforeEach(() => {
  setCmuxProgressRegistryDirForTests(null);
});

afterEach(() => {
  setCmuxProgressRegistryDirForTests(null);
  delete process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_SURFACE_ID;
  delete process.env.CMUX_SOCKET_PATH;
});

describe("cmux finalization semantics (#2926)", () => {
  test("completing-milestone and complete render with distinct icon and color", (t) => {
    const h = withFakeCli(t);
    asSession(h, "surface:1");

    syncCmuxSidebar(SIDEBAR_ON, stateWith(null, "completing-milestone"));
    syncCmuxSidebar(SIDEBAR_ON, stateWith(null, "complete"));

    const calls = h.calls().filter((call) => call[0] === "set-status");
    assert.equal(calls.length, 2);
    const finalizing = calls.find((call) => call.some((arg) => arg.includes("completing-milestone")));
    const complete = calls.find((call) => call.some((arg) => arg.endsWith("· complete")));
    assert.ok(finalizing, "finalizing status written");
    assert.ok(complete, "completed status written");
    const iconOf = (call: CliCall) => call[call.indexOf("--icon") + 1]!;
    const colorOf = (call: CliCall) => call[call.indexOf("--color") + 1]!;
    // Authoritative completion keeps the green check; finalization differs in
    // both icon and color, and the label text names the phase.
    assert.equal(iconOf(complete!), "check");
    assert.equal(colorOf(complete!), "#22c55e");
    assert.notEqual(iconOf(finalizing!), iconOf(complete!));
    assert.notEqual(colorOf(finalizing!), colorOf(complete!));
    assert.ok(finalizing!.some((arg) => arg.includes("completing-milestone")));
  });
});

describe("cmux status ownership (#2926)", () => {
  test("each session rewrites only its own keyed status row", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:1");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(1, 5)));
    clearCmuxSidebar(SIDEBAR_ON);

    const setStatusKeys = h.calls().filter((c) => c[0] === "set-status").map((c) => c[1]);
    const clearStatusKeys = h.calls().filter((c) => c[0] === "clear-status").map((c) => c[1]);
    assert.deepEqual(setStatusKeys, ["gsd:surface:1", "gsd:surface:2"]);
    assert.deepEqual(clearStatusKeys, ["gsd:surface:2"], "clear touches only the owning session's row");
    assert.deepEqual(entryKeys(h), ["gsd:surface:1"], "registry entry removed for the exiting session");
  });

  test("an unchanged re-sync still rewrites the row (no cache can leave a cleared row missing)", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:1");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(null, "executing"));
    syncCmuxSidebar(SIDEBAR_ON, stateWith(null, "executing"));
    assert.equal(h.calls().filter((c) => c[0] === "set-status").length, 2);
  });
});

describe("cmux shared progress coordination (#2926)", () => {
  test("single session keeps single-session progress values and label", (t) => {
    const h = withFakeCli(t);
    asSession(h, "surface:1");

    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    // Unconditional rewrite: no private write-cache can suppress a repair
    // after another member interleaved a write and vanished.
    assert.equal(progressCalls(h).length, 2);
    assertProgress(progressCalls(h)[0], "0.400", "2/5 tasks");
    assertProgress(progressCalls(h)[1], "0.400", "2/5 tasks");
  });

  test("interleaved sessions: every member registers and the fold spans both", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(1, 4)));

    const writes = h.calls().filter((c) => c[0] === "set-progress");
    assert.equal(writes.length, 2);
    assertProgress(writes[0], "0.400", "2/5 tasks");
    // The joining session refreshes the slot with the deterministic fold.
    assertProgress(writes[1], (3 / 9).toFixed(3), "3/9 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:2", "gsd:surface:5"]);
  });

  test("a member's own progress change is reflected without waiting for any other session", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(1, 4)));
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(3, 4))); // this session's contribution changes

    const writes = h.calls().filter((c) => c[0] === "set-progress");
    assert.equal(writes.length, 3);
    assertProgress(writes[2], (5 / 9).toFixed(3), "5/9 tasks");
  });

  test("a member exiting removes only itself and refreshes the fold over survivors", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(1, 4)));
    const callsBeforeExit = h.calls().length;
    clearCmuxSidebar(SIDEBAR_ON); // surface:5 leaves

    const newCalls = h.calls().slice(callsBeforeExit);
    assert.deepEqual(
      newCalls.filter((c) => c[0] === "clear-status").map((c) => c[1]),
      ["gsd:surface:5"],
      "clear touches only the exiting session's row",
    );
    // The departing member hands the slot over coherently: fold over the
    // survivor only — never a clear, never a stale aggregate.
    assert.equal(newCalls.filter((c) => c[0] === "set-progress").length, 1);
    assertProgress(newCalls.find((c) => c[0] === "set-progress"), "0.400", "2/5 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:2"]);
  });

  test("last member leaving clears the slot and empties the registry", (t) => {
    const h = withFakeCli(t);
    asSession(h, "surface:1");

    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    // A crashed session's leftovers appear only after our last sync — so the
    // departing cleanup itself must reap them: no later sync exists.
    writeSessionEntry(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "gsd:surface:9", {
      pid: DEAD_PID,
      progress: TASKS(9, 9)!,
      updatedAt: "crashed",
    });
    const callsBeforeExit = h.calls().length;
    clearCmuxSidebar(SIDEBAR_ON);

    const newCalls = h.calls().slice(callsBeforeExit);
    assert.equal(newCalls.filter((c) => c[0] === "clear-progress").length, 1);
    assert.deepEqual(entryKeys(h), []);
    assert.ok(
      newCalls.some((c) => c[0] === "clear-status" && c[1] === "gsd:surface:9"),
      "the departing cleanup reaps the crashed session's orphaned status row",
    );
  });

  test("a session without progress joining refreshes without erasing the fold", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    asSession(h, "surface:1");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(null)); // joins without progress

    const writes = h.calls().filter((c) => c[0] === "set-progress" || c[0] === "clear-progress");
    assert.equal(writes.length, 2, "join refreshes; nothing is cleared");
    assertProgress(writes[1], "0.400", "2/5 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:1", "gsd:surface:5"]);
  });

  test("dead-pid members are pruned and excluded from the fold (crash recovery)", (t) => {
    const h = withFakeCli(t);

    // A crashed session that wrote the slot before dying.
    writeSessionEntry(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "gsd:surface:1", {
      pid: DEAD_PID,
      progress: TASKS(9, 9)!,
      updatedAt: "2026-10-20T00:00:00.000Z",
    });

    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    assert.equal(progressCalls(h).length, 1);
    assertProgress(progressCalls(h)[0], "0.400", "2/5 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:2"], "dead entry pruned");
    // The survivor also reaps the crashed session's orphaned status row.
    assert.deepEqual(
      h.calls().filter((c) => c[0] === "clear-status").map((c) => c[1]),
      ["gsd:surface:1"],
    );
  });

  test("a crashed member's interposed slot value is repaired on the next local sync", (t) => {
    const h = withFakeCli(t);

    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5))); // A writes its fold
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(1, 4))); // B joins and writes a two-member fold
    // B crashes before A's next sync: dead entry left behind, slot still shows
    // B's last write. A's next sync must repair the bar unconditionally.
    writeSessionEntry(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "gsd:surface:2", {
      pid: DEAD_PID,
      progress: TASKS(1, 4)!,
      updatedAt: "crashed",
    });

    asSession(h, "surface:5");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    assertProgress(progressCalls(h).at(-1), "0.400", "2/5 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:5"]);
    // B's orphaned status row is reaped together with its registry entry.
    assert.ok(
      h.calls().some((c) => c[0] === "clear-status" && c[1] === "gsd:surface:2"),
      "crashed member's status row reaped",
    );
  });

  test("a corrupt registry entry is ignored, removed, and rebuilt from the syncing session", (t) => {
    const h = withFakeCli(t);
    const sessionsDir = path.join(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${encodeURIComponent("gsd:surface:1")}.json`), "{not json");

    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    assert.deepEqual(entryKeys(h), ["gsd:surface:2"]);
    assertProgress(progressCalls(h)[0], "0.400", "2/5 tasks");
  });

  test("cleanup is fenced: a same-key replacement that registered first survives", (t) => {
    const h = withFakeCli(t);

    // A "replacement" process with the same surface id registered before the
    // old process cleans up (recorded pid differs from ours).
    writeSessionEntry(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "gsd:surface:2", {
      pid: FOREIGN_ALIVE_PID,
      progress: TASKS(1, 4)!,
      updatedAt: "2026-10-20T00:00:00.000Z",
    });

    asSession(h, "surface:2");
    clearCmuxSidebar(SIDEBAR_ON); // old process cleans up

    assert.deepEqual(entryKeys(h), ["gsd:surface:2"], "replacement entry not removed");
    assert.deepEqual(progressCalls(h), [], "replacement's state not erased or rewritten");
  });

  test("restart/reconnect: the same session key re-registers with a new pid and rewrites the slot", (t) => {
    const h = withFakeCli(t);
    // Leftover from the "previous" process lifetime of the same surface.
    writeSessionEntry(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "gsd:surface:2", {
      pid: DEAD_PID,
      progress: TASKS(9, 9)!,
      updatedAt: "2026-10-20T00:00:00.000Z",
    });

    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    assert.equal(entries(h)["gsd:surface:2"]!.pid, process.pid);
    assertProgress(progressCalls(h)[0], "0.400", "2/5 tasks");
    assert.ok(
      h.calls().some((c) => c[0] === "set-status" && c[1] === "gsd:surface:2"),
      "status row is rewritten after restart",
    );
  });

  test("cross-process: a live second session's contribution joins the fold and its exit is pruned", async (t) => {
    const h = withFakeCli(t);
    asSession(h, "surface:2");
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));

    // A real second process registers its own entry, stays alive briefly,
    // then exits without cleanup (the crash path — no registry mutation).
    const sessionsDir = path.join(cmuxProgressRegistryDir(WORKSPACE, h.registryDir), "sessions");
    const entryFile = path.join(sessionsDir, `${encodeURIComponent("gsd:surface:9")}.json`);
    const script = [
      "const fs = require('node:fs');",
      `fs.mkdirSync(${JSON.stringify(sessionsDir)}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(entryFile)}, JSON.stringify({ pid: process.pid, progress: { milestones: { done: 0, total: 1 }, tasks: { done: 1, total: 4 } }, updatedAt: 'test' }));`,
      "setTimeout(() => process.exit(0), 1500);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    t.after(() => {
      child.kill("SIGKILL");
    });

    // Wait until the child's entry is on disk (deterministic, no sleeps-first).
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(entryFile)) {
      if (Date.now() > deadline) throw new Error("child never registered its entry");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Parent observes the live second session: the fold spans both pids.
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    assertProgress(progressCalls(h).at(-1), (3 / 9).toFixed(3), "3/9 tasks");

    // Child exits without cleanup; the next sync prunes it by pid death.
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    syncCmuxSidebar(SIDEBAR_ON, stateWith(TASKS(2, 5)));
    assertProgress(progressCalls(h).at(-1), "0.400", "2/5 tasks");
    assert.deepEqual(entryKeys(h), ["gsd:surface:2"]);
    assert.ok(
      h.calls().some((c) => c[0] === "clear-status" && c[1] === "gsd:surface:9"),
      "crashed child's status row reaped by the survivor",
    );
  });
});

describe("progress-registry units", () => {
  test("aggregateProgress sums levels independently and omits unreported levels", () => {
    const entries = {
      a: { pid: FOREIGN_ALIVE_PID, progress: TASKS(2, 5)!, updatedAt: "" },
      b: { pid: FOREIGN_ALIVE_PID, progress: { milestones: { done: 1, total: 2 } }, updatedAt: "" },
      c: { pid: FOREIGN_ALIVE_PID, progress: null, updatedAt: "" },
    };
    assert.deepEqual(aggregateProgress(entries), {
      milestones: { done: 1, total: 3 },
      tasks: { done: 2, total: 5 },
    });
  });

  test("aggregateProgress returns null when no member reports progress", () => {
    assert.equal(aggregateProgress({}), null);
    assert.equal(aggregateProgress({ a: { pid: FOREIGN_ALIVE_PID, progress: null, updatedAt: "" } }), null);
  });

  test("isPidAlive classifies real and impossible pids", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(DEAD_PID), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(Number.NaN), false);
  });

  test("writeSessionEntry round-trips, skips unchanged writes, and leaves no temp litter", (t) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "cmux-registry-unit-"));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const registryDir = cmuxProgressRegistryDir("workspace:abc-123", dir);
    assert.equal(path.basename(registryDir), "gsd-cmux-progress-workspace-abc-123");
    const member = { pid: 1, progress: null, updatedAt: "t" };
    writeSessionEntry(registryDir, "gsd:surface:1", member);
    assert.deepEqual(listLiveEntries(registryDir).live, { "gsd:surface:1": member });
    // Unchanged entry: no rewrite (mtime stays).
    const file = path.join(registryDir, "sessions", `${encodeURIComponent("gsd:surface:1")}.json`);
    const mtime = fs.statSync(file).mtimeMs;
    writeSessionEntry(registryDir, "gsd:surface:1", { ...member, updatedAt: "later" });
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.deepEqual(
      fs.readdirSync(path.join(registryDir, "sessions")).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  test("removeSessionEntry only removes the entry whose recorded pid matches", (t) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "cmux-registry-unit-"));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const registryDir = cmuxProgressRegistryDir("ws", dir);
    writeSessionEntry(registryDir, "k", { pid: FOREIGN_ALIVE_PID, progress: null, updatedAt: "" });
    assert.equal(removeSessionEntry(registryDir, "k", DEAD_PID), false, "different pid is fenced out");
    assert.equal(hasSessionEntry(registryDir, "k"), true);
    assert.equal(removeSessionEntry(registryDir, "k", FOREIGN_ALIVE_PID), true);
    assert.equal(hasSessionEntry(registryDir, "k"), false);
    assert.equal(removeSessionEntry(registryDir, "k", FOREIGN_ALIVE_PID), false, "already removed");
  });

  test("listLiveEntries prunes dead-pid and corrupt entries, reports reaped keys, keeps live ones", (t) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "cmux-registry-unit-"));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const registryDir = cmuxProgressRegistryDir("ws", dir);
    writeSessionEntry(registryDir, "live", { pid: FOREIGN_ALIVE_PID, progress: null, updatedAt: "" });
    writeSessionEntry(registryDir, "dead", { pid: DEAD_PID, progress: null, updatedAt: "" });
    fs.mkdirSync(path.join(registryDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(registryDir, "sessions", "corrupt.json"), "{nope");
    const { live, reapedKeys } = listLiveEntries(registryDir);
    assert.deepEqual(Object.keys(live), ["live"]);
    assert.deepEqual(reapedKeys.sort(), ["corrupt", "dead"]);
    assert.deepEqual(fs.readdirSync(path.join(registryDir, "sessions")), ["live.json"], "dead and corrupt entries removed");
  });
});
