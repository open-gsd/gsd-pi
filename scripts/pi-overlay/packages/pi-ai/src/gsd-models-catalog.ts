import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Api, Model } from "./types.js";

const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number({ minimum: 0 })),
	p75: Type.Optional(Type.Number({ minimum: 0 })),
	p90: Type.Optional(Type.Number({ minimum: 0 })),
	p99: Type.Optional(Type.Number({ minimum: 0 })),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(
		Type.Union([Type.Number({ minimum: 0 }), PercentileCutoffsSchema]),
	),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), PercentileCutoffsSchema])),
});

const CompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(
		Type.Object({
			only: Type.Optional(Type.Array(Type.String())),
			order: Type.Optional(Type.Array(Type.String())),
		}),
	),
	zaiToolStream: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	sendSessionIdHeader: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	rejectsDisabledThinking: Type.Optional(Type.Boolean()),
});

const ThinkingLevelMapSchema = Type.Object(
	{
		off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		max: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);

const CostTierSchema = Type.Object({
	inputTokensAbove: Type.Number({ minimum: 0 }),
	input: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Number()),
	cacheRead: Type.Optional(Type.Number()),
	cacheWrite: Type.Optional(Type.Number()),
});

const ModelCatalogEntrySchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	baseUrl: Type.String(),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("video")]), { minItems: 1 }),
	cost: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		tiers: Type.Optional(Type.Array(CostTierSchema)),
	}),
	contextWindow: Type.Number({ minimum: 1 }),
	maxTokens: Type.Number({ minimum: 1 }),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(CompatSchema),
	providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const ModelsCatalogSchema = Type.Record(
	Type.String({ minLength: 1 }),
	Type.Record(Type.String({ minLength: 1 }), ModelCatalogEntrySchema),
);
const validateModelsCatalog = Compile(ModelsCatalogSchema);

export type ModelsCatalog = Record<string, Record<string, Model<Api>>>;

export interface ModelsCatalogOverlay {
	version: 1;
	fetchedAt?: string;
	source?: string;
	models: ModelsCatalog;
}

export function isModelsCatalog(value: unknown): value is ModelsCatalog {
	if (!validateModelsCatalog.Check(value)) return false;

	const providers = Object.entries(value as ModelsCatalog);
	if (providers.length === 0) return false;

	return providers.every(([providerId, models]) => {
		const entries = Object.entries(models);
		return (
			entries.length > 0
			&& entries.every(([modelId, model]) => model.id === modelId && model.provider === providerId)
		);
	});
}

export function isModelsCatalogOverlay(value: unknown): value is ModelsCatalogOverlay {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

	const overlay = value as Partial<ModelsCatalogOverlay>;
	return (
		overlay.version === 1
		&& (overlay.fetchedAt === undefined || typeof overlay.fetchedAt === "string")
		&& (overlay.source === undefined || typeof overlay.source === "string")
		&& isModelsCatalog(overlay.models)
	);
}
