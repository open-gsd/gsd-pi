// Project/App: gsd-pi
// File Purpose: Regression tests for host verification scope misresolution (#1628, #1630 — map #1645, ticket #1652).

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverCommands,
  findGsdToolInvocationInVerify,
  isGsdWorkflowToolInvocation,
  runVerificationGate,
  validateVerificationCommand,
} from "../verification-gate.ts";
import { decideVerificationVerdict } from "../verification-verdict.ts";
import {
  createRepositoryRegistryFromPreferences,
  deriveRepositoryTargetsFromPlannedPaths,
} from "../repository-registry.ts";
import { resolveVerificationRepositoryTargets } from "../verification-source-integrity.ts";
import type { GSDPreferences } from "../preferences-types.ts";
import type { TaskRow } from "../db-task-slice-rows.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
} from "../gsd-db.ts";
import { handlePlanTask as handlePlanTaskWithInvocation, type PlanTaskParams } from "../tools/plan-task.ts";
import { handleReplanTask as handleReplanTaskWithInvocation } from "../tools/replan-task.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withRtkDisabled<T>(callback: () => T): T {
  const previous = process.env.GSD_RTK_DISABLED;
  process.env.GSD_RTK_DISABLED = "1";
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.GSD_RTK_DISABLED;
    } else {
      process.env.GSD_RTK_DISABLED = previous;
    }
  }
}

// ─── #1628 — GSD tool names in verify must never execute as shell noise ─────

describe("verification-gate: GSD tool-name verify (issue #1628)", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-1628"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("isGsdWorkflowToolInvocation matches canonical, aliased, prefixed, and reserved-namespace names", () => {
    assert.equal(isGsdWorkflowToolInvocation("gsd_exec_search limit 1 query D023"), true);
    assert.equal(isGsdWorkflowToolInvocation("gsd_milestone_status M002"), true);
    // Planner-hallucinated near-tool names live in the reserved gsd_* namespace.
    assert.equal(isGsdWorkflowToolInvocation("gsd_decision_get D023"), true);
    assert.equal(isGsdWorkflowToolInvocation("mcp__gsd-workflow__gsd_exec_search query D023"), true);
    assert.equal(isGsdWorkflowToolInvocation("bash: gsd_exec_search query D023"), true);
  });

  test("isGsdWorkflowToolInvocation leaves real shell commands alone", () => {
    // The bare `gsd` CLI is a genuine shell command.
    assert.equal(isGsdWorkflowToolInvocation("gsd status"), false);
    assert.equal(isGsdWorkflowToolInvocation("grep -q D023 .gsd/DECISIONS.md"), false);
    assert.equal(isGsdWorkflowToolInvocation("npm run test"), false);
    assert.equal(isGsdWorkflowToolInvocation(""), false);
  });

  test("validateVerificationCommand rejects a tool invocation with a dedicated reason", () => {
    const result = validateVerificationCommand("gsd_exec_search limit 1 query D023");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /GSD workflow tool/);
  });

  test("findGsdToolInvocationInVerify surfaces the offending line from a multi-line verify", () => {
    assert.equal(
      findGsdToolInvocationInVerify("test -f out.txt\ngsd_milestone_status M002"),
      "gsd_milestone_status M002",
    );
    assert.equal(findGsdToolInvocationInVerify("test -f out.txt\nnpm run test"), null);
  });

  test("tool-name-only verify routes to task-plan-prose instead of executing", () => {
    const result = discoverCommands({
      taskPlanVerify: "gsd_exec_search limit 1 query D023",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("tool line beside a runnable command keeps only the runnable command", () => {
    const result = discoverCommands({
      taskPlanVerify: "gsd_exec_search limit 1 query D023\nnpm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("gate passes a tool-name verify backed by qualifying task evidence — no exit-127 false fail", () => {
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      taskPlanVerify: "gsd_exec_search limit 1 query D023",
      taskEvidence: [
        { command: "gsd_exec_search limit 1 query D023", exitCode: 0, verdict: "pass", durationMs: 19 },
      ],
    }));
    assert.equal(result.passed, true);
    assert.equal(result.discoverySource, "task-plan-prose");
    assert.deepStrictEqual(result.checks, []);
    const verdict = decideVerificationVerdict("execute-task", result);
    assert.equal(verdict.passed, true);
    assert.equal(verdict.reason, "passed");
  });

  test("gate still fails closed on a genuinely broken shell command", () => {
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      taskPlanVerify: "definitely-not-a-real-command-1628 --check",
    }));
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].exitCode, 127);
  });
});

