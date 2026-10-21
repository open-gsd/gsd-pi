// Project/App: gsd-pi
// File Purpose: ADR-017 contract tests for drift-driven State Reconciliation.
// Covers sketch-flag (#5700), merge-state (#5701), stale-render (#5702),
// stale-worker (#5703), unregistered-milestone (#5704), roadmap-divergence
// (#5705), and missing-completion-timestamp (#5706) drift end-to-end, plus
// the repair-throw and persistent-drift error paths and Recovery
// Classification mapping for ReconciliationFailedError.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestone,
  getSlice,
  getSliceTasks,
  setSliceSummaryMd,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import { clearParseCache } from "../files.ts";
import { clearPathCache } from "../paths.ts";
import { detectStaleRenders, getCurrentProjectStateVersion, renderRoadmapFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";
import {
  reconcileBeforeDispatch,
  reconcileBeforeSpawn,
  ReconciliationFailedError,
  type DriftHandler,
  type DriftRecord,
  type ReconciliationDeps,
} from "../state-reconciliation.ts";
import { classifyFailure } from "../recovery-classification.ts";
import { handlerPhaseIndex, RECONCILIATION_REPAIR_PHASES } from "../state-reconciliation/registry.ts";
import { staleRenderHandler } from "../state-reconciliation/drift/stale-render.ts";
import { roadmapMissingHandler } from "../state-reconciliation/drift/roadmap.ts";
import type { GSDState } from "../types.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
    ...overrides,
  };
}

// Safety net: close the DB between every test so a failure in one test doesn't
// leak an open connection that blocks the next test's openDatabase call.
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
});

function makeFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-drift-"));
  // Flat-phase layout: phases/NN-slug/
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    /* noop */
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

test("ADR-017 (#5700): sketch-flag drift detected and repaired end-to-end", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited",
  });

  // Simulate the post-crash scenario: a *real* PLAN.md (a decomposed task)
  // exists on disk but the is_sketch flag is still 1.
  writeFileSync(
    join(base, ".gsd", "phases", "01-test", "01-02-PLAN.md"),
    makeStalePlanContent("S02", [{ id: "T01", title: "Build the feature", done: false }]),
  );
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "pre: flagged as sketch");

  const state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => state,
  });

  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "post: flag cleared");
  // #1634: the fixture never renders ROADMAP.md, so the roadmap-missing
  // handler also repairs on this pass — scope the assertion to the kind under
  // test.
  const sketchRepairs = result.repaired.filter((d) => d.kind === "stale-sketch-flag");
  assert.equal(sketchRepairs.length, 1);
  if (sketchRepairs[0]?.kind === "stale-sketch-flag") {
    assert.equal(sketchRepairs[0].mid, "M001");
    assert.equal(sketchRepairs[0].sid, "S02");
  }
});

test("#1287: stub/placeholder PLAN does NOT clear the sketch flag", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited",
  });

  const planPath = join(base, ".gsd", "phases", "01-test", "01-02-PLAN.md");

  // A bare stub PLAN (no decomposed tasks) must not clear the flag.
  writeFileSync(planPath, "# S02 Plan\n");
  clearRendererCaches();
  let state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  let result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => state,
  });
  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "stub PLAN: flag stays set");
  assert.equal(result.repaired.filter((d) => d.kind === "stale-sketch-flag").length, 0, "stub PLAN: no repair");

  // A projection round-trip stub whose only task is a synthetic "Plan NN"
  // placeholder (migrate/transformer.buildTaskTitle) must also not clear it.
  writeFileSync(
    planPath,
    makeStalePlanContent("S02", [{ id: "T01", title: "Plan 01", done: false }]),
  );
  clearRendererCaches();
  state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => state,
  });
  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "placeholder task: flag stays set");
  assert.equal(result.repaired.filter((d) => d.kind === "stale-sketch-flag").length, 0, "placeholder task: no repair");

  // buildTaskTitle also emits `${phase} ${plan}` (e.g. "00 01") when the plan
  // frontmatter carries phase/plan. This projected placeholder must not clear
  // the flag either.
  writeFileSync(
    planPath,
    makeStalePlanContent("S02", [{ id: "T01", title: "00 01", done: false }]),
  );
  clearRendererCaches();
  state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => state,
  });
  assert.equal(result.ok, true);
  assert.equal(
    getSlice("M001", "S02")?.is_sketch,
    1,
    "phase/plan placeholder task: flag stays set",
  );
  assert.equal(result.repaired.filter((d) => d.kind === "stale-sketch-flag").length, 0, "phase/plan placeholder task: no repair");
});

test("T013: a state-version-stamped stub PLAN still does NOT clear the sketch flag", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited",
  });

  // The sketch judgment is about PLAN *content*, not projection freshness, so
  // a stub carrying a current state-version stamp must still be parsed and
  // rejected — the stamp only proves it was rendered from this DB state.
  const version = getCurrentProjectStateVersion();
  writeFileSync(
    join(base, ".gsd", "phases", "01-test", "01-02-PLAN.md"),
    `${makeStalePlanContent("S02", [{ id: "T01", title: "Plan 01", done: false }])}` +
      `<!-- gsd:state-version=${version.revision}:${version.authorityEpoch} -->\n`,
  );
  clearRendererCaches();

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    getSlice("M001", "S02")?.is_sketch,
    1,
    "stamped stub PLAN: flag stays set (no stamp short-circuit)",
  );
  assert.equal(result.repaired.filter((d) => d.kind === "stale-sketch-flag").length, 0, "stamped stub PLAN: no repair");
});

test("#1288: real tasks shaped like `word + number` still clear the sketch flag", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited",
  });

  const planPath = join(base, ".gsd", "phases", "01-test", "01-02-PLAN.md");

  // `Step 1` / `RFC 1234` match the loose `word + number` shape but are genuine
  // decomposed tasks. buildTaskTitle only emits `${phase} ${plan}` with a
  // digit-led phase, so these must NOT be read as placeholders (#1288): a real
  // plan-slice like this must still clear the stale is_sketch flag.
  writeFileSync(
    planPath,
    makeStalePlanContent("S02", [
      { id: "T01", title: "Step 1", done: false },
      { id: "T02", title: "RFC 1234", done: false },
    ]),
  );
  clearRendererCaches();
  const state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => state,
  });
  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "real task titles: flag cleared");
  assert.equal(result.repaired.filter((d) => d.kind === "stale-sketch-flag").length, 1, "real task titles: repaired once");
});

test("ADR-017 (#5700): repair failure throws ReconciliationFailedError with shape", async () => {
  const seenDrift: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [seenDrift],
    repair: () => {
      throw new Error("simulated repair failure");
    },
  };

  await assert.rejects(
    () =>
      reconcileBeforeDispatch("/project", {
        invalidateStateCache: () => {},
        deriveState: async () => makeState(),
        registry: [handler],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ReconciliationFailedError, "must be ReconciliationFailedError");
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0]?.drift.kind, "stale-sketch-flag");
      assert.ok(err.failures[0]?.cause instanceof Error);
      assert.equal((err.failures[0]?.cause as Error).message, "simulated repair failure");
      assert.equal(err.pass, 0);
      assert.equal(err.persistentDrift.length, 0);
      return true;
    },
  );
});

test("ADR-017 (#5700): custom registry handlers outside built-in phases are repaired", async () => {
  const drift = { kind: "custom-drift", id: "D001" } as unknown as DriftRecord;
  let repaired = false;
  const handler = {
    kind: "custom-drift",
    detect: () => (repaired ? [] : [drift]),
    repair: () => {
      repaired = true;
    },
  } as unknown as DriftHandler;

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [handler],
  });

  assert.equal(result.ok, true);
  assert.equal(repaired, true);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0]?.kind, "custom-drift");
});

