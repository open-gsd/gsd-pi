#!/usr/bin/env node
'use strict'

// Ports that must be reapplied onto Pi v1.6.1 instead of copying the v0.75.5 overlay file.
const BLOCK_OVERLAY_ON_UNPINNED = [
  'packages/pi-agent-core/src/agent.ts',
  'packages/pi-ai/src/providers/anthropic.ts',
  'packages/pi-ai/src/providers/mistral.ts',
  'packages/pi-ai/test/google-shared-convert-tools.test.ts',
  'packages/pi-coding-agent/src/core/extensions/loader.ts',
  'packages/pi-coding-agent/src/core/extensions/types.ts',
  'packages/pi-coding-agent/src/core/keybindings.ts',
  'packages/pi-coding-agent/src/core/model-registry.ts',
  'packages/pi-coding-agent/src/core/settings-manager.ts',
  'packages/pi-coding-agent/src/core/system-prompt.ts',
  'packages/pi-ai/src/providers/google-shared.ts',
  'packages/pi-coding-agent/scripts/copy-assets.cjs',
  'packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts',
  'packages/pi-coding-agent/src/theme/theme-highlight.test.ts',
  'packages/pi-coding-agent/src/theme/theme-schema.ts',
  'packages/pi-coding-agent/src/theme/theme.ts',
  'packages/pi-coding-agent/src/theme/themes.ts',
  'packages/pi-coding-agent/src/core/session-cwd.ts',
]

function portAnthropicOAuthBreakpoint(content) {
  const from = `params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {`
  const to = `const hasSystemPrompt = Boolean(initialSystemText);
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(!hasSystemPrompt && cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {`
  if (!content.includes(from)) return { content, applied: false }
  return { content: content.replace(from, to), applied: true }
}

function portAgentCacheRetention(content) {
  let next = content
  let applied = false
  if (!next.includes('public cacheRetention?: CacheRetention')) {
  next = next.replace(
    'type Transport,\n\ttoToolDeclaration,',
    'type CacheRetention,\n\ttype Transport,\n\ttoToolDeclaration,',
  )
  next = next.replace(
    '\tsessionId?: string;\n\tthinkingBudgets?: ThinkingBudgets;',
    '\tsessionId?: string;\n\tcacheRetention?: CacheRetention;\n\tthinkingBudgets?: ThinkingBudgets;',
  )
  next = next.replace(
    '\tpublic sessionId?: string;\n\t/** Optional per-level thinking token budgets forwarded to the stream function. */',
    '\tpublic sessionId?: string;\n\t/** Prompt cache retention forwarded to the stream function. */\n\tpublic cacheRetention?: CacheRetention;\n\t/** Optional per-level thinking token budgets forwarded to the stream function. */',
  )
  next = next.replace(
    'this.sessionId = runtimeOptions.sessionId;\n\t\tthis.thinkingBudgets = runtimeOptions.thinkingBudgets;',
    'this.sessionId = runtimeOptions.sessionId;\n\t\tthis.cacheRetention = runtimeOptions.cacheRetention;\n\t\tthis.thinkingBudgets = runtimeOptions.thinkingBudgets;',
  )
  next = next.replace(
    'sessionId: this.sessionId,\n\t\t\tonPayload: this.onPayload,',
    'sessionId: this.sessionId,\n\t\t\tcacheRetention: this.cacheRetention,\n\t\t\tonPayload: this.onPayload,',
  )
  applied = next !== content
  }
  if (!next.includes('public latencyMark?:')) {
    const withLatency = next.replace(
      '\tpublic cacheRetention?: CacheRetention;\n',
      '\tpublic cacheRetention?: CacheRetention;\n\t/** Host timing sink. The v1.6.1 loop does not call this yet. */\n\tpublic latencyMark?: (phase: string, data?: Record<string, unknown>) => void;\n',
    ).replace(
      '\tcacheRetention?: CacheRetention;\n\tthinkingBudgets?: ThinkingBudgets;',
      '\tcacheRetention?: CacheRetention;\n\tlatencyMark?: (phase: string, data?: Record<string, unknown>) => void;\n\tthinkingBudgets?: ThinkingBudgets;',
    ).replace(
      'this.cacheRetention = runtimeOptions.cacheRetention;\n',
      'this.cacheRetention = runtimeOptions.cacheRetention;\n\t\tthis.latencyMark = runtimeOptions.latencyMark;\n',
    )
    applied = applied || withLatency !== next
    next = withLatency
  }
  if (!next.includes('abort(origin?:')) {
    const withAbort = next.replace(
      '\tabort(): void {\n\t\tthis.activeRun?.abortController.abort();\n\t}',
      '\tabort(origin?: "user" | "timeout" | "error" | "extension" | "programmatic"): void {\n\t\tthis.activeRun?.abortController.abort(origin);\n\t}',
    ).replace(
      '\t\tawait this.processEvents({ type: "agent_end", messages: [failureMessage] });',
      `\t\tconst abortOrigin = aborted ? abortOriginFromReason(this.activeRun?.abortController.signal) : "error";
\t\tawait this.processEvents({
\t\t\ttype: "agent_end",
\t\t\tmessages: [failureMessage],
\t\t\t...(abortOrigin ? { abortOrigin } : {}),
\t\t});`,
    )
    if (!withAbort.includes('function abortOriginFromReason') && withAbort.includes('export class Agent')) {
      next = withAbort.replace(
        'export class Agent {',
        `type AgentAbortOrigin = "user" | "timeout" | "error" | "extension" | "programmatic";
const AGENT_ABORT_ORIGINS: readonly AgentAbortOrigin[] = ["user", "timeout", "error", "extension", "programmatic"];
function abortOriginFromReason(signal: AbortSignal | undefined): AgentAbortOrigin | undefined {
\tif (!signal?.aborted) return undefined;
\tconst reason: unknown = signal.reason;
\treturn typeof reason === "string" && AGENT_ABORT_ORIGINS.includes(reason as AgentAbortOrigin) ? reason as AgentAbortOrigin : undefined;
}

export class Agent {`,
      )
      applied = true
    }
  }
  return { content: next, applied }
}

