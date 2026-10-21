// gsd-pi - Write-gate two-process seam tests.
/**
 * Deterministic interleaving tests for the host/child write-gate adapters
 * (write-gate.ts). The "child" (workflow MCP server) runs in a separate
 * process in production; these tests simulate its writes by stamping the
 * snapshot file directly, exactly as childWriteGateAdapter persists it.
 *
 * Covered interleavings:
 *   (a) child verifies on disk while the host holds stale memory — the host
 *       re-arm must NOT clobber the verification, on BOTH windows
 *       (tool_execution_start re-arm and the tool_call defer path);
 *   (b) concurrent writes: every persist is an unconditional read-merge-write
 *       (read disk → union-merge → mutate → atomic rename), so a write the
 *       other process landed in between is folded in, never overwritten;
 *   (c) two basePaths defer approval gates in the same process — both stay
 *       deferred and both activate (regression for the old single global slot);
 *   (d) old snapshot files (including ones carrying the retired epoch field)
 *       keep loading; stale fields are dropped on the next write.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  _setWriteGateInterleaveHookForTest,
  childWriteGateAdapter,
  clearDiscussionFlowState,
  getPendingGate,
  hostWriteGateAdapter,
  loadWriteGateSnapshot,
  markDepthVerified,
  refreshWriteGateStateFromDisk,
  setPendingGate,
  type WriteGateSnapshot,
} from "../bootstrap/write-gate.ts";
import { acquireSyncLock, releaseSyncLock } from "../sync-lock.ts";

const WRITE_GATE_LOCK_NAME = "write-gate.lock";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-write-gate-seam-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotPath(basePath: string): string {
  return join(basePath, ".gsd", "runtime", "write-gate-state.json");
}

/** Simulate a write from the OTHER process by stamping the file directly. */
function foreignProcessWrites(basePath: string, snapshot: Partial<WriteGateSnapshot>): void {
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });
  writeFileSync(snapshotPath(basePath), JSON.stringify({
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: null,
    ...snapshot,
  }, null, 2), "utf-8");
}

function readDiskRaw(basePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(snapshotPath(basePath), "utf-8"));
}

function makeHookHarness(): {
  handlers: Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>;
  pi: any;
} {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  return { handlers, pi };
}

function cleanup(dir: string): void {
  clearDiscussionFlowState(dir);
  rmSync(dir, { recursive: true, force: true });
}

const GATE = "depth_verification_M007_confirm";

// ── (a) verified-on-disk wins over a host re-arm ────────────────────────────

test("seam: host setPending does not clobber a child verification on disk", (t) => {
  const dir = makeTempDir("no-clobber-adapter");
  t.after(() => cleanup(dir));

  // Host has stale memory: it armed the gate earlier (persisted to disk).
  assert.equal(setPendingGate(GATE, dir), true, "fresh gate must arm");
  assert.equal(getPendingGate(dir), GATE);

  // Child verifies the gate in its own process (newer write on disk).
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    writer: "child",
  });

  // Host attempts a re-arm — adapter policy: verified on disk wins.
  assert.equal(hostWriteGateAdapter.setPending(GATE, dir), false, "re-arm must be suppressed");
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(snapshot.verifiedDepthMilestones.includes("M007"), "verification must survive");
  assert.ok((snapshot.verifiedApprovalGates ?? []).includes(GATE));
  assert.equal(getPendingGate(dir), null, "no pending gate after suppressed re-arm");
});

test("seam: tool_call defer path does not block tools for a gate the child verified", async (t) => {
  const dir = makeTempDir("no-clobber-defer");
  t.after(() => cleanup(dir));

  // Child verified the gate before the host ever saw the tool block.
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    writer: "child",
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  // tool_call defer window: ask_user_questions arrives post-hoc with the gate id.
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "ask_user_questions",
      input: { questions: [{ id: GATE }] },
    }, ctx);
  }

  // A subsequent tool in the same turn must NOT hit the deferred-gate block.
  let blocked: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolCallId: "t-next",
      toolName: "glob",
      input: { pattern: "*.md" },
    }, ctx);
    if (result?.block) blocked = result;
  }
  assert.equal(blocked, undefined, "verified gate must not be deferred/blocking");
  assert.equal(getPendingGate(dir), null);
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(snapshot.verifiedDepthMilestones.includes("M007"), "verification must survive the defer window");
});

