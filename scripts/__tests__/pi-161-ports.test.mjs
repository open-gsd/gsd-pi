import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  portAnthropicOAuthBreakpoint,
  portAgentCacheRetention,
  portAgentAbortEvent,
  portLoaderAliases,
  portSettingsSchema,
  portSettingsManager,
  portGoogleShared,
  portModelRegistryReadiness,
  buildClaudeSchemaModule,
  THEME_SHIM,
  EXTENSION_SHIM,
} = require('../pi-161-ports.cjs')

const oauthBlock = `params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {`

test('oauth breakpoint stays off the constant identity block when a system prompt follows', () => {
  const result = portAnthropicOAuthBreakpoint(oauthBlock)
  assert.equal(result.applied, true)
  assert.match(result.content, /const hasSystemPrompt = Boolean\(initialSystemText\)/)
  assert.match(result.content, /!\s*hasSystemPrompt && cacheControl/)
})

test('agent threads cacheRetention into the loop config', () => {
  const source = [
    'type Transport,',
    '\ttoToolDeclaration,',
    '\tsessionId?: string;',
    '\tthinkingBudgets?: ThinkingBudgets;',
    '\tpublic sessionId?: string;',
    '\t/** Optional per-level thinking token budgets forwarded to the stream function. */',
    'this.sessionId = runtimeOptions.sessionId;',
    '\t\tthis.thinkingBudgets = runtimeOptions.thinkingBudgets;',
    'sessionId: this.sessionId,',
    '\t\t\tonPayload: this.onPayload,',
  ].join('\n')
  const result = portAgentCacheRetention(source)
  assert.equal(result.applied, true)
  assert.match(result.content, /type CacheRetention/)
  assert.match(result.content, /public cacheRetention\?: CacheRetention/)
  assert.match(result.content, /this\.cacheRetention = runtimeOptions\.cacheRetention/)
  assert.match(result.content, /cacheRetention: this\.cacheRetention/)
})

test('agent abort keeps an optional origin and latencyMark stays assignable', () => {
  const source = [
    'export class Agent {',
    '\tabort(): void {',
    '\t\tthis.activeRun?.abortController.abort();',
    '\t}',
    '\t\tawait this.processEvents({ type: "agent_end", messages: [failureMessage] });',
    '\tpublic cacheRetention?: CacheRetention;',
    '\tcacheRetention?: CacheRetention;',
    '\tthinkingBudgets?: ThinkingBudgets;',
    'this.cacheRetention = runtimeOptions.cacheRetention;',
  ].join('\n')
  const result = portAgentCacheRetention(source)
  assert.equal(result.applied, true)
  assert.match(result.content, /abort\(origin\?:/)
  assert.match(result.content, /abortOriginFromReason/)
  assert.match(result.content, /public latencyMark\?:/)
})

test('agent_end can carry abortOrigin', () => {
  const result = portAgentAbortEvent('| { type: "agent_end"; messages: AgentMessage[] }')
  assert.equal(result.applied, true)
  assert.match(result.content, /abortOrigin\?:/)
})

test('settings schema keeps the GSD fields the host reads', () => {
  const source = [
    '\ttrueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),',
    '});',
    '\t\tterminal: Type.Optional(TerminalSettingsSchema),',
    'export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;',
  ].join('\n')
  const result = portSettingsSchema(source)
  assert.equal(result.applied, true)
  assert.match(result.content, /export type AdaptiveTuiMode/)
  assert.match(result.content, /cacheRetention: Type.Optional/)
  assert.match(result.content, /adaptiveMode: Type.Optional/)
})

test('settings manager exposes cache, adaptive mode, memory, and fallback', () => {
  const source = [
    '\tTuiMode,',
    '\tWarningSettings,',
    '} from "./settings-schema.ts";',
    '\tTuiMode,',
    '\tWarningSettings,',
    '} from "./settings-schema.ts";',
    '/** Cache-warming profile.',
    '\tsetTransport(transport: TransportSetting): void {',
    '\t\tthis.globalSettings.transport = transport;',
    '\t\tthis.markModified("transport");',
    '\t\tthis.save();',
    '\t}',
  ].join('\n')
  const result = portSettingsManager(source)
  assert.equal(result.applied, true)
  assert.match(result.content, /getCacheRetention\(/)
  assert.match(result.content, /getAdaptiveMode\(/)
  assert.match(result.content, /getFallbackSettings\(/)
})

test('google convertTools uses the Claude schema sanitizer on the legacy parameters path', () => {
  const overlay = [
    'const JSON_SCHEMA_META_DECLARATIONS = new Set(["$schema"]);',
    'export function toClaudeInputSchemaRoot(schema: unknown): Record<string, unknown> { return { type: "object" }; }',
    'function sanitizeForOpenApi(schema: unknown): unknown { return schema }',
  ].join('\n')
  const source = [
    'import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";',
    'const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;',
    '? { parameters: sanitizeForOpenApi(parameters as unknown) }',
  ].join('\n')
  const result = portGoogleShared(source, overlay)
  assert.equal(result.applied, true)
  assert.match(result.content, /toClaudeInputSchemaRoot/)
  assert.match(result.content, /from "\.\/claude-tool-schema.ts"/)
  assert.ok(buildClaudeSchemaModule(overlay))
})

test('model registry keeps ModelRuntime and answers readiness from it', () => {
  const result = portModelRegistryReadiness('\tunregisterProvider(providerName: string): void {')
  assert.equal(result.applied, true)
  assert.match(result.content, /this\.runtime\.hasConfiguredAuth\(provider\)/)
})

test('shims keep the old theme and extension type paths', () => {
  assert.match(THEME_SHIM, /modes\/interactive\/theme\/theme\.ts/)
  assert.match(EXTENSION_SHIM, /export interface GsdProgressState/)
  assert.match(EXTENSION_SHIM, /from "\.\/types\.ts"/)
})

test('loader keeps upstream aliases and adds GSD package aliases', () => {
  const source = [
    '\t_aliases = {',
    '\t\t"@earendil-works/pi-coding-agent": piCodingAgentEntry,',
    '\t}',
  ].join('\n')
  const result = portLoaderAliases(source)
  assert.equal(result.applied, true)
  assert.match(result.content, /"@gsd\/agent-core": agentCoreEntry/)
  assert.match(result.content, /"@earendil-works\/pi-coding-agent": piCodingAgentEntry/)
})
