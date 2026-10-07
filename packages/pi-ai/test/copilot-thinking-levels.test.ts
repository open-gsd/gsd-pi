import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("Copilot Completions reasoning controls", () => {
	it.each(["gpt-6-astra", "gpt-6.1-sol", "claude-fable-5"] as const)(
		"does not advertise ignored effort controls for bundled %s",
		(id) => {
			const model = getModel("github-copilot", id);
			expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
			expect(clampThinkingLevel(model, "xhigh")).toBe("off");
		},
	);

	it("keeps explicit custom compatibility and other providers unchanged", () => {
		const model = getModel("github-copilot", "gpt-6-astra");
		expect(getSupportedThinkingLevels({
			...model,
			thinkingLevelMap: { xhigh: "xhigh" },
			compat: { ...model.compat, supportsReasoningEffort: true },
		})).toContain("xhigh");
		expect(getSupportedThinkingLevels({
			...model,
			provider: "custom-provider",
		})).toContain("high");
	});
});
