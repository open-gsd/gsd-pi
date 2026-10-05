// Project/App: gsd-pi
// File Purpose: The discuss-to-auto handoff is a database row and its readiness gate reads rows, not DISCUSSION-MANIFEST.json.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { invalidateAllCaches } from "../cache.ts";
import { readDiscussionHandoffRow, writeDiscussionHandoffRow } from "../db/writers/runtime-control.ts";
import { _getAdapter, closeDatabase, insertArtifact, openDatabase } from "../gsd-db.ts";
import {
  _getPendingAutoStart,
  checkAutoStartAfterDiscuss,
  clearPendingAutoStart,
  setPendingAutoStart,
  showSmartEntry,
} from "../guided-flow.ts";
import { registerMilestones } from "../milestone-registration.ts";
import { restorePendingAutoStart } from "../pending-auto-start.ts";
import { executeCheckpointSave } from "../tools/workflow-tool-executors.ts";
import { saveContextArtifact } from "./helpers/saved-context.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function makeProject(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-handoff-rows-"));
  t.after(() => {
    clearPendingAutoStart();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  clearPendingAutoStart();
  return base;
}

function session(sessionId: string, notifications: string[] = []) {
  return {
    ctx: {
      ui: { notify: (message: string) => { notifications.push(message); } },
      sessionManager: { getSessionId: () => sessionId },
    } as any,
    pi: { setActiveTools: () => undefined, getActiveTools: () => [] } as any,
  };
}

test("a DISCUSSION-MANIFEST.json file with open gates does not block the discuss handoff", (t) => {
  const base = makeProject(t);
  writeFileSync(
    join(base, ".gsd", "DISCUSSION-MANIFEST.json"),
    JSON.stringify({ primary: "M001", milestones: {}, total: 3, gates_completed: 1 }),
  );
  saveContextArtifact("M001");
  setPendingAutoStart(base, { basePath: base, milestoneId: "M001", startAuto: false, ...session("s1") });

  assert.equal(checkAutoStartAfterDiscuss(base), true);
});

test("the handoff waits until every milestone that the discussion registered has a readiness decision row", async (t) => {
  const base = makeProject(t);
  // A milestone from before this discussion, queued with no context, is not a gate.
  registerMilestones([{ id: "M009", title: "Old queued milestone" }], "test");
  _getAdapter()!.prepare("UPDATE milestones SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'M009'").run();

  const notifications: string[] = [];
  setPendingAutoStart(base, { basePath: base, milestoneId: "M001", startAuto: false, ...session("s1", notifications) });
  registerMilestones(
    [{ id: "M001", title: "Primary" }, { id: "M002", title: "Drafted" }, { id: "M003", title: "Queued" }],
    "test",
  );
  saveContextArtifact("M001");

  assert.equal(checkAutoStartAfterDiscuss(base), false);
  assert.match(notifications.at(-1) ?? "", /readiness decision is recorded for M002, M003/);

  insertArtifact({
    path: "milestones/M002/M002-CONTEXT-DRAFT.md",
    artifact_type: "CONTEXT-DRAFT",
    milestone_id: "M002",
    slice_id: null,
    task_id: null,
    full_content: "# M002 draft\n",
  });
  assert.equal(checkAutoStartAfterDiscuss(base), false);
  assert.match(notifications.at(-1) ?? "", /readiness decision is recorded for M003:/);

  const queued = await executeCheckpointSave({
    milestoneId: "M003",
    kind: "handoff",
    confirmedContext: "Queued without discussion at the readiness gate.",
    nextAction: "Discuss M003 from scratch before planning.",
  }, base);
  assert.equal(queued.isError, undefined, JSON.stringify(queued.content));

  assert.equal(checkAutoStartAfterDiscuss(base), true);
});

test("the pending handoff is a row that a later process of the same conversation restores and finishes", (t) => {
  const base = makeProject(t);
  setPendingAutoStart(base, {
    basePath: base,
    milestoneId: "M001",
    step: false,
    startAuto: false,
    createdAt: 1_700_000_000_000,
    ...session("s1"),
  });

  const row = readDiscussionHandoffRow(base);
  assert.deepEqual({ ...row }, {
    base_path: base,
    milestone_id: "M001",
    step: 0,
    start_auto: 0,
    session_id: "s1",
    created_at: 1_700_000_000_000,
  });

  // A new process: the row is in the database and no entry is bound to live handles.
  clearPendingAutoStart();
  writeDiscussionHandoffRow(row!);
  saveContextArtifact("M001");
  assert.equal(checkAutoStartAfterDiscuss(base), false);

  const notifications: string[] = [];
  const next = session("s1", notifications);
  assert.equal(restorePendingAutoStart(base, next.ctx, next.pi), true);
  const restored = _getPendingAutoStart(base);
  assert.equal(restored?.milestoneId, "M001");
  assert.equal(restored?.step, false);
  assert.equal(restored?.startAuto, false);
  assert.equal(restored?.createdAt, 1_700_000_000_000);

  assert.equal(checkAutoStartAfterDiscuss(base), true);
  assert.deepEqual(notifications, ["Milestone M001 context captured. Continuing the planning pipeline."]);
  assert.equal(readDiscussionHandoffRow(base), null);
});

test("a handoff row of another conversation is deleted, not restored", (t) => {
  const base = makeProject(t);
  writeDiscussionHandoffRow({
    base_path: base,
    milestone_id: "M001",
    step: 1,
    start_auto: null,
    session_id: "s1",
    created_at: 1_700_000_000_000,
  });

  const other = session("s2");
  assert.equal(restorePendingAutoStart(base, other.ctx, other.pi), false);
  assert.equal(_getPendingAutoStart(base), null);
  assert.equal(readDiscussionHandoffRow(base), null);
});

test("/gsd in a later process of the same conversation finishes the saved handoff", async (t) => {
  const base = realpathSync(makeTempRepo("gsd-handoff-restore-"));
  t.after(() => {
    clearPendingAutoStart();
    closeDatabase();
    invalidateAllCaches();
    cleanup(base);
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  clearPendingAutoStart();
  registerMilestones([{ id: "M001", title: "Primary" }], "test");
  saveContextArtifact("M001");
  invalidateAllCaches();
  writeDiscussionHandoffRow({
    base_path: base,
    milestone_id: "M001",
    step: 1,
    start_auto: 0,
    session_id: "s1",
    created_at: Date.now(),
  });

  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      custom: async () => undefined,
      select: async () => undefined,
    },
  } as any;
  const pi = {
    sendMessage: () => {
      throw new Error("/gsd must not dispatch a prompt: the handoff is ready");
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any;

  await showSmartEntry(ctx, pi, base);

  assert.ok(
    notifications.includes("Milestone M001 context captured. Continuing the planning pipeline."),
    notifications.join("\n"),
  );
  assert.equal(readDiscussionHandoffRow(base), null);
  assert.equal(_getPendingAutoStart(base), null);
});