function portAgentAbortEvent(content) {
  const from = '{ type: "agent_end"; messages: AgentMessage[] }'
  if (!content.includes(from) || content.includes('abortOrigin?:')) return { content, applied: false }
  return {
    content: content.replace(from, '{ type: "agent_end"; messages: AgentMessage[]; abortOrigin?: "user" | "timeout" | "error" | "extension" | "programmatic" }'),
    applied: true,
  }
}

function portLoaderAliases(content) {
  if (content.includes('"@gsd/agent-core"')) return { content, applied: false }
  const anchor = '\t_aliases = {'
  if (!content.includes(anchor)) return { content, applied: false }
  const injected = `\tconst agentCoreWorkspacePath = path.join(packagesRoot, "gsd-agent-core/dist");
\tconst agentCoreEntry = fs.existsSync(agentCoreWorkspacePath)
\t\t? agentCoreWorkspacePath
\t\t: path.dirname(fileURLToPath(import.meta.resolve("@gsd/agent-core")));
\t_aliases = {`
  let next = content.replace(anchor, injected)
  next = next.replace(
    '\t\t"@earendil-works/pi-coding-agent": piCodingAgentEntry,',
    `\t\t"@gsd/pi-coding-agent": piCodingAgentEntry,
\t\t"@gsd/pi-agent-core": piAgentCoreEntry,
\t\t"@gsd/pi-tui": piTuiEntry,
\t\t"@gsd/pi-ai": piAiCompatEntry,
\t\t"@gsd/agent-core": agentCoreEntry,
\t\t"@gsd/agent-modes": resolveWorkspaceOrImport("gsd-agent-modes/dist/index.js", "@gsd/agent-modes"),
\t\t"@earendil-works/pi-coding-agent": piCodingAgentEntry,`,
  )
  return { content: next, applied: next !== content }
}

const SANITIZE_TOOL_SCHEMA = `
export function sanitizeToolSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(sanitizeToolSchema);
	const cleaned: Record<string, unknown> = { ...schema };
	delete cleaned.description;
	delete cleaned.examples;
	delete cleaned.default;
	if (cleaned.properties && typeof cleaned.properties === "object") {
		cleaned.properties = Object.fromEntries(
			Object.entries(cleaned.properties as Record<string, unknown>).map(([key, value]) => [key, sanitizeToolSchema(value)]),
		);
	}
	if (cleaned.items && typeof cleaned.items === "object") cleaned.items = sanitizeToolSchema(cleaned.items);
	if (Array.isArray(cleaned.allOf)) cleaned.allOf = cleaned.allOf.map(sanitizeToolSchema);
	if (Array.isArray(cleaned.anyOf)) cleaned.anyOf = cleaned.anyOf.map(sanitizeToolSchema);
	if (Array.isArray(cleaned.oneOf)) cleaned.oneOf = cleaned.oneOf.map(sanitizeToolSchema);
	return cleaned;
}
`

