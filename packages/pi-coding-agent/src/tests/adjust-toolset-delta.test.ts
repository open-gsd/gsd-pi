import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntime } from "../core/extensions/loader.js";
import { ExtensionRunner } from "../core/extensions/runner.js";
import type {
	AdjustToolSetEvent,
	AdjustToolSetResult,
} from "../core/gsd-extension-types.js";
import type { Extension, ExtensionHandler } from "../core/extensions/extension-upstream-types.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { SessionManager } from "../core/session-manager.js";

const adjustEvent: Omit<AdjustToolSetEvent, "type"> = {
	selectedModelApi: "anthropic-messages",
	selectedModelProvider: "anthropic",
	selectedModelId: "claude-opus-4-8",
	activeToolNames: ["read", "edit", "bash"],
	filteredTools: [],
};

function makeExtension(handler: ExtensionHandler<AdjustToolSetEvent, AdjustToolSetResult>): Extension {
	return {
		path: "adjust-toolset-delta.test.ts",
		resolvedPath: "adjust-toolset-delta.test.ts",
		sourceInfo: { path: "adjust-toolset-delta.test.ts", source: "test", scope: "user", origin: "top-level" },
		handlers: new Map([["adjust_tool_set", [handler as never]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		runtimeReadHandlers: new Map(),
	};
}

function makeRunner(extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(extensions, createExtensionRuntime(), "/tmp", {} as SessionManager, {} as ModelRegistry);
}

test("adjust_tool_set composes toolNames override with addTools/removeTools deltas across listeners", async () => {
	let secondCalled = false;
	const runner = makeRunner([
		makeExtension(() => ({ toolNames: ["read", "edit"] })),
		makeExtension(() => {
			secondCalled = true;
			return { removeTools: ["edit"], addTools: ["discussion_arena", "read"] };
		}),
	]);

	const composed = await runner.emitAdjustToolSet(adjustEvent);

	assert.equal(secondCalled, true);
	assert.deepEqual(composed?.toolNames, ["read", "discussion_arena"]);
});

test("adjust_tool_set keeps first-non-null toolNames and falls back to activeToolNames as delta base", async () => {
	const overrideRunner = makeRunner([
		makeExtension(() => ({ toolNames: ["read"] })),
		makeExtension(() => ({ toolNames: ["bash"] })),
	]);
	assert.deepEqual((await overrideRunner.emitAdjustToolSet(adjustEvent))?.toolNames, ["read"]);

	const deltaRunner = makeRunner([makeExtension(() => ({ addTools: ["extra"] }))]);
	assert.deepEqual((await deltaRunner.emitAdjustToolSet(adjustEvent))?.toolNames, [
		"read",
		"edit",
		"bash",
		"extra",
	]);

	const noneRunner = makeRunner([makeExtension(() => undefined)]);
	assert.equal(await noneRunner.emitAdjustToolSet(adjustEvent), undefined);
});

test("adjust_tool_set lets addTools win when the same tool is removed and added", async () => {
	const runner = makeRunner([
		makeExtension(() => ({ toolNames: ["read", "edit"] })),
		makeExtension(() => ({ removeTools: ["edit"], addTools: ["edit", "extra"] })),
	]);

	const composed = await runner.emitAdjustToolSet(adjustEvent);

	assert.deepEqual(composed?.toolNames, ["read", "edit", "extra"]);
});

test("adjust_tool_set result without override or deltas no longer blocks later listeners", async () => {
	let laterCalled = false;
	const runner = makeRunner([
		makeExtension(() => ({})),
		makeExtension(() => {
			laterCalled = true;
			return { toolNames: ["read"] };
		}),
	]);

	const composed = await runner.emitAdjustToolSet(adjustEvent);

	assert.equal(laterCalled, true);
	assert.deepEqual(composed?.toolNames, ["read"]);
});
