// Project/App: gsd-pi
// File Purpose: Tests workflow MCP launch config, tool surface, and stdio elicitation behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  buildWorkflowMcpServers,
  detectWorkflowMcpLaunchConfig,
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForAutoUnit,
  getRequiredWorkflowToolsForGuidedUnit,
  resolveWorkflowMcpProjectRoot,
  isWorkflowMcpSurfaceTool,
  supportsStructuredQuestions,
  usesWorkflowMcpTransport,
} from "../workflow-mcp.ts";
import { DB_WORKFLOW_TOOL_NAMES } from "../workflow-tool-surface.ts";
import { UNIT_TOOL_CONTRACTS } from "../unit-tool-contracts.ts";

const MCP_STDIO_TIMEOUT_MS = 90_000;

type ElicitPayload = {
  message: string;
  requestedSchema: { properties: Record<string, unknown>; required?: string[] };
};

function extractElicitPayload(request: unknown): ElicitPayload {
  const payload = (request as { params?: unknown }).params ?? request;
  return payload as ElicitPayload;
}

test("resolveWorkflowMcpProjectRoot maps milestone worktree cwd to project root", () => {
  const projectRoot = "/tmp/my-project";
  const worktrees = [
    join(projectRoot, ".gsd-worktrees", "M001-abc"),
    join(projectRoot, ".gsd", "worktrees", "M002-abc"),
  ];
  for (const worktree of worktrees) {
    assert.equal(resolveWorkflowMcpProjectRoot(worktree), projectRoot);
  }
  assert.equal(resolveWorkflowMcpProjectRoot(projectRoot), projectRoot);
});

test("guided execute-task requires canonical task completion tool", () => {
  const expected = [
    "gsd_task_complete",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_capture_thought",
  ];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("execute-task"), expected);
});

test("auto execute-task requires canonical task completion tool", () => {
  const expected = [
    "gsd_task_complete",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_capture_thought",
  ];
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("execute-task"), expected);
});

test("plan-slice requires slice + incremental task planning and roadmap reassessment tools", () => {
  // Incremental planning (#1027): gsd_plan_slice persists metadata, then
  // gsd_plan_task adds tasks one at a time, so both must be on the surface.
  const expected = ["gsd_plan_slice", "gsd_plan_task", "gsd_reassess_roadmap"];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("plan-slice"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("plan-slice"), expected);
});

test("plan-milestone requires status, roadmap, and slice + task planning tools", () => {
  // gsd_plan_task is required alongside gsd_plan_slice for incremental
  // milestone planning (#1027).
  const expected = ["gsd_milestone_status", "gsd_plan_milestone", "gsd_plan_slice", "gsd_plan_task"];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("plan-milestone"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("plan-milestone"), expected);
});

test("refine-slice requires canonical slice planning tool", () => {
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("refine-slice"), ["gsd_plan_slice"]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("refine-slice"), ["gsd_plan_slice"]);
});

test("complete-slice requires status, closeout, and execution handoff tools", () => {
  const expected = [
    "gsd_milestone_status",
    "gsd_exec",
    "gsd_capture_thought",
    "gsd_slice_complete",
    "gsd_task_reopen",
    "gsd_replan_slice",
    "gsd_replan_task",
    "gsd_rework_brief_save",
    "gsd_requirement_update",
    "gsd_summary_save",
  ];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("complete-slice"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("complete-slice"), expected);
});

test("complete-milestone requires status, requirement, project refresh, and closeout tools", () => {
  const expected = [
    "gsd_milestone_status",
    "gsd_requirement_update",
    "gsd_summary_save",
    "gsd_complete_milestone",
  ];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("complete-milestone"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("complete-milestone"), expected);
});

test("reactive-execute requires task completion and failed-task summary tools", () => {
  const expected = ["gsd_task_complete", "gsd_summary_save"];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("reactive-execute"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("reactive-execute"), expected);
});

test("workflow MCP capability surface includes native legacy gsd aliases", () => {
  const err = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_save_summary", "gsd_milestone_plan", "gsd_slice_plan"],
    {
      authMode: "externalCli",
      baseUrl: "local://test",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      projectRoot: "/tmp/project",
    },
  );

  assert.equal(err, null);
});

test("workflow MCP capability surface includes every shared workflow contract tool", () => {
  for (const name of DB_WORKFLOW_TOOL_NAMES) {
    assert.equal(isWorkflowMcpSurfaceTool(name), true, `${name} should be in workflow MCP surface`);
  }
});

