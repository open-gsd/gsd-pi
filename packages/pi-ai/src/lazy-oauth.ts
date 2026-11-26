import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.js";

/**
 * Registers OAuth flow loaders with literal dynamic imports, for Node bundles
 * that split at dynamic imports (esbuild `splitting`, Chord's worker base):
 * each flow lands in a chunk loaded on its first use, inside the bundle.
 * Without it, pi-ai imports the flows through a variable specifier that
 * bundlers cannot follow, so a bundle loads them from pi-ai's own files.
 * Browser bundles must not import this module (the flows are Node-only).
 */
export function registerLazyOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: async () => (await import("./auth/oauth/anthropic.js")).anthropicOAuth,
		openaiCodex: async () => (await import("./auth/oauth/openai-codex.js")).openaiCodexOAuth,
		openaiChatGPT: async () => (await import("./auth/oauth/openai-chatgpt.js")).openaiChatGPTOAuth,
		githubCopilot: async () => (await import("./auth/oauth/github-copilot.js")).githubCopilotOAuth,
		openrouter: async () => (await import("./auth/oauth/openrouter.js")).openRouterOAuth,
		kimiCoding: async () => (await import("./auth/oauth/kimi-coding.js")).kimiCodingOAuth,
		meta: async () => (await import("./auth/oauth/meta.js")).metaOAuth,
		xai: async () => (await import("./auth/oauth/xai.js")).xaiOAuth,
		radius: async (options) => (await import("./auth/oauth/radius.js")).createRadiusOAuth(options),
	});
}
