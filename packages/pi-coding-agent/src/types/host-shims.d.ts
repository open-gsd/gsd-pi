declare module "@gsd/agent-core" {
	export type AgentSessionRuntimeDiagnostic = {
		type: string;
		message: string;
		[key: string]: unknown;
	};
	export function serializeConversation(...args: unknown[]): string;
	export function completeSummarization(...args: unknown[]): unknown;
	export function estimateTokens(...args: unknown[]): number;
	export function getSummarizationFailure(...args: unknown[]): unknown;
	const _default: unknown;
	export default _default;
}

declare module "@gsd/agent-core/*" {
	const mod: unknown;
	export = mod;
}

declare module "@gsd/agent-modes" {
	export function isValidThinkingLevel(level: string): boolean;
	export function parseArgs(...args: unknown[]): unknown;
	export type Args = Record<string, unknown>;
}

declare module "@gsd/agent-modes/modes/interactive/components/keybinding-hints.js" {
	export function keyHint(...args: unknown[]): unknown;
	export function keyText(...args: unknown[]): unknown;
}

declare module "@gsd/agent-modes/modes/interactive/components/visual-truncate.js" {
	export class VisualLinePreview {
		constructor(...args: unknown[]);
	}
}

declare module "@gsd/agent-modes/modes/interactive/components/diff.js" {
	export function renderDiff(...args: unknown[]): unknown;
}

declare module "@gsd/agent-modes/modes/interactive/components/dynamic-border.js" {
	export class DynamicBorder {
		constructor(...args: unknown[]);
	}
}

declare module "@gsd/agent-modes/modes/interactive/components/auth-url.js" {
	export class AuthUrlComponent {
		constructor(...args: unknown[]);
	}
}
