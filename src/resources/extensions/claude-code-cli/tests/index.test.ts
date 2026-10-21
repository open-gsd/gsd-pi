// gsd-pi - Claude Code CLI extension wiring tests
import { test } from "node:test";
import assert from "node:assert/strict";
import claudeCodeCli from "../index.ts";

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

test("registers a before_provider_request hook to capture the UI context", () => {
	const { pi, handlers } = makeMockPi();
	claudeCodeCli(pi as never);

	const registered = handlers.get("before_provider_request");
	assert.ok(registered && registered.length === 1, "before_provider_request handler must be registered");

	// Without this hook, core calls streamSimple with no UI context and
	// ask_user_questions self-cancels. The handler must accept both UI states
	// without throwing and must not mutate the provider payload.
	const handler = registered[0];
	const sentinelUi = { kind: "ui" };
	assert.equal(handler({ type: "before_provider_request" }, { hasUI: true, ui: sentinelUi }), undefined);
	assert.equal(handler({ type: "before_provider_request" }, { hasUI: false, ui: sentinelUi }), undefined);
});
