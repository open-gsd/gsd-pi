import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthOperationOptions,
	AuthResult,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderHeaders,
} from "@gsd/pi-ai";
import { registerApiProvider } from "@gsd/pi-ai/compat";
import { gsdFakeInstall } from "@gsd/pi-ai/providers/gsd-fake";
import type { AuthStorage } from "./auth-storage.js";
import type { DiscoveryResult } from "./model-discovery.js";
import type { ModelRuntime } from "./model-runtime.js";
import { isLocalModel } from "./local-model-check.js";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.js";
import type { VirtualModelDefinition } from "./virtual-models.js";
import {
	getDisabledModelProviders,
	isProviderRequestReady as checkProviderRequestReady,
	type ProviderAuthMode,
	type ProviderReadinessConfig,
	setDisabledModelProviders as applyDisabledModelProviders,
	settleProviderReadiness as settleRegisteredProviderReadiness,
} from "./provider-readiness.js";

export type { ProviderAuthMode } from "./provider-readiness.js";

type GsdProviderConfigInput = ProviderConfigInput & Partial<ProviderReadinessConfig>;

export type { ProviderConfigInput } from "./provider-composer.js";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.js";

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;
	private readonly storedAuthStorage?: AuthStorage;
	private readonly storedModelsJsonPath?: string;
	private readonly registeredProviders = new Map<string, ProviderReadinessConfig>();
	private readonly providerRequestConfigs = new Map<string, { apiKey?: string }>();
	private disabledModelProviders = new Set<string>();

	constructor(runtime: ModelRuntime, authStorage?: AuthStorage, modelsJsonPath?: string) {
		this.runtime = runtime;
		this.storedAuthStorage = authStorage;
		this.storedModelsJsonPath = modelsJsonPath;
	}

	get authStorage(): AuthStorage {
		if (this.storedAuthStorage) return this.storedAuthStorage;
		throw new Error("ModelRegistry has no AuthStorage reference");
	}

	get modelsJsonPath(): string | undefined {
		return this.storedModelsJsonPath;
	}

	/** Underlying async runtime for model resolution helpers (e.g. findInitialModel). */
	getModelRuntime(): ModelRuntime {
		return this.runtime;
	}

	/** Host-compatible factory: AuthStorage + models.json path → ModelRuntime facade. */
	static async create(authStorage: import("./auth-storage.js").AuthStorage, modelsJsonPath?: string): Promise<ModelRegistry> {
		const { ModelRuntime } = await import("./model-runtime.js");
		const resolvedModelsPath =
			modelsJsonPath === undefined ? undefined : modelsJsonPath;
		const runtime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: resolvedModelsPath,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime, authStorage, resolvedModelsPath);
		await registry.ensureFakeProviderIfEnabled();
		return registry;
	}

	static async inMemory(authStorage: import("./auth-storage.js").AuthStorage): Promise<ModelRegistry> {
		const { ModelRuntime } = await import("./model-runtime.js");
		const runtime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime, authStorage, undefined);
		await registry.ensureFakeProviderIfEnabled();
		return registry;
	}

	/**
	 * E2E-only: when `GSD_FAKE_LLM_TRANSCRIPT` is set, register the deterministic
	 * JSONL-replay provider (ModelRuntime catalog + compat api-registry) so
	 * `gsd-fake-model` is request-ready and AgentSession streamSimple resolves api `"fake"`.
	 */
	private async ensureFakeProviderIfEnabled(): Promise<void> {
		const installed = gsdFakeInstall();
		if (!installed) return;
		// Shared streams: ModelRuntime catalog + compat api-registry must share one cursor.
		registerApiProvider(installed.streams, "gsd-fake");
		this.runtime.registerNativeProvider(installed.provider);
		this.registeredProviders.set("gsd-fake", { authMode: "none", isReady: () => true });
		await this.runtime.refresh({ allowNetwork: false });
	}

	setDisabledModelProviders(providers: string[]): void {
		applyDisabledModelProviders(this._readinessDeps(), providers);
		this.disabledModelProviders = this._readinessDeps().disabledModelProviders;
	}

	getDisabledModelProviders(): string[] {
		return getDisabledModelProviders(this._readinessDeps());
	}

	async discoverModels(_providers?: string[]): Promise<DiscoveryResult[]> {
		return [];
	}

	getAllWithDiscovered(): Model<Api>[] {
		return this.getAll();
	}

	isDiscovered(model: Model<Api>): boolean;
	isDiscovered(provider: string, modelId: string): boolean;
	isDiscovered(modelOrProvider: Model<Api> | string, modelId?: string): boolean {
		void modelOrProvider;
		void modelId;
		return false;
	}

	getProviderAuthMode(provider: string): ProviderAuthMode {
		if (provider === "gsd-fake") return "none";
		if (this.runtime.isUsingOAuth(provider)) return "oauth";
		if (this.runtime.hasConfiguredAuth(provider)) return "apiKey";
		return "none";
	}

	isAllLocalChain(): boolean {
		const models = this.getAll();
		if (models.length === 0) return false;
		return models.every((model) => isLocalModel(model));
	}

	static isLocalModel = isLocalModel;

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return this.getAll().filter((model) => this.isProviderRequestReady(model.provider));
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** Find a model of a non-chat type, e.g. `findOfType("classifier", "typesafe", "jev-latest")`. */
	findOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** Stream through the configured provider with request-time authentication. */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.runtime.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.runtime.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** Every known model of a type (chat, image, classifier), optionally for one provider. */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.runtime.getModelsOfType(type, provider);
	}

	/** Models of a type whose provider has working credentials. */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** Classify structured state with request-time authentication. Never rejects. */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.runtime.classify(model, context, options);
	}

	/** Generate images with request-time authentication. Never rejects. */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.runtime.generateImages(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	/** GSD compat alias for {@link getApiKeyForProvider}; accepts a provider id or model. */
	async getApiKey(providerOrModel: string | Model<Api>): Promise<string | undefined> {
		const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		return this.getApiKeyForProvider(provider);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: GsdProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: GsdProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.upsertRegisteredProvider(providerOrName, config);
			if (config.apiKey) {
				this.providerRequestConfigs.set(providerOrName, { apiKey: config.apiKey });
			}
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	isProviderRequestReady(provider: string): boolean {
		return checkProviderRequestReady(this._readinessDeps(), provider, (providerId) => {
			if (this.runtime.hasConfiguredAuth(providerId)) return true;
			return this.runtime.getProviderAuthStatus(providerId).configured;
		});
	}

	settleProviderReadiness(provider?: string): Promise<void> {
		return settleRegisteredProviderReadiness(this._readinessDeps(), provider);
	}

	unregisterProvider(providerName: string): void {
		this.registeredProviders.delete(providerName);
		this.providerRequestConfigs.delete(providerName);
		this.runtime.unregisterProvider(providerName);
	}

	private upsertRegisteredProvider(providerName: string, config: GsdProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, this.readinessConfigFromProvider(config));
			return;
		}
		const next = { ...existing, ...this.readinessConfigFromProvider(config) };
		this.registeredProviders.set(providerName, next);
	}

	private readinessConfigFromProvider(config: GsdProviderConfigInput): ProviderReadinessConfig {
		return {
			authMode: config.authMode,
			isReady: config.isReady,
			settleReadiness: config.settleReadiness,
			apiKey: config.apiKey,
			oauth: config.oauth,
		};
	}

	private _readinessDeps() {
		return {
			authStorage: this.authStorage,
			registeredProviders: this.registeredProviders,
			providerRequestConfigs: this.providerRequestConfigs,
			disabledModelProviders: this.disabledModelProviders,
		};
	}

	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.runtime.registerVirtualModel(definition);
	}

	unregisterVirtualModel(providerName: string, id: string): void {
		this.runtime.unregisterVirtualModel(providerName, id);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
