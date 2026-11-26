/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import type { Content, FinishReason, FunctionCallingConfigMode, Part } from "@google/genai";
import type { Context, ImageContent, Model, StopReason, TextContent, Tool } from "../types.js";
import { sanitizeToolSchema } from "../utils/sanitize-tool-schema.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessagesWithReport } from "./transform-messages.js";

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
// Google-documented sentinel for unsigned Gemini 3 function calls.
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return false;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessagesWithReport(
		context.messages,
		model,
		normalizeToolCallId,
		"google-generative-ai",
	);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const supportedContent = model.input.includes("image")
					? msg.content
					: msg.content.filter((item) => item.type === "text");
				const parts: Part[] = supportedContent.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					// Gemini 3 requires a signature on function calls when thinking is enabled.
					const effectiveSignature =
						thoughtSignature ??
						(getGeminiMajorVersion(model.id) === 3 ? SKIP_THOUGHT_SIGNATURE_VALIDATOR : undefined);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(effectiveSignature && { thoughtSignature: effectiveSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
	"unevaluatedProperties",
]);

const CLAUDE_UNSUPPORTED_SCHEMA_KEYS = new Set([
	...JSON_SCHEMA_META_DECLARATIONS,
	"$ref",
	"nullable",
	"examples",
	"example",
	"readOnly",
	"writeOnly",
]);

function inferJsonSchemaType(value: unknown): string {
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	if (typeof value === "boolean") {
		return "boolean";
	}
	return "string";
}

function isConstOnlySchema(schema: unknown): schema is { const: unknown } {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return false;
	}
	const obj = schema as Record<string, unknown>;
	return "const" in obj;
}

function collapseConstUnion(
	obj: Record<string, unknown>,
	unionKey: "oneOf" | "anyOf",
): Record<string, unknown> {
	const variants = obj[unionKey] as unknown[];
	const enumValues = variants.map((variant) => (variant as { const: unknown }).const);
	const enumTypes = new Set(enumValues.map(inferJsonSchemaType));
	const { [unionKey]: _removed, ...rest } = obj;
	return {
		...rest,
		type: enumTypes.size === 1 ? [...enumTypes][0] : "string",
		enum: enumValues,
	};
}

function mergePropertySchemas(a: unknown, b: unknown): unknown {
	if (!a) return b;
	if (!b) return a;
	if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
		return b;
	}

	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const leftConst = left.const;
	const rightConst = right.const;
	if (leftConst !== undefined && rightConst !== undefined) {
		const enumValues = Array.from(new Set([leftConst, rightConst]));
		const { const: _leftConst, ...leftWithoutConst } = left;
		const { const: _rightConst, ...rightWithoutConst } = right;
		return {
			...leftWithoutConst,
			...rightWithoutConst,
			enum: enumValues,
			type: enumValues.every((value) => typeof value === "string") ? "string" : right.type ?? left.type,
		};
	}

	if (Array.isArray(left.enum) || Array.isArray(right.enum)) {
		const enumValues = Array.from(
			new Set([...(Array.isArray(left.enum) ? left.enum : []), ...(Array.isArray(right.enum) ? right.enum : [])]),
		);
		return {
			...left,
			...right,
			enum: enumValues,
		};
	}

	return { ...left, ...right };
}

/**
 * Cloud Code Assist translates Claude-model function declarations into
 * Anthropic custom tool schemas. Keep that route on a conservative object-root
 * schema, matching the Anthropic provider's conversion for top-level unions.
 */
export function normalizeClaudeToolSchemaForGoogle(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return {
			type: "object",
			properties: {},
			required: [],
		};
	}

	const jsonSchema = schema as Record<string, unknown>;
	const variants = Array.isArray(jsonSchema.anyOf)
		? jsonSchema.anyOf
		: Array.isArray(jsonSchema.oneOf)
			? jsonSchema.oneOf
			: [];
	const objectVariants = variants.filter(
		(candidate): candidate is Record<string, unknown> =>
			!!candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate) &&
			candidate.type === "object" &&
			typeof candidate.properties === "object" &&
			candidate.properties !== null &&
			!Array.isArray(candidate.properties),
	);

	if (objectVariants.length === 0) {
		const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...withoutUnions } = jsonSchema;
		return {
			...withoutUnions,
			type: "object",
			properties:
				typeof jsonSchema.properties === "object" &&
				jsonSchema.properties !== null &&
				!Array.isArray(jsonSchema.properties)
					? jsonSchema.properties
					: {},
			required: Array.isArray(jsonSchema.required)
				? jsonSchema.required.filter((key): key is string => typeof key === "string")
				: [],
		};
	}

	const properties = objectVariants.reduce(
		(acc: Record<string, unknown>, candidate) => ({
			...acc,
			...Object.fromEntries(
				Object.entries(candidate.properties as Record<string, unknown>).map(([key, value]) => [
					key,
					mergePropertySchemas(acc[key], value),
				]),
			),
		}),
		{},
	);
	const required = Array.from(
		new Set(
			objectVariants.flatMap((candidate) =>
				Array.isArray(candidate.required)
					? candidate.required.filter((key): key is string => typeof key === "string")
					: [],
			),
		),
	);

	const normalized: Record<string, unknown> = {
		type: "object",
		properties,
	};
	if (required.length > 0) {
		normalized.required = required;
	}
	return normalized;
}

