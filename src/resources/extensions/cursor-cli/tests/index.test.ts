import { test } from "node:test";
import assert from "node:assert/strict";
import cursorCli, { probeAndRegisterCursorModels } from "../index.ts";
import { CURSOR_AGENT_MODELS } from "../models.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeMockPi() {
	const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
	const handlers: Record<string, Handler> = {};
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
		registerProvider(name: string, config: Record<string, unknown>) {
			providers.push({ name, config });
		},
		unregisterProvider(name: string) {
			for (let i = providers.length - 1; i >= 0; i--) {
				if (providers[i]?.name === name) providers.splice(i, 1);
			}
		},
	};
	return { pi, providers, handlers };
}

function modelIds(providers: Array<{ config: Record<string, unknown> }>): string[] {
	return (providers[0]?.config.models as Array<{ id: string }>).map((model) => model.id);
}

test("registers the cursor-agent provider with external CLI auth", () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);

	assert.equal(providers.length, 1);
	assert.equal(providers[0].name, "cursor-agent");
	assert.equal(providers[0].config.name, "Cursor Agent");
	assert.equal(providers[0].config.authMode, "externalCli");
	assert.equal(providers[0].config.api, "cursor-stream-json");
	assert.equal(providers[0].config.baseUrl, "local://cursor-agent");
	assert.equal(typeof providers[0].config.isReady, "function");
	assert.equal(typeof providers[0].config.streamSimple, "function");
});

test("registers static Cursor subscription models as offline fallback (#1869)", () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	assert.ok(models.some((model) => model.id === "composer-2.5"));
	assert.ok(models.some((model) => model.id === "claude-4.6-sonnet-medium"));
	assert.ok(models.some((model) => model.id === "gpt-5.5-medium"));
	assert.ok(!models.some((model) => model.id === "claude-sonnet-4-6"));
	assert.ok(!models.some((model) => model.id === "gpt-5.5"));
	assert.ok(models.every((model) => (model.cost as Record<string, number>).input === 0));
});

test("session_start rediscovers CLI models and replaces the fallback catalog (#1869)", async () => {
	const { pi, providers, handlers } = makeMockPi();
	cursorCli(pi as never);
	assert.equal((providers[0].config.models as Array<{ id: string }>).some((m) => m.id === "composer-2.5"), true);

	await probeAndRegisterCursorModels(
		pi as never,
		() => ["gpt-5.6-sol-high - GPT-5.6 Sol 1M High", "composer-2.5 - Composer 2.5 (current)"].join("\n"),
		() => true,
	);
	assert.equal(providers.length, 1);
	const models = providers[0].config.models as Array<{ id: string }>;
	assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol-high", "composer-2.5"]);
	assert.equal(typeof handlers.session_start, "function");
});

test("session_start does not block on live catalog discovery in headless (#1869)", () => {
	const { pi, providers, handlers } = makeMockPi();
	cursorCli(pi as never);
	const before = providers[0].config.models;

	const result = handlers.session_start({}, { hasUI: false });
	assert.equal(result, undefined);
	assert.equal(handlers.session_start.constructor.name, "Function");
	assert.equal(providers[0].config.models, before);
	assert.deepEqual(modelIds(providers), CURSOR_AGENT_MODELS.map((model) => model.id));
});

test("probe skips --list-models when the cursor-agent binary is missing (#1869)", async () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);
	let reads = 0;
	const models = await probeAndRegisterCursorModels(
		pi as never,
		() => {
			reads += 1;
			return "kimi-k3 - Kimi K3";
		},
		() => false,
	);
	assert.equal(reads, 0);
	assert.equal(models, CURSOR_AGENT_MODELS);
	assert.deepEqual(modelIds(providers), CURSOR_AGENT_MODELS.map((model) => model.id));
});

test("probe keeps the fallback catalog when list-models throws (#1869)", async () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);
	const models = await probeAndRegisterCursorModels(
		pi as never,
		() => {
			throw new Error("cursor-agent --list-models failed");
		},
		() => true,
	);
	assert.equal(models, CURSOR_AGENT_MODELS);
	assert.deepEqual(modelIds(providers), CURSOR_AGENT_MODELS.map((model) => model.id));
});

test("GSD_CURSOR_DISABLE keeps the provider dormant", () => {
	const original = process.env.GSD_CURSOR_DISABLE;
	process.env.GSD_CURSOR_DISABLE = "1";
	try {
		const { pi, providers } = makeMockPi();
		cursorCli(pi as never);
		assert.equal(providers.length, 0);
	} finally {
		if (original === undefined) delete process.env.GSD_CURSOR_DISABLE;
		else process.env.GSD_CURSOR_DISABLE = original;
	}
});