test("workflow MCP capability surface preserves session and read tools outside DB contracts", () => {
  for (const name of ["gsd_execute", "gsd_status", "gsd_progress", "gsd_doctor", "gsd_graph"]) {
    assert.equal(isWorkflowMcpSurfaceTool(name), true, `${name} should stay in workflow MCP surface`);
  }
});

test("deep project setup units declare required workflow MCP tools", () => {
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("discuss-project"), [
    "ask_user_questions",
    "gsd_summary_save",
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("discuss-requirements"), [
    "ask_user_questions",
    "gsd_requirement_save",
    "gsd_summary_save",
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("research-decision"), [
    "ask_user_questions",
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("discuss-project"), [
    "ask_user_questions",
    "gsd_summary_save",
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("discuss-requirements"), [
    "ask_user_questions",
    "gsd_requirement_save",
    "gsd_summary_save",
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("research-decision"), [
    "ask_user_questions",
  ]);
});

test("detectWorkflowMcpLaunchConfig prefers explicit env override", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_NAME: "workflow-tools",
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["dist/cli.js"]),
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ FOO: "bar" }),
    GSD_WORKFLOW_MCP_CWD: "/tmp/project",
    GSD_CLI_PATH: "/tmp/gsd",
  });

  assert.deepEqual(launch, {
    name: "workflow-tools",
    command: "node",
    args: ["dist/cli.js"],
    cwd: "/tmp/project",
    env: launch?.env,
  });
  assert.equal(launch?.env?.FOO, "bar");
  assert.equal(launch?.env?.GSD_CLI_PATH, "/tmp/gsd");
  assert.equal(launch?.env?.GSD_BIN_PATH, "/tmp/gsd");
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});

test("detectWorkflowMcpLaunchConfig normalizes explicit workflow MCP env CLI aliases", () => {
  const binOnly = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_BIN_PATH: "/tmp/gsd-bin" }),
  });
  assert.equal(binOnly?.env?.GSD_CLI_PATH, "/tmp/gsd-bin");
  assert.equal(binOnly?.env?.GSD_BIN_PATH, "/tmp/gsd-bin");

  const cliOnly = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd-cli" }),
  });
  assert.equal(cliOnly?.env?.GSD_CLI_PATH, "/tmp/gsd-cli");
  assert.equal(cliOnly?.env?.GSD_BIN_PATH, "/tmp/gsd-cli");
});

test("buildWorkflowMcpServers mirrors explicit launch config", () => {
  const servers = buildWorkflowMcpServers("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["dist/cli.js"]),
  });

  assert.deepEqual(servers, {
    "gsd-workflow": {
      command: "node",
      args: ["dist/cli.js"],
      env: servers?.["gsd-workflow"]?.env,
    },
  });
  assert.equal((servers?.["gsd-workflow"]?.env as Record<string, string> | undefined)?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal((servers?.["gsd-workflow"]?.env as Record<string, string> | undefined)?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match((servers?.["gsd-workflow"]?.env as Record<string, string> | undefined)?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match((servers?.["gsd-workflow"]?.env as Record<string, string> | undefined)?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});

test("detectWorkflowMcpLaunchConfig resolves the bundled server from GSD_PROJECT_ROOT", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-worktree-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");

  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");

  const launch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
    GSD_PROJECT_ROOT: repoRoot,
  });

  assert.deepEqual(launch, {
    name: "gsd-workflow",
    command: process.execPath,
    args: [cliPath],
    cwd: repoRoot,
    env: launch?.env,
  });
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, repoRoot);
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});

test("detectWorkflowMcpLaunchConfig resolves the bundled server from GSD_BIN_PATH ancestry", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-worktree-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");
  const devCliPath = join(repoRoot, "scripts", "dev-cli.js");

  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  mkdirSync(join(repoRoot, "scripts"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");
  writeFileSync(devCliPath, "#!/usr/bin/env node\n", "utf-8");

  const launch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
    GSD_BIN_PATH: devCliPath,
  });

  assert.deepEqual(launch, {
    name: "gsd-workflow",
    command: process.execPath,
    args: [realpathSync(cliPath)],
    cwd: worktreeRoot,
    env: launch?.env,
  });
  assert.equal(launch?.env?.GSD_CLI_PATH, devCliPath);
  assert.equal(launch?.env?.GSD_BIN_PATH, devCliPath);
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, worktreeRoot);
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});

