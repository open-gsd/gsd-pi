// Preview dispatch purity tests (#2230)
// A preview resolveDispatch (read-only `gsd headless ... query`) must decide
// exactly like a real dispatch but must not persist any dispatch side effect.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  upsertSlicePlanning,
  upsertTaskPlanning,
  insertGateRow,
  getGateResults,
  _getAdapter,
  executeDomainOperation,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import { resolveDeepProjectSetupState } from "../deep-project-setup-policy.ts";
import type { GSDPreferences } from "../preferences.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { renderPlanFromDb } from "../markdown-renderer.ts";
import { invalidateAllCaches } from "../cache.ts";
import { DISPATCH_RULES, resolveDispatch } from "../auto-dispatch.ts";

const validProject = readFileSync(
  new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
  "utf-8",
);
const validRequirements = readFileSync(
  new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
  "utf-8",
);

function setupTestProject(): { tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "dispatch-preview-"));
  const dbPath = join(tmpDir, ".gsd", "gsd.db");
  mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
  openDatabase(dbPath);

  insertMilestone({
    id: "M001",
    title: "Test Milestone",
    status: "active",
  });

  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "medium",
    depends: [],
  });

  // Write roadmap file (required for deriveState)
  const milestoneDir = join(tmpDir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Vision",
      "Test milestone vision.",
      "",
      "## Success Criteria",
      "- Test criteria",
      "",
      "## Delivery Sequence",
      "- [ ] **S01: Test Slice** `risk:medium`",
      "  After this: test demo",
      "",
    ].join("\n"),
  );

  return { tmpDir };
}

function planSlice(tmpDir: string) {
  upsertSlicePlanning("M001", "S01", {
    goal: "Test goal",
    successCriteria: "Test criteria",
    proofLevel: "contract",
    integrationClosure: "",
    observabilityImpact: "Run tests",
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Test Task",
    status: "pending",
  });
  upsertTaskPlanning("M001", "S01", "T01", {
    title: "Test Task",
    description: "Implement test",
    estimate: "1h",
    files: ["src/test.ts"],
    verify: "npm test",
    inputs: [],
    expectedOutput: ["src/test.ts"],
    observabilityImpact: "",
    fullPlanMd: "",
  });
}

/** Fixture in evaluating-gates with pending Q3/Q4 and gate_evaluation absent. */
async function setupEvaluatingGates() {
  const { tmpDir } = setupTestProject();
  planSlice(tmpDir);
  await renderPlanFromDb(tmpDir, "M001", "S01");

  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });

  invalidateStateCache();
  const state = await deriveState(tmpDir);
  assert.equal(state.phase, "evaluating-gates");
  return { tmpDir, state };
}

describe("dispatch preview purity (#2230)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const setup = await setupEvaluatingGates();
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    invalidateAllCaches();
    invalidateStateCache();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("preview resolves evaluating-gates to skip without persisting gate omission", async () => {
    const state = await deriveState(tmpDir);

    const result = await resolveDispatch({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state,
      prefs: undefined, // effective gate_evaluation disabled
      preview: true,
    });

    assert.equal(result.action, "skip");

    // The preview must not persist the omission: gates stay pending.
    const byId = new Map(getGateResults("M001", "S01").map((gate) => [gate.gate_id, gate]));
    assert.equal(byId.get("Q3")?.status, "pending", "preview must not mutate pending gate Q3");
    assert.equal(byId.get("Q4")?.status, "pending", "preview must not mutate pending gate Q4");
  });

  test("real dispatch (no preview flag) still omits pending gates", async () => {
    const state = await deriveState(tmpDir);

    const result = await resolveDispatch({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state,
      prefs: undefined, // effective gate_evaluation disabled
    });

    assert.equal(result.action, "skip");

    // Real dispatch behavior is unchanged: gate omission is persisted.
    const byId = new Map(getGateResults("M001", "S01").map((gate) => [gate.gate_id, gate]));
    assert.equal(byId.get("Q3")?.verdict, "omitted");
    assert.equal(byId.get("Q4")?.verdict, "omitted");
  });

  test("preview with explicit gate_evaluation:{enabled:false} leaves gates pending", async () => {
    const state = await deriveState(tmpDir);

    const result = await resolveDispatch({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state,
      prefs: { gate_evaluation: { enabled: false } },
      preview: true,
    });

    assert.equal(result.action, "skip");
    const byId = new Map(getGateResults("M001", "S01").map((gate) => [gate.gate_id, gate]));
    assert.equal(byId.get("Q3")?.status, "pending");
    assert.equal(byId.get("Q4")?.status, "pending");
  });

  test("repeated preview queries are idempotent and non-mutating", async () => {
    const first = await resolveDispatch({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state: await deriveState(tmpDir),
      prefs: undefined,
      preview: true,
    });
    const second = await resolveDispatch({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state: await deriveState(tmpDir),
      prefs: undefined,
      preview: true,
    });

    assert.deepEqual(second, first);
    assert.equal(first.action, "skip");
    const byId = new Map(getGateResults("M001", "S01").map((gate) => [gate.gate_id, gate]));
    assert.equal(byId.get("Q3")?.status, "pending");
    assert.equal(byId.get("Q4")?.status, "pending");
  });
});

