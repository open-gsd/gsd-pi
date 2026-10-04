/**
 * clear-stale-autostart.test.ts — #3667
 *
 * Pending auto-start entries carry a createdAt timestamp so later /gsd
 * invocations can distinguish an in-flight discussion from a stale one.
 */

import { describe, test, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { clearDiscussionFlowState, getPendingGate, setPendingGate } from "../bootstrap/write-gate.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import {
  _getPendingAutoStart,
  clearPendingAutoStart,
  setPendingAutoStart,
  showSmartEntry,
} from "../guided-flow.ts";
import { saveContextArtifact } from "./helpers/saved-context.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function pendingInput(basePath: string, milestoneId: string) {
  return {
    basePath,
    milestoneId,
    ctx: { ui: { notify: () => undefined } } as any,
    pi: { sendMessage: () => undefined } as any,
  };
}

/** A project whose only milestone is parked, so /gsd finds no active milestone. */
function openParkedMilestoneProject(t: TestContext): string {
  const base = realpathSync(makeTempRepo("gsd-pending-autostart-rows-"));
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    cleanup(base);
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Parked milestone", status: "parked" });
  invalidateAllCaches();
  return base;
}

/** An interactive session where every menu is left unanswered. */
function makeCtx(opts: { idle?: boolean } = {}) {
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      custom: async () => undefined,
      select: async () => undefined,
    },
  } as any;
  return { ctx, notifications };
}

const pi = {
  sendMessage: () => {
    throw new Error("/gsd must not dispatch a prompt in these tests");
  },
  getActiveTools: () => [],
  setActiveTools: () => {},
} as any;

afterEach(() => {
  clearPendingAutoStart();
});

describe("clear stale pending auto-start (#3667)", () => {
  test("setPendingAutoStart defaults createdAt to Date.now()", (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pending-autostart-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const before = Date.now();

    setPendingAutoStart(base, pendingInput(base, "M001"));

    const entry = _getPendingAutoStart(base);
    assert.ok(entry);
    assert.equal(typeof entry!.createdAt, "number");
    assert.ok(entry!.createdAt >= before);
  });

  test("setPendingAutoStart preserves explicit createdAt for stale-entry checks", (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pending-autostart-old-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"), { recursive: true });

    setPendingAutoStart(base, { ...pendingInput(base, "M001"), createdAt: 123 });

    assert.equal(_getPendingAutoStart(base)?.createdAt, 123);
  });

  test("a planned milestone clears the pending entry; a ROADMAP file with no slice rows does not", async (t) => {
    const base = openParkedMilestoneProject(t);
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001\n\n## Slices\n- [ ] **S01: First slice** `risk:low` `depends:[]`\n",
    );
    const { ctx, notifications } = makeCtx();
    setPendingAutoStart(base, pendingInput(base, "M001"));

    await showSmartEntry(ctx, pi, base);
    assert.ok(_getPendingAutoStart(base), "the ROADMAP file does not prove the plan");
    assert.match(notifications.join("\n"), /Discussion already in progress/);

    insertSlice({ id: "S01", milestoneId: "M001", title: "First slice" });
    await showSmartEntry(ctx, pi, base);
    assert.equal(_getPendingAutoStart(base), null, "slice rows prove the plan");
  });

  test("a saved draft keeps an old pending entry; a CONTEXT-DRAFT file with no row does not", async (t) => {
    const base = openParkedMilestoneProject(t);
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT-DRAFT.md"), "# Draft\n");
    const { ctx, notifications } = makeCtx();

    insertArtifact({
      path: "milestones/M001/M001-CONTEXT-DRAFT.md",
      artifact_type: "CONTEXT-DRAFT",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "# Draft\n",
    });
    setPendingAutoStart(base, { ...pendingInput(base, "M001"), createdAt: 123 });
    await showSmartEntry(ctx, pi, base);
    assert.ok(_getPendingAutoStart(base), "a saved draft is an interview in progress");
    assert.match(notifications.join("\n"), /Discussion already in progress/);

    _getAdapter()!.prepare("DELETE FROM artifacts").run();
    await showSmartEntry(ctx, pi, base);
    assert.equal(_getPendingAutoStart(base), null, "the draft file alone leaves the entry stale");
  });

  test("a live agent turn keeps an old pending entry that has no saved rows", async (t) => {
    const base = openParkedMilestoneProject(t);
    const { ctx, notifications } = makeCtx({ idle: false });
    setPendingAutoStart(base, { ...pendingInput(base, "M001"), createdAt: 123 });

    await showSmartEntry(ctx, pi, base);

    assert.ok(_getPendingAutoStart(base));
    assert.match(notifications.join("\n"), /Discussion already in progress/);
  });

  test("a CONTEXT file with no saved row leaves an old pending entry stale", async (t) => {
    const base = openParkedMilestoneProject(t);
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n");
    const { ctx, notifications } = makeCtx();
    setPendingAutoStart(base, { ...pendingInput(base, "M001"), createdAt: 123 });

    await showSmartEntry(ctx, pi, base);

    assert.equal(_getPendingAutoStart(base), null, "the CONTEXT file does not prove a finished discussion");
    assert.doesNotMatch(notifications.join("\n"), /Discussion already in progress/);
  });

  test("a saved CONTEXT row recovers a finished-but-unconsumed discussion instead of dead-ending", async (t) => {
    // The discussion saved CONTEXT but the agent_end handoff never consumed the
    // entry (e.g. an external-engine post-hoc gate re-arm wiped the depth
    // verification after the save). Without recovery, every /gsd prints
    // "Discussion already in progress" forever.
    const base = openParkedMilestoneProject(t);
    t.after(() => clearDiscussionFlowState(base));
    saveContextArtifact("M001");
    setPendingGate("depth_verification_M001_confirm", base);
    const { ctx, notifications } = makeCtx();
    const handoff = makeCtx();
    setPendingAutoStart(base, {
      ...pendingInput(base, "M001"),
      ctx: handoff.ctx,
      createdAt: 123,
      startAuto: false,
    });

    await showSmartEntry(ctx, pi, base);

    assert.equal(getPendingGate(base), null, "the stale depth gate of this milestone is cleared");
    assert.match(handoff.notifications.join("\n"), /Milestone M001 context captured/);
    assert.equal(_getPendingAutoStart(base), null, "the handoff consumed the entry");
    assert.doesNotMatch(notifications.join("\n"), /Discussion already in progress/);
  });

  test("recovery leaves a pending depth gate of another milestone armed", async (t) => {
    const base = openParkedMilestoneProject(t);
    t.after(() => clearDiscussionFlowState(base));
    saveContextArtifact("M001");
    setPendingGate("depth_verification_M999_confirm", base);
    const { ctx } = makeCtx();
    const handoff = makeCtx();
    setPendingAutoStart(base, {
      ...pendingInput(base, "M001"),
      ctx: handoff.ctx,
      createdAt: 123,
      startAuto: false,
    });

    await showSmartEntry(ctx, pi, base);

    assert.match(handoff.notifications.join("\n"), /Milestone M001 context captured/);
    assert.equal(getPendingGate(base), "depth_verification_M999_confirm");
  });

});
