/**
 * gsd-pi — Regression tests for #2782
 *
 * Providers registered on `session_start` (e.g. the bundled Ollama extension)
 * are absent from the model registry when cli.ts resolves the default model,
 * so a session whose only provider registers that way boots on the
 * DEFAULT_MODEL placeholder (`unknown/unknown`) and the first prompt fails
 * with "No API key found for the selected model" (print) or
 * "No API provider registered for provider/api: unknown/unknown" (TUI).
 *
 * The repair: before the prompt auth check, if the session still carries the
 * placeholder, resolve the configured default from the registry — by then,
 * session_start registration has settled — and apply it without rewriting
 * the user's persisted default (#2077's silent-rewrite concern).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODEL } from "@gsd/pi-agent-core";
import { AgentSessionModelModule } from "./session/agent-session-model.js";
import { AgentSessionPromptModule } from "./session/agent-session-prompt.js";

/** The model a session_start-registered provider contributes once it settles. */
function registeredModel() {
	return {
		provider: "ollama",
		id: "local-model",
		name: "local-model",
		api: "ollama-chat",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	} as const;
}

/**
 * Host fixture shaped like makeModelModuleHost in agent-session.test.ts, with
 * the pieces repairPlaceholderModel reads: the configured default, the
 * registry's available (authed) models, and the persistence spies.
 */
function makeRepairHost(options: {
	available?: Array<unknown>;
	defaultProvider?: string;
	defaultModel?: string;
	model?: unknown;
}) {
	const persistedModels: string[][] = [];
	const sessionModels: string[][] = [];
	const modelSelectEvents: Array<Record<string, unknown>> = [];
	const host = {
		get model() {
			return (this as { agent: { state: { model: unknown } } }).agent.state.model;
		},
		thinkingLevel: "off",
		agent: { state: { model: options.model ?? DEFAULT_MODEL, thinkingLevel: "off" } },
		modelRegistry: {
			getAvailable: () => options.available ?? [],
			hasConfiguredAuth: (m: unknown) => m === (options.available ?? [])[0],
			isUsingOAuth: () => false,
		},
		sessionManager: {
			appendModelChange: (provider: string, id: string) => sessionModels.push([provider, id]),
		},
		settingsManager: {
			getDefaultProvider: () => options.defaultProvider,
			getDefaultModel: () => options.defaultModel,
			getDefaultThinkingLevel: () => "off",
			setDefaultModelAndProvider: (provider: string, id: string) => persistedModels.push([provider, id]),
		},
		setThinkingLevel: () => {},
		_extensionRunner: {
			emit: async (event: Record<string, unknown>) => {
				modelSelectEvents.push(event);
			},
		},
	};

	return { host, persistedModels, sessionModels, modelSelectEvents };
}

describe("AgentSessionModelModule.repairPlaceholderModel (#2782)", () => {
	it("applies the configured default once the session_start provider has registered", async () => {
		const model = registeredModel();
		const { host, persistedModels, sessionModels, modelSelectEvents } = makeRepairHost({
			available: [model],
			defaultProvider: "ollama",
			defaultModel: "local-model",
		});

		const repaired = await new AgentSessionModelModule(host as never).repairPlaceholderModel();

		assert.equal(repaired, true, "the placeholder must be repairable");
		assert.equal(
			(host as { agent: { state: { model: unknown } } }).agent.state.model,
			model,
			"the session model must be the configured default",
		);
		assert.deepEqual(persistedModels, [], "repair must never rewrite the user's persisted default");
		assert.deepEqual(sessionModels, [["ollama", "local-model"]], "the model change must land in the transcript");
		const [selectEvent] = modelSelectEvents;
		assert.equal(selectEvent?.type, "model_select", "repair emits the model_select event");
		assert.equal(selectEvent?.source, "restore", "repair is not a user choice — consumers treat restore as non-manual");
		assert.equal(selectEvent?.previousModel, DEFAULT_MODEL, "the placeholder is the previous model");
		assert.equal((selectEvent?.model as { provider: string }).provider, "ollama");
	});

	it("leaves a real session model untouched", async () => {
		const model = registeredModel();
		const { host } = makeRepairHost({
			available: [model],
			defaultProvider: "ollama",
			defaultModel: "local-model",
			model,
		});

		const repaired = await new AgentSessionModelModule(host as never).repairPlaceholderModel();

		assert.equal(repaired, false, "a session that already has a model needs no repair");
		assert.equal((host as { model: unknown }).model, model);
	});

	it("keeps the placeholder when the configured default is still unregistered", async () => {
		const { host } = makeRepairHost({
			available: [],
			defaultProvider: "ollama",
			defaultModel: "local-model",
		});

		const repaired = await new AgentSessionModelModule(host as never).repairPlaceholderModel();

		assert.equal(repaired, false, "nothing to repair from yet");
		assert.equal(
			(host as { agent: { state: { model: unknown } } }).agent.state.model,
			DEFAULT_MODEL,
			"the placeholder must be preserved, not replaced by a guess",
		);
	});

	it("keeps the placeholder when no default is configured", async () => {
		const { host } = makeRepairHost({ available: [registeredModel()] });

		const repaired = await new AgentSessionModelModule(host as never).repairPlaceholderModel();

		assert.equal(repaired, false);
		assert.equal(
			(host as { agent: { state: { model: unknown } } }).agent.state.model,
			DEFAULT_MODEL,
		);
	});

	it("retries a failed repair on the next prompt once the provider registers", async () => {
		// The interactive-mode known limitation: the first prompt can beat the
		// session_start provider registration. The single-flight memo must clear
		// on settle so the repair retries instead of caching the failure.
		const model = registeredModel();
		const { host, modelSelectEvents } = makeRepairHost({
			available: [],
			defaultProvider: "ollama",
			defaultModel: "local-model",
		});
		const registry = (host as { modelRegistry: { getAvailable: () => Array<unknown>; hasConfiguredAuth: (m: unknown) => boolean } }).modelRegistry;

		const module = new AgentSessionModelModule(host as never);
		assert.equal(await module.repairPlaceholderModel(), false, "first prompt: nothing registered yet");

		// The session_start provider registers between the two prompts.
		registry.getAvailable = () => [model];
		registry.hasConfiguredAuth = (m) => m === model;
		assert.equal(await module.repairPlaceholderModel(), true, "second prompt: repair retries after settling");
		assert.equal((host as { model: unknown }).model, model);
		assert.equal(modelSelectEvents.length, 1, "exactly one model_select lands across the two prompts");
	});
});

