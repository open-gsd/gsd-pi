/** GSD host compatibility types for assistant message content blocks. */

export interface ServerToolUse {
	type: "serverToolUse";
	id: string;
	name: string;
	input: unknown;
	caller?: unknown;
	externalResult?: unknown;
}

export interface WebSearchResult {
	type: "webSearchResult";
	toolUseId: string;
	content: unknown;
	caller?: unknown;
}

export type ServerToolUseContent = ServerToolUse;
export type WebSearchResultContent = WebSearchResult;

export type { ModelRouting } from "./types.js";