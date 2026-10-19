/**
 * Claude Code CLI Provider Extension
 *
 * Registers a model provider that delegates inference to the user's
 * locally-installed Claude Code CLI via the official Agent SDK.
 *
 * Users with a Claude Code subscription (Pro/Max/Team) get access to
 * subsidized inference through GSD's UI — no API key required.
 *
 * TOS-compliant: uses Anthropic's official `@anthropic-ai/claude-agent-sdk`,
 * never touches credentials, never offers a login flow.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { buildClaudeCodeModelList } from "./models.js";
import { isClaudeCodeReady, primeClaudeCodeReadiness, settleClaudeCodeReadiness } from "./readiness.js";
import { setClaudeCodeUIContext, streamViaClaudeCode } from "./stream-adapter.js";

export default function claudeCodeCli(pi: ExtensionAPI) {
	// Core calls `streamSimple` with a plain `SimpleStreamOptions` (no UI
	// context), so the elicitation handler used by `ask_user_questions` is
	// otherwise never wired and self-cancels. `before_provider_request` does
	// not fire for this provider (#2118); capture the live UI from session
	// start and each agent turn as well.
	const captureUi = (_event: unknown, ctx: { hasUI: boolean; ui: Parameters<typeof setClaudeCodeUIContext>[0] }) => {
		setClaudeCodeUIContext(ctx.hasUI ? ctx.ui : undefined);
	};
	pi.on("session_start", captureUi);
	pi.on("before_agent_start", captureUi);
	pi.on("before_provider_request", captureUi);

	// isReady() only reads a cache; start the first CLI probe now so the
	// answer is usually there before anything asks.
	primeClaudeCodeReadiness();

	pi.registerProvider("claude-code", {
		authMode: "externalCli",
		api: "anthropic-messages",
		baseUrl: "local://claude-code",
		isReady: isClaudeCodeReady,
		settleReadiness: settleClaudeCodeReadiness,
		streamSimple: streamViaClaudeCode,
		// Hardcoded list merged with the pi-ai anthropic catalog so new Claude
		// releases register without a code change (#2437).
		models: buildClaudeCodeModelList(),
	});
}
