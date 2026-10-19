// Project/App: gsd-pi
// File Purpose: The GSD tools cursor-agent can call. Single source of truth for the stream adapter and the dispatch readiness check.

export const CURSOR_AGENT_PROVIDER_ID = "cursor-agent";

/** GSD lifecycle tools the stream adapter executes on the local host. cursor-agent cannot call any other GSD tool. */
export const CURSOR_BRIDGED_GSD_TOOL_NAMES: readonly string[] = [
	"gsd_task_complete",
	"gsd_complete_task",
	"gsd_task_recovery_resume",
];

const CURSOR_BRIDGED_GSD_TOOLS = new Set(CURSOR_BRIDGED_GSD_TOOL_NAMES);

export function gsdToolBaseName(name: string): string {
	return name.replace(/^mcp__.+?__/, "");
}

export function isCursorBridgedGsdTool(name: string): boolean {
	const base = gsdToolBaseName(name);
	return CURSOR_BRIDGED_GSD_TOOLS.has(name) || CURSOR_BRIDGED_GSD_TOOLS.has(base);
}
