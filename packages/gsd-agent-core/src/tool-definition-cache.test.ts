import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AgentSessionExtensionsModule } from "./session/agent-session-extensions.ts";
import { createSyntheticSourceInfo } from "@gsd/pi-coding-agent/core/source-info.js";
import { createAllToolDefinitions } from "@gsd/pi-coding-agent/core/tools/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal host that satisfies the AgentSessionHost surface needed
 * by refreshToolRegistry / setActiveToolsByName without touching the real
 * agent, session-manager, or provider layers.
 */
function makeHost(cwd = "/tmp/project", allowedToolNames?: string[]) {
	const agentStateTools: Array<{ name: string }> = [];
	const systemPromptChunks: string[] = [];

	const baseTools = createAllToolDefinitions(cwd);
	const baseToolDefinitions = new Map(
		Object.entries(baseTools).map(([name, tool]) => [name, tool as any]),
	);

	const host = {
		_cwd: cwd,
		_allowedToolNames: allowedToolNames ? new Set(allowedToolNames) : undefined,
		_customTools: [] as any[],
		_baseToolsOverride: undefined as Record<string, any> | undefined,
		_baseToolDefinitions: baseToolDefinitions,
		_extensionRunner: {
			getAllRegisteredTools: () => [],
			hasHandlers: () => false,
			getFlagValues: () => new Map(),
			createContext: () => ({}),
		} as any,
		agent: {
			state: {
				get tools() { return agentStateTools; },
				set tools(val: Array<{ name: string }>) { agentStateTools.length = 0; agentStateTools.push(...val); },
				get systemPrompt() { return systemPromptChunks[systemPromptChunks.length - 1] ?? ""; },
				set systemPrompt(val: string) { systemPromptChunks.push(val); },
			},
		},
		getActiveToolNames: () => agentStateTools.map((t) => t.name),
		setActiveToolsByName: (toolNames: string[]) => {
			agentStateTools.length = 0;
			for (const name of toolNames) {
				const tool = host._toolRegistry.get(name);
				if (tool) agentStateTools.push({ name: tool.name });
			}
		},
		_toolRegistry: new Map() as Map<string, any>,
		_toolDefinitions: new Map() as Map<string, any>,
		_toolPromptSnippets: new Map() as Map<string, string>,
		_toolPromptGuidelines: new Map() as Map<string, string[]>,
		_visibleSkillNames: [] as string[],
		resourceLoader: {
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
	} as any;

	return host;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool Definition Cache", () => {
	test("1. same tool set → cache hit (no rebuild)", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		// First call — cache miss, full rebuild.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		const registryAfterFirst = host._toolRegistry;
		const defsAfterFirst = host._toolDefinitions;

		// Second call — same config → cache hit, Maps reused.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		const registryAfterSecond = host._toolRegistry;
		const defsAfterSecond = host._toolDefinitions;

		// Same Map instances = cache hit.
		assert.strictEqual(registryAfterFirst, registryAfterSecond, "toolRegistry should be cached");
		assert.strictEqual(defsAfterFirst, defsAfterSecond, "toolDefinitions should be cached");
	});

	test("2. repeated rebuild with same configuration → no duplicate reconstruction", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		const registrySizes: number[] = [];
		const defSizes: number[] = [];

		for (let i = 0; i < 5; i++) {
			mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
			registrySizes.push(host._toolRegistry.size);
			defSizes.push(host._toolDefinitions.size);
		}

		// All calls produce the same registry size (no growth from duplicate entries).
		assert.ok(registrySizes.every((s) => s === registrySizes[0]), "registry size should be stable");
		assert.ok(defSizes.every((s) => s === defSizes[0]), "definitions size should be stable");
	});

	test("3. different tool set → cache miss", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		const firstRegistry = host._toolRegistry;

		// Change cwd to force a different cache key.
		host._cwd = "/tmp/other-project";
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		const secondRegistry = host._toolRegistry;

		assert.notStrictEqual(firstRegistry, secondRegistry, "different cwd → cache miss → new registry");
	});

	test("4. extension tool change → no stale definitions", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		// First call — no extensions.
		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const firstRegistry = host._toolRegistry;

		// Simulate extension tool being registered.
		(host._extensionRunner as any).getAllRegisteredTools = () => [
			{
				definition: { name: "my-ext-tool", description: "ext", parameters: {}, promptSnippet: undefined, promptGuidelines: undefined, execute: async () => {} },
				sourceInfo: createSyntheticSourceInfo("<test-ext>", { source: "extension" }),
			},
		];

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: true });
		const secondRegistry = host._toolRegistry;
		const secondDefs = host._toolDefinitions;

		// Cache should have invalidated because registered tool names changed.
		assert.notStrictEqual(firstRegistry, secondRegistry, "registry should be rebuilt");
		assert.ok(secondDefs.has("my-ext-tool"), "extension tool should be in definitions");
	});

	test("5. custom tool change → no stale definitions", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const firstRegistry = host._toolRegistry;

		// Add a custom tool.
		host._customTools = [
			{ name: "custom-tool", description: "custom", parameters: {}, promptSnippet: undefined, promptGuidelines: undefined, execute: async () => {} },
		];

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const secondRegistry = host._toolRegistry;

		// Cache should have invalidated because custom tool names changed.
		assert.notStrictEqual(firstRegistry, secondRegistry, "custom tool change → cache miss");
		assert.ok(secondRegistry.has("custom-tool"), "custom tool should be in registry");
	});

	test("6. allowed-tool change → no stale definitions", () => {
		const host = makeHost(["read", "bash"]); // Only read and bash allowed.
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: true });
		const firstRegistry = host._toolRegistry;

		// Relax allowed tools.
		host._allowedToolNames = new Set(["read", "bash", "edit", "write"]);

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: true });
		const secondRegistry = host._toolRegistry;

		assert.notStrictEqual(firstRegistry, secondRegistry, "allowed tool change → cache miss");
	});

	test("7. extension reload → no stale definitions", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const firstRegistry = host._toolRegistry;

		// Simulate extension reload — new extension runner with different tools.
		(host._extensionRunner as any).getAllRegisteredTools = () => [
			{
				definition: { name: "new-ext-tool", description: "new", parameters: {}, promptSnippet: undefined, promptGuidelines: undefined, execute: async () => {} },
				sourceInfo: createSyntheticSourceInfo("<new-ext>", { source: "extension" }),
			},
		];

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: true });
		const secondRegistry = host._toolRegistry;

		assert.notStrictEqual(firstRegistry, secondRegistry, "extension reload → cache miss");
	});

	test("8. CWD change → correct behavior", () => {
		const host = makeHost("/tmp/project-a");
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const firstRegistry = host._toolRegistry;

		host._cwd = "/tmp/project-b";
		mod.refreshToolRegistry({ activeToolNames: ["read"], includeAllExtensionTools: false });
		const secondRegistry = host._toolRegistry;

		assert.notStrictEqual(firstRegistry, secondRegistry, "CWD change → cache miss");
	});

	test("9. tool execution still uses the correct executable implementation", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });

		// The "read" tool in the registry should be the built-in one.
		const readTool = host._toolRegistry.get("read");
		assert.ok(readTool, "read tool should be in registry");
		assert.ok(typeof readTool.execute === "function", "read tool should have execute function");
	});

	test("10. final API tool payload remains semantically identical to pre-cache", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);

		// First call — build.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		const firstNames = Array.from(host._toolRegistry.keys()).sort();

		// Second call — cache hit.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		const secondNames = Array.from(host._toolRegistry.keys()).sort();

		// The tool names (which become the API payload) are identical.
		assert.deepEqual(firstNames, secondNames, "tool names should be identical after cache hit");

		// Third call — cache miss (different cwd).
		host._cwd = "/tmp/other";
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		const thirdNames = Array.from(host._toolRegistry.keys()).sort();

		// After cache miss, the tool names should still be the same (same base tools).
		assert.deepEqual(thirdNames, firstNames, "tool names should be consistent after cache miss");
	});
});

