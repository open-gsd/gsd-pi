/**
 * clear-stale-autostart.test.ts — #3667
 *
 * Pending auto-start entries carry a createdAt timestamp so later /gsd
 * invocations can distinguish an in-flight discussion from a stale one.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  _getPendingAutoStart,
  clearPendingAutoStart,
  setPendingAutoStart,
} from "../guided-flow.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function pendingInput(basePath: string, milestoneId: string) {
  return {
    basePath,
    milestoneId,
    ctx: { ui: { notify: () => undefined } } as any,
    pi: { sendMessage: () => undefined } as any,
  };
}

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

  test("guided-flow clears stale pending entry when discuss already completed", () => {
    const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
    assert.ok(
      source.includes('const milestoneHasRoadmap = !!resolveMilestoneFile(basePath, entry.milestoneId, "ROADMAP");'),
      "pending auto-start gate must check ROADMAP presence for completed discuss sessions",
    );
    assert.ok(
      source.includes('milestoneRow.status !== "queued"'),
      "pending auto-start gate must require non-queued DB milestone status before clearing",
    );
    assert.ok(
      source.includes("if (discussPlanComplete)"),
      "pending auto-start gate must clear stale map entries for completed discussions",
    );
  });

  test("guided-flow recovers a finished-but-unconsumed discussion instead of dead-ending", () => {
    // CONTEXT exists + no live turn means the discussion completed but the
    // agent_end handoff never consumed the entry (e.g. an external-engine
    // post-hoc gate re-arm wiped the depth verification after the save).
    // Without recovery, every /gsd prints "Discussion already in progress"
    // forever: the stale heuristic requires CONTEXT to be absent and
    // discussPlanComplete requires a ROADMAP that planning never produced.
    const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
    assert.ok(
      source.includes("milestoneHasContext && !isAgentTurnInFlight(ctx)"),
      "pending-entry guard must have a recovery branch for CONTEXT-present, no-turn-in-flight entries",
    );
    assert.ok(
      source.includes("extractDepthVerificationMilestoneId(pendingGateId) === entry.milestoneId"),
      "recovery must only clear a pending gate belonging to the entry's own milestone",
    );
    assert.ok(
      source.includes("if (checkAutoStartAfterDiscuss(basePath)) return;"),
      "recovery must re-run the discuss→auto handoff after clearing the stale gate",
    );
  });

  test("guided-flow does not treat a live discuss turn as a stale pending entry", () => {
    const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
    assert.ok(
      source.includes("!isAgentTurnInFlight(ctx)"),
      "stale-entry deletion must be gated on no agent turn being in flight — a dispatched " +
      "discuss turn can think for over 30s before writing its first artifact, and deleting " +
      "its entry re-dispatches the workflow (duplicate interview + duplicate completion message)",
    );
    assert.ok(
      source.includes('const milestoneHasDraft = !!resolveMilestoneFile(basePath, entry.milestoneId, "CONTEXT-DRAFT");'),
      "stale-entry check must treat an existing CONTEXT-DRAFT as proof of an in-progress interview",
    );
    assert.ok(
      source.includes("!milestoneHasDraft"),
      "stale-entry deletion must require the CONTEXT-DRAFT to be absent",
    );
    assert.ok(
      source.includes("ctx.hasPendingMessages"),
      "in-flight detection must also cover dispatched-but-not-yet-started queued messages",
    );
  });
});