test("detectWorkflowMcpLaunchConfig memoizes repo root discovery for the same deep GSD_BIN_PATH", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-cache-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-cache-wt-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");
  const devCliPath = join(repoRoot, ".gsd", "worktrees", "M001", "S01", "deep", "bin", "gsd");

  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  mkdirSync(join(repoRoot, ".gsd", "worktrees", "M001", "S01", "deep", "bin"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");
  writeFileSync(devCliPath, "#!/usr/bin/env node\n", "utf-8");

  try {
    const firstLaunch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
      GSD_BIN_PATH: devCliPath,
    });
    assert.equal(firstLaunch?.args?.[0], realpathSync(cliPath));

    rmSync(cliPath, { force: true });

    const secondLaunch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
      GSD_BIN_PATH: devCliPath,
    });
    assert.equal(
      secondLaunch?.args?.[0],
      join(realpathSync(repoRoot), "packages", "mcp-server", "dist", "cli.js"),
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("detectWorkflowMcpLaunchConfig resolves the bundled server from a symlinked GSD_BIN_PATH", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-symlink-root-"));
  const binDir = mkdtempSync(join(tmpdir(), "gsd-workflow-symlink-bin-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-symlink-wt-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");
  const devCliPath = join(repoRoot, "scripts", "dev-cli.js");
  const symlinkPath = join(binDir, "gsd");

  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  mkdirSync(join(repoRoot, "scripts"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");
  writeFileSync(devCliPath, "#!/usr/bin/env node\n", "utf-8");
  symlinkSync(devCliPath, symlinkPath);

  try {
    const launch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
      GSD_BIN_PATH: symlinkPath,
    });

    assert.ok(launch, "expected a launch config when GSD_BIN_PATH is a symlink");
    assert.deepEqual(launch, {
      name: "gsd-workflow",
      command: process.execPath,
      args: [realpathSync(cliPath)],
      cwd: worktreeRoot,
      env: launch?.env,
    });
    assert.equal(launch?.env?.GSD_CLI_PATH, symlinkPath);
    assert.equal(launch?.env?.GSD_BIN_PATH, symlinkPath);
    assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
    assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, worktreeRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("detectWorkflowMcpLaunchConfig resolves the bundled server relative to the installed GSD package", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_BIN_PATH: "/tmp/gsd-loader.js",
  });

  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.cwd, "/tmp/project");
  assert.equal(launch?.env?.GSD_CLI_PATH, "/tmp/gsd-loader.js");
  assert.equal(launch?.env?.GSD_BIN_PATH, "/tmp/gsd-loader.js");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
  assert.equal(typeof launch?.args?.[0], "string");
  assert.match(launch?.args?.[0] ?? "", /packages[\/\\]mcp-server[\/\\](dist[\/\\]cli\.js|src[\/\\]cli\.ts)$/);
  if ((launch?.args?.[0] ?? "").endsWith(".ts")) {
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }
});

test("detectWorkflowMcpLaunchConfig resolves the bundled server relative to the package without env hints", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {});

  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.cwd, "/tmp/project");
  assert.equal(launch?.env?.GSD_CLI_PATH, undefined);
  assert.equal(launch?.env?.GSD_BIN_PATH, undefined);
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
  assert.equal(typeof launch?.args?.[0], "string");
  assert.match(launch?.args?.[0] ?? "", /packages[\/\\]mcp-server[\/\\](dist[\/\\]cli\.js|src[\/\\]cli\.ts)$/);
  if ((launch?.args?.[0] ?? "").endsWith(".ts")) {
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }
});