function buildClaudeSchemaModule(overlay) {
  const start = overlay.indexOf('const JSON_SCHEMA_META_DECLARATIONS')
  const end = overlay.indexOf('function sanitizeForOpenApi')
  if (start < 0 || end < 0) return null
  const body = overlay.slice(start, end)
  if (!body.includes('export function toClaudeInputSchemaRoot')) return null
  return `/** Claude tool-schema sanitizer kept from the v0.75.5 Google shared module. */\n${body}\n${SANITIZE_TOOL_SCHEMA}`
}

function portGoogleShared(content, overlay) {
  let next = content
  let applied = false
  if (!next.includes('SKIP_THOUGHT_SIGNATURE_VALIDATOR')) {
    const withSentinel = next.replace(
      'const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;\n',
      'const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;\nconst SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";\n',
    ).replace(
      `const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};`,
      `const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const effectiveSignature =
						thoughtSignature ??
						(getGeminiMajorVersion(model.id) === 3 ? SKIP_THOUGHT_SIGNATURE_VALIDATOR : undefined);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(effectiveSignature && { thoughtSignature: effectiveSignature }),
					};`,
    )
    applied = withSentinel !== next
    next = withSentinel
  }
  if (!next.includes('toClaudeInputSchemaRoot') && overlay && buildClaudeSchemaModule(overlay)) {
    const patched = next.replace(
      '? { parameters: sanitizeForOpenApi(parameters as unknown) }',
      '? { parameters: sanitizeToolSchema(toClaudeInputSchemaRoot(parameters as unknown)) }',
    )
    if (patched !== next && !patched.includes('from "./claude-tool-schema.ts"')) {
      next = patched.replace(
        'import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";',
        'import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";\nimport { sanitizeToolSchema, toClaudeInputSchemaRoot } from "./claude-tool-schema.ts";',
      )
      applied = true
    }
  }
  return { content: next, applied }
}

function portSettingsSchema(content) {
  if (content.includes('export type AdaptiveTuiMode')) return { content, applied: false }
  let next = content.replace(
    '\ttrueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),\n});',
    `\tadaptiveMode: Type.Optional(
\t\tType.Union(
\t\t\t[
\t\t\t\tType.Literal("auto"),
\t\t\t\tType.Literal("chat"),
\t\t\t\tType.Literal("workflow"),
\t\t\t\tType.Literal("validation"),
\t\t\t\tType.Literal("debug"),
\t\t\t\tType.Literal("compact"),
\t\t\t],
\t\t\t{ description: "Adaptive TUI density override." },
\t\t),
\t),
\ttrueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});`,
  )
  next = next.replace(
    '\t\tterminal: Type.Optional(TerminalSettingsSchema),\n',
    `\t\tcacheRetention: Type.Optional(
\t\t\tType.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")], {
\t\t\t\tdescription: "Prompt cache TTL. long survives gaps longer than five minutes.",
\t\t\t}),
\t\t),
\t\tmemory: Type.Optional(
\t\t\tType.Object({
\t\t\t\tenabled: Type.Optional(Type.Boolean()),
\t\t\t\tmaxRolloutsPerStartup: Type.Optional(Type.Number()),
\t\t\t\tmaxRolloutAgeDays: Type.Optional(Type.Number()),
\t\t\t\tminRolloutIdleHours: Type.Optional(Type.Number()),
\t\t\t\tstage1Concurrency: Type.Optional(Type.Number()),
\t\t\t\tsummaryInjectionTokenLimit: Type.Optional(Type.Number()),
\t\t\t}),
\t\t),
\t\tfallback: Type.Optional(
\t\t\tType.Object({
\t\t\t\tenabled: Type.Optional(Type.Boolean()),
\t\t\t\tchains: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Object({
\t\t\t\t\tprovider: Type.String(),
\t\t\t\t\tmodel: Type.String(),
\t\t\t\t})))),
\t\t\t}),
\t\t),
\t\tterminal: Type.Optional(TerminalSettingsSchema),
`,
  )
  next = next.replace(
    'export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;',
    `export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export type AdaptiveTuiMode = "auto" | "chat" | "workflow" | "validation" | "debug" | "compact";
export type CacheRetentionSetting = "none" | "short" | "long";
export interface MemorySettings {
	enabled?: boolean;
	maxRolloutsPerStartup?: number;
	maxRolloutAgeDays?: number;
	minRolloutIdleHours?: number;
	stage1Concurrency?: number;
	summaryInjectionTokenLimit?: number;
}
export interface FallbackChainEntry {
	provider: string;
	model: string;
}
export interface FallbackSettings {
	enabled?: boolean;
	chains?: Record<string, FallbackChainEntry[]>;
}
`,
  )
  return { content: next, applied: next !== content }
}