test("ADR-017 (#5700): a detector failure degrades to a blocker without aborting other handlers", async () => {
  // A single detector throwing (e.g. a transient file read error) must NOT
  // abort the whole cycle and hide every later handler's drift. It is collected
  // as a blocker (so dispatch is still gated) while the remaining detectors run
  // and their drift is repaired — graceful degradation, not fail-fast.
  const throwingHandler: DriftHandler = {
    kind: "stale-render",
    detect: () => {
      throw new Error("simulated detect failure");
    },
    repair: () => {
      /* never reached: detect throws */
    },
  };

  let repairCount = 0;
  const workingHandler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () =>
      repairCount === 0
        ? [{ kind: "stale-sketch-flag", mid: "M001", sid: "S02" }]
        : [],
    repair: () => {
      repairCount++;
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [throwingHandler, workingHandler],
  });

  assert.equal(result.ok, true, "cycle must not abort on a single detector failure");
  // The working handler (registered AFTER the thrower) still detected + repaired.
  assert.equal(repairCount, 1, "later handler must still run despite earlier detect failure");
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0]?.kind, "stale-sketch-flag");
  // The detector failure surfaces as a blocker so dispatch is still gated.
  assert.ok(
    result.blockers.some(
      (b) => b.includes("stale-render") && b.includes("simulated detect failure"),
    ),
    "detect failure must surface as a blocker",
  );
});

test("ADR-017 (#5700): persistent drift after cap=2 throws ReconciliationFailedError", async () => {
  // Detect always returns one drift; repair is a no-op (drift never goes away).
  const persistent: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [persistent],
    repair: () => {
      /* no-op: drift cannot be cleared */
    },
  };

  await assert.rejects(
    () =>
      reconcileBeforeDispatch("/project", {
        invalidateStateCache: () => {},
        deriveState: async () => makeState(),
        registry: [handler],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ReconciliationFailedError);
      assert.equal(err.failures.length, 0);
      assert.equal(err.persistentDrift.length, 1);
      assert.equal(err.persistentDrift[0]?.kind, "stale-sketch-flag");
      return true;
    },
  );
});

test("ADR-017 (#5700): classifyFailure recognizes ReconciliationFailedError", () => {
  const err = new ReconciliationFailedError({
    failures: [
      {
        drift: { kind: "stale-sketch-flag", mid: "M001", sid: "S02" },
        cause: new Error("boom"),
      },
    ],
    pass: 0,
  });

  const result = classifyFailure({ error: err });

  assert.equal(result.failureKind, "reconciliation-drift");
  assert.equal(result.action, "escalate");
  assert.equal(result.exitReason, "reconciliation-drift");
  assert.match(result.remediation, /persistent or repair-failed drift kinds/);
});

test("ADR-017: terminal drift blockers return blockers instead of repair exceptions", async () => {
  const record: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [record],
    blocker: () => "manual drift review required",
    repair: () => {
      throw new Error("repair should not run for terminal blockers");
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [handler],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, ["manual drift review required"]);
  assert.equal(result.repaired.length, 0);
});

test("ADR-017: terminal blockers return a state snapshot refreshed after co-occurring repairs", async () => {
  const repairDrift: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const terminalDrift: DriftRecord = {
    kind: "completed-milestone-reopened",
    milestoneId: "M001",
    dbStatus: "active",
  };
  let repaired = false;
  const repairHandler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: (state) => (state.nextAction === "before repair" ? [repairDrift] : []),
    repair: () => {
      repaired = true;
    },
  };
  const terminalHandler: DriftHandler = {
    kind: "completed-milestone-reopened",
    detect: (state) => (state.nextAction === "before repair" ? [terminalDrift] : []),
    blocker: () => "manual completed-milestone review required",
    repair: () => {
      throw new Error("repair should not run for terminal blockers");
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () =>
      makeState({ nextAction: repaired ? "after repair" : "before repair" }),
    registry: [repairHandler, terminalHandler],
  });

  assert.equal(result.ok, true);
  assert.equal(result.stateSnapshot.nextAction, "after repair");
  assert.equal(result.repaired.length, 1);
  assert.deepEqual(result.blockers, ["manual completed-milestone review required"]);
});

test("ADR-017: terminal drift blockers take precedence over co-occurring repair failures", async () => {
  const terminalDrift: DriftRecord = {
    kind: "completed-milestone-reopened",
    milestoneId: "M001",
    dbStatus: "active",
  };
  const repairDrift: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const terminalHandler: DriftHandler = {
    kind: "completed-milestone-reopened",
    detect: () => [terminalDrift],
    blocker: () => "manual completed-milestone review required",
    repair: () => {
      throw new Error("repair should not run for terminal blockers");
    },
  };
  const repairHandler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [repairDrift],
    repair: () => {
      throw new Error("simulated repair failure");
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [repairHandler, terminalHandler],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, ["manual completed-milestone review required"]);
});

test("ADR-017: terminal drift found after repair cap returns blockers", async () => {
  const repairDrift: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const terminalDrift: DriftRecord = {
    kind: "completed-milestone-reopened",
    milestoneId: "M001",
    dbStatus: "active",
  };
  let repairCount = 0;
  const repairHandler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => (repairCount < 2 ? [repairDrift] : []),
    repair: () => {
      repairCount++;
    },
  };
  const terminalHandler: DriftHandler = {
    kind: "completed-milestone-reopened",
    detect: () => (repairCount >= 2 ? [terminalDrift] : []),
    blocker: () => "manual completed-milestone review required",
    repair: () => {
      throw new Error("repair should not run for terminal blockers");
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [repairHandler, terminalHandler],
  });

  assert.equal(result.ok, true);
  assert.equal(result.repaired.length, 2);
  assert.deepEqual(result.blockers, ["manual completed-milestone review required"]);
});

test("ADR-017: final persistent drift mixed with blockers still fails closed", async () => {
  const repairDrift: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const terminalDrift: DriftRecord = {
    kind: "completed-milestone-reopened",
    milestoneId: "M001",
    dbStatus: "active",
  };
  let repairCount = 0;
  const repairHandler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [repairDrift],
    repair: () => {
      repairCount++;
    },
  };
  const terminalHandler: DriftHandler = {
    kind: "completed-milestone-reopened",
    detect: () => (repairCount >= 2 ? [terminalDrift] : []),
    blocker: () => "manual completed-milestone review required",
    repair: () => {
      throw new Error("repair should not run for terminal blockers");
    },
  };

  await assert.rejects(
    () =>
      reconcileBeforeDispatch("/project", {
        invalidateStateCache: () => {},
        deriveState: async () => makeState(),
        registry: [repairHandler, terminalHandler],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ReconciliationFailedError);
      assert.deepEqual(err.persistentDrift.map((d) => d.kind).sort(), [
        "completed-milestone-reopened",
        "stale-sketch-flag",
      ]);
      return true;
    },
  );
});

// ─── #5701: merge-state drift ────────────────────────────────────────────────

