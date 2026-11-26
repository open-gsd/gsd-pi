import type { InlineExtension } from "../core/extensions/types.js";
import codemodeExtension from "./codemode/index.js";
import llamaExtension from "./llama/index.js";
import mcpExtension from "./mcp/index.js";
import toolSearchExtension from "./tool-search/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