// ─── Adopted skip-validation closeout: preview decision fidelity ──────────

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rowCount(sql: string): number {
  return Number(db().prepare(sql).get()?.["count"] ?? 0);
}

function adoptFixtureAtFence(
  writes: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt",
    idempotencyKey: `fixture/test.fixture.adopt/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType: "test.fixture.adopt" },
  }, (context) => {
    writes(context);
    return {
      events: [{
        eventType: "test.fixture.adopt",
        entityType: "milestone",
        entityId: "M001",
        payload: { operationType: "test.fixture.adopt" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `fixture/test.fixture.adopt/${context.resultingRevision}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

/**
 * Adopted-lifecycle milestone whose slice work is complete: the exact
 * validator scenario for the skip-validation closeout path.
 */
function makeAdoptedFixture(): string {
  const basePath = mkdtempSync(join(tmpdir(), "dispatch-preview-adopted-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'preview';\n");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Waived validation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Done", status: "complete" });
  adoptFixtureAtFence((context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  return basePath;
}

function validatingMilestoneContext(basePath: string, preview: boolean) {
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "validating-milestone → validate-milestone"
  );
  assert.ok(rule, "validating-milestone dispatch rule must exist");
  return rule.match({
    basePath,
    mid: "M001",
    midTitle: "Waived validation",
    state: {
      phase: "validating-milestone",
      activeMilestone: { id: "M001", title: "Waived validation" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Waived validation", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: { phases: { skip_milestone_validation: true } },
    preview,
  } as any);
}

describe("dispatch preview decision fidelity (#2230 adopted skip-validation)", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    invalidateAllCaches();
    invalidateStateCache();
    closeDatabase();
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    fixtures.length = 0;
  });

  test("preview decides like the real turn when the waiver write is suppressed", async () => {
    // Preview: waiver write suppressed — decision must still be the one the
    // real turn reaches once the waiver is recorded.
    fixtures.push(makeAdoptedFixture());
    const previewResult = await validatingMilestoneContext(fixtures[0], true);
    assert.ok(previewResult, "preview rule.match returned null");
    const previewWaiverCount = rowCount(`SELECT COUNT(*) AS count FROM workflow_waivers`);
    const previewValidationWritten = existsSync(
      join(fixtures[0], ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    );
    closeDatabase();

    // Real turn: waiver recorded.
    fixtures.push(makeAdoptedFixture());
    const realResult = await validatingMilestoneContext(fixtures[1], false);
    assert.ok(realResult, "real rule.match returned null");
    const realWaiverCount = rowCount(`SELECT COUNT(*) AS count FROM workflow_waivers`);
    const realValidationWritten = existsSync(
      join(fixtures[1], ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    );

    assert.equal(realResult.action, "dispatch", "real turn dispatches complete-milestone");
    if (realResult.action !== "dispatch") throw new Error("expected real dispatch");
    assert.equal(realResult.unitType, "complete-milestone");
    assert.equal(realWaiverCount, 1);

    assert.equal(
      previewResult.action,
      realResult.action,
      `preview must return the same decision as the real turn (got ${JSON.stringify(previewResult)})`,
    );
    if (previewResult.action !== "dispatch") throw new Error("expected preview dispatch");
    assert.equal(previewResult.unitType, "complete-milestone");
    assert.equal(previewResult.unitId, realResult.unitId);
    // The suppression held: no waiver was persisted by the preview.
    assert.equal(previewWaiverCount, 0);
    assert.equal(realValidationWritten, true, "real turn writes the waived VALIDATION projection");
    assert.equal(previewValidationWritten, false, "preview must not write the waived VALIDATION projection");
  });
});

// ─── Missing-task-plan recovery: PLAN projection purity (#2230) ───────────

function markdownFiles(basePath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(full.slice(basePath.length + 1));
    }
  };
  const gsdDir = join(basePath, ".gsd");
  if (existsSync(gsdDir)) walk(gsdDir);
  return out.sort();
}

function makeExecutingFixture(): string {
  const { tmpDir } = setupTestProject();
  planSlice(tmpDir); // DB slice + task rows, but NO PLAN projection on disk
  return tmpDir;
}

function missingTaskPlanRuleMatch(basePath: string, preview: boolean) {
  const rule = DISPATCH_RULES.find((candidate) =>
    candidate.name === "executing → execute-task (recover missing task plan → plan-slice)"
  );
  assert.ok(rule, "missing-task-plan recovery rule must exist");
  return rule.match({
    basePath,
    mid: "M001",
    midTitle: "Test Milestone",
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test Milestone" },
      activeSlice: { id: "S01", title: "Test Slice" },
      activeTask: { id: "T01", title: "Test Task" },
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Test Milestone", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    preview,
  } as any);
}

describe("dispatch preview purity: missing-task-plan PLAN projection (#2230)", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    invalidateAllCaches();
    invalidateStateCache();
    closeDatabase();
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    fixtures.length = 0;
  });

  test("preview re-renders nothing; the real turn heals the PLAN — same fall-through", async () => {
    fixtures.push(makeExecutingFixture());
    const previewResult = await missingTaskPlanRuleMatch(fixtures[0], true);
    const previewMarkdown = markdownFiles(fixtures[0]);
    closeDatabase();

    fixtures.push(makeExecutingFixture());
    const realResult = await missingTaskPlanRuleMatch(fixtures[1], false);
    const realMarkdown = markdownFiles(fixtures[1]);

    // Decision parity: both the real render and the read-only mirror end in
    // the same fall-through to the normal execute-task rule.
    assert.equal(previewResult, null, "preview mirrors the render-success fall-through");
    assert.equal(realResult, null, "real turn falls through after healing the PLAN");

    // The real turn wrote the PLAN projection; the preview wrote nothing.
    assert.ok(
      realMarkdown.some((file) => file.endsWith("-PLAN.md")),
      `real turn should heal the PLAN projection, got: ${realMarkdown.join(", ")}`,
    );
    assert.deepEqual(
      previewMarkdown.filter((file) => file.endsWith("-PLAN.md")),
      [],
      "preview must not write the PLAN projection",
    );
  });
});