function makeGitBase(): string {
  const base = join(tmpdir(), `gsd-adr017-merge-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}

function rmTreeQuiet(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function resolveGitPathForTest(base: string, gitPath: string): string {
  const resolvedPath = execFileSync("git", ["rev-parse", "--git-path", gitPath], {
    cwd: base,
    encoding: "utf-8",
  }).trim();
  return isAbsolute(resolvedPath) ? resolvedPath : resolve(base, resolvedPath);
}

test("ADR-017 (#5701): merge-state drift detected and repaired end-to-end", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));

  // Build a clean fast-forward-resolvable merge: feature branch with one file,
  // then start merge --no-commit on main so MERGE_HEAD exists with no conflicts.
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "feature.txt"), "feature content");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add feature"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "feature"], { cwd: base, stdio: "ignore" });

  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")), "pre: MERGE_HEAD exists");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    existsSync(join(base, ".git", "MERGE_HEAD")),
    false,
    "post: MERGE_HEAD cleared after reconciliation",
  );
  const mergeRepaired = result.repaired.find((d) => d.kind === "unmerged-merge-state");
  assert.ok(mergeRepaired, "repaired list should include the merge-state drift record");
  if (mergeRepaired?.kind === "unmerged-merge-state") {
    assert.equal(mergeRepaired.basePath, base);
  }
});

test("ADR-017 (#5701): merge-state drift is detected in linked worktrees", async (t) => {
  const base = makeGitBase();
  const worktree = join(tmpdir(), `gsd-adr017-worktree-${randomUUID()}`);
  t.after(() => {
    rmTreeQuiet(worktree);
    rmTreeQuiet(base);
  });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "feature.txt"), "feature content");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add feature"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "-b", "wt-main", worktree, "main"], {
    cwd: base,
    stdio: "ignore",
  });
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "feature"], {
    cwd: worktree,
    stdio: "ignore",
  });

  const mergeHeadPath = execFileSync("git", ["rev-parse", "--git-path", "MERGE_HEAD"], {
    cwd: worktree,
    encoding: "utf-8",
  }).trim();
  assert.ok(existsSync(mergeHeadPath), "pre: MERGE_HEAD exists in resolved worktree gitdir");
  assert.equal(existsSync(join(worktree, ".git", "MERGE_HEAD")), false);

  const result = await reconcileBeforeDispatch(worktree, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(mergeHeadPath), false, "post: MERGE_HEAD cleared after reconciliation");
  assert.ok(
    result.repaired.some((d) => d.kind === "unmerged-merge-state"),
    "repaired list should include the worktree merge-state drift record",
  );
});

test("ADR-017 (#5701): stale clean squash marker is removed without a no-op commit", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));

  const squashMsgPath = resolveGitPathForTest(base, "SQUASH_MSG");
  const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: base,
    encoding: "utf-8",
  }).trim();

  writeFileSync(squashMsgPath, "stale squash message\n");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf-8" }).trim(),
    "",
    "pre: stale squash marker must not imply worktree/index changes",
  );

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(squashMsgPath), false, "post: stale SQUASH_MSG is cleared");
  assert.ok(
    result.repaired.some((d) => d.kind === "unmerged-merge-state"),
    "repaired list should include the stale squash marker drift",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf-8" }).trim(),
    beforeHead,
    "reconciliation must not create a no-op commit for stale marker-only state",
  );
});

test("ADR-017 (#5701): stale squash marker is removed after restored local changes", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));

  const squashMsgPath = resolveGitPathForTest(base, "SQUASH_MSG");
  const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: base,
    encoding: "utf-8",
  }).trim();

  writeFileSync(join(base, "local-notes.txt"), "restored local work\n");
  writeFileSync(squashMsgPath, "stale squash message\n");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(squashMsgPath), false, "post: stale SQUASH_MSG is cleared");
  assert.equal(
    readFileSync(join(base, "local-notes.txt"), "utf-8"),
    "restored local work\n",
    "reconciliation must preserve restored local work",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf-8" }).trim(),
    beforeHead,
    "reconciliation must not commit restored local work",
  );
});

test("ADR-017 (#5701): no merge state → detector returns no drift", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "unmerged-merge-state"),
    false,
    "no merge drift should be reported when the repo is clean",
  );
});

// ─── #5702: stale-render drift ───────────────────────────────────────────────

function clearRendererCaches(): void {
  clearParseCache();
  clearPathCache();
  invalidateStateCache();
}

function makeStalePlanContent(sliceId: string, tasks: Array<{ id: string; title: string; done: boolean }>): string {
  const lines: string[] = [];
  lines.push(`# ${sliceId}: Test Slice`);
  lines.push("");
  lines.push("**Goal:** Test slice goal");
  lines.push("**Demo:** Test demo");
  lines.push("");
  lines.push("## Must-Haves");
  lines.push("");
  lines.push("- Everything works");
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const t of tasks) {
    const checkbox = t.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${t.id}: ${t.title}** \`est:1h\``);
  }
  lines.push("");
  return lines.join("\n");
}

function makeStaleRoadmapContent(slices: Array<{ id: string; title: string; done: boolean }>): string {
  const lines: string[] = [];
  lines.push("# M001 Roadmap");
  lines.push("");
  lines.push("**Vision:** Test milestone");
  lines.push("");
  lines.push("## Slices");
  lines.push("");
  for (const s of slices) {
    const checkbox = s.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  }
  lines.push("");
  return lines.join("\n");
}

test("ADR-017 (#5702): stale-render drift detected and repaired end-to-end", async (t) => {
  t.skip("TODO(flat-phase): stale-render detection temporarily disabled during layout transition"); return;
  const base = "";
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });

  // Plan with both tasks unchecked — DB says done, file disagrees.
  const planPath = join(sliceDir, "01-01-PLAN.md");
  writeFileSync(planPath, makeStalePlanContent("S01", [
    { id: "T01", title: "First task", done: false },
    { id: "T02", title: "Second task", done: false },
  ]));
  clearRendererCaches();

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  const renderRepaired = result.repaired.find((d) => d.kind === "stale-render");
  assert.ok(renderRepaired, "repaired list should include the stale-render drift");

  const repairedContent = readFileSync(planPath, "utf-8");
  // Flat-phase format: **T01**: Title (colon after bold, not inside)
  assert.match(repairedContent, /\[x\][^\n]*\*\*T01\*\*/, "T01 checkbox should be checked after repair");
  assert.match(repairedContent, /\[x\][^\n]*\*\*T02\*\*/, "T02 checkbox should be checked after repair");
});

test("#1003: stale-render plan repair reopens DB before rendering", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-render-reopen-"));
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });

  const planPath = join(sliceDir, "01-01-PLAN.md");
  writeFileSync(planPath, makeStalePlanContent("S01", [
    { id: "T01", title: "First task", done: false },
  ]));
  closeDatabase();

  await staleRenderHandler.repair(
    {
      kind: "stale-render",
      renderPath: planPath,
      reason: "T01 is done in DB but unchecked in plan",
    },
    { basePath: base, state: makeState() },
  );

  const repairedContent = readFileSync(planPath, "utf-8");
  assert.match(repairedContent, /\[x\][^\n]*\*\*T01\*\*/, "T01 checkbox should be checked after DB reopen repair");
  assert.equal(getSliceTasks("M001", "S01").length, 1, "DB should be reopened on the original project database");
});

test("#1003: stale-render plan repair switches back from an open wrong DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-render-wrong-db-"));
  const wrongBase = mkdtempSync(join(tmpdir(), "gsd-stale-render-other-db-"));
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  mkdirSync(join(wrongBase, ".gsd"), { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
    rmTreeQuiet(wrongBase);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });

  const planPath = join(sliceDir, "01-01-PLAN.md");
  writeFileSync(planPath, makeStalePlanContent("S01", [
    { id: "T01", title: "First task", done: false },
  ]));
  closeDatabase();

  openDatabase(join(wrongBase, ".gsd", "gsd.db"));

  await staleRenderHandler.repair(
    {
      kind: "stale-render",
      renderPath: planPath,
      reason: "T01 is done in DB but unchecked in plan",
    },
    { basePath: base, state: makeState() },
  );

  const repairedContent = readFileSync(planPath, "utf-8");
  assert.match(repairedContent, /\[x\][^\n]*\*\*T01\*\*/, "T01 checkbox should be checked after switching back to the project DB");
  assert.equal(getSliceTasks("M001", "S01").length, 1, "repair should leave the project DB active");
});

test("#1034: validation-blocked milestone summary drift returns blocker instead of exhausting repair passes", async () => {
  const drift: Extract<DriftRecord, { kind: "stale-render" }> = {
    kind: "stale-render",
    renderPath: "/repo/.gsd/milestones/M001/M001-SUMMARY.md",
    reason: "M001 is complete with summary in DB but SUMMARY.md missing on disk",
  };
  let repairCalled = false;
  const handler: DriftHandler<Extract<DriftRecord, { kind: "stale-render" }>> = {
    kind: "stale-render",
    detect: () => [drift],
    blocker: staleRenderHandler.blocker!,
    repair: () => {
      repairCalled = true;
    },
  };

  const validationBlocker = [
    "Milestone M001 is blocked because milestone validation returned needs-attention.",
    "Fix options:",
    "1. Review the validation details: `/gsd status`",
  ].join("\n");

  const result = await reconcileBeforeDispatch("/repo", {
    invalidateStateCache: () => {},
    deriveState: async () =>
      makeState({
        phase: "blocked",
        blockers: [validationBlocker],
        nextAction: "Resolve M001 validation attention before proceeding.",
      }),
    registry: [handler],
  });

  assert.equal(result.ok, true);
  assert.equal(repairCalled, false, "validation-blocked milestone summary drift should not attempt repair");
  assert.ok(
    result.blockers.some((blocker) => blocker.includes("milestone validation returned needs-attention")),
    "validation blocker should be returned to the caller",
  );
  assert.ok(
    result.blockers.some((blocker) => blocker.includes("Stale milestone summary render")),
    "stale-render blocker should explain why repair did not run",
  );
});

