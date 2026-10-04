// Project/App: gsd-pi
// File Purpose: A custom workflow run is database rows; the run directory files are renders.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import {
  hydrateCustomStepVerifyRetryCount,
  saveCustomStepVerifyRetryCount,
} from "../auto/custom-verify-retry-store.ts";
import { handleCustomEngineVerifyRetry } from "../auto/workflow-custom-engine-retry.ts";
import { runCustomVerificationWithEvidence } from "../custom-verification.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { markWorkerCrashed, registerAutoWorker } from "../db/auto-workers.ts";
import {
  customWorkflowRunId,
  getCustomWorkflowRun,
  getCustomWorkflowStepClaim,
  getLatestCustomWorkflowStepVerification,
} from "../db/custom-workflow-runs.ts";
import type { EngineDispatchAction } from "../engine-types.ts";
import { readGraph, writeGraph, type WorkflowGraph } from "../graph.ts";
import { _getAdapter, closeDatabase, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { projectionRendererFor } from "../projection-worker.ts";
import { createRun, importRunDirectory, listRuns, openRunForResume } from "../run-manager.ts";

const PIPELINE = [
  "version: 1",
  "name: pipeline",
  "steps:",
  "  - id: draft",
  "    name: Draft",
  "    prompt: Write the draft",
  "    requires: []",
  "    produces: []",
  "  - id: review",
  "    name: Review",
  "    prompt: Review the draft",
  "    requires: [draft]",
  "    produces: [review.md]",
  "    verify:",
  "      policy: content-heuristic",
  "  - id: publish",
  "    name: Publish",
  "    prompt: Publish it",
  "    requires: [review]",
  "    produces: []",
].join("\n");

function statuses(graph: WorkflowGraph): Record<string, string> {
  return Object.fromEntries(graph.steps.map((step) => [step.id, step.status]));
}

describe("custom workflow runs in the database", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-custom-workflow-db-")));
    mkdirSync(join(base, ".gsd", "workflow-defs"), { recursive: true });
    writeFileSync(join(base, ".gsd", "workflow-defs", "pipeline.yaml"), PIPELINE, "utf-8");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  });

  afterEach(() => {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  function worker(): string {
    return registerAutoWorker({ projectRootRealpath: base });
  }

  async function dispatch(engine: CustomWorkflowEngine): Promise<EngineDispatchAction> {
    return engine.resolveDispatch(await engine.deriveState(base), { basePath: base });
  }

  function dispatchedUnit(action: EngineDispatchAction): string {
    assert.equal(action.action, "dispatch");
    return action.action === "dispatch" ? action.step.unitId : "";
  }

  /** Verify the step, then mark it complete, as the auto loop does. */
  async function complete(engine: CustomWorkflowEngine, runDir: string, stepId: string): Promise<void> {
    assert.equal(runCustomVerificationWithEvidence(runDir, stepId).outcome, "continue");
    await engine.reconcile(await engine.deriveState(base), {
      unitType: "custom-step",
      unitId: `pipeline/${stepId}`,
      startedAt: 0,
      finishedAt: 1,
    });
  }

  test("an edited or deleted GRAPH.yaml does not change the next step and is rendered again", async () => {
    const runDir = createRun(base, "pipeline");
    const engine = new CustomWorkflowEngine(runDir, worker());
    assert.equal(dispatchedUnit(await dispatch(engine)), "pipeline/draft");
    await complete(engine, runDir, "draft");

    // A hand edit that claims every step is complete.
    const edited = readGraph(runDir);
    writeGraph(runDir, { ...edited, steps: edited.steps.map((step) => ({ ...step, status: "complete" as const })) });

    assert.equal((await engine.deriveState(base)).isComplete, false);
    assert.equal(dispatchedUnit(await dispatch(engine)), "pipeline/review");
    assert.deepEqual(statuses(readGraph(runDir)), { draft: "complete", review: "active", publish: "pending" });

    rmSync(join(runDir, "GRAPH.yaml"));
    rmSync(join(runDir, "DEFINITION.yaml"));
    assert.equal(dispatchedUnit(await dispatch(engine)), "pipeline/review");
    assert.deepEqual(statuses(readGraph(runDir)), { draft: "complete", review: "active", publish: "pending" });
    assert.equal(existsSync(join(runDir, "DEFINITION.yaml")), true);
    assert.equal(listRuns(base)[0]?.steps.completed, 1);
  });

  test("two sessions cannot run the same step", async () => {
    const runDir = createRun(base, "pipeline");
    const runId = customWorkflowRunId(runDir);
    const first = worker();
    const second = worker();

    assert.equal(dispatchedUnit(await dispatch(new CustomWorkflowEngine(runDir, first))), "pipeline/draft");

    const refused = await dispatch(new CustomWorkflowEngine(runDir, second));
    assert.equal(refused.action, "stop");
    assert.match(refused.action === "stop" ? refused.reason : "", /"draft" is running in another session/);
    assert.equal(getCustomWorkflowStepClaim(runId, "draft"), first);

    // The session that ran the step may dispatch it again (a retry).
    assert.equal(dispatchedUnit(await dispatch(new CustomWorkflowEngine(runDir, first))), "pipeline/draft");
  });

  test("a step with no verify policy records an inconclusive result with a waiver", async () => {
    const runDir = createRun(base, "pipeline");
    const runId = customWorkflowRunId(runDir);
    const engine = new CustomWorkflowEngine(runDir, worker());
    await dispatch(engine);

    const result = runCustomVerificationWithEvidence(runDir, "draft");

    assert.equal(result.outcome, "continue");
    assert.deepEqual(getLatestCustomWorkflowStepVerification(runId, "draft"), {
      verdict: "inconclusive",
      evidence: { policy: "none", reason: "not-configured", stepId: "draft" },
      waiverRationale: "The step has no verify policy.",
    });
  });

  test("a step completes only from a stored verification result that passed or was waived", async () => {
    const runDir = createRun(base, "pipeline");
    const runId = customWorkflowRunId(runDir);
    const engine = new CustomWorkflowEngine(runDir, worker());
    await dispatch(engine);
    const draftDone = {
      unitType: "custom-step",
      unitId: "pipeline/draft",
      startedAt: 0,
      finishedAt: 1,
    };

    // Not verified yet: no result is stored.
    await assert.rejects(engine.reconcile(await engine.deriveState(base), draftDone), /verification result is missing/);
    await complete(engine, runDir, "draft");

    // review must produce review.md; the file is missing, so the result is a fail.
    await dispatch(engine);
    assert.equal(runCustomVerificationWithEvidence(runDir, "review").outcome, "pause");
    assert.equal(getLatestCustomWorkflowStepVerification(runId, "review")?.verdict, "fail");
    await assert.rejects(
      engine.reconcile(await engine.deriveState(base), { ...draftDone, unitId: "pipeline/review" }),
      /verification result is fail/,
    );
    assert.equal(statuses(readGraph(runDir))["review"], "active");

    writeFileSync(join(runDir, "review.md"), "Looks good.", "utf-8");
    await complete(engine, runDir, "review");
    assert.deepEqual(getLatestCustomWorkflowStepVerification(runId, "review"), {
      verdict: "pass",
      evidence: { policy: "content-heuristic", reason: "checks-passed" },
      waiverRationale: null,
    });
    assert.equal(statuses(readGraph(runDir))["review"], "complete");
  });

  test("a run resumes by its id after a crash that wrote no pause", async () => {
    const runDir = createRun(base, "pipeline");
    const runId = customWorkflowRunId(runDir);
    const crashed = worker();
    const engine = new CustomWorkflowEngine(runDir, crashed);
    await dispatch(engine);
    await complete(engine, runDir, "draft");
    assert.equal(dispatchedUnit(await dispatch(engine)), "pipeline/review");
    // The process dies while review runs. Nothing is paused; only the rows remain.
    markWorkerCrashed(crashed);
    rmSync(join(runDir, "GRAPH.yaml"));

    const restarted = worker();
    const resumedDir = openRunForResume(base, runId);

    assert.equal(resumedDir, runDir);
    assert.equal(dispatchedUnit(await dispatch(new CustomWorkflowEngine(resumedDir, restarted))), "pipeline/review");
    assert.equal(getCustomWorkflowStepClaim(runId, "review"), restarted);
    assert.throws(() => openRunForResume(base, "pipeline/2000-01-01T00-00-00"), /no such run/);
    assert.throws(() => openRunForResume(base, "../pipeline"), /<name>\/<timestamp>/);
  });

  test("resume imports a run directory from a release that kept runs in files", async () => {
    const runId = "legacy/2026-01-01T00-00-00";
    const runDir = join(base, ".gsd", "workflow-runs", runId);
    const definition = {
      version: 1,
      name: "legacy",
      steps: [
        { id: "a", name: "A", prompt: "Do a", requires: [], produces: [] },
        { id: "b", name: "B", prompt: "Do b", requires: ["a"], produces: [] },
      ],
    };
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(definition), "utf-8");
    writeFileSync(join(runDir, "PARAMS.json"), JSON.stringify({ target: "app" }), "utf-8");
    writeGraph(runDir, {
      steps: [
        { id: "a", title: "A", status: "complete", prompt: "Do a", dependsOn: [], finishedAt: "2026-01-01T00:05:00.000Z" },
        { id: "b", title: "B", status: "pending", prompt: "Do b", dependsOn: ["a"] },
      ],
      metadata: { name: "legacy", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(getCustomWorkflowRun(runId), null);

    // /gsd workflow resume <run> imports a run directory that has no rows.
    assert.equal(openRunForResume(base, runId), runDir);

    const run = getCustomWorkflowRun(runId);
    assert.deepEqual(run?.definition, definition);
    assert.deepEqual(run?.params, { target: "app" });
    assert.equal(run?.createdAt, "2026-01-01T00:00:00.000Z");
    // The rows are the state now: the file is not read again.
    rmSync(join(runDir, "GRAPH.yaml"));
    const engine = new CustomWorkflowEngine(runDir, worker());
    assert.equal(dispatchedUnit(await dispatch(engine)), "legacy/b");
    assert.deepEqual(statuses(readGraph(runDir)), { a: "complete", b: "active" });
  });

  test("import refuses a run directory with an unknown step status", () => {
    const runDir = join(base, ".gsd", "workflow-runs", "legacy", "2026-01-01T00-00-00");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({ version: 1, name: "legacy", steps: [] }), "utf-8");
    writeFileSync(
      join(runDir, "GRAPH.yaml"),
      stringify({
        steps: [{ id: "a", title: "A", status: "skipped", prompt: "Do a" }],
        metadata: { name: "legacy", created_at: "2026-01-01T00:00:00.000Z" },
      }),
      "utf-8",
    );

    assert.throws(() => importRunDirectory(runDir), /step "a" has unknown status "skipped"/);
    assert.equal(getCustomWorkflowRun("legacy/2026-01-01T00-00-00"), null);
  });

  test("the verification retry count of a step survives a restart with no file", async () => {
    const runDir = createRun(base, "pipeline");
    await dispatch(new CustomWorkflowEngine(runDir, worker()));
    const retry = (session: { activeRunDir: string; verificationRetryCount: Map<string, number> }) =>
      handleCustomEngineVerifyRetry({
        session,
        unitType: "custom-step",
        unitId: "pipeline/draft",
        basePath: base,
        iteration: 1,
        maxRetries: 3,
        deps: {
          hydrateRetryCounts: () => {
            const counts = hydrateCustomStepVerifyRetryCount(session, "custom-step", "pipeline/draft");
            assert.ok(counts, "the step of a run with rows has a step row");
            return counts;
          },
          saveRetryCounts: () => {
            assert.equal(saveCustomStepVerifyRetryCount(session, "custom-step", "pipeline/draft"), true);
          },
          recover: async () => ({ outcome: "retry" }),
          logRetry: () => {},
          reportRetry: () => {},
        },
      });

    const beforeRestart = { activeRunDir: runDir, verificationRetryCount: new Map<string, number>() };
    assert.deepEqual(await retry(beforeRestart), { action: "retry", attempts: 1 });
    assert.deepEqual(await retry(beforeRestart), { action: "retry", attempts: 2 });

    // A new process has an empty session.
    const afterRestart = { activeRunDir: runDir, verificationRetryCount: new Map<string, number>() };
    assert.deepEqual(await retry(afterRestart), { action: "retry", attempts: 3 });
    assert.equal((await retry(afterRestart)).action, "stop");
    assert.equal(existsSync(join(runDir, "runtime")), false);
  });

  test("each step transition queues Projection Work that the worker can render", async () => {
    const runDir = createRun(base, "pipeline");
    await dispatch(new CustomWorkflowEngine(runDir, worker()));
    const head = _getAdapter()!.prepare(
      `SELECT projection_kind, projection_key FROM workflow_projection_work
       ORDER BY source_project_revision DESC LIMIT 1`,
    ).get() as { projection_kind: string; projection_key: string };
    rmSync(join(runDir, "GRAPH.yaml"));

    const renderer = projectionRendererFor(head.projection_kind, head.projection_key);
    assert.ok(renderer, "the queued row has a renderer");
    await renderer.render(base);

    assert.deepEqual(statuses(readGraph(runDir)), { draft: "active", review: "pending", publish: "pending" });
  });
});
