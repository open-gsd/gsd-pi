import assert from "node:assert/strict";
import test from "node:test";
import {
	getBeforeAgentStartContext,
	setBeforeAgentStartContext,
} from "../core/extensions/before-agent-start-context.js";
import { createExtensionRuntime } from "../core/extensions/loader.js";
import { ExtensionRunner } from "../core/extensions/runner.js";
import type {
	BeforeAgentStartEvent,
	Extension,
	ExtensionHandler,
} from "../core/extensions/extension-upstream-types.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { SessionManager } from "../core/session-manager.js";

function makeExtension(handler: ExtensionHandler<BeforeAgentStartEvent>): Extension {
	return {
		path: "before-agent-start-context.test.ts",
		resolvedPath: "before-agent-start-context.test.ts",
		sourceInfo: { path: "before-agent-start-context.test.ts", source: "test", scope: "user", origin: "top-level" },
		handlers: new Map([["before_agent_start", [handler as never]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		runtimeReadHandlers: new Map(),
	};
}

test("before_agent_start carries host dispatch context when set and omits it when cleared", async (t) => {
	t.after(() => setBeforeAgentStartContext(undefined));
	const seen: Array<Pick<BeforeAgentStartEvent, "unitType" | "phase">> = [];
	const extension = makeExtension((event) => {
		seen.push({ unitType: event.unitType, phase: event.phase });
	});
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		"/tmp",
		{} as SessionManager,
		{} as ModelRegistry,
	);

	await runner.emitBeforeAgentStart("hello", undefined, "base", { cwd: "/tmp" });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], { unitType: undefined, phase: undefined });

	setBeforeAgentStartContext({ unitType: "execute-task", phase: "executing" });
	await runner.emitBeforeAgentStart("hello", undefined, "base", { cwd: "/tmp" });
	assert.equal(seen.length, 2);
	assert.deepEqual(seen[1], { unitType: "execute-task", phase: "executing" });

	setBeforeAgentStartContext(undefined);
	await runner.emitBeforeAgentStart("hello", undefined, "base", { cwd: "/tmp" });
	assert.equal(seen.length, 3);
	assert.deepEqual(seen[2], { unitType: undefined, phase: undefined });
});

test("setBeforeAgentStartContext copies the context object", (t) => {
	t.after(() => setBeforeAgentStartContext(undefined));
	const context: { unitType?: string; phase?: string } = { unitType: "execute-task" };
	setBeforeAgentStartContext(context);
	context.unitType = "plan-slice";
	assert.deepEqual(getBeforeAgentStartContext(), { unitType: "execute-task" });
});
