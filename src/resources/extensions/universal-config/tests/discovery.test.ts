/**
 * Tests for the discovery orchestrator.
 * Runs with: node --experimental-strip-types --test
 */

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { discoverAllConfigs } from "../discovery.ts";
import { formatDiscoveryForCommand, formatDiscoveryForTool } from "../format.ts";

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown) {
  mkdirp(join(path, ".."));
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function writeText(path: string, content: string) {
  mkdirp(join(path, ".."));
  writeFileSync(path, content, "utf8");
}

function makeTempDirs() {
  const base = join(tmpdir(), `ucd-disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testRoot = join(base, "project");
  const testHome = join(base, "home");
  mkdirp(testRoot);
  mkdirp(testHome);
  return { testRoot, testHome, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("discoverAllConfigs", () => {
  test("returns empty result for clean directories", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.totalItems, 0);
      assert.equal(result.summary.toolsScanned, 8);
      assert.equal(result.summary.toolsWithConfig, 0);
      assert.equal(result.summary.claudeSkills, 0);
      assert.equal(result.summary.claudePlugins, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      cleanup();
    }
  });

  test("discovers config from multiple tools", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testHome, ".claude.json"), {
        mcpServers: { "claude-mcp": { command: "node", args: ["server.js"] } },
      });
      writeText(join(testHome, ".claude/skills/test-skill/SKILL.md"), "# Test skill");
      writeJson(join(testHome, ".claude/plugins/test-plugin/package.json"), { name: "test-plugin" });
      writeText(join(testRoot, ".cursorrules"), "Use semicolons.");
      writeText(join(testRoot, ".github/copilot-instructions.md"), "Be helpful.");

      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.toolsWithConfig, 3);
      assert.equal(result.summary.mcpServers, 1);
      assert.equal(result.summary.rules, 1);
      assert.equal(result.summary.contextFiles, 1);
      assert.equal(result.summary.claudeSkills, 1);
      assert.equal(result.summary.claudePlugins, 1);
      assert.equal(result.allItems.length, 5);
    } finally {
      cleanup();
    }
  });

  test("handles nonexistent paths gracefully", async () => {
    const result = await discoverAllConfigs("/nonexistent/path", "/nonexistent/home");
    assert.equal(result.summary.totalItems, 0);
    assert.ok(result.warnings.length >= 0);
  });

  test("groups items by tool", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".cursor/mcp.json"), {
        mcpServers: { s1: { command: "a" }, s2: { command: "b" } },
      });

      const result = await discoverAllConfigs(testRoot, testHome);
      const cursorResult = result.tools.find((t) => t.tool.id === "cursor");
      assert.ok(cursorResult);
      assert.equal(cursorResult!.items.length, 2);
    } finally {
      cleanup();
    }
  });

  test("summary counts are accurate", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".cursor/mcp.json"), { mcpServers: { s1: { command: "a" } } });
      writeText(join(testRoot, ".cursorrules"), "Rule 1");
      writeText(join(testRoot, ".clinerules"), "Rule 2");
      writeText(join(testRoot, ".github/copilot-instructions.md"), "Instructions");
      writeJson(join(testRoot, ".vscode/settings.json"), { "editor.tabSize": 2 });

      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.mcpServers, 1);
      assert.equal(result.summary.rules, 2);
      assert.equal(result.summary.contextFiles, 1);
      assert.equal(result.summary.settings, 1);
      assert.equal(result.summary.claudeSkills, 0);
      assert.equal(result.summary.claudePlugins, 0);
      assert.equal(result.summary.totalItems, 5);
    } finally {
      cleanup();
    }
  });
});

describe("Codex TOML discovery privacy boundary", () => {
  test("model-visible tool and command text omit endpoint values while raw internal config is preserved", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      // Non-production sentinels generated at runtime: unique per run, never stored as literals.
      const argSecret = `arg-${randomUUID()}`;
      const positionalSecret = `pos-${randomUUID()}`;
      const querySecret = `qry-${randomUUID()}`;
      const userinfoSecret = `usr-${randomUUID()}`;
      const envSecret = `env-${randomUUID()}`;
      const commandSecret = `cmd-${randomUUID()}`;
      writeText(
        join(testHome, ".codex/config.toml"),
        [
          "[mcp_servers.stdio]",
          `command = '${commandSecret}'`,
          `args = ['server.js', '--token', '${argSecret}', '${positionalSecret}']`,
          "[mcp_servers.stdio.env]",
          `VALUE = '${envSecret}'`,
          "[mcp_servers.basic]",
          `url = 'https://review:${userinfoSecret}@example.test/mcp'`,
          "",
        ].join("\n"),
      );
      writeText(
        join(testRoot, ".codex/config.toml"),
        `[mcp_servers.remote]\nurl = 'https://example.test/mcp?session=${querySecret}'\n`,
      );

      const result = await discoverAllConfigs(testRoot, testHome);
      const text = formatDiscoveryForTool(result);
      const commandText = formatDiscoveryForCommand(result).join("\n");
      const secrets = [argSecret, positionalSecret, querySecret, userinfoSecret, envSecret, commandSecret];

      for (const secret of secrets) {
        assert.ok(!text.includes(secret), "model-visible tool text must not contain endpoint values");
        assert.ok(!commandText.includes(secret), "/configs summary must not contain endpoint values");
      }

      // Exact metadata: names, transports, source scopes, and counts.
      assert.ok(text.includes("3 MCP server(s)"));
      assert.ok(text.includes("- stdio [stdio] stdio command configured; arguments omitted (user)"));
      assert.ok(text.includes("- basic [http] remote endpoint configured; URL omitted (user)"));
      assert.ok(text.includes("- remote [http] remote endpoint configured; URL omitted (project)"));
      assert.ok(commandText.includes("MCP: stdio (user)"));
      assert.ok(commandText.includes("MCP: remote (project)"));

      // Raw internal discovery data (used by explicit config import) is unchanged.
      const stdio = result.allItems.find((i) => i.type === "mcp-server" && i.name === "stdio");
      assert.ok(stdio && stdio.type === "mcp-server");
      assert.equal(stdio.command, commandSecret);
      assert.deepEqual(stdio.args, ["server.js", "--token", argSecret, positionalSecret]);
      assert.equal(stdio.env?.VALUE, envSecret);
      assert.equal(stdio.source.level, "user");
      const basic = result.allItems.find((i) => i.type === "mcp-server" && i.name === "basic");
      assert.ok(basic && basic.type === "mcp-server");
      assert.equal(basic.url, `https://review:${userinfoSecret}@example.test/mcp`);
      const remote = result.allItems.find((i) => i.type === "mcp-server" && i.name === "remote");
      assert.ok(remote && remote.type === "mcp-server");
      assert.equal(remote.url, `https://example.test/mcp?session=${querySecret}`);
      assert.equal(remote.source.level, "project");
    } finally {
      cleanup();
    }
  });
});