function convertPatternPropertiesToAdditionalProperties(
	obj: Record<string, unknown>,
	sanitize: (schema: unknown) => unknown,
): Record<string, unknown> {
	if (!("patternProperties" in obj)) {
		return obj;
	}

	const { patternProperties, ...rest } = obj;
	if ("additionalProperties" in rest) {
		return rest;
	}

	const valueSchemas = Object.values(patternProperties as Record<string, unknown>).map((value) => sanitize(value));
	if (valueSchemas.length === 1) {
		return { ...rest, additionalProperties: valueSchemas[0] };
	}
	if (valueSchemas.length > 1) {
		return { ...rest, additionalProperties: true };
	}
	return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function simplifyNonConstUnion(
	obj: Record<string, unknown>,
	unionKey: "oneOf" | "anyOf" | "allOf",
	sanitize: (schema: unknown) => unknown,
): Record<string, unknown> {
	const variants = (obj[unionKey] as unknown[]).map((variant) => sanitize(variant));
	const { [unionKey]: _removed, description, ...rest } = obj;
	const desc = typeof description === "string" ? description : undefined;

	const objectVariants = variants.filter(
		(variant): variant is Record<string, unknown> => isRecord(variant) && variant.type === "object",
	);
	if (objectVariants.length > 0 && objectVariants.length === variants.length) {
		const merged = sanitize(
			normalizeClaudeToolSchemaForGoogle({
				type: "object",
				properties: objectVariants.reduce(
					(acc: Record<string, unknown>, candidate) => ({
						...acc,
						...Object.fromEntries(
							Object.entries((candidate.properties as Record<string, unknown>) ?? {}).map(([key, value]) => [
								key,
								mergePropertySchemas(acc[key], value),
							]),
						),
					}),
					{},
				),
			}),
		);
		return {
			...(isRecord(merged) ? merged : { type: "object" }),
			...rest,
			...(desc ? { description: desc } : {}),
		};
	}

	const arrayVariant = variants.find((variant) => isRecord(variant) && variant.type === "array");
	const stringVariant = variants.find((variant) => isRecord(variant) && variant.type === "string");
	if (arrayVariant && stringVariant && variants.length === 2) {
		return {
			...arrayVariant,
			...rest,
			...(desc ? { description: desc } : {}),
		};
	}

	if (objectVariants[0] && stringVariant && variants.length === 2) {
		return {
			...objectVariants[0],
			...rest,
			...(desc
				? { description: `${desc}. A plain string fallback is also accepted.` }
				: { description: "Structured object preferred; a plain string fallback is also accepted." }),
		};
	}

	const firstVariant = variants.find(isRecord);
	if (firstVariant) {
		return {
			...firstVariant,
			...rest,
			...(desc ? { description: desc } : {}),
		};
	}

	return {
		type: "string",
		...rest,
		...(desc ? { description: desc } : {}),
	};
}

function normalizeAdditionalProperties(value: unknown): unknown {
	if (value === false) {
		return undefined;
	}
	if (isRecord(value) && Object.keys(value).length === 0) {
		return true;
	}
	return value;
}

/**
 * Deep sanitizer for Claude custom tool schemas on Cloud Code Assist.
 * Anthropic accepts a strict JSON Schema draft 2020-12 subset: no nested
 * anyOf/oneOf/allOf, $ref, or patternProperties.
 */
function sanitizeForClaudeInputSchemaDeep(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(sanitizeForClaudeInputSchemaDeep);
	}
	if (!isRecord(schema)) {
		return schema;
	}

	let obj = convertPatternPropertiesToAdditionalProperties(schema, sanitizeForClaudeInputSchemaDeep);

	const unionKey =
		"oneOf" in obj && Array.isArray(obj.oneOf)
			? ("oneOf" as const)
			: "anyOf" in obj && Array.isArray(obj.anyOf)
				? ("anyOf" as const)
				: "allOf" in obj && Array.isArray(obj.allOf)
					? ("allOf" as const)
					: null;
	if (unionKey) {
		const variants = obj[unionKey] as unknown[];
		if (variants.length > 0 && variants.every(isConstOnlySchema)) {
			const collapsedUnionKey = unionKey === "allOf" ? "anyOf" : unionKey;
			const { [unionKey]: unionVariants, type: _type, ...restWithoutUnion } = obj;
			return sanitizeForClaudeInputSchemaDeep(
				collapseConstUnion({ ...restWithoutUnion, [collapsedUnionKey]: unionVariants }, collapsedUnionKey),
			);
		}
		const { type: _type, ...withoutType } = obj;
		return sanitizeForClaudeInputSchemaDeep(simplifyNonConstUnion(withoutType, unionKey, sanitizeForClaudeInputSchemaDeep));
	}

	if ("const" in obj) {
		const { const: constValue, ...rest } = obj;
		const next: Record<string, unknown> = { ...rest };
		if (!("enum" in next)) {
			next.enum = [constValue];
		}
		if (!("type" in next)) {
			next.type = inferJsonSchemaType(constValue);
		}
		return sanitizeForClaudeInputSchemaDeep(next);
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (CLAUDE_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
		if (key === "additionalProperties") {
			const normalized = normalizeAdditionalProperties(value);
			if (normalized === undefined) continue;
			result[key] = sanitizeForClaudeInputSchemaDeep(normalized);
			continue;
		}
		if (key === "required" && Array.isArray(value) && value.length === 0) continue;
		result[key] = sanitizeForClaudeInputSchemaDeep(value);
	}
	return result;
}

/**
 * Build a Claude-compatible tool input schema root from a TypeBox/JSON Schema
 * tool definition. Matches the direct Anthropic provider's conservative shape.
 */
export function toClaudeInputSchemaRoot(schema: unknown): Record<string, unknown> {
	const sanitized = sanitizeForClaudeInputSchemaDeep(normalizeClaudeToolSchemaForGoogle(schema)) as Record<
		string,
		unknown
	>;
	const root: Record<string, unknown> = {
		type: "object",
		properties: (sanitized.properties as Record<string, unknown>) ?? {},
	};
	if (Array.isArray(sanitized.required) && sanitized.required.length > 0) {
		root.required = sanitized.required.filter((key): key is string => typeof key === "string");
	}
	return root;
}

/**
 * Strip meta-declarations and rewrite JSON Schema features unsupported by the
 * Cloud Code Assist legacy OpenAPI `parameters` field (OpenAPI 3.03).
 *
 * TypeBox `Type.Literal` unions compile to `anyOf`/`oneOf` entries with `const`,
 * which the API rejects ("Unknown name \"const\""). Collapse those to `enum`.
 * TypeBox `Type.Record` compiles to `patternProperties`, which the API also rejects.
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(sanitizeForOpenApi);
	}
	if (typeof schema !== "object" || schema === null) {
		return schema;
	}

	let obj = schema as Record<string, unknown>;
	obj = convertPatternPropertiesToAdditionalProperties(obj, sanitizeForOpenApi);

	const unionKey =
		"oneOf" in obj && Array.isArray(obj.oneOf)
			? ("oneOf" as const)
			: "anyOf" in obj && Array.isArray(obj.anyOf)
				? ("anyOf" as const)
				: null;
	if (unionKey) {
		const variants = obj[unionKey] as unknown[];
		if (variants.length > 0 && variants.every(isConstOnlySchema)) {
			return sanitizeForOpenApi(collapseConstUnion(obj, unionKey));
		}
	}

	if ("const" in obj) {
		const { const: constValue, ...rest } = obj;
		const next: Record<string, unknown> = { ...rest };
		if (!("enum" in next)) {
			next.enum = [constValue];
		}
		if (!("type" in next)) {
			next.type = inferJsonSchemaType(constValue);
		}
		return sanitizeForOpenApi(next);
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		if (key === "additionalProperties" && value === false) continue;
		if (key === "required" && Array.isArray(value) && value.length === 0) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/** Legacy export name used by google-shared.test.ts and provider-capabilities docs. */
export function sanitizeSchemaForGoogle(schema: unknown): unknown {
	return sanitizeForOpenApi(schema);
}

/**
 * Moonshot/Kimi `tools.function.parameters` rejects anyOf/oneOf/allOf and
 * requires `type` on parent schemas. Reuses the Claude deep sanitizer.
 */
export function sanitizeSchemaForMoonshot(schema: unknown): Record<string, unknown> {
	return toClaudeInputSchemaRoot(schema);
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 *
 * Schemas are sanitized to remove fields not supported by Cloud Code Assist
 * (patternProperties, const converted to enum, etc.).
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				if (useParameters) {
					// Legacy OpenAPI `parameters` field (OpenAPI 3.03 Schema).
					// Used for Cloud Code Assist with Claude models where the API
					// translates `parameters` into Anthropic's `input_schema`.
					return {
						name: tool.name,
						description: tool.description,
						parameters: sanitizeToolSchema(
							toClaudeInputSchemaRoot(tool.parameters as unknown),
						),
					};
				}
				// Full JSON Schema via `parametersJsonSchema` — supports anyOf,
				// oneOf, const, etc. Sanitize to remove fields unsupported by
				// Cloud Code Assist (patternProperties, const→enum, etc.), then
				// strip verbose metadata for payload size reduction.
				return {
					name: tool.name,
					description: tool.description,
					parametersJsonSchema: sanitizeToolSchema(
						sanitizeForOpenApi(tool.parameters as unknown),
					),
				};
			}),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "none":
			return "NONE" as FunctionCallingConfigMode;
		case "any":
			return "ANY" as FunctionCallingConfigMode;
		default:
			return "AUTO" as FunctionCallingConfigMode;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason | string | undefined): StopReason {
	if (reason === "STOP") return "stop";
	if (reason === "MAX_TOKENS") return "length";
	return "error";
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