test("workflow MCP launch config reaches mutation tools over stdio", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-transport-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  // Isolate the spawned MCP server from the developer's real ~/.gsd so it
  // can't pick up a configured Discord/Slack/Telegram channel from global
  // PREFERENCES.md and route ask_user_questions through a remote adapter
  // instead of MCP elicitation.
  const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-workflow-home-"));

  const launch = detectWorkflowMcpLaunchConfig(projectRoot, {});
  assert.ok(launch, "expected a workflow MCP launch config");
  assert.match(
    launch.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "",
    /(dist[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]tools[\/\\]workflow-tool-executors\.js|src[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]tools[\/\\]workflow-tool-executors\.(js|ts))$/,
  );
  assert.match(
    launch.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "",
    /(dist[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]bootstrap[\/\\]write-gate\.js|src[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]bootstrap[\/\\]write-gate\.(js|ts))$/,
  );
  if ((launch.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "").endsWith(".ts")) {
    assert.match(launch.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }

  const client = new Client(
    { name: "workflow-mcp-transport-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const elicitation = extractElicitPayload(request as unknown);

    assert.match(elicitation.message, /Please answer the following question/);
    assert.ok(elicitation.requestedSchema.properties.transport_mode);
    assert.ok(elicitation.requestedSchema.properties["transport_mode__note"]);
    assert.ok(elicitation.requestedSchema.required?.includes("transport_mode"));

    return {
      action: "accept",
      content: {
        transport_mode: "None of the above",
        transport_mode__note: "Need Windows-safe MCP elicitation.",
      },
    };
  });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...process.env,
      ...launch.env,
      GSD_HOME: isolatedGsdHome,
      DISCORD_BOT_TOKEN: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    } as Record<string, string>,
    cwd: launch.cwd,
    stderr: "pipe",
  });

  try {
    await client.connect(transport, { timeout: MCP_STDIO_TIMEOUT_MS });

    const tools = await client.listTools(undefined, { timeout: MCP_STDIO_TIMEOUT_MS });
    assert.ok(
      (tools.tools ?? []).some((tool) => tool.name === "gsd_plan_slice"),
      "expected workflow MCP surface to expose gsd_plan_slice",
    );
    assert.ok(
      (tools.tools ?? []).some((tool) => tool.name === "ask_user_questions"),
      "expected workflow MCP surface to expose ask_user_questions",
    );

    const askResult = await client.callTool(
      {
        name: "ask_user_questions",
        arguments: {
          questions: [
            {
              id: "transport_mode",
              header: "Transport",
              question: "How should the workflow prompt be delivered?",
              options: [
                { label: "Local UI", description: "Use the host tool UI." },
                { label: "Remote UI", description: "Use a remote response channel." },
              ],
            },
          ],
        },
      },
      undefined,
      { timeout: MCP_STDIO_TIMEOUT_MS },
    );
    assert.equal(askResult.isError, undefined);
    assert.equal(
      ((askResult.content as Array<{ text?: string }>)?.[0])?.text ?? "",
      JSON.stringify({
        answers: {
          transport_mode: {
            answers: ["None of the above", "user_note: Need Windows-safe MCP elicitation."],
          },
        },
      }),
    );

    const milestoneResult = await client.callTool(
      {
        name: "gsd_plan_milestone",
        _meta: { "io.opengsd/idempotency-key": "workflow-mcp-transport-milestone" },
        arguments: {
          projectDir: projectRoot,
          milestoneId: "M001",
          title: "Transport planning",
          vision: "Verify stdio workflow MCP uses the executor bridge.",
          slices: [
            {
              sliceId: "S01",
              title: "Bridge path",
              risk: "low",
              depends: [],
              demo: "Milestone planning succeeds over stdio MCP.",
              goal: "Prove the executor bridge works in the spawned server.",
              successCriteria: "gsd_plan_slice can write plan artifacts.",
              proofLevel: "integration",
              integrationClosure: "Stdio MCP client reaches the workflow executor bridge.",
              observabilityImpact: "Regression test covers the spawned-server path.",
            },
          ],
        },
      },
      undefined,
      { timeout: MCP_STDIO_TIMEOUT_MS },
    );
    assert.equal(milestoneResult.isError, undefined);
    assert.match(
      ((milestoneResult.content as Array<{ text?: string }>)?.[0])?.text ?? "",
      /Planned milestone M001/,
    );

    const sliceResult = await client.callTool(
      {
        name: "gsd_plan_slice",
        _meta: { "io.opengsd/idempotency-key": "workflow-mcp-transport-slice" },
        arguments: {
          projectDir: projectRoot,
          milestoneId: "M001",
          sliceId: "S01",
          goal: "Persist slice planning over the spawned MCP transport.",
          tasks: [
            {
              taskId: "T01",
              title: "Connect the bridge",
              description: "Ensure the workflow executor bridge resolves in the child process.",
              estimate: "10m",
              files: ["src/resources/extensions/gsd/workflow-mcp.ts"],
              verify: "node --test",
              inputs: [],
              expectedOutput: ["src/bridge-status.md"],
              requiredWorkflowTools: [],
            },
          ],
        },
      },
      undefined,
      { timeout: MCP_STDIO_TIMEOUT_MS },
    );
    assert.equal(sliceResult.isError, undefined);
    assert.match(
      ((sliceResult.content as Array<{ text?: string }>)?.[0])?.text ?? "",
      /Planned slice S01/,
    );
    // Flat-phase: M001 title "Transport planning" → phases/01-transport-planning/01-01-PLAN.md
    assert.ok(
      existsSync(join(projectRoot, ".gsd", "phases", "01-transport-planning", "01-01-PLAN.md")),
      "expected slice plan artifact to be written through stdio MCP",
    );
    // Flat-phase: tasks are checkboxes in the slice plan file, no per-task plan files.
  } finally {
    await client.close().catch(() => {});
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  }
});

