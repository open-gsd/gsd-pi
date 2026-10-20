import type { Api, Model, ThinkingLevelMap } from "../types.js";

export const MINIMAX_FLASH_THINKING_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Curated release entries, shared with the catalog generator. */
export const MINIMAX_FLASH_MODELS: Model<Api>[] = [
	...["minimax", "minimax-cn"].map((provider): Model<"anthropic-messages"> => ({
		id: "MiniMax-M3.1-Flash",
		name: "MiniMax-M3.1-Flash",
		api: "anthropic-messages",
		provider,
		baseUrl: provider === "minimax" ? "https://api.minimax.io/anthropic" : "https://api.minimaxi.com/anthropic",
		compat: { forceAdaptiveThinking: true },
		reasoning: true,
		thinkingLevelMap: MINIMAX_FLASH_THINKING_LEVELS,
		input: ["text", "image", "video"],
		// No cache-write price is published; zero is the catalog's unknown sentinel.
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 524288,
	})),
	{
		id: "minimax/minimax-m3.1-flash:free",
		name: "MiniMax: MiniMax M3.1 Flash (free)",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinkingLevelMap: MINIMAX_FLASH_THINKING_LEVELS,
		input: ["text", "image", "video"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 524288,
	},
	{
		id: "minimax-m3.1-flash-free",
		name: "MiniMax M3.1 Flash Free",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		thinkingLevelMap: MINIMAX_FLASH_THINKING_LEVELS,
		input: ["text", "image", "video"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 512000,
	},
];

/** Only the direct service has this wire contract; custom proxies retain their own. */
export function isDirectMiniMaxM3(model: Model<Api>): boolean {
	if (model.id !== "MiniMax-M3" && model.id !== "MiniMax-M3.1-Flash") return false;
	try {
		const url = new URL(model.baseUrl);
		return url.protocol === "https:" && ["api.minimax.io", "api.minimaxi.com"].includes(url.hostname);
	} catch {
		return false;
	}
}

export function isMiniMaxFlashGateway(model: Model<Api>): boolean {
	return MINIMAX_FLASH_MODELS.some((entry) =>
		entry.api === "openai-completions" && entry.provider === model.provider &&
		entry.id === model.id && entry.baseUrl === model.baseUrl.replace(/\/$/, ""),
	);
}

export function miniMaxFlashEffort(effort: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" {
	if (effort === "minimal") return "low";
	if (effort === undefined) return "max";
	if (["low", "medium", "high", "xhigh", "max"].includes(effort)) {
		return effort as "low" | "medium" | "high" | "xhigh" | "max";
	}
	throw new Error(`MiniMax-M3.1-Flash does not support reasoning effort ${effort}`);
}