// ─── #1628 — plan-time rejection of tool-name verifies ──────────────────────

describe("plan-time verify validation (issue #1628)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-verify-1628-"));
    mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", demo: "Demo." });
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* noop */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function taskParams(overrides: Partial<PlanTaskParams> = {}): PlanTaskParams {
    return {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      title: "Record decision",
      description: "Persist decision D023.",
      estimate: "10m",
      files: ["docs/decisions.md"],
      verify: "grep -q D023 docs/decisions.md",
      inputs: ["docs/decisions.md"],
      expectedOutput: ["docs/decisions.md"],
      ...overrides,
    };
  }

  test("gsd_plan_task rejects a verify that names a GSD tool", async () => {
    const result = await handlePlanTaskWithInvocation(
      taskParams({ verify: "gsd_exec_search limit 1 query D023" }),
      base,
      internalPlanningInvocation(),
    );
    assert.ok("error" in result);
    assert.match(result.error, /verify must be a shell command, not a GSD tool invocation/);
    assert.equal(getTask("M001", "S01", "T01"), null, "tool-name verify must not persist");
  });

  test("gsd_plan_task accepts a shell-checkable verify", async () => {
    const result = await handlePlanTaskWithInvocation(taskParams(), base, internalPlanningInvocation());
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(getTask("M001", "S01", "T01")?.verify, "grep -q D023 docs/decisions.md");
  });

  test("gsd_replan_task rejects a verify that names a GSD tool", async () => {
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Record decision", status: "pending" });
    const result = await handleReplanTaskWithInvocation(
      { ...taskParams(), verify: "gsd_milestone_status M002" },
      base,
      internalPlanningInvocation(),
    );
    assert.ok("error" in result);
    assert.match(result.error, /verify must be a shell command, not a GSD tool invocation/);
  });
});

// ─── #1630 — parent-workspace target resolution follows the task's files ────

const PARENT_WORKSPACE_PREFS = {
  workspace: {
    mode: "parent",
    repositories: {
      frontend: { path: "frontend" },
      backend: { path: "backend" },
    },
  },
} as GSDPreferences;

function fakeTaskRow(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: "T01",
    slice_id: "S01",
    milestone_id: "M001",
    title: "task",
    status: "pending",
    files: [],
    ...overrides,
  } as TaskRow;
}