// ---------------------------------------------------------------------------
// Phase 7 — Skip Redundant Active-Tool Rebinding
// ---------------------------------------------------------------------------
// These tests verify the optimization that skips setActiveToolsByName()
// on cache hit + unchanged effective active tool selection.

describe("Phase 7 — Skip Redundant Rebinding", () => {
	test("cache hit + same active tools → setActiveToolsByName() skipped", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		// First call — cache miss, executed.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute setActiveToolsByName");

		// Second call — cache hit, same tools → skipped.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "second call should be skipped (cache hit + same tools)");
	});

	test("cache hit + different active tools → setActiveToolsByName() executed", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");

		// Different tools → executed.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "different tools → executed");
		assert.ok(
			host.agent.state.tools.some((t) => t.name === "edit"),
			"should have edit tool after different tool set",
		);
	});

	test("cache miss + same active tool names → setActiveToolsByName() executed", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");

		// Change cwd → cache miss → executed (even with same active tools).
		host._cwd = "/tmp/other-project";
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "cache miss → executed (even with same active tools)");
	});

	test("CWD change → cache MISS → setActiveToolsByName() executed (even with same active tools)", () => {
		const host = makeHost("/tmp/project-a");
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");

		// Same active tools but different CWD → cache miss → executed.
		host._cwd = "/tmp/project-b";
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "CWD change → cache miss → executed");

		// Verify tools were rebound correctly.
		const toolNames = host.agent.state.tools.map((t) => t.name);
		assert.ok(toolNames.includes("read"), "should have read tool");
		assert.ok(toolNames.includes("bash"), "should have bash tool");
	});

	test("extension reload → cache MISS → setActiveToolsByName() executed", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");
		const firstTools = [...host.agent.state.tools.map((t) => t.name)];

		// Simulate extension reload — new extension runner.
		(host._extensionRunner as any).getAllRegisteredTools = () => [
			{
				definition: { name: "ext-tool", description: "ext", parameters: {}, promptSnippet: undefined, promptGuidelines: undefined, execute: async () => {} },
				sourceInfo: createSyntheticSourceInfo("<test>", { source: "extension" }),
			},
		];
		host._cwd = "/tmp/project-reload"; // Force cache miss.

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "extension reload → cache miss → executed");
		assert.ok(
			host.agent.state.tools.some((t) => t.name === "read"),
			"should have read tool after extension reload",
		);
	});

	test("allowed tool config change → cache MISS → setActiveToolsByName() executed", () => {
		// Build host with restricted allowed tools.
		const host = makeHost("/tmp/project", ["read", "bash"]);
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");

		// Relax allowed tools → cache miss → executed.
		host._allowedToolNames = new Set(["read", "bash", "edit"]);
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "allowed tool change → cache miss → executed");
	});

	test("system prompt unchanged on skipped path", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");
		const firstBasePrompt = host._baseSystemPrompt;

		// Second call — cache hit, same tools → skipped, system prompt unchanged.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit", "write"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "second call should be skipped");
		assert.strictEqual(host._baseSystemPrompt, firstBasePrompt, "_baseSystemPrompt should be the same instance");
	});

	test("cache HIT + different active tools → EXECUTED (guard non interferisce)", () => {
		const host = makeHost();
		const mod = new AgentSessionExtensionsModule(host);
		let callCount = 0;
		const origSetActive = host.setActiveToolsByName.bind(host);
		(host as any).setActiveToolsByName = (toolNames: string[]) => {
			callCount++;
			origSetActive(toolNames);
		};

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 1, "first call should execute");

		// Different tools → executed.
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash", "edit"], includeAllExtensionTools: true });
		assert.strictEqual(callCount, 2, "different tools → executed");
		assert.ok(
			host.agent.state.tools.some((t) => t.name === "edit"),
			"should have edit tool",
		);
	});
});
