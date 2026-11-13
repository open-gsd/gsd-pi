import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import registerCmuxCua from "../index.ts";

// Criterion 19-P01 (portable, partial): with the admission gate closed, the
// default extension registers no Computer Use tools (which includes no
// text-entry tool) and no lifecycle handlers. The fake counts registrations;
// nothing touches the desktop, a helper or the filesystem.
//
// NOT covered here (kept open under 19-P01): cold-import file/token counters
// and combined non-Mac startup.
function fakePi() {
	const tools: string[] = [];
	const handlers: string[] = [];
	const pi = {
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
		on(event: string) {
			handlers.push(event);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers };
}

describe("cmux CUA default-off (criterion 19-P01)", () => {
	test("registers no Computer Use tools while the admission gate is closed", () => {
		const { pi, tools } = fakePi();
		registerCmuxCua(pi);
		assert.deepEqual(tools, []);
	});

	test("registers no lifecycle handlers while the admission gate is closed", () => {
		const { pi, handlers } = fakePi();
		registerCmuxCua(pi);
		assert.deepEqual(handlers, []);
	});
});
