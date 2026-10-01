// ask-user-questions-overlay — Regression tests for #2333
//
// While the interview dialog is displayed the chat viewport bounced up/down:
// the dialog REPLACED the editor in the bottom-anchored layout, so every
// mount/unmount shrank/grew the bottom block and triggered destructive
// full repaints. The interview must be requested as an overlay instead.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import askUserQuestionsExtension, {
	resetAskUserQuestionsCache,
} from "../../ask-user-questions.ts";

const question = {
	id: "depth_check",
	header: "Depth Check",
	question: "Did I capture the depth right?",
	options: [
		{ label: "Yes, you got it", description: "Proceed" },
		{ label: "Not quite - let me clarify", description: "Clarify" },
	],
};

function getAskUserQuestionsTool() {
	const tools: any[] = [];
	askUserQuestionsExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
	const tool = tools.find((t) => t.name === "ask_user_questions");
	assert.ok(tool, "ask_user_questions should be registered");
	return tool;
}

function fakeCtx(customCalls: unknown[]) {
	return {
		hasUI: true,
		ui: {
			custom: (_factory: unknown, options?: unknown) => {
				customCalls.push(options);
				return Promise.resolve({
					endInterview: false,
					answers: { depth_check: { selected: "Yes, you got it", notes: "" } },
				});
			},
		},
	} as any;
}

describe("ask_user_questions interview overlay (#2333)", () => {
	beforeEach(() => {
		resetAskUserQuestionsCache();
		// Keep the local-only path deterministic regardless of machine prefs.
		process.env.GSD_DISABLE_REMOTE_QUESTIONS = "1";
	});

	afterEach(() => {
		delete process.env.GSD_DISABLE_REMOTE_QUESTIONS;
	});

	test("local-only path requests the interview as an overlay", async () => {
		const tool = getAskUserQuestionsTool();
		const customCalls: unknown[] = [];
		const ctx = fakeCtx(customCalls);

		const result = await tool.execute("t1", { questions: [question] }, undefined, () => {}, ctx);

		assert.equal(customCalls.length, 1, "interview should be dispatched through ui.custom");
		assert.deepEqual(customCalls[0], { overlay: true });
		assert.equal((result.details as any).cancelled, false);
	});
});