test("ADR-017 (#5702): stale-render detector reason strings match repair contract", (t) => {
  t.skip("TODO(flat-phase): stale-render detection temporarily disabled during layout transition"); return;
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-render-reasons-"));
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "First task",
    status: "done",
    fullSummaryMd: "# T01 Summary\n",
  });
  setSliceSummaryMd("M001", "S01", "# S01 Summary\n", "# S01 UAT\n");

  writeFileSync(
    join(base, ".gsd", "phases", "01-test", "01-ROADMAP.md"),
    makeStaleRoadmapContent([{ id: "S01", title: "Slice", done: false }]),
  );
  writeFileSync(
    join(sliceDir, "01-01-PLAN.md"),
    makeStalePlanContent("S01", [{ id: "T01", title: "First task", done: false }]),
  );
  clearRendererCaches();

  const reasons = detectStaleRenders(base).map((entry) => entry.reason).sort();

  assert.deepEqual(reasons, [
    "S01 is closed in DB but unchecked in roadmap",
    "S01 is complete with UAT in DB but UAT.md missing on disk",
    "S01 is complete with summary in DB but SUMMARY.md missing on disk",
    "T01 is complete with summary in DB but SUMMARY.md missing on disk",
    "T01 is done in DB but unchecked in plan",
  ].sort());
});

test("ADR-017 (#5702): missing UAT.md clears stale full_uat_md from DB", { skip: true }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-clear-uat-"));
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
  setSliceSummaryMd("M001", "S01", "# S01 Summary\n", "# S01 UAT\nLegacy planning text\n");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(result.ok, true);

  const updated = getSlice("M001", "S01");
  assert.equal(updated?.full_uat_md ?? "", "", "full_uat_md should be cleared after UAT deletion");
  assert.equal(
    existsSync(join(sliceDir, "01-01-UAT.md")),
    false,
    "UAT.md should not be recreated while clearing stale UAT content",
  );
});

test("ADR-017 (#5702): stale-render plan repair works with descriptor-layout milestone dir", async (t) => {
  t.skip("TODO(flat-phase): stale-render detection temporarily disabled during layout transition"); return;
  // Regression for bugbot finding: repairStaleRenderFromBasePath was passing the
  // raw dir segment (e.g. M001-DESCRIPTOR) straight to renderPlanCheckboxes, which
  // queries the DB as getSliceTasks("M001-DESCRIPTOR", …) → empty → throws.
  // After the fix it calls canonicalizeMilestoneId() first.
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-descriptor-"));
  // Flat-phase descriptor-style: 01-DESCRIPTOR → DB milestone M001
  const milestoneDir = "01-DESCRIPTOR";
  const sliceDir = join(base, ".gsd", "phases", milestoneDir);
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmTreeQuiet(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  // DB uses the canonical ID (M001), directory uses the descriptor name.
  insertMilestone({ id: "M001", title: "Descriptor Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task One", status: "done" });

  const planPath = join(sliceDir, "01-01-PLAN.md");
  writeFileSync(planPath, makeStalePlanContent("S01", [
    { id: "T01", title: "Task One", done: false },
  ]));
  clearRendererCaches();

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true, "reconcile should succeed with descriptor-layout milestone dir");
  const renderRepaired = result.repaired.find((d) => d.kind === "stale-render");
  assert.ok(renderRepaired, "stale-render drift should be repaired");
  const repairedContent = readFileSync(planPath, "utf-8");
  assert.match(repairedContent, /\[x\][^\n]*\*\*T01\*\*/, "T01 checkbox should be checked after repair");
});

// ─── #5703: stale-worker drift ───────────────────────────────────────────────

const DEAD_PID = 999_999_999; // far above any realistic system PID; process.kill(pid, 0) → ESRCH

function writeFakeSessionLock(base: string, pid: number): string {
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const lockFile = join(gsdDir, "auto.lock");
  // Mirror SessionLockData minimum shape
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      unitType: "starting",
      unitId: "bootstrap",
    }),
  );
  // Also create the proper-lockfile directory artifact at <gsdDir>.lock
  mkdirSync(`${gsdDir}.lock`, { recursive: true });
  return lockFile;
}

test("ADR-017 (#5703): stale-worker drift detected and orphaned lock cleared", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-worker-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const lockFile = writeFakeSessionLock(base, DEAD_PID);
  assert.ok(existsSync(lockFile), "pre: lock file written");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(lockFile), false, "post: orphaned lock file removed");
  const workerRepaired = result.repaired.find((d) => d.kind === "stale-worker");
  assert.ok(workerRepaired, "repaired list should include the stale-worker drift");
  if (workerRepaired?.kind === "stale-worker") {
    assert.equal(workerRepaired.pid, DEAD_PID);
  }
});

test("ADR-017 (#5703): live worker lock is not cleared", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-worker-live-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // PID 1 (init/launchd): process.kill(1, 0) returns EPERM as non-root, which
  // isPidAlive correctly treats as alive. process.pid would be rejected by the
  // self-PID guard in isPidAlive (treated as not alive).
  const ALIVE_PID = 1;
  const lockFile = writeFakeSessionLock(base, ALIVE_PID);
  assert.ok(existsSync(lockFile), "pre: lock file written");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    existsSync(lockFile),
    true,
    "live lock must NOT be cleared (would steal the lock from a running session)",
  );
  assert.equal(
    result.repaired.some((d) => d.kind === "stale-worker"),
    false,
    "no stale-worker drift should be reported when the lock owner is alive",
  );
});

// ─── #5704: unregistered-milestone drift ────────────────────────────────────

test("ADR-017 (#5704/#1281): unregistered-milestone drift pauses with a hint instead of hard-escalating", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-projmd-"));
  const milestoneDir = join(base, ".gsd", "phases", "42-test");
  mkdirSync(milestoneDir, { recursive: true });
  // Roadmap with one slice — meaningful content, will be picked up by importer
  writeFileSync(
    join(milestoneDir, "M042-ROADMAP.md"),
    [
      "# M042: Test Milestone",
      "",
      "**Vision:** Verify unregistered-milestone drift",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  // Pre-condition: filesystem has the milestone, DB does NOT.
  assert.equal(getMilestone("M042"), null, "pre: DB has no row for M042");

  // #1281: the handler exposes a `blocker`, so reconciliation returns a
  // non-fatal pause-with-hint (ok:true + blocker) rather than throwing.
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(result.ok, true);
  const blocker = result.blockers.find((b) => /M042/.test(b));
  assert.ok(blocker, "expected an M042 unregistered-milestone blocker");
  assert.match(blocker!, /markdown projection/);
  // Hint leads with targeted, non-destructive actions (rename/discard)...
  assert.match(blocker!, /Rename/);
  assert.match(blocker!, /Discard/);
  // ...and reframes recover as a destructive last resort, not the fix (#826).
  assert.match(blocker!, /\/gsd recover/);
  assert.match(blocker!, /last resort/i);
  // Runtime never imports markdown into the DB.
  assert.equal(getMilestone("M042"), null, "post: DB still has no row for M042");
});

test("#1281: descriptive flat-phase dir registered under a suffixed id → no false-positive drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-1281-suffix-"));
  // Descriptive slug the flat-phase extractor cannot recover the suffix from →
  // it derives the bare `M007`, which has no DB row.
  const milestoneDir = join(base, ".gsd", "phases", "07-v40fmq-m007-v40fmq-navigation-footer-system");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M007-v40fmq-ROADMAP.md"),
    [
      "# M007: Navigation Footer System",
      "",
      "**Vision:** Verify no false-positive unregistered-milestone drift",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  // The milestone IS registered — under the unique_milestone_ids suffixed id.
  insertMilestone({ id: "M007-v40fmq", title: "Navigation Footer System", status: "complete" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.blockers.some((b) => /unregistered/i.test(b) || /M007/.test(b)),
    false,
    "bare M007 derived from the slug must resolve to the registered M007-v40fmq row",
  );
});

