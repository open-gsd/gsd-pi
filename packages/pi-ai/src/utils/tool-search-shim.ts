/**
 * Anthropic deferred-tool ToolSearch is not supported in Pi/GSD runtimes.
 * Models still emit `select:mcp__…__tool` queries; return explicit guidance instead
 * of a hard "Tool ToolSearch not found" failure.
 */

import { parseMcpToolName } from "./mcp-tool-name.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isToolSearchToolName(toolName: string): boolean {
	return toolName.toLowerCase() === "toolsearch";
}

export function parseToolSearchSelectQuery(query: string): string | null {
	const trimmed = query.trim();
	const match = trimmed.match(/^select:(.+)$/i);
	if (!match) return null;
	const name = match[1]?.trim();
	return name && name.length > 0 ? name : null;
}

export function extractToolSearchQuery(args: unknown): string {
	if (typeof args === "string") {
		return args;
	}
	if (!isRecord(args)) {
		return "";
	}
	if (typeof args.query === "string") {
		return args.query;
	}
	if (typeof args.input === "string") {
		return args.input;
	}
	return "";
}

export interface ToolSearchShimOptions {
	activeToolNames?: readonly string[];
}

function activeEquivalentForSelectedTool(toolName: string, activeToolNames: readonly string[] | undefined): string | null {
	if (!activeToolNames || activeToolNames.length === 0) return null;
	const mcp = parseMcpToolName(toolName);
	const canonicalToolName = mcp?.tool ?? toolName;

	for (const activeName of activeToolNames) {
		if (activeName === toolName || activeName === canonicalToolName) return activeName;
		const activeMcp = parseMcpToolName(activeName);
		if (activeMcp?.tool === canonicalToolName) return activeName;
	}

	const requestedLower = toolName.toLowerCase();
	const canonicalLower = canonicalToolName.toLowerCase();
	for (const activeName of activeToolNames) {
		if (activeName.toLowerCase() === requestedLower || activeName.toLowerCase() === canonicalLower) return activeName;
		const activeMcp = parseMcpToolName(activeName);
		if (activeMcp?.tool.toLowerCase() === canonicalLower) return activeName;
	}

	return null;
}

function formatDirectCallHint(toolName: string, options: ToolSearchShimOptions = {}): { text: string; resolvedTool: string } {
	const activeEquivalent = activeEquivalentForSelectedTool(toolName, options.activeToolNames);
	if (activeEquivalent) {
		return {
			text: `Call \`${activeEquivalent}\` directly. ToolSearch is not available in GSD.`,
			resolvedTool: activeEquivalent,
		};
	}

	const mcpTool = parseMcpToolName(toolName);
	if (mcpTool) {
		return {
			text:
				`ToolSearch is not available in GSD. Do not call \`${toolName}\` unless it appears in the active tool list. ` +
				`Call \`${mcpTool.tool}\` directly if listed, or use the exact active MCP-scoped name shown in your tool list.`,
			resolvedTool: mcpTool.tool,
		};
	}

	if (toolName.startsWith("mcp__")) {
		return {
			text:
				`ToolSearch is not available in GSD. Do not call \`${toolName}\` unless it appears in the active tool list. ` +
				"Use the exact active tool name shown in your tool list.",
			resolvedTool: toolName,
		};
	}
	if (toolName.startsWith("gsd_") || toolName === "memory_query" || toolName === "capture_thought") {
		return {
			text:
				`Call \`${toolName}\` directly. In Claude Code, use that server's MCP-scoped name from the active tool list. ` +
				"ToolSearch is not available in GSD.",
			resolvedTool: toolName,
		};
	}
	return {
		text: `Call \`${toolName}\` directly. ToolSearch is not available in GSD.`,
		resolvedTool: toolName,
	};
}

export function createToolSearchShimResult(args: unknown, options: ToolSearchShimOptions = {}): {
	content: Array<{ type: "text"; text: string }>;
	details: { operation: "tool_search_shim"; query: string; resolvedTool: string | null };
} {
	const query = extractToolSearchQuery(args);
	const selected = parseToolSearchSelectQuery(query);
	const resolved = selected ? formatDirectCallHint(selected, options) : null;
	const text = resolved?.text ?? "ToolSearch is not available in GSD. Call the workflow tool you need directly by name.";
	return {
		content: [{ type: "text", text }],
		details: { operation: "tool_search_shim", query, resolvedTool: resolved?.resolvedTool ?? null },
	};
}
