import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntime } from "../core/extensions/loader.js";
import { ExtensionRunner } from "../core/extensions/runner.js";
import type { Extension, ExtensionEvent, ExtensionHandler } from "../core/extensions/extension-upstream-types.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { SessionManager } from "../core/session-manager.js";
import type { PhaseChangeEvent } from "../core/gsd-extension-types.js";

function makeExtension(handler: ExtensionHandler<PhaseChangeEvent>): Extension {
	return {
		path: "phase-change-event.test.ts",
		resolvedPath: "phase-change-event.test.ts",
		sourceInfo: { path: "phase-change-event.test.ts", source: "test", scope: "user", origin: "top-level" },
		handlers: new Map([["phase_change", [handler as never]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		runtimeReadHandlers: new Map(),
	};
}

test("emitExtensionEventDynamic dispatches phase_change to registered handlers", async () => {
	const seen: PhaseChangeEvent[] = [];
	const runner = new ExtensionRunner(
		[makeExtension((event) => {
			seen.push(event);
		})],
		createExtensionRuntime(),
		"/tmp",
		{} as SessionManager,
		{} as ModelRegistry,
	);

	const event = {
		type: "phase_change",
		previousPhase: null,
		currentPhase: "execute-task",
		source: "auto",
		traceId: "trace-1",
	} as ExtensionEvent;

	await runner.emitExtensionEventDynamic(event);

	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.type, "phase_change");
	assert.equal(seen[0]?.currentPhase, "execute-task");
});
