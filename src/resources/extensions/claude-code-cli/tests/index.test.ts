// gsd-pi - Claude Code CLI extension wiring tests
import { test } from "node:test";
import assert from "node:assert/strict";
import claudeCodeCli from "../index.ts";
import { buildClaudeCodeModelList, CLAUDE_CODE_MODELS } from "../models.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeMockPi() {
	const handlers = new Map<string, Handler[]>();
	const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider(name: string, config: Record<string, unknown>) {
			providers.push({ name, config });
		},
	};
	return { pi, handlers, providers };
}

test("registers the claude-code provider with a streamSimple delegate", () => {
	const { pi, providers } = makeMockPi();
	claudeCodeCli(pi as never);

	assert.equal(providers.length, 1);
	assert.equal(providers[0].name, "claude-code");
	assert.equal(typeof providers[0].config.streamSimple, "function");
});

test("registers Claude Opus 5 as a Claude Code CLI model", () => {
	const { pi, providers } = makeMockPi();
	claudeCodeCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	const opus5 = models.find((model) => model.id === "claude-opus-5");

	assert.ok(opus5, "claude-opus-5 must be selectable via the claude-code provider");
	assert.equal(opus5.name, "Claude Opus 5 (via Claude Code)");
	assert.equal(opus5.reasoning, true);
	assert.equal(opus5.contextWindow, 1_000_000);
	assert.equal(opus5.maxTokens, 128_000);
});

test("registers Claude Sonnet 5 as a Claude Code CLI model", () => {
	const { pi, providers } = makeMockPi();
	claudeCodeCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	const sonnet5 = models.find((model) => model.id === "claude-sonnet-5");

	assert.ok(sonnet5, "claude-sonnet-5 must be selectable via the claude-code provider");
	assert.equal(sonnet5.name, "Claude Sonnet 5 (via Claude Code)");
	assert.equal(sonnet5.reasoning, true);
	assert.equal(sonnet5.contextWindow, 1_000_000);
	assert.equal(sonnet5.maxTokens, 128_000);
});

// #2437 — catalog-driven registration: new Claude releases must register
// without a code change in models.ts.
test("registers catalog-only Claude models (claude-fable-5-1) with zero cost and catalog metadata (#2437)", () => {
	const { pi, providers } = makeMockPi();
	claudeCodeCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	const fable51 = models.find((model) => model.id === "claude-fable-5-1");

	assert.ok(fable51, "claude-fable-5-1 must register from the anthropic catalog without a code change");
	assert.equal(fable51.name, "Claude Fable 5.1 (via Claude Code)");
	assert.equal(fable51.reasoning, true);
	assert.equal(fable51.contextWindow, 1_000_000);
	assert.equal(fable51.maxTokens, 128_000);
	assert.deepEqual(fable51.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(fable51.compat, { forceAdaptiveThinking: true, strictRequestParams: true, thinkingOffMode: "omit" });
	assert.deepEqual(fable51.thinkingLevelMap, { xhigh: "xhigh" });
});

test("every hardcoded CLAUDE_CODE_MODELS entry survives the catalog merge", () => {
	const { pi, providers } = makeMockPi();
	claudeCodeCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	const ids = new Set(models.map((model) => model.id));
	for (const model of CLAUDE_CODE_MODELS) {
		assert.ok(ids.has(model.id), `${model.id} must remain registered`);
	}
});

test("buildClaudeCodeModelList: hardcoded list wins conflicts, catalog-only entries are appended, dated aliases are excluded", () => {
	const merged = buildClaudeCodeModelList([
		{
			id: "claude-opus-5",
			name: "Catalog Opus 5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 123,
			maxTokens: 456,
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: { xhigh: "max" },
		},
		{
			id: "claude-opus-9",
			name: "Claude Opus 9",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 10, cacheRead: 1, cacheWrite: 2 },
			contextWindow: 999_000,
			maxTokens: 64_000,
		},
		{
			id: "claude-opus-4-5-20251101",
			name: "Claude Opus 4.5 (dated)",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		},
	]);

	const opus5 = merged.find((model) => model.id === "claude-opus-5");
	assert.ok(opus5, "conflicting id must stay registered");
	assert.equal(opus5.name, "Claude Opus 5 (via Claude Code)", "curated name must win over the catalog name");
	assert.equal(opus5.contextWindow, 1_000_000, "curated context window must win over the catalog value");
	assert.equal(opus5.maxTokens, 128_000, "curated max tokens must win over the catalog value");
	assert.equal(opus5.thinkingLevelMap, undefined, "curated entry (no map) must not inherit the catalog map");

	const opus9 = merged.find((model) => model.id === "claude-opus-9");
	assert.ok(opus9, "catalog-only first-party id must be merged in");
	assert.deepEqual(opus9.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "merged entries must be zero-cost");

	assert.ok(
		!merged.some((model) => model.id === "claude-opus-4-5-20251101"),
		"dated snapshot aliases must be excluded",
	);

	// Curated order is preserved so "first model" fallback selection stays
	// stable; catalog-only entries are appended after the curated list.
	assert.equal(merged[0]!.id, CLAUDE_CODE_MODELS[0]!.id, "curated list order must lead the merged list");
	assert.deepEqual(
		merged.slice(0, CLAUDE_CODE_MODELS.length).map((model) => model.id),
		CLAUDE_CODE_MODELS.map((model) => model.id),
		"curated entries must keep their relative order",
	);
	assert.equal(merged[merged.length - 1]!.id, "claude-opus-9", "catalog-only entries must be appended at the end");
});

test("buildClaudeCodeModelList: catalog strictRequestParams compat flows through to merged entries (#2500)", () => {
	const merged = buildClaudeCodeModelList([
		{
			id: "claude-sonnet-5-5",
			name: "Claude Sonnet 5.5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, strictRequestParams: true },
		},
	]);

	const sonnet55 = merged.find((model) => model.id === "claude-sonnet-5-5");
	assert.ok(sonnet55, "catalog sonnet-5-5 must be merged in");
	assert.deepEqual(
		sonnet55.compat,
		{ forceAdaptiveThinking: true, strictRequestParams: true },
		"strictRequestParams must reach the registered model so the stream adapter can guard requests",
	);
});

test("buildClaudeCodeModelList: curated Opus 5.5 and Fable 5 carry the thinking-off compat (#2500)", () => {
	const merged = buildClaudeCodeModelList([]);
	const expected = {
		"claude-opus-5-5": { forceAdaptiveThinking: true, strictRequestParams: true, thinkingOffMode: "omit" },
		// Fable 5 cannot disable thinking but still accepts forced tool choice.
		"claude-fable-5": { forceAdaptiveThinking: true, thinkingOffMode: "omit" },
	};
	for (const [id, compat] of Object.entries(expected)) {
		const model = merged.find((entry) => entry.id === id);
		assert.ok(model, `${id} must be registered`);
		assert.deepEqual(model.compat, compat, `${id} cannot disable thinking; the adapter needs thinkingOffMode omit`);
	}
});

test("captures UI context before streamSimple, including when before_provider_request never fires (#2118)", () => {
	const { pi, handlers } = makeMockPi();
	claudeCodeCli(pi as never);

	for (const event of ["session_start", "before_agent_start", "before_provider_request"]) {
		const registered = handlers.get(event);
		assert.ok(registered && registered.length === 1, `${event} handler must be registered`);
		const handler = registered[0]!;
		const sentinelUi = { kind: "ui" };
		assert.equal(handler({ type: event }, { hasUI: true, ui: sentinelUi }), undefined);
		assert.equal(handler({ type: event }, { hasUI: false, ui: sentinelUi }), undefined);
	}
});
