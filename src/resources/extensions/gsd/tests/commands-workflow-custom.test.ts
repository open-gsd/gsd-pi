/**
 * commands-workflow-custom.test.ts — Tests for `/gsd workflow` subcommands
 * and catalog completions.
 *
 * Uses real temp directories with actual definition YAML files.
 */

import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";
import { closeDatabase, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { customWorkflowRunId } from "../db/custom-workflow-runs.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import { PAUSED_SESSION_KV_KEY } from "../interrupted-session.ts";
import { createRun, listRuns } from "../run-manager.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
let savedCwd: string;

function makeTmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-cmd-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // The run and resume subcommands name a run in the auto session.
  autoSession.reset();
  // The run and resume subcommands open the database of the project.
  if (isDbAvailable()) closeDatabase();
  // Restore cwd if changed during tests
  if (savedCwd && process.cwd() !== savedCwd) {
    process.chdir(savedCwd);
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
  }
  tmpDirs.length = 0;
});

before(() => {
  savedCwd = process.cwd();
});

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
    sessionManager: {
      getSessionFile: () => null,
    },
  };
}

function createMockPi() {
  return {
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on() {},
    sendMessage() {},
  };
}

/** Write a minimal valid workflow definition YAML to the expected location. */
function writeDefinition(basePath: string, name: string, content: string): void {
  const defsDir = join(basePath, ".gsd", "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, `${name}.yaml`), content, "utf-8");
}

const SIMPLE_DEF = `
version: 1
name: test-workflow
description: A test workflow
steps:
  - id: step-1
    name: First Step
    prompt: Do step 1
    requires: []
    produces: []
`;

const INVALID_DEF = `
version: 2
name: bad-workflow
steps: []
`;

// ─── Catalog Registration ────────────────────────────────────────────────

describe("workflow catalog registration", () => {
  it("model appears in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "model");
    assert.ok(entry, "model should be in TOP_LEVEL_SUBCOMMANDS");
    assert.match(entry!.desc, /session model/i);
  });

  it("getGsdArgumentCompletions('m') includes model", () => {
    const completions = getGsdArgumentCompletions("m");
    const labels = completions.map((c: any) => c.label);
    assert.ok(labels.includes("model"), "should include model completion");
  });

  it("workflow appears in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "workflow");
    assert.ok(entry, "workflow should be in TOP_LEVEL_SUBCOMMANDS");
    assert.ok(entry!.desc.includes("new"), "description should mention new");
    assert.ok(entry!.desc.includes("run"), "description should mention run");
  });

  it("getGsdArgumentCompletions('workflow ') returns the full subcommand set", () => {
    const completions = getGsdArgumentCompletions("workflow ");
    const labels = completions.map((c: any) => c.label);
    for (const sub of [
      "new", "run", "list", "info", "install", "uninstall", "validate", "pause", "resume", "approve",
    ]) {
      assert.ok(labels.includes(sub), `missing completion: ${sub}`);
    }
    assert.equal(labels.length, 10, "should have exactly 10 subcommands");
  });

  it("getGsdArgumentCompletions('workflow r') filters to run and resume", () => {
    const completions = getGsdArgumentCompletions("workflow r");
    const labels = completions.map((c: any) => c.label);
    assert.ok(labels.includes("run"), "should include run");
    assert.ok(labels.includes("resume"), "should include resume");
    assert.ok(!labels.includes("list"), "should not include list");
  });

  it("getGsdArgumentCompletions('workflow run ') returns definition names", () => {
    const base = makeTmpBase();
    writeDefinition(base, "deploy-pipeline", SIMPLE_DEF);
    writeDefinition(base, "test-suite", SIMPLE_DEF);

    // Change cwd so the completion scanner can find `.gsd/workflow-defs/`
    process.chdir(base);

    const completions = getGsdArgumentCompletions("workflow run ");
    const labels = completions.map((c: any) => c.label);
    assert.ok(labels.includes("deploy-pipeline"), "should include deploy-pipeline");
    assert.ok(labels.includes("test-suite"), "should include test-suite");
  });

  it("getGsdArgumentCompletions('workflow validate ') returns definition names", () => {
    const base = makeTmpBase();
    writeDefinition(base, "my-workflow", SIMPLE_DEF);

    process.chdir(base);

    const completions = getGsdArgumentCompletions("workflow validate ");
    const labels = completions.map((c: any) => c.label);
    assert.ok(labels.includes("my-workflow"), "should include my-workflow");
  });

  it("getGsdArgumentCompletions('workflow run d') filters by prefix", () => {
    const base = makeTmpBase();
    writeDefinition(base, "deploy-pipeline", SIMPLE_DEF);
    writeDefinition(base, "test-suite", SIMPLE_DEF);

    process.chdir(base);

    const completions = getGsdArgumentCompletions("workflow run d");
    const labels = completions.map((c: any) => c.label);
    assert.ok(labels.includes("deploy-pipeline"), "should include deploy-pipeline");
    assert.ok(!labels.includes("test-suite"), "should not include test-suite");
  });
});