test("ADR-017 (#5704): registered milestone (DB row present) → no drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-projmd-clean-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "01-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Already-registered milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Slice** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "unregistered-milestone"),
    false,
    "no drift should be reported when the milestone is already in the DB",
  );
});

// ─── #5705: roadmap-divergence drift ─────────────────────────────────────────

test("ADR-017 (#391): roadmap-divergence skips slices before task planning completes", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-unplanned-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  const originalRoadmap = [
    "# M001: Test",
    "",
    "**Vision:** Verify transient milestone planning state",
    "",
    "## Slices",
    "",
    "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
    "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
    "",
  ].join("\n");
  writeFileSync(roadmapPath, originalRoadmap);
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });

  assert.equal(getSliceTasks("M001", "S01").length, 0, "pre: S01 has not been planned");
  assert.equal(getSliceTasks("M001", "S02").length, 0, "pre: S02 has not been planned");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "unplanned slices should not trigger roadmap-divergence repair",
  );
  assert.equal(readFileSync(roadmapPath, "utf-8"), originalRoadmap);
  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "DB remains unchanged");
});

test("ADR-017 (#870): roadmap-divergence accepts recovered S00 blocker sequence", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-s00-"));
  const milestoneId = "M002-a1rwmq";
  // Flat-phase layout: startup migrates legacy milestones/ on contact, and
  // reconcileBeforeDispatch now settles a pending migration before detecting
  // drift — a legacy fixture would be converted mid-reconcile.
  const milestoneDir = join(base, ".gsd", "phases", "02-a1rwmq-support-command-policy-hardening");
  const roadmapPath = join(milestoneDir, "02-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  const originalRoadmap = [
    "# M002-a1rwmq: Support Command Policy Hardening",
    "",
    "**Vision:** Recover DB-backed planning state.",
    "",
    "## Slices",
    "",
    "- [x] **S00-blocker: Blocker placeholder - planning failed** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
    "- [ ] **S01: Source of truth contract** `risk:medium` `depends:[]`",
    "  > After this: S01 tasks are planned.",
    "",
    "- [ ] **S02: Policy implementation** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
    "- [ ] **S03: Verification coverage** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
    "- [ ] **S04: Documentation handoff** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
  ].join("\n");
  writeFileSync(roadmapPath, originalRoadmap);
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: milestoneId,
    title: "Support Command Policy Hardening",
    status: "active",
    planning: { vision: "Recover DB-backed planning state." },
  });
  insertSlice({ id: "S00-blocker", milestoneId, title: "Blocker placeholder - planning failed", status: "complete", risk: "medium", depends: [], demo: "", sequence: 0 });
  insertSlice({ id: "S01", milestoneId, title: "Source of truth contract", status: "pending", risk: "medium", depends: [], demo: "S01 tasks are planned.", sequence: 1 });
  insertSlice({ id: "S02", milestoneId, title: "Policy implementation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertSlice({ id: "S03", milestoneId, title: "Verification coverage", status: "pending", risk: "medium", depends: [], demo: "", sequence: 3 });
  insertSlice({ id: "S04", milestoneId, title: "Documentation handoff", status: "pending", risk: "medium", depends: [], demo: "", sequence: 4 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Map current support command policy inputs", status: "pending" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId, title: "Define shared policy surface shape", status: "pending" });
  insertTask({ id: "T03", sliceId: "S01", milestoneId, title: "Lock source of truth contract coverage", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: milestoneId, title: "Support Command Policy Hardening" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "matching recovered DB/ROADMAP state must not report persistent roadmap-divergence",
  );
  assert.equal(readFileSync(roadmapPath, "utf-8"), originalRoadmap);
});

test("ADR-017 (#1619): skipped slices are excluded from the divergence view", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-skipped-"));
  const milestoneId = "M017";
  // Flat-phase layout: startup migrates legacy milestones/ on contact, and
  // reconcileBeforeDispatch now settles a pending migration before detecting
  // drift — a legacy fixture would be converted mid-reconcile.
  const milestoneDir = join(base, ".gsd", "phases", "17-blocker-skipped-milestone");
  const roadmapPath = join(milestoneDir, "17-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  // The projection omits the skipped S00-blocker, so S01 renders first.
  const originalRoadmap = [
    `# ${milestoneId}: Blocker Skipped Milestone`,
    "",
    "**Vision:** Skipped blocker slice must not wedge reconciliation.",
    "",
    "## Slices",
    "",
    "- [ ] **S01: Source of truth contract** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
    "- [ ] **S02: Policy implementation** `risk:medium` `depends:[]`",
    "  > After this: ",
    "",
  ].join("\n");
  writeFileSync(roadmapPath, originalRoadmap);
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: milestoneId,
    title: "Blocker Skipped Milestone",
    status: "queued",
    planning: { vision: "Skipped blocker slice must not wedge reconciliation." },
  });
  insertSlice({ id: "S00-blocker", milestoneId, title: "Blocker placeholder", status: "skipped", risk: "medium", depends: [], demo: "", sequence: 0 });
  insertSlice({ id: "S01", milestoneId, title: "Source of truth contract", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId, title: "Policy implementation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  // S01 is planned, so it counts as "ready" — without excluding the skipped
  // S00-blocker its DB index (1) would never match its roadmap index (0).
  insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Map policy inputs", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: milestoneId, title: "Blocker Skipped Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "a skipped slice omitted by the renderer must not report roadmap-divergence",
  );
  assert.equal(readFileSync(roadmapPath, "utf-8"), originalRoadmap);
});

test("ADR-017 (#5705): roadmap-divergence re-renders projection without syncing depends into DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  // ROADMAP.md declares S02 depends on [S01]
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify roadmap-divergence drift",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  // Seed DB with S02 depending on []  — diverges from ROADMAP.md
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Plan S02", status: "pending" });

  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "pre: DB has S02.depends = []");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "post: DB depends remains authoritative");
  assert.match(
    readFileSync(roadmapPath, "utf-8"),
    /- \[ \] \*\*S02: Feature\*\* `risk:medium` `depends:\[\]`/,
    "post: ROADMAP projection is regenerated from DB depends",
  );
  const roadmapRepaired = result.repaired.find((d) => d.kind === "roadmap-divergence");
  assert.ok(roadmapRepaired, "repaired list should include the roadmap-divergence drift");
  if (roadmapRepaired?.kind === "roadmap-divergence") {
    assert.equal(roadmapRepaired.milestoneId, "M001");
  }
});

test("ADR-017 (#5705): ROADMAP-only slice is removed from projection and not inserted into DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-newslice-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  // ROADMAP.md declares S01 and S02; DB will only have S01.
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify new-slice insertion via roadmap-divergence repair",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  // Only insert S01 — S02 is intentionally absent from the DB.
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });

  assert.equal(getSlice("M001", "S02"), null, "pre: S02 has no DB row");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02"), null, "post: S02 still has no DB row");
  const rendered = readFileSync(roadmapPath, "utf-8");
  assert.match(rendered, /- \[ \] \*\*S01: Foundation\*\*/);
  assert.doesNotMatch(rendered, /S02: Feature/, "post: ROADMAP-only S02 removed from projection");
  const roadmapRepaired = result.repaired.find((d) => d.kind === "roadmap-divergence");
  assert.ok(roadmapRepaired, "repaired list should include the roadmap-divergence drift");
  if (roadmapRepaired?.kind === "roadmap-divergence") {
    assert.equal(roadmapRepaired.milestoneId, "M001");
  }
});

test("ADR-017 (#5705): ROADMAP sequence drift re-renders from DB order without mutating DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-sequence-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify sequence drift",
      "",
      "## Slices",
      "",
      "- [ ] **S02: Feature** `risk:medium` `depends:[]`",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Plan S02", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S01")?.sequence, 1, "post: S01 DB sequence remains authoritative");
  assert.equal(getSlice("M001", "S02")?.sequence, 2, "post: S02 DB sequence remains authoritative");
  const rendered = readFileSync(roadmapPath, "utf-8");
  assert.ok(
    rendered.indexOf("S01: Foundation") < rendered.indexOf("S02: Feature"),
    "post: ROADMAP projection follows DB sequence",
  );
  assert.ok(result.repaired.some((d) => d.kind === "roadmap-divergence"));
});

