// gsd-pi + Regression tests for checkAutoStartAfterDiscuss handoff copy (R3b)
//
// Missing-row repair may accept a handoff whose CONTEXT artifact row is in the
// database, but "Milestone X ready." is reserved for executable plans with
// persisted slices. A CONTEXT.md file alone never writes the database.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkAutoStartAfterDiscuss,
  setPendingAutoStart,
  clearPendingAutoStart,
  _getPendingAutoStart,
} from "../guided-flow.ts";
import { drainLogs } from "../workflow-logger.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  getMilestone,
} from "../gsd-db.ts";
import {
  clearDiscussionFlowState,
  clearPendingGate,
} from "../bootstrap/write-gate.ts";
import { getMilestoneScopedArtifacts } from "../db/queries.ts";
import { saveContextArtifact } from "./helpers/saved-context.ts";

interface MockCapture {
  notifies: Array<{ msg: string; level: string }>;
  messages: Array<{ payload: any; options: any }>;
}

function mkCapture(): MockCapture {
  return { notifies: [], messages: [] };
}

function mkCtx(cap: MockCapture): any {
  return {
    ui: {
      notify: (msg: string, level: string) => {
        cap.notifies.push({ msg, level });
      },
    },
  };
}

function mkPi(cap: MockCapture): any {
  return {
    sendMessage: (payload: any, options: any) => {
      cap.messages.push({ payload, options });
    },
    setActiveTools: () => undefined,
    getActiveTools: () => [],
  };
}

function mkBase(): string {
  // realpathSync to normalize the macOS /var → /private/var symlink so the
  // basePath we pass matches what the workspace projectRoot resolves to.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-ready-guard-")));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Ready Guard Test\n\nContext.\n",
  );
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# State\n\nactive: M001\n",
  );
  return base;
}

describe("checkAutoStartAfterDiscuss ready-notify DB guard (R3b)", () => {
  let base: string;
  let cap: MockCapture;

  beforeEach(() => {
    closeDatabase();
    clearPendingAutoStart();
    drainLogs();
  });

  afterEach(() => {
    closeDatabase();
    clearPendingAutoStart();
    if (base) {
      try { clearDiscussionFlowState(base); } catch { /* */ }
      try { clearPendingGate(base); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("repairs a missing milestone row when a saved CONTEXT artifact row exists", () => {
    base = mkBase();
    openDatabase(":memory:");
    saveContextArtifact("M001");

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, true, "missing row with pinned context should repair and accept handoff");

    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /ready\.?$/i.test(n.msg),
    );
    assert.equal(successReady, undefined, "must not announce 'ready' when DB row missing");

    const recovered = getMilestone("M001");
    assert.ok(recovered, "R3b recovery must insert a placeholder 'queued' DB row");
    assert.equal(recovered!.status, "queued", "placeholder row must have status 'queued'");

    assert.equal(
      cap.notifies.some(n => n.level === "warning"),
      false,
      "successful missing-row repair must not warn the user",
    );
    assert.deepEqual(cap.notifies, [
      {
        msg: "Milestone M001 context captured. Continuing the planning pipeline.",
        level: "success",
      },
    ]);
  });

  test("fails closed and keeps pending handoff when DB is unavailable", () => {
    base = mkBase();
    closeDatabase();

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false, "DB-unavailable handoff must fail closed");
    assert.equal(
      _getPendingAutoStart(base)?.milestoneId,
      "M001",
      "failed closed handoff must remain pending for a later retry",
    );
    assert.equal(
      cap.notifies.some(n => n.level === "success"),
      false,
      "must not notify success before the milestone row is verified",
    );
  });

  test("announces 'ready' when DB row has executable slices", () => {
    base = mkBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Ready Guard Test", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Executable Slice",
      status: "pending",
    });

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, true, "must return true on the happy path");

    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /Milestone\s+M001\s+ready/i.test(n.msg),
    );
    assert.ok(successReady, "must announce 'Milestone M001 ready.' on success");
  });

  test("refuses a CONTEXT.md that was not saved to the database and writes no artifact row (#2107)", () => {
    base = mkBase();
    openDatabase(":memory:");
    // The milestone row exists; the context was written to disk only.
    insertMilestone({ id: "M001", title: "Ready Guard Test", status: "needs-discussion" });

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    assert.equal(checkAutoStartAfterDiscuss(), false, "a file with no artifact row is not a handoff");
    assert.deepEqual(getMilestoneScopedArtifacts("M001"), [], "the file is not registered in the database");
    assert.equal(_getPendingAutoStart(base)?.milestoneId, "M001", "the handoff stays pending");
    assert.equal(cap.notifies.length, 1);
    assert.equal(cap.notifies[0]!.level, "error");
    assert.match(cap.notifies[0]!.msg, /CONTEXT\.md is on disk but not in the database.*gsd_summary_save/);
  });

  test("a CONTEXT.md on disk never creates the milestone row", () => {
    base = mkBase();
    openDatabase(":memory:");

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    assert.equal(checkAutoStartAfterDiscuss(), false);
    assert.equal(getMilestone("M001"), null, "no placeholder row from a file");
    assert.equal(cap.notifies.some(n => n.level === "success"), false);
    assert.equal(cap.notifies.some(n => n.level === "error" && /no DB row exists/.test(n.msg)), true);
  });
});
