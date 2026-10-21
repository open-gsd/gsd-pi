import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

// models.dev 2026-09 refresh: Claude Fable 5.1 joined the Anthropic-backed providers; github-copilot dropped claude-opus-4.6.
const EXPECTED_ADAPTIVE_THINKING_MODELS = [
	"anthropic-vertex/claude-fable-5",
	"anthropic-vertex/claude-fable-5-1",
	"anthropic-vertex/claude-opus-4-6",
	"anthropic-vertex/claude-opus-4-7",
	"anthropic-vertex/claude-opus-4-8",
	"anthropic-vertex/claude-opus-5",
	"anthropic-vertex/claude-sonnet-4-6",
	"anthropic-vertex/claude-sonnet-5",
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5-1",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-opus-4-7",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"cloudflare-ai-gateway/claude-fable-5.1",
	"cloudflare-ai-gateway/claude-opus-4.6",
	"cloudflare-ai-gateway/claude-opus-4.7",
	"cloudflare-ai-gateway/claude-opus-4.8",
	"cloudflare-ai-gateway/claude-opus-5",
	"cloudflare-ai-gateway/claude-sonnet-4.6",
	"cloudflare-ai-gateway/claude-sonnet-5",
	"github-copilot/claude-opus-4.7",
	"github-copilot/claude-opus-4.8",
	"github-copilot/claude-sonnet-4.6",
	"minimax-cn/MiniMax-M3",
	"minimax/MiniMax-M3",
	"opencode/claude-fable-5",
	"opencode/claude-fable-5-1",
	"opencode/claude-opus-4-6",
	"opencode/claude-opus-4-7",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5",
	"opencode/claude-sonnet-4-6",
	"opencode/claude-sonnet-5",
	"vercel-ai-gateway/anthropic/claude-fable-5",
	"vercel-ai-gateway/anthropic/claude-fable-5.1",
	"vercel-ai-gateway/anthropic/claude-opus-4.6",
	"vercel-ai-gateway/anthropic/claude-opus-4.7",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-4.8-fast",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-5-fast",
	"vercel-ai-gateway/anthropic/claude-sonnet-4.6",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks exactly the built-in Anthropic API models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model) => model.api === "anthropic-messages" || model.api === "anthropic-vertex")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual([...EXPECTED_ADAPTIVE_THINKING_MODELS].sort());
	});
});