test("ADR-017 (#5705): ROADMAP checkbox drift re-renders from DB status without mutating DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-checkbox-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify checkbox drift",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S01")?.status, "pending", "post: DB status remains authoritative");
  assert.match(
    readFileSync(roadmapPath, "utf-8"),
    /- \[ \] \*\*S01: Foundation\*\*/,
    "post: ROADMAP checkbox reflects DB status",
  );
  assert.ok(result.repaired.some((d) => d.kind === "roadmap-divergence"));
});

test("ADR-017 (#5705): in-sync ROADMAP and DB → no roadmap-divergence drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-clean-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "01-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Already in sync",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
  );
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "no roadmap-divergence drift should be reported when DB matches markdown",
  );
});

// T031: the roadmap detector compares content on every call — a state-version
// stamp never short-circuits it, because a stale projection can carry the
// current stamp (slice writes don't bump `project_authority.revision`) and a
// hand-edited file keeps whatever stamp it was written with.
function writeStampedRoadmap(roadmapPath: string, stamp: string): void {
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify stamp short-circuit",
      "",
      "## Slices",
      "",
      // Diverges from the DB below (DB has S02.depends = []).
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      "",
      stamp,
      "",
    ].join("\n"),
  );
}

function seedStampFixtureDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Plan S02", status: "pending" });
}

test("T031: a roadmap stamped with the CURRENT state version still reports diverging content as drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-t031-roadmap-stamp-current-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  t.after(() => cleanup(base));

  // Write unstamped first so the DB (and its state version) exists before the
  // stamp is computed, then stamp the diverging fixture with the current
  // revision:epoch. A matching stamp must NOT suppress the comparison.
  writeStampedRoadmap(roadmapPath, "");
  seedStampFixtureDb(base);

  const version = getCurrentProjectStateVersion();
  writeStampedRoadmap(
    roadmapPath,
    `<!-- gsd:state-version=${version.revision}:${version.authorityEpoch} -->`,
  );
  clearRendererCaches();

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    "current stamp must not short-circuit the content comparison",
  );
  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "DB depends remains authoritative");
  assert.match(
    readFileSync(roadmapPath, "utf-8"),
    /- \[ \] \*\*S02: Feature\*\* `risk:medium` `depends:\[\]`/,
    "projection re-rendered from DB depends",
  );
});

test("T031: a stamped roadmap whose content diverges from the DB still reports drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-t031-roadmap-stamp-stale-"));
  const milestoneDir = join(base, ".gsd", "phases", "01-test");
  const roadmapPath = join(milestoneDir, "01-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  t.after(() => cleanup(base));

  writeStampedRoadmap(roadmapPath, "<!-- gsd:state-version=999:999 -->");
  seedStampFixtureDb(base);
  clearRendererCaches();

  assert.notDeepEqual(
    getCurrentProjectStateVersion(),
    { revision: 999, authorityEpoch: 999 },
    "fixture precondition: 999:999 must not be the current DB state version",
  );

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    "mismatched stamp must take the existing comparison path and report drift",
  );
  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "DB depends remains authoritative");
  assert.match(
    readFileSync(roadmapPath, "utf-8"),
    /- \[ \] \*\*S02: Feature\*\* `risk:medium` `depends:\[\]`/,
    "projection re-rendered from DB depends",
  );
});

test("ADR-017 (#1370): roadmap-divergence skips completed milestone sharing active worktree phase", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-shared-phase-"));
  const milestoneDir = join(base, ".gsd", "phases", "06-rlrbot-m006-rlrbot-tool-registry-and-command-sa");
  const roadmapPath = join(milestoneDir, "06-ROADMAP.md");
  mkdirSync(milestoneDir, { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M006"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M006-rlrbot"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M006", "M006-META.json"), "{}\n");
  writeFileSync(join(base, ".gsd", "milestones", "M006-rlrbot", "M006-rlrbot-META.json"), "{}\n");
  const activeRoadmap = [
    "# M006-rlrbot: Active worktree",
    "",
    "**Vision:** Keep the active worktree projection authoritative.",
    "",
    "## Slices",
    "",
    "- [ ] **S01: Shared slice** `risk:medium` `depends:[]`",
    "  > After this: Active work remains pending.",
    "",
  ].join("\n");
  writeFileSync(roadmapPath, activeRoadmap);
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M006", title: "Completed source", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M006", title: "Shared slice", status: "complete", risk: "medium", depends: [], demo: "Completed.", sequence: 1 });
  insertMilestone({
    id: "M006-rlrbot",
    title: "Active worktree",
    status: "active",
    planning: { vision: "Keep the active worktree projection authoritative." },
  });
  insertSlice({ id: "S01", milestoneId: "M006-rlrbot", title: "Shared slice", status: "pending", risk: "medium", depends: [], demo: "Active work remains pending.", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M006-rlrbot", title: "Plan active work", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M006-rlrbot", title: "Active worktree" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "completed milestone sharing the phase dir must not trigger roadmap-divergence repair",
  );
  assert.equal(readFileSync(roadmapPath, "utf-8"), activeRoadmap);
});

// ─── #5706: missing-completion-timestamp drift ──────────────────────────────

test("ADR-017 (#5706): task with SUMMARY but null completed_at → backfilled", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-completion-task-"));
  const tasksDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(tasksDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

  // Move T01 to complete WITHOUT setting completed_at (simulating drift after
  // an external recovery path or a partial state migration).
  updateTaskStatus("M001", "S01", "T01", "complete", undefined);
  // SUMMARY.md attests to completion on disk.
  const summaryPath = join(tasksDir, "T01-SUMMARY.md");
  writeFileSync(summaryPath, "# T01 Summary\n");
  const summaryMtimeMs = statSync(summaryPath).mtime.getTime();

  const taskBefore = getSliceTasks("M001", "S01").find((t) => t.id === "T01");
  assert.equal(taskBefore?.status, "complete");
  assert.equal(taskBefore?.completed_at, null, "pre: completed_at is null");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } }),
  });

  assert.equal(result.ok, true);
  const taskAfter = getSliceTasks("M001", "S01").find((t) => t.id === "T01");
  assert.ok(taskAfter?.completed_at, "post: completed_at populated");
  const completedAtMs = Date.parse(taskAfter?.completed_at ?? "");
  assert.ok(Number.isFinite(completedAtMs), "post: completed_at is parseable ISO string");
  assert.equal(completedAtMs, summaryMtimeMs, "post: completed_at derived from SUMMARY mtime");
  const drift = result.repaired.find((d) => d.kind === "missing-completion-timestamp");
  assert.ok(drift, "drift recorded");
  if (drift?.kind === "missing-completion-timestamp") {
    assert.equal(drift.entity, "task");
    assert.deepEqual(drift.ids, ["M001/S01/T01"]);
  }
});

test("ADR-017 (#5706): repair is idempotent — re-running preserves the timestamp", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-completion-idempotent-"));
  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  updateSliceStatus("M001", "S01", "complete", undefined);
  const summaryPath = join(sliceDir, "01-01-SUMMARY.md");
  writeFileSync(summaryPath, "# S01 Summary\n");
  const summaryMtimeMs = statSync(summaryPath).mtime.getTime();

  const firstResult = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } }),
  });
  assert.equal(firstResult.ok, true);
  const tsAfterFirst = getSlice("M001", "S01")?.completed_at;
  assert.ok(tsAfterFirst, "first pass: completed_at populated");
  const completedAtMs = Date.parse(tsAfterFirst ?? "");
  assert.ok(Number.isFinite(completedAtMs), "first pass: completed_at is parseable ISO string");
  assert.equal(completedAtMs, summaryMtimeMs, "first pass: completed_at derived from SUMMARY mtime");

  // Second pass — drift is already cleared, no record should appear, and
  // the existing timestamp is untouched.
  const secondResult = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } }),
  });
  assert.equal(secondResult.ok, true);
  assert.equal(
    secondResult.repaired.some((d) => d.kind === "missing-completion-timestamp"),
    false,
    "second pass: no drift detected after first repair",
  );
  assert.equal(getSlice("M001", "S01")?.completed_at, tsAfterFirst, "timestamp unchanged");
});

