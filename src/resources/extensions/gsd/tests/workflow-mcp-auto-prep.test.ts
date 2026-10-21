import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GSD_BROWSER_MCP_SERVER_NAME, GSD_WORKFLOW_MCP_SERVER_NAME } from "../mcp-project-config.ts";
import { prepareWorkflowMcpForProject, shouldAutoPrepareWorkflowMcp } from "../workflow-mcp-auto-prep.ts";

test("shouldAutoPrepareWorkflowMcp enables prep for externalCli local transport", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getProviderAuthMode: () => "externalCli",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp enables prep when Claude Code provider is known before auth mode settles", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
  });

  assert.equal(result, true);
});

test("prepareWorkflowMcpForProject uses the selected unit model when session provider differs", (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-unit-model-"));
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" | "success" }> = [];

  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "openai", baseUrl: "https://api.openai.com" },
      modelRegistry: {
        getProviderAuthMode: (provider: string) => provider === "claude-code" ? "externalCli" : "apiKey",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error" | "success") => {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    },
    projectRoot,
    { provider: "claude-code", baseUrl: "local://claude-code" },
  );

  assert.equal(result?.status, "created");
  assert.equal(existsSync(join(projectRoot, ".mcp.json")), true);
  assert.match(notifications.map((entry) => entry.message).join("\n"), /GSD MCP Server Prepared/);
});

test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is ready", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: (provider: string) => provider === "claude-code",
    },
  });

  assert.equal(result, false);
});

test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is registered", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: (provider: string) => provider === "claude-code" ? "externalCli" : "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, false);
});

test("shouldAutoPrepareWorkflowMcp stays disabled when neither transport nor provider readiness match", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, false);
});

test("prepareWorkflowMcpForProject warns with /gsd mcp init guidance when prep fails", () => {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" | "success" }> = [];
  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error" | "success") => {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    },
    "/",
  );

  assert.equal(result, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Please run \/gsd mcp init \./);
});

test("before_agent_start auto-prepares project workflow MCP for Claude Code CLI", async (t) => {
  const { registerHooks } = await import("../bootstrap/register-hooks.ts");
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-before-agent-"));
  const originalCwd = process.cwd();
  const notifications: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
  };

  t.after(() => {
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  process.chdir(projectRoot);
  registerHooks(pi as any, []);

  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart, "before_agent_start hook should be registered");

  await beforeAgentStart(
    { prompt: "hello", systemPrompt: "base" },
    {
      cwd: projectRoot,
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setWidget() {},
      },
    },
  );

  const configPath = join(projectRoot, ".mcp.json");
  assert.equal(existsSync(configPath), true, "Claude Code CLI turns should create project MCP config");

  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
    mcpServers?: Record<string, unknown>;
  };
  assert.ok(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME]);
  assert.ok(parsed.mcpServers?.[GSD_BROWSER_MCP_SERVER_NAME]);
  const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf-8")) as {
    enabledMcpjsonServers?: string[];
  };
  assert.deepEqual(settings.enabledMcpjsonServers, [
    GSD_WORKFLOW_MCP_SERVER_NAME,
    GSD_BROWSER_MCP_SERVER_NAME,
  ]);
  assert.match(notifications.join("\n"), /GSD MCP Server Prepared/);
});

test("before_agent_start returns discovered skill fallback without project .gsd", async (t) => {
  const { registerHooks } = await import("../bootstrap/register-hooks.ts");
  const { clearSkillSnapshot, snapshotSkills } = await import("../skill-discovery.js");
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-skill-before-agent-"));
  const skillHome = mkdtempSync(join(tmpdir(), "gsd-skill-home-"));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalGsdHome = process.env.GSD_HOME;
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
  };

  t.after(() => {
    process.chdir(originalCwd);
    clearSkillSnapshot();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = originalGsdHome;
    }
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(skillHome, { recursive: true, force: true });
  });

  process.env.HOME = skillHome;
  process.env.GSD_HOME = join(skillHome, ".gsd");
  process.chdir(projectRoot);
  snapshotSkills();

  const skillDir = join(skillHome, ".agents", "skills", "late-skill");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, "---\nname: late-skill\ndescription: Use for late skill.\n---\n\n# late-skill\n");

  registerHooks(pi as any, []);
  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart, "before_agent_start hook should be registered");

  const result = await beforeAgentStart(
    { prompt: "hello", systemPrompt: "event system prompt" },
    {
      cwd: projectRoot,
      model: { provider: "openai", baseUrl: "https://api.openai.com" },
      modelRegistry: {
        getProviderAuthMode: () => "apiKey",
        isProviderRequestReady: () => false,
      },
      getSystemPrompt: () => "context system prompt",
      reload: async () => {},
      ui: {
        notify() {},
        setWidget() {},
      },
    },
  );

  assert.match(result?.systemPrompt ?? "", /<newly_discovered_skills>/);
  assert.match(result?.systemPrompt ?? "", /late-skill/);
  assert.equal(result?.systemPrompt?.includes(skillPath), true);
});