describe("repository target derivation (issue #1630)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-targets-1630-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    mkdirSync(join(base, "frontend", "src"), { recursive: true });
    mkdirSync(join(base, "backend", "src"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test("root-only paths derive the orchestration root target", () => {
    const registry = createRepositoryRegistryFromPreferences(base, PARENT_WORKSPACE_PREFS);
    assert.deepEqual(
      deriveRepositoryTargetsFromPlannedPaths(registry, ["infra/main.hcl", "docs/README.md"]),
      ["project"],
    );
  });

  test("child-repo paths derive the child target; mixed paths derive both", () => {
    const registry = createRepositoryRegistryFromPreferences(base, PARENT_WORKSPACE_PREFS);
    assert.deepEqual(
      deriveRepositoryTargetsFromPlannedPaths(registry, ["frontend/src/app.ts"]),
      ["frontend"],
    );
    assert.deepEqual(
      deriveRepositoryTargetsFromPlannedPaths(registry, ["infra/main.hcl", join(base, "backend", "src", "server.ts")]),
      ["project", "backend"],
    );
    assert.deepEqual(
      deriveRepositoryTargetsFromPlannedPaths(registry, ["Update `frontend/src/app.ts` for the feature"]),
      ["frontend"],
      "prose-annotated planned paths must use the shared path extractor",
    );
  });

  test("derivation abstains outside parent mode or without usable paths", () => {
    const projectRegistry = createRepositoryRegistryFromPreferences(base, undefined);
    assert.equal(deriveRepositoryTargetsFromPlannedPaths(projectRegistry, ["infra/main.hcl"]), null);
    const parentRegistry = createRepositoryRegistryFromPreferences(base, PARENT_WORKSPACE_PREFS);
    assert.equal(deriveRepositoryTargetsFromPlannedPaths(parentRegistry, []), null);
    assert.equal(deriveRepositoryTargetsFromPlannedPaths(parentRegistry, ["  "]), null);
  });

  test("verification targets for a stored root task without targets resolve to the root", () => {
    const task = fakeTaskRow({ files: ["infra/main.hcl"] });
    const resolved = resolveVerificationRepositoryTargets(base, PARENT_WORKSPACE_PREFS, task, null);
    assert.deepEqual(resolved.repositories.map((repo) => repo.id), ["project"]);
    assert.equal(resolved.repositories[0].root, join(base));
  });

  test("verification targets for a child-repo task without targets fan out to that child only", () => {
    const task = fakeTaskRow({ files: ["frontend/src/app.ts"] });
    const resolved = resolveVerificationRepositoryTargets(base, PARENT_WORKSPACE_PREFS, task, null);
    assert.deepEqual(resolved.repositories.map((repo) => repo.id), ["frontend"]);
  });

  test("stored explicit targets win, and no-task resolution scopes to the orchestration root", () => {
    const explicit = fakeTaskRow({ files: ["infra/main.hcl"], target_repositories: ["backend"] });
    const resolvedExplicit = resolveVerificationRepositoryTargets(base, PARENT_WORKSPACE_PREFS, explicit, null);
    assert.deepEqual(resolvedExplicit.repositories.map((repo) => repo.id), ["backend"]);
    assert.equal(resolvedExplicit.explicitTargetsRequested, true);

    // #1656: with nothing explicit and nothing derivable, a parent workspace
    // verifies the orchestration root instead of fanning out to every child.
    const resolvedDefault = resolveVerificationRepositoryTargets(base, PARENT_WORKSPACE_PREFS, null, null);
    assert.deepEqual(resolvedDefault.repositories.map((repo) => repo.id), ["project"]);
  });
});

describe("plan-task parent-workspace target derivation (issue #1630)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-plan-1630-"));
    mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
    mkdirSync(join(base, "frontend", "src"), { recursive: true });
    mkdirSync(join(base, "backend", "src"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "workspace:",
        "  mode: parent",
        "  repositories:",
        "    frontend:",
        "      path: frontend",
        "    backend:",
        "      path: backend",
        "---",
      ].join("\n"),
      "utf-8",
    );
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", demo: "Demo." });
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* noop */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function taskParams(overrides: Partial<PlanTaskParams> = {}): PlanTaskParams {
    return {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      title: "Provision infra",
      description: "Create orchestration-root infra files.",
      estimate: "15m",
      files: ["infra/main.hcl"],
      verify: "test -f infra/main.hcl",
      inputs: ["infra/main.hcl"],
      expectedOutput: ["infra/main.hcl"],
      ...overrides,
    };
  }

  test("a root-targeting task stores [project] so host verification runs at the root cwd", async () => {
    const result = await handlePlanTaskWithInvocation(taskParams(), base, internalPlanningInvocation());
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const task = getTask("M001", "S01", "T01");
    assert.deepEqual(task?.target_repositories, ["project"]);

    const resolved = resolveVerificationRepositoryTargets(base, PARENT_WORKSPACE_PREFS, task, null);
    assert.deepEqual(resolved.repositories.map((repo) => repo.id), ["project"]);
  });

  test("a child-targeting task still fans out to its child repository", async () => {
    const childFile = join("frontend", "src", "app.ts");
    const result = await handlePlanTaskWithInvocation(
      taskParams({ files: [childFile], inputs: [childFile], expectedOutput: [childFile], verify: "test -f frontend/src/app.ts" }),
      base,
      internalPlanningInvocation(),
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.deepEqual(getTask("M001", "S01", "T01")?.target_repositories, ["frontend"]);
  });

  test("explicit targetRepositories still win over derivation", async () => {
    const result = await handlePlanTaskWithInvocation(
      taskParams({ targetRepositories: ["project"], files: [join("frontend", "src", "app.ts")] }),
      base,
      internalPlanningInvocation(),
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.deepEqual(getTask("M001", "S01", "T01")?.target_repositories, ["project"]);
  });

  test("replan without explicit targets heals a fossilized fan-out row to the derived target", async () => {
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Provision infra",
      status: "pending",
      planning: { targetRepositories: ["frontend", "backend"] },
    });

    const result = await handleReplanTaskWithInvocation(taskParams(), base, internalPlanningInvocation());
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.deepEqual(getTask("M001", "S01", "T01")?.target_repositories, ["project"]);
  });

  test("replan with explicit targets keeps them over derivation", async () => {
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Provision infra",
      status: "pending",
      planning: { targetRepositories: ["frontend", "backend"] },
    });

    const result = await handleReplanTaskWithInvocation(
      { ...taskParams(), targetRepositories: ["backend"] },
      base,
      internalPlanningInvocation(),
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.deepEqual(getTask("M001", "S01", "T01")?.target_repositories, ["backend"]);
  });
});
