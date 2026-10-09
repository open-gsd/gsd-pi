import { describe, expect, it } from "vitest";
import {
	clampThinkingLevel,
	getModel,
	getSupportedThinkingLevels,
} from "../src/models.js";

describe("Copilot Completions reasoning controls", () => {
	it.each(["kimi-k3", "gemini-3.6-flash", "claude-fable-5"] as const)(
		"does not advertise ignored effort controls for bundled %s",
		(id) => {
			const model = getModel("github-copilot", id);
			expect(model.api).toBe("openai-completions");
			expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
			expect(clampThinkingLevel(model, "xhigh")).toBe("off");
		},
	);

	it.each(["gpt-6-astra", "gpt-6.1-sol"] as const)(
		"advertises Responses reasoning levels for bundled %s",
		(id) => {
			const model = getModel("github-copilot", id);
			expect(model.api).toBe("openai-responses");
			expect(getSupportedThinkingLevels(model)).toEqual([
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
			expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
		},
	);

	it("keeps explicit custom compatibility and other providers unchanged", () => {
		const model = getModel("github-copilot", "claude-fable-5");
		expect(
			getSupportedThinkingLevels({
				...model,
				thinkingLevelMap: { xhigh: "xhigh" },
				compat: { ...model.compat, supportsReasoningEffort: true },
			}),
		).toContain("xhigh");
		expect(
			getSupportedThinkingLevels({
				...model,
				provider: "custom-provider",
			}),
		).toContain("high");
	});
});
