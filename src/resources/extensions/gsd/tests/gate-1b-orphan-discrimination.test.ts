/**
 * gsd-pi / guided-flow — regression tests for Gate 1b discussion handoff
 *
 * Gate 1b treats queued + pinned CONTEXT.md as Discussion Complete, Planning
 * Pending. It must accept the handoff without warning the user or injecting a
 * hidden gsd_plan_milestone retry.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkAutoStartAfterDiscuss,
  _getPendingAutoStart,
  setPendingAutoStart,
  clearPendingAutoStart,
} from "../guided-flow.ts";
import { drainLogs } from "../workflow-logger.ts";
import {
  openDatabase,
  closeDatabase,
  getMilestone,
  insertMilestone,
} from "../gsd-db.ts";

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
  const base = mkdtempSync(join(tmpdir(), "gsd-gate1b-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function mkFlatBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-gate1b-flat-"));
  mkdirSync(join(base, ".gsd", "phases", "01-m001"), { recursive: true });
  return base;
}

function writeContext(base: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext written by discuss phase.\n",
  );
}

function writeFlatContext(base: string): void {
  writeFileSync(
    join(base, ".gsd", "phases", "01-m001", "01-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext written by discuss phase.\n",
  );
}

describe("Gate 1b discussion handoff in checkAutoStartAfterDiscuss", () => {
  let base: string;
  let cap: MockCapture;

  beforeEach(() => {
    clearPendingAutoStart();
    drainLogs();
  });

  afterEach(() => {
    closeDatabase();
    clearPendingAutoStart();
    if (base) {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("queued row + CONTEXT.md accepts context-captured handoff without hidden retry", () => {
    base = mkBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "queued" });
    writeContext(base);

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();

    assert.equal(result, true, "queued + context is a valid planning-pending handoff");
    assert.equal(cap.messages.length, 0, "must not inject a hidden recovery turn");
    assert.equal(cap.notifies.length, 1, "must emit one success notification");
    assert.deepEqual(cap.notifies[0], {
      msg: "Milestone M001 context captured. Continuing the planning pipeline.",
      level: "success",
    });
    assert.equal(
      cap.notifies.some(n => /queued|gsd_plan_milestone/i.test(n.msg)),
      false,
      "user-visible copy must not mention queued state or internal plan tool retry",
    );
  });

  test("queued row without CONTEXT.md still waits silently for discussion output", () => {
    base = mkBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "queued" });

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    drainLogs();

    const result = checkAutoStartAfterDiscuss();

    assert.equal(result, false, "must keep waiting while discuss has not written context");
    assert.equal(cap.messages.length, 0, "no hidden recovery turn expected");
    assert.equal(cap.notifies.length, 0, "no user notifications expected");

    const logs = drainLogs();
    const gate1bLog = logs.find(
      (e) => e.component === "guided" && /Gate 1b/.test(e.message),
    );
    assert.equal(gate1bLog, undefined, "Gate 1b must not log when CONTEXT.md is absent");
  });

  test("flat-phase CONTEXT.md accepts handoff without a legacy milestone context file", () => {
    base = mkFlatBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "queued" });
    writeFlatContext(base);

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();

    assert.equal(result, true, "flat-phase context must be found by the handoff");
    assert.equal(cap.messages.length, 0, "startAuto=false must suppress scheduling");
    assert.deepEqual(cap.notifies[0], {
      msg: "Milestone M001 context captured. Continuing the planning pipeline.",
      level: "success",
    });
  });

  test("DB-unavailable recovery blocks handoff instead of reporting success", () => {
    base = mkFlatBase();
    writeFlatContext(base);

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();

    assert.equal(result, false, "handoff must fail closed when the DB row cannot be confirmed");
    assert.equal(cap.messages.length, 0, "must not schedule auto-start when DB is unavailable");
    assert.equal(
      cap.notifies.some(n => n.level === "success"),
      false,
      "must not report a successful handoff when DB recovery was skipped",
    );
    assert.ok(_getPendingAutoStart(base), "pending handoff should remain for a later recovery attempt");
  });

  test("missing DB row with CONTEXT.md inserts a queued row and accepts handoff", () => {
    base = mkFlatBase();
    openDatabase(":memory:");
    writeFlatContext(base);

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      startAuto: false,
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();

    assert.equal(result, true, "successful insert should recover the missing row");
    assert.equal(getMilestone("M001")?.status, "queued");
    assert.deepEqual(cap.notifies[0], {
      msg: "Milestone M001 context captured. Continuing the planning pipeline.",
      level: "success",
    });
  });
});
