import type { ThinkingLevel } from "@gsd/pi-agent-core";
import { isDefaultPlaceholderModel } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual, streamSimple } from "@gsd/pi-ai";
import { formatNoApiKeyFoundMessage } from "@gsd/pi-coding-agent/core/auth-guidance.js";
import { DEFAULT_THINKING_LEVEL } from "@gsd/pi-coding-agent/core/defaults.js";
import type { ModelCycleResult } from "./agent-session-types.js";
import { THINKING_LEVELS } from "./agent-session-types.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export class AgentSessionModelModule {
	/** In-flight placeholder repair, shared so concurrent first prompts run one repair. */
	private placeholderRepairInFlight: Promise<boolean> | undefined;

	constructor(readonly host: AgentSessionHost) {}

	async getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this.host.modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this.host.modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	async getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		if (this.host.agent.streamFn === streamSimple) {
			return this.getRequiredRequestAuth(model);
		}

		const result = await this.host.modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	async emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this.host._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	async setModel(model: Model<any>, options?: { persist?: boolean; source?: "set" | "restore" }): Promise<void> {
		if (!this.host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.host.model;
		const thinkingLevel = this.getThinkingLevelForModelSwitch();
		this.host.agent.state.model = model;
		this.host.sessionManager.appendModelChange(model.provider, model.id);
		if (options?.persist !== false) {
			this.host.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		// Re-clamp thinking level for new model's capabilities
		this.host.setThinkingLevel(thinkingLevel);

		// "restore" is the non-manual source: session resume and registry
		// re-application, not a fresh user choice. Consumers treat it
		// accordingly (e.g. the Copilot cheaper-alternative advisory skips it).
		await this.emitModelSelect(model, previousModel, options?.source ?? "set");
	}

	/**
	 * Apply the configured default model when the session still carries the
	 * no-model placeholder (#2782). Providers registered on session_start
	 * (e.g. the bundled Ollama extension) are absent from the registry while
	 * cli.ts resolves the default, so the session can reach the first prompt
	 * on the placeholder; by prompt time registration has settled. Never
	 * rewrites the user's persisted default (persist: false — the default
	 * being applied is already the persisted choice).
	 */
	async repairPlaceholderModel(): Promise<boolean> {
		if (!isDefaultPlaceholderModel(this.host.model)) return false;

		// Single-flight: concurrent first prompts (e.g. back-to-back RPC
		// prompt commands, which rpc-mode does not await) share one repair,
		// so the model_select event and the transcript model_change land
		// exactly once. Today the check→set path is fully synchronous, so
		// this is an explicit contract rather than a lock — it keeps the
		// guarantee if the path ever awaits (e.g. awaiting provider
		// registration settlement). Cleared on settle so a failed repair
		// (nothing registered yet) retries on the next prompt.
		this.placeholderRepairInFlight ??= this.applyConfiguredDefaultModel();
		try {
			return await this.placeholderRepairInFlight;
		} finally {
			this.placeholderRepairInFlight = undefined;
		}
	}

	/**
	 * Resolve and apply the configured default model. Only called while the
	 * session model is the no-model placeholder (#2782).
	 */
	private async applyConfiguredDefaultModel(): Promise<boolean> {
		const provider = this.host.settingsManager.getDefaultProvider();
		const modelId = this.host.settingsManager.getDefaultModel();
		if (!provider || !modelId) return false;

		const match = this.host.modelRegistry.getAvailable().find(
			(m: Model<any>) => m.provider === provider && m.id === modelId,
		);
		// Pre-check so an unauthenticated default degrades to no-repair
		// instead of throwing past the gate — the original auth error
		// must surface unchanged when repair is impossible.
		if (!match || !this.host.modelRegistry.hasConfiguredAuth(match)) return false;

		// "restore": an automatic re-application of the configured default,
		// not a user choice — consumers distinguish it from manual selection.
		await this.setModel(match, { persist: false, source: "restore" });
		return true;
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.host._scopedModels.length > 0) {
			return this.cycleScopedModel(direction);
		}
		return this.cycleAvailableModel(direction);
	}

	async cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this.host._scopedModels.filter((scoped) => this.host.modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.host.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this.getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.host.agent.state.model = next.model;
		this.host.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.host.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.host.setThinkingLevel(thinkingLevel);

		await this.emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.host.thinkingLevel, isScoped: true };
	}

	async cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this.host.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.host.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this.getThinkingLevelForModelSwitch();
		this.host.agent.state.model = nextModel;
		this.host.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.host.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.host.setThinkingLevel(thinkingLevel);

		await this.emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.host.thinkingLevel, isScoped: false };
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.host.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.host.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.host.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.host.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this.host.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this.host._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.host.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.host.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.host.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.host.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.host.model?.reasoning;
	}

	getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.host.thinkingLevel;
	}

	clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.host.model ? (clampThinkingLevel(this.host.model, level) as ThinkingLevel) : "off";
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this.host._scopedModels = scopedModels;
	}

}
