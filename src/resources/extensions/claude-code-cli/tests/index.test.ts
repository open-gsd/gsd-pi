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
	assert.deepEqual(
		fable51.compat,
		{ forceAdaptiveThinking: true, strictRequestParams: true },
		"catalog strict-surface marker for Fable 5.1 must reach the registered model (#2645)",
	);
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
	// Catalog thinking metadata is additive (#2830): a curated entry without
	// its own map/compat inherits the catalog entry's.
	assert.deepEqual(
		opus5.thinkingLevelMap,
		{ xhigh: "max" },
		"curated entry (no map) must inherit the catalog thinkingLevelMap",
	);
	assert.deepEqual(
		opus5.compat,
		{ forceAdaptiveThinking: true },
		"curated entry (no compat) must inherit the catalog compat flags",
	);

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

// #2645 — curated CLAUDE_CODE_MODELS entries win the catalog merge (#2437),
// so the strict-surface compat must be restated on the curated opus-5-5 /
// fable-5 entries; without it thinking-off sends {type:"disabled"} and 400s.
test("curated 5.x entries carry the strict-surface compat through the merge (#2645)", () => {
	const merged = buildClaudeCodeModelList([]);

	const opus55 = merged.find((model) => model.id === "claude-opus-5-5");
	assert.ok(opus55, "curated opus-5-5 must be present");
	assert.deepEqual(
		opus55.compat,
		{ forceAdaptiveThinking: true, strictRequestParams: true },
		"curated Opus 5.5 must keep the strictRequestParams umbrella",
	);

	const fable5 = merged.find((model) => model.id === "claude-fable-5");
	assert.ok(fable5, "curated fable-5 must be present");
	assert.deepEqual(
		fable5.compat,
		{ forceAdaptiveThinking: true, thinkingOffMode: "between_tools", rejectsTemperature: true },
		"curated Fable 5 must carry the granular flags (it accepts forced tool_choice)",
	);
});

// #2701 — Haiku 5.5 registers via the curated list with the adaptive +
// temperature compat (no strict umbrella: it accepts disabled + forced
// tool_choice) and the 1M/128K limits.
test("curated Haiku 5.5 carries adaptive + temperature compat through the merge (#2701)", () => {
	const merged = buildClaudeCodeModelList([]);

	const haiku55 = merged.find((model) => model.id === "claude-haiku-5-5");
	assert.ok(haiku55, "curated haiku-5-5 must be present");
	assert.deepEqual(
		haiku55.compat,
		{ forceAdaptiveThinking: true, rejectsTemperature: true },
		"curated Haiku 5.5 must be adaptive-only and temperature-guarded without the strict umbrella",
	);
	assert.equal(haiku55.contextWindow, 1_000_000);
	assert.equal(haiku55.maxTokens, 128_000);
	assert.deepEqual(haiku55.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

// #2830 — curated entries win the merge, but only for the fields they
// actually specify: catalog compat flags OR in and curated thinkingLevelMap
// keys override, so curated ids keep the catalog's xhigh mapping.
test("curated compat keys win the per-field merge; catalog keys fill the gaps (#2830)", () => {
	const merged = buildClaudeCodeModelList([
		{
			id: "claude-opus-5-5",
			name: "Catalog Opus 5.5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 123,
			maxTokens: 456,
			compat: { forceAdaptiveThinking: true, strictRequestParams: false, rejectsTemperature: true },
			thinkingLevelMap: { xhigh: "xhigh", high: "HIGH" },
		},
	]);

	const opus55 = merged.find((model) => model.id === "claude-opus-5-5");
	assert.ok(opus55, "conflicting id must stay registered");
	assert.equal(opus55.contextWindow, 1_000_000, "curated limits must still win");
	assert.deepEqual(
		opus55.compat,
		// Curated strictRequestParams (true) beats the catalog's false; the
		// catalog's rejectsTemperature fills the gap the curated entry leaves.
		{ forceAdaptiveThinking: true, strictRequestParams: true, rejectsTemperature: true },
	);
	assert.deepEqual(
		opus55.thinkingLevelMap,
		{ xhigh: "xhigh", high: "HIGH" },
		"curated entry without a map must inherit the catalog keys",
	);
	// The merge composes into a copy — the module-level curated list itself
	// must stay untouched (no catalog compat/map may leak into later merges).
	assert.equal(
		CLAUDE_CODE_MODELS.find((model) => model.id === "claude-opus-5-5")?.thinkingLevelMap,
		undefined,
		"merge must not mutate the curated list entries",
	);
	assert.deepEqual(
		CLAUDE_CODE_MODELS.find((model) => model.id === "claude-opus-5-5")?.compat,
		{ forceAdaptiveThinking: true, strictRequestParams: true },
		"merge must not add catalog compat flags to the curated constant",
	);
});

// #2830 — the real anthropic catalog carries the xhigh maps and the adaptive
// compat that curated entries drop today; they must reach the merged list.
test("real catalog thinking metadata reaches curated entries (#2830)", () => {
	const merged = buildClaudeCodeModelList();

	const opus55 = merged.find((model) => model.id === "claude-opus-5-5");
	assert.ok(opus55, "curated opus-5-5 must be present");
	assert.deepEqual(
		opus55.thinkingLevelMap,
		{ xhigh: "xhigh" },
		"Opus 5.5 must keep the catalog xhigh mapping so configured xhigh is not clamped to high",
	);

	const opus46 = merged.find((model) => model.id === "claude-opus-4-6");
	assert.ok(opus46, "curated opus-4-6 must be present");
	assert.deepEqual(opus46.thinkingLevelMap, { xhigh: "max" }, "Opus 4.6 maps xhigh to max effort");

	const sonnet5 = merged.find((model) => model.id === "claude-sonnet-5");
	assert.ok(sonnet5, "curated sonnet-5 must be present");
	assert.equal(
		sonnet5.compat?.forceAdaptiveThinking,
		true,
		"Sonnet 5 must inherit adaptive thinking — the id heuristic does not cover it",
	);
	assert.deepEqual(sonnet5.thinkingLevelMap, { xhigh: "xhigh" });

	// The anthropic catalog has no thinkingLevelMap for the Haiku rows — the
	// curated entries must not grow an empty/undefined map.
	const haiku45 = merged.find((model) => model.id === "claude-haiku-4-5");
	assert.ok(haiku45, "curated haiku-4-5 must be present");
	assert.equal(haiku45.thinkingLevelMap, undefined);
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
