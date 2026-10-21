import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import type { GSDState } from "../types.ts";

function makeTestBase(t: TestContext, prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Structured Questions", status: "active" });
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function makeState(phase: GSDState["phase"]): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Structured Questions" },
    activeSlice: null,
    activeTask: null,
    phase,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

function makeContext(
  basePath: string,
  phase: GSDState["phase"],
  structuredQuestionsAvailable: "true" | "false",
): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Structured Questions",
    state: makeState(phase),
    prefs: undefined,
    structuredQuestionsAvailable,
  };
}

function setGsdHeadless(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.GSD_HEADLESS;
  process.env.GSD_HEADLESS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.GSD_HEADLESS;
    else process.env.GSD_HEADLESS = previous;
  });
}

function unsetGsdHeadless(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.GSD_HEADLESS;
  delete process.env.GSD_HEADLESS;
  t.after(() => {
    if (previous === undefined) delete process.env.GSD_HEADLESS;
    else process.env.GSD_HEADLESS = previous;
  });
}

test("auto-dispatch passes structuredQuestionsAvailable=true into discuss-milestone prompt", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-structured-");

  unsetGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "needs-discussion", "true"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, true);
  assert.match(
    result.prompt,
    /\*\*Structured questions available: true\*\*/,
  );
});

test("auto-dispatch preserves structuredQuestionsAvailable=false for discuss-milestone prompt", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-plain-");

  unsetGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "pre-planning", "false"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, true);
  assert.match(
    result.prompt,
    /\*\*Structured questions available: false\*\*/,
  );
});

test("auto-dispatch uses discuss-headless prompt when GSD_HEADLESS is set", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-headless-");

  setGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "pre-planning", "true"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, false);
  assert.match(result.prompt, /This is a \*\*headless\*\* flow/);
  assert.doesNotMatch(result.prompt, /\*\*Structured questions available: true\*\*/);
});

test("auto-dispatch uses discuss-headless prompt for needs-discussion when GSD_HEADLESS is set", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-headless-");

  setGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "needs-discussion", "true"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, false);
  assert.match(result.prompt, /This is a \*\*headless\*\* flow/);
  assert.doesNotMatch(result.prompt, /\*\*Structured questions available: true\*\*/);
});

test("auto-dispatch pauses after execution-entry discuss-milestone recovery", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-executing-");

  unsetGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "executing", "true"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, true);
});

test("auto-dispatch uses discuss-headless prompt for executing when GSD_HEADLESS is set", async (t) => {
  const tmp = makeTestBase(t, "gsd-discuss-milestone-headless-");

  setGsdHeadless(t);

  const result = await resolveDispatch(makeContext(tmp, "executing", "true"));

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "discuss-milestone");
  assert.equal(result.pauseAfterDispatch, false);
  assert.match(result.prompt, /This is a \*\*headless\*\* flow/);
  assert.doesNotMatch(result.prompt, /\*\*Structured questions available: true\*\*/);
});
