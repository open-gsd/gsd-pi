import { anthropicOAuth } from "./auth/oauth/anthropic.js";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.js";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.js";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.js";
import { metaOAuth } from "./auth/oauth/meta.js";
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.js";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.js";
import { openRouterOAuth } from "./auth/oauth/openrouter.js";
import { createRadiusOAuth } from "./auth/oauth/radius.js";
import { xaiOAuth } from "./auth/oauth/xai.js";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiChatGPT: () => openaiChatGPTOAuth,
		githubCopilot: () => githubCopilotOAuth,
		openrouter: () => openRouterOAuth,
		kimiCoding: () => kimiCodingOAuth,
		meta: () => metaOAuth,
		xai: () => xaiOAuth,
		radius: createRadiusOAuth,
	});
}