function portSettingsManager(content) {
  if (content.includes('getCacheRetention(')) return { content, applied: false }
  let next = content.replace(
    '\tTuiMode,\n\tWarningSettings,\n} from "./settings-schema.ts";',
    '\tAdaptiveTuiMode,\n\tCacheRetentionSetting,\n\tFallbackChainEntry,\n\tFallbackSettings,\n\tMemorySettings,\n\tTuiMode,\n\tWarningSettings,\n} from "./settings-schema.ts";',
  )
  next = next.replace(
    '\tTuiMode,\n\tWarningSettings,\n} from "./settings-schema.ts";\n/** Cache-warming profile.',
    '\tAdaptiveTuiMode,\n\tCacheRetentionSetting,\n\tFallbackChainEntry,\n\tFallbackSettings,\n\tMemorySettings,\n\tTuiMode,\n\tWarningSettings,\n} from "./settings-schema.ts";\n/** Cache-warming profile.',
  )
  next = next.replace(
    `	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}`,
    `	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCacheRetention(): CacheRetentionSetting | undefined {
		return this.settings.cacheRetention;
	}

	setCacheRetention(cacheRetention: CacheRetentionSetting): void {
		this.globalSettings.cacheRetention = cacheRetention;
		this.markModified("cacheRetention");
		this.save();
	}

	getAdaptiveMode(): AdaptiveTuiMode {
		return this.settings.terminal?.adaptiveMode ?? "auto";
	}

	setAdaptiveMode(mode: AdaptiveTuiMode): void {
		if (!this.globalSettings.terminal) this.globalSettings.terminal = {};
		this.globalSettings.terminal.adaptiveMode = mode;
		this.markModified("terminal", "adaptiveMode");
		this.save();
	}

	getMemorySettings(): Required<MemorySettings> {
		return {
			enabled: this.settings.memory?.enabled ?? false,
			maxRolloutsPerStartup: this.settings.memory?.maxRolloutsPerStartup ?? 64,
			maxRolloutAgeDays: this.settings.memory?.maxRolloutAgeDays ?? 30,
			minRolloutIdleHours: this.settings.memory?.minRolloutIdleHours ?? 12,
			stage1Concurrency: this.settings.memory?.stage1Concurrency ?? 8,
			summaryInjectionTokenLimit: this.settings.memory?.summaryInjectionTokenLimit ?? 5000,
		};
	}

	getFallbackSettings(): { enabled: boolean; chains: Record<string, FallbackChainEntry[]> } {
		return {
			enabled: this.settings.fallback?.enabled ?? false,
			chains: this.settings.fallback?.chains ?? {},
		};
	}`,
  )
  return { content: next, applied: next !== content }
}

function portThemeHighlight(content, overlayTheme) {
  if (content.includes('GSD_ENABLE_NATIVE_TUI_HIGHLIGHT')) return { content, applied: false }
  const start = overlayTheme.indexOf('function isIdentStartCode')
  const end = overlayTheme.indexOf('export function highlightCode')
  if (start < 0 || end < 0 || !content.includes('export function highlightCode(code: string, lang?: string): string[] {\n')) {
    return { content, applied: false }
  }
  const helper = overlayTheme.slice(start, end)
  const next = content.replace(
    'export function highlightCode(code: string, lang?: string): string[] {\n',
    `const NATIVE_TUI_HIGHLIGHT_ENABLED = process.env.GSD_ENABLE_NATIVE_TUI_HIGHLIGHT === "1";\n\n${helper}export function highlightCode(code: string, lang?: string): string[] {\n\tif (!NATIVE_TUI_HIGHLIGHT_ENABLED) {\n\t\treturn lang ? lightweightHighlightCode(code) : code.split("\\n");\n\t}\n`,
  )
  return { content: next, applied: next !== content }
}