test("ADR-017: artifact/DB status divergence fails closed instead of importing completion artifacts", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-artifact-db-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  writeFileSync(
    join(base, ".gsd", "phases", "01-test", "01-01-SUMMARY.md"),
    "# S01 Summary\n\nAlready done on disk.\n",
  );

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
  assert.equal(getSlice("M001", "S01")?.status, "pending", "DB status remains authoritative");
});

test("ADR-017: meaningful disk-only slice drift blocker includes repair guidance", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-disk-slice-guidance-"));
  const diskOnlySliceDir = join(base, ".gsd", "phases", "01-test");
  t.after(() => cleanup(base));

  mkdirSync(diskOnlySliceDir, { recursive: true });
  writeFileSync(join(diskOnlySliceDir, "01-99-PLAN.md"), "# Disk-only plan\n\nWork to review.\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Known Slice", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  const message = result.blockers.join("\n");
  assert.match(message, /Slice ID drift in M001/);
  assert.match(message, /Review .*S99/);
  assert.match(message, /move or delete/);
  assert.match(message, /\.gsd\/quarantine\/milestones\/M001\/slices\/S99-manual-review/);
  assert.match(message, /copy or merge/);
  assert.match(message, /\/gsd doctor M001/);
  assert.match(message, /\/gsd next or \/gsd auto/);
});

test("ADR-017: orphan task completion artifact fails closed", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-task-artifact-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  insertArtifact({
    path: join(base, ".gsd", "phases", "01-test", "T99-SUMMARY.md"),
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T99",
    full_content: "# T99 Summary\n\nStale artifact after replan.\n",
  });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
});

test("ADR-017 (#414): an unproven failure-path summary remains a blocker", async (t) => {
  // When gsd_summary_save writes a SUMMARY artifact row for a task that never
  // called gsd_task_complete, the task stays pending and the artifact DB row
  // remains fail-closed without a canonical staged Attempt/Result.
  const base = mkdtempSync(join(tmpdir(), "gsd-failure-path-summary-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S04", milestoneId: "M001", title: "Task", status: "pending" });
  insertArtifact({
    path: join(base, ".gsd", "phases", "01-test", "T01-SUMMARY.md"),
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S04",
    task_id: "T01",
    full_content: "# T01 Failure Summary\n",
  });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.blockers.length > 0, "blocker must be produced for pending-task SUMMARY drift");
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
});

test("ADR-017 (#414): a summary artifact without DB tasks remains a blocker", async (t) => {
  // No task identity means the SUMMARY cannot be proven as a DB-backed staged projection.
  const base = mkdtempSync(join(tmpdir(), "gsd-no-db-tasks-summary-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Slice", status: "pending" });
  // No tasks inserted — slice has SUMMARY artifacts for a task that no longer exists.
  insertArtifact({
    path: join(base, ".gsd", "phases", "01-test", "T01-SUMMARY.md"),
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S04",
    task_id: "T01",
    full_content: "# T01 Failure Summary\n",
  });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.blockers.length > 0, "blocker must be produced for no-db-tasks SUMMARY drift");
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
});

test("ADR-017 (#414): a disk-only task summary remains a blocker", async (t) => {
  // When gsd_summary_save writes a SUMMARY file to disk for a task that never
  // called gsd_task_complete, but the artifact DB row was not yet written (or
  // the process crashed before insertion), no durable projection identity can
  // prove that the file is current.
  const base = mkdtempSync(join(tmpdir(), "gsd-task-disk-summary-drift-"));
  t.after(() => cleanup(base));

  const tasksDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Failure Summary\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S04", milestoneId: "M001", title: "Task", status: "pending" });
  // No artifact row inserted — SUMMARY exists only on disk.

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.blockers.length > 0, "blocker must be produced for on-disk task SUMMARY drift");
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
});

test("ADR-017 (#414): a disk-only slice summary remains a blocker", async (t) => {
  // When a SUMMARY file exists on disk for a slice that is still pending
  // (no gsd_task_complete for the slice), it remains unproven projection drift.
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-disk-summary-drift-"));
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "01-04-SUMMARY.md"), "# S04 Failure Summary\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Slice", status: "pending" });
  // No artifact row inserted — SUMMARY exists only on disk.

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.blockers.length > 0, "blocker must be produced for on-disk slice SUMMARY drift");
  assert.match(result.blockers.join("\n"), /Artifact\/DB status drift/);
});

test("completedMilestoneReopenedGuidance tells active milestones to finish closeout", async () => {
  const { completedMilestoneReopenedGuidance } = await import(
    "../state-reconciliation/drift/artifact-db.ts"
  );
  const guidance = completedMilestoneReopenedGuidance({
    milestoneId: "M005",
    dbStatus: "active",
    completedDispatchAt: "2026-05-30T00:01:00.000Z",
  });
  assert.match(guidance, /M005/);
  assert.match(guidance, /\/gsd dispatch complete-milestone M005/);
  assert.match(guidance, /\/gsd status M005/);
  assert.match(guidance, /\/gsd next again before fixing/);
});

test("ADR-017: completed milestone dispatch history blocks accidental re-planning", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-completed-reopened-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });

  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.prepare(
    `INSERT OR REPLACE INTO workers
      (worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath)
     VALUES ('w1', 'local', 1, '2026-05-30T00:00:00.000Z', 'test', '2026-05-30T00:00:00.000Z', 'stopped', :root)`,
  ).run({ ":root": base });
  adapter.prepare(
    `INSERT INTO unit_dispatches
      (trace_id, worker_id, milestone_lease_token, milestone_id, unit_type, unit_id, status, attempt_n, started_at, ended_at)
     VALUES
      ('trace', 'w1', 1, 'M001', 'complete-milestone', 'M001', 'completed', 1, '2026-05-30T00:00:00.000Z', '2026-05-30T00:01:00.000Z')`,
  ).run();

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.match(result.blockers.join("\n"), /completed closeout dispatch history/);
  assert.match(result.blockers.join("\n"), /\/gsd dispatch complete-milestone M001/);
});

test("ADR-017: synthetic parallel-research slice directory is ignored", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-sentinel-drift-"));
  t.after(() => cleanup(base));

  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    existsSync(join(base, ".gsd", "phases", "01-test")),
    true,
    "sentinel directory is left alone, not treated as a real disk-only slice",
  );
  assert.equal(result.repaired.some((record) => record.kind === "disk-slice-id-divergence"), false);
});

test("#1565: unique-suffix DB milestone id resolves slices planned under the filesystem id", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-suffix-id-drift-"));
  t.after(() => cleanup(base));

  const phaseDir = join(base, ".gsd", "phases", "04-t76mxm-new-milestone-m004-t76mxm");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "04-04-PLAN.md"), "# Plan S04\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  // gsd_plan_milestone stored the unique-suffix row; later units planned slices
  // under the short filesystem-derived id that findMilestoneIds() returns for
  // this phase dir, which reconciliation had imported as its own milestone row.
  insertMilestone({ id: "M004-t76mxm", title: "Milestone", status: "active" });
  insertMilestone({ id: "M004", title: "Milestone", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M004", title: "Slice", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () =>
      makeState({ activeMilestone: { id: "M004-t76mxm", title: "Milestone" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.blockers.join("\n").includes("references unknown S04"),
    false,
    "plan file for a slice stored under the filesystem id must not be flagged as unknown",
  );
});

test("#1623: suffixed DB slice id satisfies the bare PLAN-filename slice id", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-suffixed-slice-drift-"));
  t.after(() => cleanup(base));

  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# Plan S01\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  // Replanning stored the slice with a suffix; the plan filename can only ever
  // encode the bare numeric index, so exact-id matching flagged false drift.
  insertSlice({ id: "S01-replan", milestoneId: "M001", title: "Slice", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.blockers.join("\n").includes("references unknown S01"),
    false,
    "suffixed slice id must satisfy the bare id derived from the plan filename",
  );
});

test("#1623: bare plan slice id does not match a longer numeric slice id", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-bare-slice-prefix-drift-"));
  t.after(() => cleanup(base));

  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# Plan S01\n");

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S010", milestoneId: "M001", title: "Slice", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(
    result.blockers.join("\n").includes("references unknown S01"),
    true,
    "S010 is a different slice, not a suffixed alias of S01",
  );
});

