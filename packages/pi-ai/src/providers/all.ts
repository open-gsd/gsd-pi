import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../models.generated.js";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.js";
import type { AnyModel, Api, ClassifierApi, ClassifierModel, ImageApi, ImageModel, Model } from "../types.js";
import { amazonBedrockProvider } from "./amazon-bedrock.js";
import { antLingProvider } from "./ant-ling.js";
import { anthropicProvider } from "./anthropic.js";
import { azureProvider } from "./azure.js";
import { basetenProvider } from "./baseten.js";
import { cerebrasProvider } from "./cerebras.js";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.js";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.js";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { deepseekProvider } from "./deepseek.js";
import { fireworksProvider } from "./fireworks.js";
import { githubCopilotProvider } from "./github-copilot.js";
import { googleProvider } from "./google.js";
import { googleVertexProvider } from "./google-vertex.js";
import { groqProvider } from "./groq.js";
import { huggingfaceProvider } from "./huggingface.js";
import { kimiCodingProvider } from "./kimi-coding.js";
import { metaProvider } from "./meta.js";
import { minimaxProvider } from "./minimax.js";
import { minimaxCnProvider } from "./minimax-cn.js";
import { mistralProvider } from "./mistral.js";
import { moonshotaiProvider } from "./moonshotai.js";
import { moonshotaiCnProvider } from "./moonshotai-cn.js";
import { nvidiaProvider } from "./nvidia.js";
import { openaiProvider } from "./openai.js";
import { openaiCodexProvider } from "./openai-codex.js";
import { opencodeProvider } from "./opencode.js";
import { opencodeGoProvider } from "./opencode-go.js";
import { openrouterProvider } from "./openrouter.js";
import { qwenTokenPlanProvider } from "./qwen-token-plan.js";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.js";
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.js";
import { qwenTokenPlanIndividualCnProvider } from "./qwen-token-plan-individual-cn.js";
import { radiusProvider } from "./radius.js";
import { togetherProvider } from "./together.js";
import { typesafeProvider } from "./typesafe.js";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.js";
import { xaiProvider } from "./xai.js";
import { xiaomiProvider } from "./xiaomi.js";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.js";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.js";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.js";
import { zaiProvider } from "./zai.js";
import { zaiCodingCnProvider } from "./zai-coding-cn.js";

export { radiusProvider };

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinChatModelId<TProvider extends BuiltinProvider> = keyof (typeof MODELS)[TProvider];
type BuiltinImageModelId<TProvider extends BuiltinProvider> = keyof (typeof IMAGE_MODELS)[TProvider];
type BuiltinClassifierModelId<TProvider extends BuiltinProvider> = keyof (typeof CLASSIFIER_MODELS)[TProvider];
/** API ids of catalog entries. Built-in getters return `Model<Api>` shapes, not literal entry types. */
type CatalogApi<TEntry> = TEntry extends { api: infer TApi extends string } ? TApi : never;

/** Typed read of one generated built-in chat model. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends BuiltinChatModelId<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): Model<CatalogApi<(typeof MODELS)[TProvider][TModelId]>> {
	return (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider]?.[modelId as string] as Model<
		CatalogApi<(typeof MODELS)[TProvider][TModelId]>
	>;
}

/** Typed read of one generated built-in image model. */
export function getBuiltinImageModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinImageModelId<TProvider>,
>(provider: TProvider, modelId: TModelId): ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][TModelId]>> {
	return (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider]?.[
		modelId as string
	] as ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][TModelId]>>;
}

/** Typed read of one generated built-in classifier model. */
export function getBuiltinClassifierModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinClassifierModelId<TProvider>,
>(
	provider: TProvider,
	modelId: TModelId,
): ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][TModelId]>> {
	return (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[provider]?.[
		modelId as string
	] as ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][TModelId]>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[] {
	const models = (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider];
	return Object.values(models ?? {}) as Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[];
}

export function getBuiltinImageModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ImageModel<CatalogApi<(typeof IMAGE_MODELS)[TProvider][BuiltinImageModelId<TProvider>]>>[] {
	const models = (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider];
	return Object.values(models ?? {}) as ImageModel<
		CatalogApi<(typeof IMAGE_MODELS)[TProvider][BuiltinImageModelId<TProvider>]>
	>[];
}

export function getBuiltinClassifierModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ClassifierModel<CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][BuiltinClassifierModelId<TProvider>]>>[] {
	const models = (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[
		provider
	];
	return Object.values(models ?? {}) as ClassifierModel<
		CatalogApi<(typeof CLASSIFIER_MODELS)[TProvider][BuiltinClassifierModelId<TProvider>]>
	>[];
}

export function getAllBuiltinModels<TProvider extends BuiltinProvider>(provider: TProvider): AnyModel[] {
	return [...getBuiltinModels(provider), ...getBuiltinImageModels(provider), ...getBuiltinClassifierModels(provider)];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureProvider(),
		basetenProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		metaProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		qwenTokenPlanIndividualProvider(),
		qwenTokenPlanIndividualCnProvider(),
		radiusProvider(),
		togetherProvider(),
		typesafeProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}
