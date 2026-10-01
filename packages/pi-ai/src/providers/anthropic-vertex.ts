import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { getEnvApiKey } from "../env-api-keys.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
	type AnthropicEffort,
	type AnthropicOptions,
	streamAnthropic,
} from "./anthropic.js";
import { usesClaudeAdaptiveThinking } from "./claude-thinking-off.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";

export type AnthropicVertexOptions = Omit<AnthropicOptions, "client">;

let anthropicVertexClass: typeof AnthropicVertex | undefined;

async function getAnthropicVertexClass(): Promise<typeof AnthropicVertex> {
	if (!anthropicVertexClass) {
		const mod = await import("@anthropic-ai/vertex-sdk");
		anthropicVertexClass = mod.AnthropicVertex;
	}
	return anthropicVertexClass;
}

function resolveProjectId(): string {
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
		process.env.GOOGLE_CLOUD_PROJECT ||
		process.env.GCLOUD_PROJECT;
	if (!projectId) {
		throw new Error(
			"Anthropic Vertex requires a project ID. Set ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT.",
		);
	}
	return projectId;
}

function resolveRegion(): string {
	return process.env.CLOUD_ML_REGION || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
}

async function createVertexClient(): Promise<AnthropicVertex> {
	const AnthropicVertexClass = await getAnthropicVertexClass();
	return new AnthropicVertexClass({
		projectId: resolveProjectId(),
		region: resolveRegion(),
	});
}

function createErrorMessage(model: Model<"anthropic-vertex">, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function asAnthropicMessagesModel(model: Model<"anthropic-vertex">): Model<"anthropic-messages"> {
	return model as unknown as Model<"anthropic-messages">;
}

function mapThinkingLevelToEffort(
	model: Model<"anthropic-vertex">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamAnthropicVertex: StreamFunction<"anthropic-vertex", AnthropicVertexOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: AnthropicVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			const client = await createVertexClient();
			const inner = streamAnthropic(asAnthropicMessagesModel(model), context, {
				...options,
				client: client as unknown as Anthropic,
			});

			for await (const event of inner) {
				stream.push(event);
			}
		} catch (error) {
			const message = createErrorMessage(model, error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		}
	})();

	return stream;
};

export const streamSimpleAnthropicVertex: StreamFunction<"anthropic-vertex", SimpleStreamOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || getEnvApiKey("anthropic-vertex");
	if (!apiKey) {
		throw new Error(
			`No API key for provider: ${model.provider}. Set ANTHROPIC_VERTEX_PROJECT_ID or configure Google Application Default Credentials to use Claude on Vertex AI.`,
		);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropicVertex(
			model,
			context,
			{ ...base, thinkingEnabled: false } satisfies AnthropicVertexOptions,
		);
	}

	if (usesClaudeAdaptiveThinking(model.id, model.compat?.forceAdaptiveThinking)) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropicVertex(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicVertexOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropicVertex(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicVertexOptions);
};