/**
 * Thrown by the mock agent's prompt() to prove the prompt-path test got past
 * the model auth check — the exact gate the #2782 placeholder died at.
 */
class PastTheGateError extends Error {}

function makePromptHost(options: { available: Array<unknown>; defaultProvider?: string; defaultModel?: string }) {
	const repair = makeRepairHost(options);
	const host = {
		// Object spread would copy the repair fixture's model getter as a stale
		// plain property; the prompt host needs the live view of agent state.
		get model() {
			return (this as { agent: { state: { model: unknown } } }).agent.state.model;
		},
		thinkingLevel: "off",
		agent: {
			state: { model: DEFAULT_MODEL, thinkingLevel: "off" },
			latencyMark: undefined,
			prompt: async () => {
				throw new PastTheGateError();
			},
			continue: async () => {},
		},
		modelRegistry: repair.host.modelRegistry,
		sessionManager: repair.host.sessionManager,
		settingsManager: repair.host.settingsManager,
		setThinkingLevel: () => {},
		_extensionRunner: {
			emit: async () => {},
			emitError: async () => {},
			hasHandlers: () => false,
			emitBeforeAgentStart: async () => undefined,
		},
		flushPendingBashMessages: () => {},
		markTurnLatency: () => {},
		beginTurnLatency: () => ({ source: "test" }),
		finishTurnLatency: () => {},
		findLastAssistantMessage: () => undefined,
		_pendingNextTurnMessages: [],
		_baseSystemPrompt: "",
		_baseSystemPromptOptions: undefined,
		promptTemplates: [],
		markFirstStreamActivity: () => {},
		repairPlaceholderModel: async () =>
			new AgentSessionModelModule(host as never).repairPlaceholderModel(),
	};
	return host;
}

describe("prompt() placeholder repair (#2782)", () => {
	it("repairs the unknown placeholder before the auth check and proceeds", async () => {
		const host = makePromptHost({
			available: [registeredModel()],
			defaultProvider: "ollama",
			defaultModel: "local-model",
		});

		await assert.rejects(
			new AgentSessionPromptModule(host as never).prompt("hello world"),
			PastTheGateError,
			"the prompt must pass the model auth gate and reach the agent run",
		);
		assert.equal(
			(host as { model: unknown }).model.provider,
			"ollama",
			"the session must be on the repaired model by the time the agent runs",
		);
	});

	it("still fails at the auth gate when nothing can repair the placeholder", async () => {
		const host = makePromptHost({
			available: [],
			defaultProvider: "ollama",
			defaultModel: "local-model",
		});

		await assert.rejects(
			new AgentSessionPromptModule(host as never).prompt("hello world"),
			(err: Error) => err.message.includes("No API key found for the selected model"),
			"the original #2782 symptom must surface unchanged when repair is impossible",
		);
		assert.equal(
			(host as { model: unknown }).model.provider,
			"unknown",
			"the placeholder must be preserved, not guessed away",
		);
	});
});
