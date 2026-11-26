/** GSD host compatibility types for assistant message content blocks. */

/** Result from an externally executed tool (e.g. Claude Code SDK). */
export interface ExternalToolResult {
	/** Raw content from an externally executed tool. Normalized at runtime before consumers receive it. */
	content?: unknown;
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface ServerToolUse {
	type: "serverToolUse";
	id: string;
	name: string;
	input: unknown;
	caller?: unknown;
	externalResult?: ExternalToolResult;
}

export interface WebSearchResult {
	type: "webSearchResult";
	toolUseId: string;
	content: unknown;
	caller?: unknown;
}

export type ServerToolUseContent = ServerToolUse;
export type WebSearchResultContent = WebSearchResult;
