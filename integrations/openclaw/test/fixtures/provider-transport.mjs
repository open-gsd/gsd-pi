import assert from 'node:assert/strict';
import { configureHttpDispatcher } from '../../../../packages/pi-coding-agent/dist/core/http-dispatcher.js';
import { streamSimpleOpenAICompletions } from '../../../../packages/pi-ai/dist/providers/openai-completions.js';

configureHttpDispatcher(0);
const model = {
  id: 'DeepSeek-V4.1-Flash-1017', name: 'Offline fixture', provider: 'spark',
  api: 'openai-completions', baseUrl: 'https://provider.invalid/v1',
  reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 1048576,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: { supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
};
const request = (text, options = {}) => streamSimpleOpenAICompletions(model, {
  messages: [{ role: 'user', content: text, timestamp: 0 }],
}, { apiKey: process.env.GSD_TEST_KEY, maxRetries: 0, timeoutMs: 2000, ...options }).result();

for (const [text, options] of [
  ['default', {}], ['override', { maxTokens: 32768, reasoning: 'max' }],
  ['native-upper-bound', { maxTokens: 1048576, reasoning: 'xhigh' }],
  ['delayed', {}],
]) {
  const result = await request(text, options);
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(result.content.filter(c => c.type === 'text').map(c => c.text).join(''), 'ok');
}
const timeout = await request('timeout', { timeoutMs: 15 });
assert.equal(timeout.stopReason, 'error');
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20);
const aborted = await request('abort', { signal: controller.signal });
clearTimeout(timer);
assert.equal(aborted.stopReason, 'aborted');
console.log(JSON.stringify({ successfulStreams: 4, timeoutObserved: true, abortObserved: true }));