test("seam: tool_execution_start re-arm window keeps the child verification", async (t) => {
  const dir = makeTempDir("no-clobber-exec-start");
  t.after(() => cleanup(dir));

  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    writer: "child",
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "mcp__gsd-workflow__ask_user_questions",
      args: { questions: [{ id: GATE }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "post-hoc replay must not re-arm a verified gate");
  assert.ok(loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M007"));
});

// ── (b) concurrent writes re-merge instead of overwriting ───────────────────

test("seam: host persist re-merges a concurrent child write (unconditional read-merge-write)", (t) => {
  const dir = makeTempDir("concurrent-write");
  t.after(() => cleanup(dir));

  // Host persists its own verification.
  markDepthVerified("M001", dir);

  // Child lands a different verification on disk while the host is idle.
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M002"],
    writer: "child",
  });

  // Host persists again — every mutation re-reads the disk snapshot and
  // union-merges before writing, so the child's verification survives.
  markDepthVerified("M003", dir);
  const merged = loadWriteGateSnapshot(dir);
  assert.deepEqual(merged.verifiedDepthMilestones, ["M001", "M002", "M003"]);
  assert.equal(readDiskRaw(dir).writer, "host");
});

test("seam: missing snapshot resets stale in-memory pending gate before mutation", (t) => {
  const dir = makeTempDir("missing-snapshot-reset");
  t.after(() => cleanup(dir));

  assert.equal(setPendingGate(GATE, dir), true);
  rmSync(snapshotPath(dir), { force: true });

  markDepthVerified("M008", dir);

  const snapshot = loadWriteGateSnapshot(dir);
  assert.equal(snapshot.pendingGateId, null);
  assert.deepEqual(snapshot.verifiedDepthMilestones, ["M008"]);
  assert.equal(readDiskRaw(dir).pendingGateId, null);
});

test("seam: childWriteGateAdapter is write-through and stamps writer provenance", (t) => {
  const dir = makeTempDir("child-write-through");
  t.after(() => cleanup(dir));

  foreignProcessWrites(dir, { verifiedDepthMilestones: ["M001"], writer: "host" });
  childWriteGateAdapter.markDepthVerified("M002", dir);

  const disk = readDiskRaw(dir);
  assert.deepEqual(disk.verifiedDepthMilestones, ["M001", "M002"], "fresh disk read, then mutate");
  assert.equal(disk.writer, "child");
});

// ── (c) per-basePath deferred gates ──────────────────────────────────────────

test("seam: two basePaths defer gates in one process and both activate", async (t) => {
  const dirA = makeTempDir("defer-a");
  const dirB = makeTempDir("defer-b");
  t.after(() => {
    cleanup(dirA);
    cleanup(dirB);
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const gateA = "depth_verification_M010_confirm";
  const gateB = "depth_verification_M020_confirm";
  const ctxA = { cwd: dirA, ui: { notify: () => undefined } } as any;
  const ctxB = { cwd: dirB, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "a-1", toolName: "ask_user_questions", input: { questions: [{ id: gateA }] } }, ctxA);
  }
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "b-1", toolName: "ask_user_questions", input: { questions: [{ id: gateB }] } }, ctxB);
  }

  // With the old single global slot, project A's deferral was lost the moment
  // project B deferred. Both must still block follow-up tools.
  for (const [ctx, label] of [[ctxA, "A"], [ctxB, "B"]] as const) {
    let blocked: any;
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({ toolCallId: `chk-${label}`, toolName: "glob", input: { pattern: "*" } }, ctx);
      if (result?.block) blocked = result;
    }
    assert.equal(blocked?.block, true, `project ${label} deferred gate must still block`);
    assert.match(blocked?.reason ?? "", /Approval question/);
  }

  // Activation happens via tool_execution_start in each project independently.
  for (const [ctx, gate, dir] of [[ctxA, gateA, dirA], [ctxB, gateB, dirB]] as const) {
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolCallId: "act", toolName: "ask_user_questions", args: { questions: [{ id: gate }] } }, ctx);
    }
    assert.equal(getPendingGate(dir), gate, `gate must arm durably for ${dir}`);
  }
});

// ── (d) backward compatibility: legacy snapshot fields ──────────────────────

test("seam: old snapshot with a retired epoch field loads and sheds it on write", (t) => {
  const dir = makeTempDir("legacy-snapshot");
  t.after(() => cleanup(dir));

  writeFileSync(
    (mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true }), snapshotPath(dir)),
    JSON.stringify({
      verifiedDepthMilestones: ["M001"],
      verifiedApprovalGates: ["depth_verification_M001_confirm"],
      activeQueuePhase: false,
      pendingGateId: null,
      // Written by an older build that still stamped the write-only epoch.
      epoch: 7,
    }),
    "utf-8",
  );

  const loaded = loadWriteGateSnapshot(dir);
  assert.deepEqual(loaded.verifiedDepthMilestones, ["M001"]);
  assert.equal("epoch" in loaded, false, "retired epoch field is not surfaced");

  const refreshed = refreshWriteGateStateFromDisk(dir);
  assert.ok(refreshed.verifiedDepthMilestones.includes("M001"));

  markDepthVerified("M002", dir);
  const upgraded = readDiskRaw(dir);
  assert.deepEqual(upgraded.verifiedDepthMilestones, ["M001", "M002"]);
  assert.equal("epoch" in upgraded, false, "retired epoch field is dropped on rewrite");
  assert.equal(upgraded.writer, "host");
});

