import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  portAnthropicOAuthBreakpoint,
  portAgentCacheRetention,
  portLoaderAliases,
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
