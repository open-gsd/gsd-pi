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
  if (content.includes('public cacheRetention?: CacheRetention')) return { content, applied: false }
  let next = content.replace(
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
  return { content: next, applied: next !== content }
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

module.exports = {
  BLOCK_OVERLAY_ON_UNPINNED,
  portAnthropicOAuthBreakpoint,
  portAgentCacheRetention,
  portLoaderAliases,
}