function portModelRegistryReadiness(content) {
  if (content.includes('isProviderRequestReady(')) return { content, applied: false }
  const anchor = '\tunregisterProvider(providerName: string): void {'
  if (!content.includes(anchor)) return { content, applied: false }
  return {
    content: content.replace(
      anchor,
      `\tisProviderRequestReady(provider: string): boolean {
\t\treturn this.runtime.hasConfiguredAuth(provider);
\t}

\tsettleProviderReadiness(): Promise<void> {
\t\treturn this.runtime.refresh().then(() => undefined);
\t}

\tunregisterProvider(providerName: string): void {`,
    ),
    applied: true,
  }
}

const THEME_SHIM = 'export * from "../modes/interactive/theme/theme.ts";\n'
const EXTENSION_SHIM = `export type { Extension, ExtensionEvent, ExtensionHandler } from "./types.ts";

export type GsdProgressWidgetMode = "min" | "small" | "full";

export interface GsdProgressState {
	phase: string;
	modeTag?: "AUTO" | "NEXT";
	taskProgress?: { done: number; total: number };
	sliceProgress?: { done: number; total: number };
	sliceLabel?: string;
	taskLabel?: string;
	unitLabel?: string;
	elapsed?: string;
	eta?: string;
	model?: string;
	dynamicRoutingTier?: "light" | "standard" | "heavy";
	healthSummary?: string;
	path?: string;
	widgetMode?: GsdProgressWidgetMode;
}
`

function applyPi161Ports(destRoot, overlayRoot, fs, path) {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = fs
  const { dirname, join } = path
  const read = (rel) => readFileSync(join(destRoot, rel), 'utf8')
  const write = (rel, content) => {
    const file = join(destRoot, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const overlay = (rel) => readFileSync(join(overlayRoot, rel), 'utf8')
  const applied = []
  const run = (rel, port) => {
    if (!existsSync(join(destRoot, rel))) return
    const result = port(read(rel))
    if (result.applied) write(rel, result.content)
    applied.push([rel, result.applied])
  }
  run('packages/pi-ai/src/api/anthropic-messages.ts', portAnthropicOAuthBreakpoint)
  run('packages/pi-agent-core/src/agent.ts', portAgentCacheRetention)
  run('packages/pi-agent-core/src/types.ts', portAgentAbortEvent)
  run('packages/pi-coding-agent/src/core/extensions/loader.ts', portLoaderAliases)
  run('packages/pi-coding-agent/src/core/settings-schema.ts', portSettingsSchema)
  run('packages/pi-coding-agent/src/core/settings-manager.ts', portSettingsManager)
  run('packages/pi-coding-agent/src/core/model-registry.ts', portModelRegistryReadiness)
  const googleOverlay = overlay('packages/pi-ai/src/providers/google-shared.ts')
  const claudeModule = buildClaudeSchemaModule(googleOverlay)
  if (claudeModule) write('packages/pi-ai/src/api/claude-tool-schema.ts', claudeModule)
  run('packages/pi-ai/src/api/google-shared.ts', (content) => portGoogleShared(content, googleOverlay))
  run('packages/pi-coding-agent/src/modes/interactive/theme/theme.ts', (content) => portThemeHighlight(content, overlay('packages/pi-coding-agent/src/theme/theme.ts')))
  write('packages/pi-coding-agent/src/theme/theme.ts', THEME_SHIM)
  write('packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts', EXTENSION_SHIM)
  return applied
}

module.exports = {
  BLOCK_OVERLAY_ON_UNPINNED,
  THEME_SHIM,
  EXTENSION_SHIM,
  portAnthropicOAuthBreakpoint,
  portAgentCacheRetention,
  portAgentAbortEvent,
  portLoaderAliases,
  portGoogleShared,
  portSettingsSchema,
  portSettingsManager,
  portThemeHighlight,
  portModelRegistryReadiness,
  buildClaudeSchemaModule,
  applyPi161Ports,
}
