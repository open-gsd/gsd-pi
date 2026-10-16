import type { ThinkingLevel } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual, streamSimple } from "@gsd/pi-ai";
import { formatNoApiKeyFoundMessage } from "@gsd/pi-coding-agent/core/auth-guidance.js";
import { DEFAULT_THINKING_LEVEL } from "@gsd/pi-coding-agent/core/defaults.js";
import { findInitialModel } from "@gsd/pi-coding-agent/core/model-resolver.js";
import type { ModelCycleResult } from "./agent-session-types.js";
import { THINKING_LEVELS } from "./agent-session-types.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export class AgentSessionModelModule {
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

	async setModel(model: Model<any>, options?: { persist?: boolean }): Promise<void> {
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

		await this.emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Re-resolve the session model when it is still the `unknown/unknown`
	 * placeholder (#2782). Extensions that register providers on
	 * `session_start` (e.g. the bundled ollama extension) only become visible
	 * to the registry after `bindExtensions()`, while the initial model was
	 * already picked in `createAgentSession()` before that. The repair runs
	 * after `session_start` and again lazily before the first prompt. It is
	 * non-destructive: it completes the startup resolution without touching
	 * persisted model/thinking defaults or session history, never overwrites
	 * an already-resolved model (including a mid-repair user choice), and an
	 * unreachable registry is a no-op.
	 */
	async repairPlaceholderModel(): Promise<void> {
		const current = this.host.model;
		if (current && !(current.provider === "unknown" && current.api === "unknown")) {
			return;
		}

		// Prefer the model recorded in the session being resumed: startup
		// could not restore it before registration, but it should win over
		// the settings default once its provider registers.
		let resolved: Model<any> | undefined;
		try {
			const recorded = this.host.sessionManager.buildSessionContext().model;
			if (recorded) {
				const restored = this.host.modelRegistry.find(recorded.provider, recorded.modelId);
				if (restored && this.host.modelRegistry.hasConfiguredAuth(restored)) {
					resolved = restored;
				}
			}
		} catch {
			// No restorable session context — fall through to settings default.
		}

		if (!resolved) {
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: this.host.settingsManager.getDefaultProvider(),
				defaultModelId: this.host.settingsManager.getDefaultModel(),
				defaultThinkingLevel: this.host.settingsManager.getDefaultThinkingLevel(),
				modelRegistry: this.host.modelRegistry,
			});
			resolved = result.model;
		}

		// The registry lookup above can await — re-check so a model selected
		// in the meantime (user choice or a concurrent repair) is kept.
		const latest = this.host.model;
		if (latest && !(latest.provider === "unknown" && latest.api === "unknown")) {
			return;
		}
		if (!resolved) {
			return;
		}

		// Apply the way createAgentSession applies a startup model: a direct
		// state assignment plus the model_select notification. No settings or
		// session-history writes; the session thinking level is clamped to the
		// repaired model's capabilities in memory only ("off" is not valid for
		// every model — thinkingLevelMap.off === null excludes it).
		const previousModel = current;
		this.host.agent.state.model = resolved;
		this.host.agent.state.thinkingLevel = clampThinkingLevel(resolved, this.host.thinkingLevel) as ThinkingLevel;
		await this.emitModelSelect(resolved, previousModel, "set");
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
