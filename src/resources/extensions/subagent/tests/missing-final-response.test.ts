import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markMissingFinalResponse } from "../index.js";

type SingleResultLike = Parameters<typeof markMissingFinalResponse>[0];

function makeAssistantMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 2,
			cost: { total: 0 },
		},
	} as any;
}

function makeResult(overrides: Partial<SingleResultLike> = {}): SingleResultLike {
	return {
		agent: "executor",
		agentSource: "user",
		task: "do a thing",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

describe("markMissingFinalResponse", () => {
	it("marks a zero-exit result with no final output and reports model and original stopReason", () => {
		const result = makeResult({ model: "claude-opus-5-5", stopReason: "maxTokens" });

		markMissingFinalResponse(result);

		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		assert.equal(
			result.errorMessage,
			"Subagent produced no valid final response (child exited 0; model: claude-opus-5-5, stopReason: maxTokens).",
		);
		assert.equal(result.stderr, result.errorMessage);
	});

	for (const diagnostic of [
		"400 model not accessible via /chat/completions",
		"401 Unauthorized (synthetic provider diagnostic)",
		"TransportError: connection reset (synthetic diagnostic)",
		"  400 model not accessible via /chat/completions\n\n  synthetic provider detail  \n",
	]) {
		it(`preserves the existing diagnostic ${JSON.stringify(diagnostic)}`, () => {
			const stderr = "existing child stderr\n";
			const result = makeResult({
				model: "luna",
				stopReason: "error",
				errorMessage: diagnostic,
				stderr,
				messages: [makeAssistantMessage(" \n\t")],
			});
			const context =
				"Subagent produced no valid final response (child exited 0; model: luna, stopReason: error).";

			markMissingFinalResponse(result);

			assert.equal(result.exitCode, 1);
			assert.equal(result.stopReason, "error");
			assert.equal(result.errorMessage, `${diagnostic}\n${context}`);
			assert.equal(result.stderr, stderr);
		});
	}

	it("uses only missing-final context for absent stderr when a diagnostic exists", () => {
		const diagnostic = "400 model not accessible via /chat/completions";
		const result = makeResult({ errorMessage: diagnostic });
		const context =
			"Subagent produced no valid final response (child exited 0; model: unknown, stopReason: unknown).";

		markMissingFinalResponse(result);

		assert.equal(result.errorMessage, `${diagnostic}\n${context}`);
		assert.equal(result.stderr, context);
	});

	it("reports unknown for missing model and missing original stopReason", () => {
		const result = makeResult();

		markMissingFinalResponse(result);

		assert.equal(
			result.errorMessage,
			"Subagent produced no valid final response (child exited 0; model: unknown, stopReason: unknown).",
		);
	});

	it("leaves a non-zero-exit result untouched", () => {
		const result = makeResult({
			exitCode: 2,
			stopReason: "aborted",
			errorMessage: "child crashed",
			stderr: "boom",
		});

		const original = structuredClone(result);

		markMissingFinalResponse(result);

		assert.deepEqual(result, original);
		assert.equal(result.exitCode, 2);
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "child crashed");
		assert.equal(result.stderr, "boom");
	});

	it("leaves a result with final output untouched", () => {
		const result = makeResult({
			model: "claude-opus-5-5",
			stopReason: "stop",
			messages: [makeAssistantMessage("final answer")],
		});

		const original = structuredClone(result);

		markMissingFinalResponse(result);

		assert.deepEqual(result, original);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.stderr, "");
	});
});
