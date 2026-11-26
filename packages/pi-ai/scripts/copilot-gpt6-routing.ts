// Keep this provider-specific: direct OpenAI and other gateways have different endpoint contracts.
const COPILOT_GPT6_RESPONSES_IDS = new Set([
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
	"gpt-6-astra",
]);

export function applyCopilotGpt6ResponsesRouting(model: {
	id: string;
	provider: string;
	api: string;
	compat?: unknown;
}): void {
	if (model.provider !== "github-copilot" || !COPILOT_GPT6_RESPONSES_IDS.has(model.id)) return;
	if (model.api === "openai-completions") delete model.compat;
	model.api = "openai-responses";
}