test("#1623: skipped slice does not produce unrepairable roadmap-divergence", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-skipped-roadmap-drift-"));
  t.after(() => cleanup(base));

  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  const roadmapPath = join(phaseDir, "01-ROADMAP.md");
  // The rendered projection omits skipped slices, so S01 is absent by design.
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify skipped slices stay out of the divergence check",
      "",
      "## Slices",
      "",
      "- [ ] **S02: Feature** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Test",
    status: "active",
    planning: { vision: "Verify skipped slices stay out of the divergence check" },
  });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Placeholder", status: "skipped", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Plan S02", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true, result.ok ? "" : result.blockers.join("\n"));
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "a skipped slice missing from ROADMAP.md is the rendered contract, not drift",
  );
});

test("#1623: stale roadmap row for a now-skipped slice is re-rendered away", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-skipped-roadmap-stale-"));
  t.after(() => cleanup(base));

  const phaseDir = join(base, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  const roadmapPath = join(phaseDir, "01-ROADMAP.md");
  writeFileSync(
    roadmapPath,
    [
      "# M001: Test",
      "",
      "**Vision:** Verify skipped slices are dropped from a stale projection",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Placeholder** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[]`",
      "",
    ].join("\n"),
  );

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Test",
    status: "active",
    planning: { vision: "Verify skipped slices are dropped from a stale projection" },
  });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Placeholder", status: "skipped", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Plan S02", status: "pending" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true, result.ok ? "" : result.blockers.join("\n"));
  const roadmap = readFileSync(roadmapPath, "utf-8");
  assert.equal(roadmap.includes("S01: Placeholder"), false, "skipped slice is dropped");
  assert.match(roadmap, /S02: Feature/);
});

// ─── #5707: caller closure (reconcileBeforeSpawn) ────────────────────────────

test("ADR-017 (#5707): reconcileBeforeSpawn returns ok=true on clean reconciliation", async () => {
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [],
  });
  assert.equal(result.ok, true);
});

test("ADR-017 (#5707): reconcileBeforeSpawn surfaces blockers as ok=false", async () => {
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState({ phase: "blocked", blockers: ["lock missing"] }),
    registry: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /lock missing/);
  }
});

test("ADR-017 (#5707): reconcileBeforeSpawn catches ReconciliationFailedError → ok=false", async () => {
  const persistent: DriftRecord = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => [persistent],
    repair: () => { /* no-op: drift cannot be cleared, persists past cap=2 */ },
  };

  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [handler],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /stale-sketch-flag/);
  }
});

test("ADR-017 (#5707): reconcileBeforeSpawn reports repaired drift in ok=true reason", async () => {
  let detectCalls = 0;
  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => {
      detectCalls++;
      return detectCalls === 1
        ? [{ kind: "stale-sketch-flag", mid: "M001", sid: "S02" }]
        : [];
    },
    repair: () => { /* repair "succeeds" — second detect returns empty */ },
  };

  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [handler],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.reason ?? "", /stale-sketch-flag/);
  }
});

test("reconcileBeforeSpawn preserves an unbaselined roadmap before re-projecting", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    title: "Test",
    status: "active",
    planning: { vision: "Canonical vision" },
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Canonical slice",
    status: "pending",
    risk: "low",
    depends: [],
  });
  const rendered = await renderRoadmapFromDb(base, "M001");
  assert.equal("roadmapPath" in rendered, true);
  const roadmapPath = join(base, ".gsd", "phases", "01-test", "01-ROADMAP.md");
  writeFileSync(roadmapPath, "# Externally edited roadmap\n", "utf-8");
  rmSync(join(base, ".gsd", ".compat.json"), { force: true });

  const result = await reconcileBeforeSpawn(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [roadmapMissingHandler],
  });

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.match(readFileSync(roadmapPath, "utf-8"), /Canonical slice/);
  const quarantineRoot = join(base, ".gsd", "quarantine", "projections");
  const quarantinedRoadmap = readdirSync(quarantineRoot, { recursive: true })
    .map(String)
    .find((path) => path.endsWith("01-ROADMAP.md"));
  assert.ok(quarantinedRoadmap);
  assert.equal(
    readFileSync(join(quarantineRoot, quarantinedRoadmap), "utf-8"),
    "# Externally edited roadmap\n",
  );
});

test("ADR-017 (#6238): reconcileBeforeSpawn does not pass reconcile-only deps object", async () => {
  let receivedDeps: Partial<ReconciliationDeps> | undefined;
  const result = await reconcileBeforeSpawn("/project", {
    reconcile: async (_basePath, deps) => {
      receivedDeps = deps;
      return {
        ok: true,
        stateSnapshot: makeState(),
        repaired: [],
        blockers: [],
        blockerDetails: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(receivedDeps, undefined);
});

// ─── Lifecycle and classification ────────────────────────────────────────────

test("ADR-017 (#5700): cascading drift triggers second pass within cap", async () => {
  // First pass detects drift A; repair "fixes" it. Second pass detects drift B
  // (cascading); repair fixes it. Third call would see no drift. Cap=2 means
  // we have exactly two repair passes available.
  const detectedSequence: DriftRecord[][] = [
    [{ kind: "stale-sketch-flag", mid: "M001", sid: "S02" }],
    [{ kind: "stale-sketch-flag", mid: "M001", sid: "S03" }],
    [],
  ];
  let detectCallIdx = 0;
  const repaired: DriftRecord[] = [];

  const handler: DriftHandler = {
    kind: "stale-sketch-flag",
    detect: () => detectedSequence[detectCallIdx++] ?? [],
    repair: (record) => {
      repaired.push(record);
    },
  };

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [handler],
  });

  assert.equal(result.ok, true);
  assert.equal(result.repaired.length, 2, "both passes' repairs collected");
  assert.equal(repaired.length, 2);
});

test("deriveState is pure: stale sketch healed only via reconcileBeforeDispatch", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited",
  });
  writeFileSync(
    join(base, ".gsd", "phases", "01-test", "01-02-PLAN.md"),
    makeStalePlanContent("S02", [{ id: "T01", title: "Build the feature", done: false }]),
  );

  const { deriveState } = await import("../state.ts");
  invalidateStateCache();

  const beforeReconcile = await deriveState(base);
  assert.equal(beforeReconcile.phase, "refining", "derive alone must not heal stale sketch flag");
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "DB flag unchanged before reconcile");

  const result = await reconcileBeforeDispatch(base);
  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "reconcile clears sketch flag");

  invalidateStateCache();
  const afterReconcile = await deriveState(base);
  assert.notEqual(afterReconcile.phase, "refining", "derive after reconcile advances past sketch gate");
});

test("pre-dispatch reconciliation excludes projection observations", () => {
  assert.equal(RECONCILIATION_REPAIR_PHASES.length, 2);
  assert.equal(handlerPhaseIndex("external-markdown-edit"), -1);
  assert.equal(handlerPhaseIndex("external-planning-edit"), -1);
  assert.ok(handlerPhaseIndex("stale-sketch-flag") < handlerPhaseIndex("stale-render"));
});

test("custom reconciliation blockers retain their structured drift evidence", async () => {
  const externalDrift: DriftRecord = {
    kind: "external-markdown-edit",
    projectionPath: "phases/01-test/01-ROADMAP.md",
    expectedSha: "before",
    actualSha: "after",
    entities: ["M001"],
  };
  const externalHandler: DriftHandler = {
    kind: "external-markdown-edit",
    detect: () => [externalDrift],
    blocker: () => "review the external modeled edit",
    repair: () => {
      throw new Error("blocked external repair must not run");
    },
  };
  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    registry: [externalHandler],
  });

  assert.equal(result.repaired.length, 0);
  assert.deepEqual(result.blockers, ["review the external modeled edit"]);
  assert.deepEqual(result.blockerDetails, [{
    message: "review the external modeled edit",
    drift: externalDrift,
  }]);
});