// ── (e) corrupt snapshot is treated as a reset (matches "delete the file") ──

test("seam: corrupt snapshot file resets host state instead of persisting stale pendingGateId", (t) => {
  const dir = makeTempDir("corrupt-snapshot");
  t.after(() => cleanup(dir));

  // Host arms a gate; stale pendingGateId now lives in memory and on disk.
  assert.equal(setPendingGate(GATE, dir), true);
  assert.equal(getPendingGate(dir), GATE);

  // The snapshot file is corrupted out-of-band (e.g. partial write from a
  // crashed editor, foreign tool, or filesystem fault).
  writeFileSync(snapshotPath(dir), "{ not json", "utf-8");

  // refreshWriteGateStateFromDisk must treat the unreadable file the same
  // as a missing file: full reset, including dropping the stale pending id.
  const refreshed = refreshWriteGateStateFromDisk(dir);
  assert.equal(refreshed.pendingGateId, null, "stale pendingGateId must not survive a corrupt snapshot");
  assert.deepEqual(refreshed.verifiedDepthMilestones, []);
  assert.deepEqual(refreshed.verifiedApprovalGates, []);
  assert.equal(getPendingGate(dir), null);

  // A subsequent mutation must not write the stale gate back to disk.
  markDepthVerified("M042", dir);
  const persisted = readDiskRaw(dir);
  assert.equal(persisted.pendingGateId, null, "next persist must not re-stamp the stale pending id");
  assert.deepEqual(persisted.verifiedDepthMilestones, ["M042"]);
});

test("seam: mutateWriteGateState reset path drops stale pendingGateId on a corrupt snapshot", (t) => {
  const dir = makeTempDir("corrupt-snapshot-mutate");
  t.after(() => cleanup(dir));

  // Host arms a gate first.
  assert.equal(setPendingGate(GATE, dir), true);

  // Corrupt the snapshot directly (skipping the refresh path so we exercise
  // the reconcile-on-mutate branch in mutateWriteGateState).
  writeFileSync(snapshotPath(dir), "}}}", "utf-8");

  // markDepthVerified runs through mutateWriteGateState; the reconcile pass
  // must reset the in-memory state when the disk read returns null, even
  // though the file still exists on disk.
  markDepthVerified("M099", dir);

  const persisted = readDiskRaw(dir);
  assert.equal(persisted.pendingGateId, null, "stale pending id must not be persisted after a corrupt-snapshot reconcile");
  assert.deepEqual(persisted.verifiedDepthMilestones, ["M099"]);
});

// ── (f) cross-process lock closes the read-merge-write lost-update window ────

test("seam: read-merge-write holds the write-gate lock across the whole critical section", (t) => {
  const dir = makeTempDir("lock-held");
  t.after(() => {
    _setWriteGateInterleaveHookForTest(null);
    cleanup(dir);
  });

  // Fire inside the host's critical section, standing in for the OTHER process
  // attempting to enter its own read-merge-write. The lock must lock it out.
  let peerAcquiredMidSection: boolean | null = null;
  _setWriteGateInterleaveHookForTest((lockRoot) => {
    const res = acquireSyncLock(lockRoot, 0, WRITE_GATE_LOCK_NAME);
    peerAcquiredMidSection = res.acquired;
    if (res.acquired) releaseSyncLock(lockRoot, WRITE_GATE_LOCK_NAME);
  });

  markDepthVerified("M001", dir);

  assert.equal(
    peerAcquiredMidSection,
    false,
    "a concurrent process must be locked out of the read-merge-write section — this is what prevents the lost-update",
  );
  // The lock is released after the mutation, and the mutation still took effect.
  assert.ok(loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M001"));
  assert.equal(acquireSyncLock(dir, 0, WRITE_GATE_LOCK_NAME).acquired, true, "lock released after mutation");
  releaseSyncLock(dir, WRITE_GATE_LOCK_NAME);
});

test("seam: gate mutation fails OPEN when a live peer holds the lock (never blocks/refuses)", (t) => {
  const dir = makeTempDir("lock-fail-open");
  t.after(() => cleanup(dir));

  // A live peer holds the lock (its own PID → never stolen as stale).
  assert.equal(acquireSyncLock(dir, 0, WRITE_GATE_LOCK_NAME).acquired, true);
  try {
    // Host arms a gate while contended: fail-open means it proceeds anyway.
    const armed = setPendingGate(GATE, dir);
    assert.equal(armed, true, "arm must succeed (fail-open) even though the lock is held");
    assert.equal(getPendingGate(dir), GATE);
    assert.equal(readDiskRaw(dir).pendingGateId, GATE, "fail-open still persists the mutation");
  } finally {
    releaseSyncLock(dir, WRITE_GATE_LOCK_NAME);
  }
});
