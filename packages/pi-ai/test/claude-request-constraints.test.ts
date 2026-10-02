import { describe, expect, it } from "vitest";
import { getClaudeRequestConstraints, rejectsSamplingParams } from "../src/providers/claude-request-constraints.js";

describe("getClaudeRequestConstraints", () => {
	const strictBetweenTools = { strictRequestParams: true, thinkingOffMode: "between_tools" };
	const strictOmit = { strictRequestParams: true, thinkingOffMode: "omit" };
	const omitOnly = { strictRequestParams: false, thinkingOffMode: "omit" };

	for (const [id, expected] of [
		["claude-sonnet-5-5", strictBetweenTools],
		["claude-sonnet-5.5", strictBetweenTools],
		["anthropic/claude-sonnet-5.5:batch", strictBetweenTools],
		["us.anthropic.claude-sonnet-5-5", strictBetweenTools],
		["claude-sonnet-5-5-20261001", strictBetweenTools],
		["claude-opus-5-5", strictOmit],
		["claude-opus-5.5-fast", strictOmit],
		["claude-opus-5-5@20260922", strictOmit],
		["claude-fable-5-1", strictOmit],
		["anthropic/claude-fable-5.1", strictOmit],
		["claude-fable-5", omitOnly],
		["claude-fable-5-20260601", omitOnly],
		["us.anthropic.claude-fable-5-v1:0", omitOnly],
		["claude-fable-5@20260601", omitOnly],
	] as const) {
		it(`matches ${id}`, () => {
			expect(getClaudeRequestConstraints(id)).toEqual(expected);
		});
	}

	for (const id of [
		"claude-sonnet-5",
		"claude-sonnet-5-20260801",
		"claude-opus-5",
		"claude-opus-5-50",
		"claude-fable-50",
		"claude-sonnet-4-6",
		"gpt-5.5",
		undefined,
	]) {
		it(`leaves ${id} unconstrained`, () => {
			expect(getClaudeRequestConstraints(id)).toBeUndefined();
		});
	}

	it("treats thinking-always-on models as rejecting sampling params", () => {
		expect(rejectsSamplingParams(getClaudeRequestConstraints("claude-fable-5"))).toBe(true);
		expect(rejectsSamplingParams(getClaudeRequestConstraints("claude-sonnet-5-5"))).toBe(true);
		expect(rejectsSamplingParams(getClaudeRequestConstraints("claude-sonnet-5"))).toBe(false);
	});
});
