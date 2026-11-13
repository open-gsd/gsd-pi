import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import registerCmuxCua from "../index.ts";

// Criterion 19-P01 (portable, partial): with admission closed, the default
// export registers no tools or lifecycle handlers.
// The fake observes only pi.registerTool and pi.on.
// It does not intercept desktop, helper, process or filesystem APIs.
// The static import precedes these probes: neither direct cold-import side
// effects nor transitive module-graph inertness are tested here.

function observedPi() {
	const calls: string[] = [];
	const pi = {
		registerTool(def: { name: string }) {
			calls.push(`registerTool:${def.name}`);
		},
		on(event: string) {
			calls.push(`on:${event}`);
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

describe("cmux CUA default-export registration inertness (criterion 19-P01, partial)", () => {
	test("default export registers no tools or lifecycle handlers with admission closed", () => {
		const { pi, calls } = observedPi();
		registerCmuxCua(pi);
		assert.deepEqual(calls, [], `unexpected registrations: ${calls.join(", ")}`);
	});

	test("repeated calls register no tools or lifecycle handlers", () => {
		const { pi, calls } = observedPi();
		registerCmuxCua(pi);
		registerCmuxCua(pi);
		assert.deepEqual(calls, []);
	});

	test("default export does not throw when the pi API is minimal", () => {
		const bare = {} as unknown as ExtensionAPI;
		assert.doesNotThrow(() => registerCmuxCua(bare));
	});
});