// ─── Deep project setup: self-heal purity (#2230) ──────────────────────────

const deepPrefs = { planning_depth: "deep" } as GSDPreferences;

function makeDeepFixture(opts: { prefsCaptured: boolean; withMarker: boolean }): string {
  const base = mkdtempSync(join(tmpdir(), "dispatch-preview-deep-"));
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nplanning_depth: deep${opts.prefsCaptured ? "\nworkflow_prefs_captured: true" : ""}\n---\n`,
  );
  writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
  if (opts.withMarker) {
    writeFileSync(
      join(base, ".gsd", "runtime", "research-decision.json"),
      JSON.stringify({ decision: "skip", source: "workflow-preferences" }),
    );
  }
  return base;
}

describe("dispatch preview purity: deep setup self-heal (#2230)", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    fixtures.length = 0;
  });

  test("preview does not self-heal workflow prefs; decision matches the real turn", () => {
    fixtures.push(makeDeepFixture({ prefsCaptured: false, withMarker: true }));
    const previewState = resolveDeepProjectSetupState(deepPrefs, fixtures[0], true);
    const prefsAfterPreview = readFileSync(join(fixtures[0], ".gsd", "PREFERENCES.md"), "utf-8");

    fixtures.push(makeDeepFixture({ prefsCaptured: false, withMarker: true }));
    const realState = resolveDeepProjectSetupState(deepPrefs, fixtures[1], false);
    const prefsAfterReal = readFileSync(join(fixtures[1], ".gsd", "PREFERENCES.md"), "utf-8");

    assert.deepEqual(
      { status: previewState.status, stage: previewState.stage, reason: previewState.reason },
      { status: realState.status, stage: realState.stage, reason: realState.reason },
      "preview decision must equal the real turn's",
    );
    assert.match(prefsAfterReal, /workflow_prefs_captured: true/, "real turn heals the prefs flag");
    assert.doesNotMatch(prefsAfterPreview, /workflow_prefs_captured/, "preview must not heal the prefs flag");
  });

  test("preview does not write the default research marker; decision matches the real turn", () => {
    fixtures.push(makeDeepFixture({ prefsCaptured: true, withMarker: false }));
    const previewState = resolveDeepProjectSetupState(deepPrefs, fixtures[0], true);
    const markerAfterPreview = existsSync(join(fixtures[0], ".gsd", "runtime", "research-decision.json"));

    fixtures.push(makeDeepFixture({ prefsCaptured: true, withMarker: false }));
    const realState = resolveDeepProjectSetupState(deepPrefs, fixtures[1], false);
    const markerAfterReal = existsSync(join(fixtures[1], ".gsd", "runtime", "research-decision.json"));

    assert.deepEqual(
      { status: previewState.status, stage: previewState.stage, reason: previewState.reason },
      { status: realState.status, stage: realState.stage, reason: realState.reason },
      "preview decision must equal the real turn's",
    );
    assert.equal(markerAfterReal, true, "real turn writes the default skip marker");
    assert.equal(markerAfterPreview, false, "preview must not write the default skip marker");
  });
});