test("workflow MCP stdio surface exposes every unit's required workflow tool", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-all-unit-tools-"));
  const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-workflow-all-unit-home-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  const launch = detectWorkflowMcpLaunchConfig(projectRoot, {});
  assert.ok(launch, "expected a workflow MCP launch config");

  const client = new Client({ name: "workflow-mcp-contract-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...process.env,
      ...launch.env,
      GSD_HOME: isolatedGsdHome,
      DISCORD_BOT_TOKEN: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    } as Record<string, string>,
    cwd: launch.cwd,
    stderr: "pipe",
  });

  try {
    await client.connect(transport, { timeout: MCP_STDIO_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { timeout: MCP_STDIO_TIMEOUT_MS });
    const exposedTools = new Set((listed.tools ?? []).map((tool) => tool.name));

    for (const [unitType, contract] of Object.entries(UNIT_TOOL_CONTRACTS)) {
      for (const toolName of contract.requiredWorkflowTools) {
        if (!toolName.startsWith("gsd_") && toolName !== "ask_user_questions") continue;
        assert.ok(
          exposedTools.has(toolName),
          `${unitType} requires ${toolName}, but workflow MCP exposed ${JSON.stringify([...exposedTools].sort())}`,
        );
      }
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  }
});

test("workflow MCP ask_user_questions uses stdio elicitation round-trip", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-elicit-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-workflow-home-"));

  const launch = detectWorkflowMcpLaunchConfig(projectRoot, {});
  assert.ok(launch, "expected a workflow MCP launch config");

  const client = new Client(
    { name: "workflow-mcp-elicit-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  let requestSeen: {
    message: string;
    requestedSchema: { properties: Record<string, unknown>; required?: string[] };
  } | null = null;

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = extractElicitPayload(request as unknown);

    requestSeen = params;

    return {
      action: "accept",
      content: {
        deployment: "None of the above",
        deployment__note: "Need hybrid deployment.",
      },
    };
  });

  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...process.env,
      ...launch.env,
      GSD_HOME: isolatedGsdHome,
      DISCORD_BOT_TOKEN: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    } as Record<string, string>,
    cwd: launch.cwd,
    stderr: "pipe",
  });

  try {
    await client.connect(transport, { timeout: MCP_STDIO_TIMEOUT_MS });

    const result = await client.callTool(
      {
        name: "ask_user_questions",
        arguments: {
          questions: [
            {
              id: "deployment",
              header: "Deploy",
              question: "Where will this run?",
              options: [
                { label: "Cloud", description: "Managed hosting." },
                { label: "On-prem", description: "Runs in customer infrastructure." },
              ],
            },
          ],
        },
      },
      undefined,
      { timeout: MCP_STDIO_TIMEOUT_MS },
    );

    assert.ok(requestSeen, "expected stdio transport to forward an elicitation request");
    const seen = requestSeen as ElicitPayload;
    assert.match(seen.message, /Please answer the following question/);
    assert.ok(seen.requestedSchema.properties.deployment);
    assert.ok(seen.requestedSchema.properties.deployment__note);
    assert.ok(seen.requestedSchema.required?.includes("deployment"));

    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const text = content.find((item: { type: string; text?: string }) => item.type === "text");
    assert.ok(text && "text" in text);
    assert.equal(
      text.text,
      JSON.stringify({
        answers: {
          deployment: {
            answers: ["None of the above", "user_note: Need hybrid deployment."],
          },
        },
      }),
    );
  } finally {
    await client.close();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  }
});

test("usesWorkflowMcpTransport matches local externalCli providers", () => {
  assert.equal(usesWorkflowMcpTransport("externalCli", "local://claude-code"), true);
  assert.equal(usesWorkflowMcpTransport("externalCli", "https://api.example.com"), false);
  assert.equal(usesWorkflowMcpTransport("oauth", "local://custom"), false);
});

