/**
 * Parse Claude Code / MCP-prefixed tool names (`mcp__<server>__<tool>`).
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice("mcp__".length);
	const delim = rest.indexOf("__");
	if (delim <= 0 || delim + 2 >= rest.length) return null;
	return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}

/** Strip `mcp__<server>__` prefix when present; otherwise return the original name. */
export function stripMcpToolPrefix(name: string): string {
	const parsed = parseMcpToolName(name);
	return parsed ? parsed.tool : name;
}
