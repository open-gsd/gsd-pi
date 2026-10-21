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

		markMissingFinalResponse(result);

		assert.equal(result.exitCode, 2);
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "child crashed");
		assert.equal(result.stderr, "boom");
	});

	it("keeps a captured provider error as the headline and appends the missing-final context (#2968)", () => {
		const result = makeResult({
			model: "github-copilot/gpt-6-luna",
			stopReason: "error",
			errorMessage: '400 model "gpt-6-luna" is not accessible via the /chat/completions endpoint',
		});

		markMissingFinalResponse(result);

		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		const message = result.errorMessage ?? "";
		assert.match(message, /^400 model "gpt-6-luna" is not accessible via the \/chat\/completions endpoint/);
		assert.ok(message.includes("Subagent produced no valid final response"));
		assert.ok(message.includes("model: github-copilot/gpt-6-luna, stopReason: error"));
		assert.equal(result.stderr, result.errorMessage);
	});

	it("preserves a multiline provider error verbatim and appends the missing-final context on a new line", () => {
		const cause = "400 model unavailable\ntrace-id: 42\nretry after backoff";
		const result = makeResult({ errorMessage: cause });

		markMissingFinalResponse(result);

		assert.equal(
			result.errorMessage,
			`${cause}\nSubagent produced no valid final response (child exited 0; model: unknown, stopReason: unknown).`,
		);
	});

	it("falls back to the generic message when the captured error is whitespace-only", () => {
		const result = makeResult({ errorMessage: "  \n\t " });

		markMissingFinalResponse(result);

		assert.equal(
			result.errorMessage,
			"Subagent produced no valid final response (child exited 0; model: unknown, stopReason: unknown).",
		);
	});

	it("does not overwrite existing stderr when a provider error is preserved", () => {
		const result = makeResult({
			errorMessage: "400 model unavailable",
			stderr: "child stderr output",
		});

		markMissingFinalResponse(result);

		assert.equal(result.stderr, "child stderr output");
		assert.ok(result.errorMessage?.startsWith("400 model unavailable"));
	});

	it("leaves a result with final output untouched", () => {
		const result = makeResult({
			model: "claude-opus-5-5",
			stopReason: "stop",
			messages: [makeAssistantMessage("final answer")],
		});

		markMissingFinalResponse(result);

		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.stderr, "");
	});
});