test("supportsStructuredQuestions recognizes workflow MCP question tools", () => {
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: {},
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions(["mcp__gsd-workflow__ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: {},
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions(["mcp__gsd-workflow__*"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: {},
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions(["mcp__gsd-browser__*"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: {},
    }),
    false,
  );
  assert.equal(
    supportsStructuredQuestions(["mcp__gsd-workflow__ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: { GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS: "0" } as NodeJS.ProcessEnv,
    }),
    false,
  );
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions([], {
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
    }),
    false,
  );
});

test("supportsStructuredQuestions gates non-local externalCli providers", () => {
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      env: {},
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "https://api.example.com",
      env: {},
    }),
    true,
  );
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      env: { GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS: "0" } as NodeJS.ProcessEnv,
    }),
    false,
  );
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "https://api.example.com",
      env: { GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS: "0" } as NodeJS.ProcessEnv,
    }),
    false,
  );
});

test("transport compatibility passes when required tools fit current MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_task_complete"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "guided flow",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility discovers the bundled MCP server without env overrides", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_task_complete"],
    {
      projectRoot: "/tmp/project",
      env: {},
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows auto execute-task over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_complete_task"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility ignores API-backed providers", () => {
  const error = getWorkflowTransportSupportError(
    "openai-codex",
    ["gsd_plan_slice"],
    {
      projectRoot: "/tmp/project",
      env: {},
      surface: "auto-mode",
      unitType: "plan-slice",
      authMode: "oauth",
      baseUrl: "https://api.openai.com",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows plan-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    getRequiredWorkflowToolsForAutoUnit("plan-slice"),
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "plan-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows complete-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    getRequiredWorkflowToolsForAutoUnit("complete-slice"),
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "complete-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows reassess-roadmap over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_milestone_status", "gsd_reassess_roadmap"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "reassess-roadmap",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows gate-evaluate over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_save_gate_result"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "gate-evaluate",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows validate-milestone over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    getRequiredWorkflowToolsForAutoUnit("validate-milestone"),
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "validate-milestone",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows complete-milestone over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    getRequiredWorkflowToolsForAutoUnit("complete-milestone"),
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "complete-milestone",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility now allows replan-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_replan_slice"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "replan-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility accepts workflow MCP tools absent from parent active tool surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_summary_save"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "run-uat",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      activeTools: ["ScheduleWakeup", "ToolSearch", "bash", "read", "write"],
    },
  );

  assert.equal(error, null);
});

test("transport compatibility still checks non-MCP tools against parent active tool surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_summary_save", "secure_env_collect"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "run-uat",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      activeTools: ["ScheduleWakeup", "ToolSearch", "bash", "read", "write"],
    },
  );

  assert.match(error ?? "", /requires secure_env_collect/);
  assert.doesNotMatch(error ?? "", /gsd_summary_save/);
});

test("transport compatibility allows plan-slice MCP tools when parent surface is scoped (regression #457)", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    getRequiredWorkflowToolsForAutoUnit("plan-slice"),
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "plan-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      activeTools: [
        "ScheduleWakeup",
        "ToolSearch",
        "ask_user_questions",
        "async_bash",
        "await_job",
        "bash",
        "bg_shell",
        "cancel_job",
        "capture_thought",
        "discover_configs",
        "edit",
        "fetch_page",
        "get_library_docs",
        "gsd_checkpoint_db",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_milestone_status",
        "gsd_resume",
        "mcp_call",
        "mcp_discover",
        "mcp_servers",
        "memory_query",
        "read",
        "resolve_library",
        "secure_env_collect",
        "subagent",
        "write",
      ],
    },
  );

  assert.equal(error, null);
});

test("transport compatibility still blocks units whose MCP tools are not exposed", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["secure_env_collect"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "guided-discussion",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.match(error ?? "", /requires secure_env_collect/);
  assert.match(error ?? "", /currently exposes only/);
});

test("discuss-milestone guided flow does not abort when all required tools are on MCP surface (regression #469)", () => {
  // Guided flow starts the workflow MCP server as part of dispatch, so the
  // parent session active-tool list is not authoritative for MCP tools.
  const discussMilestoneTools = [
    "ask_user_questions",
    "gsd_summary_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
  ];
  const error = getWorkflowTransportSupportError(
    "claude-code",
    discussMilestoneTools,
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "guided flow",
      unitType: "discuss-milestone",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
    },
  );

  assert.equal(error, null);
});

test("transport compatibility accepts MCP-namespaced runtime tools", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_summary_save"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "research-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      activeTools: ["mcp__gsd-workflow__gsd_summary_save"],
    },
  );

  assert.equal(error, null);
});
