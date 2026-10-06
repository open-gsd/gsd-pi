// gsd-pi - Projection write guard for the Claude Code provider
/**
 * Claude Code runs its own Write/Edit/Bash tools before the agent loop sees
 * them, so the native `tool_call` write guard never fires (see
 * ../gsd/engine-hook-contract.ts). This PreToolUse hook applies the same
 * guard: a write to STATE.md, gsd.db or a managed projection is denied with
 * the name of the tool that owns that state.
 */

import { blockedBashWriteReason, blockedWriteReason } from "../gsd/write-intercept.js";

/** SDK tool matcher for the hook: every Claude Code tool that can write a file. */
export const PROJECTION_WRITE_GUARD_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";

interface PreToolUseHookInput {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: unknown;
}

interface PreToolUseHookResult {
	hookSpecificOutput?: {
		hookEventName: "PreToolUse";
		permissionDecision?: "allow" | "deny" | "ask";
		permissionDecisionReason?: string;
	};
}

export async function projectionWriteGuardHook(hookInput: PreToolUseHookInput): Promise<PreToolUseHookResult> {
	if (hookInput?.hook_event_name !== "PreToolUse") return {};
	const input = (hookInput.tool_input ?? {}) as { file_path?: unknown; notebook_path?: unknown; command?: unknown };
	const path = input.file_path ?? input.notebook_path;
	const reason = hookInput.tool_name === "Bash"
		? (typeof input.command === "string" ? blockedBashWriteReason(input.command) : null)
		: (typeof path === "string" ? blockedWriteReason(path) : null);
	if (!reason) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}