// ─── Command Handler Tests ───────────────────────────────────────────────

describe("workflow command handler", () => {
  // Dynamically import the handler so module-level side effects
  // don't break when auto.ts pulls in heavy runtime deps.
  // We test the pure routing logic by calling handleWorkflowCommand directly.

  async function callHandler(trimmed: string) {
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.ts");
    const ctx = createMockCtx();
    const pi = createMockPi();
    const handled = await handleWorkflowCommand(trimmed, ctx as any, pi as any);
    return { handled, notifications: ctx.notifications };
  }

  it("bare '/gsd workflow' lists plugins grouped by mode", async () => {
    const { handled, notifications } = await callHandler("workflow");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("Workflow Plugins")),
      "should list plugins",
    );
  });

  it("'/gsd workflow new' shows skill invocation message", async () => {
    const { handled, notifications } = await callHandler("workflow new");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("create-workflow")),
      "should mention create-workflow skill",
    );
  });

  it("'/gsd workflow run' without name shows usage warning", async () => {
    const { handled, notifications } = await callHandler("workflow run");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.message.includes("Usage")),
      "should show usage warning",
    );
  });

  it("preserves quoted workflow run overrides (#4130)", async () => {
    const { parseWorkflowRunArgs } = await import("../commands/handlers/workflow.ts");
    assert.deepStrictEqual(
      parseWorkflowRunArgs('demo-workflow target="multi word target" region=\'us east\''),
      {
        defName: "demo-workflow",
        overrides: {
          target: "multi word target",
          region: "us east",
        },
      },
    );
  });

  it("'/gsd workflow run nonexistent' shows error for missing definition", async () => {
    const { handled, notifications } = await callHandler("workflow run nonexistent-def-12345");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.message.includes("not found")),
      "should show definition-not-found error",
    );
  });

  it("'/gsd workflow validate' without name shows usage warning", async () => {
    const { handled, notifications } = await callHandler("workflow validate");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.message.includes("Usage")),
      "should show usage warning",
    );
  });

  it("'/gsd workflow validate nonexistent' shows definition not found", async () => {
    const { handled, notifications } = await callHandler("workflow validate nonexistent-def-12345");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.message.includes("not found")),
      "should show not-found error",
    );
  });

  it("'/gsd workflow pause' without custom engine shows warning", async () => {
    const { handled, notifications } = await callHandler("workflow pause");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning"),
      "should show warning when no custom workflow is running",
    );
  });

  it("'/gsd workflow resume' without custom engine shows warning", async () => {
    const { handled, notifications } = await callHandler("workflow resume");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning"),
      "should show warning when no custom workflow to resume",
    );
  });

  it("'/gsd workflow resume <run>' for an unknown run shows an error", async () => {
    const base = makeTmpBase();
    mkdirSync(join(base, ".gsd"));
    process.chdir(base);
    const { handled, notifications } = await callHandler("workflow resume no-such-workflow/2026-01-01T00-00-00");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.message.includes("no such run")),
      "should show the unknown-run error",
    );
  });

  /**
   * Call a subcommand that starts auto-mode. The start is detached, so wait
   * until it ends. An invalid GSD_PROJECT_ID ends it at the first check of the
   * session bootstrap, before a model is called.
   */
  async function callAutoStartingHandler(t: { after(fn: () => void): void }, trimmed: string) {
    const priorProjectId = process.env.GSD_PROJECT_ID;
    process.env.GSD_PROJECT_ID = "invalid project id";
    t.after(() => {
      if (priorProjectId === undefined) delete process.env.GSD_PROJECT_ID;
      else process.env.GSD_PROJECT_ID = priorProjectId;
    });
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.ts");
    const ctx = {
      ...createMockCtx(),
      sessionManager: { getSessionFile: () => null, getSessionId: () => "workflow-command-test" },
      modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false },
      model: undefined,
    };
    const pi = { ...createMockPi(), getThinkingLevel: () => "off" };
    await handleWorkflowCommand(trimmed, ctx as any, pi as any);
    const deadline = Date.now() + 10_000;
    const ended = () => ctx.notifications.some((n) =>
      n.level === "error" || n.message.includes("GSD_PROJECT_ID must contain only"));
    while (!ended() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return ctx.notifications;
  }

  for (const command of ["workflow run home-notes", "workflow home-notes"]) {
    it(`'/gsd ${command}' creates the run in a project with no .gsd directory`, async (t) => {
      // The definition is a global plugin, so the project needs no .gsd directory for it.
      const home = makeTmpBase();
      mkdirSync(join(home, "workflows"));
      writeFileSync(join(home, "workflows", "home-notes.yaml"), SIMPLE_DEF.replace("test-workflow", "home-notes"), "utf-8");
      const priorHome = process.env.GSD_HOME;
      process.env.GSD_HOME = home;
      t.after(() => {
        if (priorHome === undefined) delete process.env.GSD_HOME;
        else process.env.GSD_HOME = priorHome;
      });
      const base = realpathSync(makeTmpBase());
      process.chdir(base);

      const notifications = await callAutoStartingHandler(t, command);

      assert.ok(
        notifications.some((n) => n.message.includes("Created workflow run: home-notes")),
        notifications.map((n) => n.message).join(" | "),
      );
      // The run is database rows, and auto-mode started on it.
      const [run] = listRuns(base, "home-notes");
      assert.equal(run?.steps.total, 1);
      assert.equal(existsSync(join(run!.runDir, "GRAPH.yaml")), true);
      assert.equal(autoSession.activeRunDir, run!.runDir);
      assert.ok(notifications.some((n) => n.message.includes("GSD_PROJECT_ID must contain only")),
        "auto-mode start reached the session bootstrap");
    });
  }

  it("'/gsd workflow resume <run>' starts the named run when another run has a pause record", async (t) => {
    const base = realpathSync(makeTmpBase());
    for (const name of ["alpha", "beta"]) writeDefinition(base, name, SIMPLE_DEF.replace("test-workflow", name));
    openDatabase(join(base, ".gsd", "gsd.db"));
    const alphaDir = createRun(base, "alpha");
    const betaDir = createRun(base, "beta");
    // alpha paused in an earlier process: its pause record is in runtime_kv.
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      activeEngineId: "custom",
      activeRunDir: alphaDir,
      originalBasePath: base,
    });
    process.chdir(base);

    const notifications = await callAutoStartingHandler(t, `workflow resume ${customWorkflowRunId(betaDir)}`);

    const messages = notifications.map((n) => n.message);
    assert.ok(messages.some((m) => m.includes("GSD_PROJECT_ID must contain only")),
      `auto-mode start reached the session bootstrap, got: ${messages.join(" | ")}`);
    assert.ok(!messages.some((m) => m.includes("Resuming paused custom workflow")), messages.join(" | "));
    assert.equal(autoSession.activeRunDir, betaDir);
    assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
    // The run that the session dispatches is beta. alpha did not start.
    const engine = new CustomWorkflowEngine(autoSession.activeRunDir!);
    const action = await engine.resolveDispatch(await engine.deriveState(base), { basePath: base });
    assert.equal(action.action === "dispatch" ? action.step.unitId : action.action, "beta/step-1");
    assert.equal(listRuns(base, "alpha")[0]?.status, "pending");
  });

  it("'/gsd workflow unknown-sub' shows unknown subcommand", async () => {
    const { handled, notifications } = await callHandler("workflow blurble");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("Unknown workflow subcommand")),
      "should show unknown subcommand message",
    );
  });

  it("'/gsd workflow list' with no runs shows empty message", async () => {
    const { handled, notifications } = await callHandler("workflow list");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("No workflow runs found")),
      "should show no runs message",
    );
  });

  it("non-workflow commands are not intercepted by custom workflow routing", async () => {
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.ts");
    const ctx = createMockCtx();
    const pi = createMockPi();
    // "queue" does not start with "workflow" so the custom routing should not handle it.
    // The function may still handle it via its existing dev-workflow routing, but it
    // should not be captured by the custom workflow `if` block.
    // We verify this by checking that a clearly non-workflow command like "somethingelse"
    // returns false (unhandled).
    const handled = await handleWorkflowCommand("somethingelse", ctx as any, pi as any);
    assert.equal(handled, false, "non-workflow commands should return false");
  });
});
