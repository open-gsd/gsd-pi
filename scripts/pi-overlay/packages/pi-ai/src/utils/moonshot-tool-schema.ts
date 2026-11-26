import { toClaudeInputSchemaRoot } from "../api/claude-tool-schema.js";
import type { Model } from "../types.js";

const FORBIDDEN_UNION_KEY_RE = /\b(anyOf|oneOf|allOf)\b/;

/** True when an openai-completions model sends tools to Moonshot's API surface. */
export function requiresMoonshotToolSchemaSanitization(
	model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id">,
): boolean {
	const { provider, baseUrl, id } = model;
	if (provider === "moonshotai" || provider === "moonshotai-cn") return true;
	if (baseUrl.includes("api.moonshot.")) return true;
	if (provider === "openrouter" && id.startsWith("moonshotai/")) return true;
	return false;
}

/** True for Anthropic-compatible providers that enforce Moonshot-flavored input_schema. */
export function requiresMoonshotToolSchemaSanitizationAnthropic(
	model: Pick<Model<"anthropic-messages">, "provider">,
): boolean {
	return model.provider === "kimi-coding";
}

/** Test helper — returns paths of forbidden union keywords in a schema tree. */
export function collectForbiddenUnionSchemaPaths(value: unknown, path = "$"): string[] {
	if (value === null || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => collectForbiddenUnionSchemaPaths(item, `${path}[${index}]`));
	}

	const violations: string[] = [];
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_UNION_KEY_RE.test(key)) {
			violations.push(`${path}.${key}`);
		}
		violations.push(...collectForbiddenUnionSchemaPaths(nested, `${path}.${key}`));
	}
	return violations;
}

/**
 * Moonshot/Kimi tool schemas require Claude-style object roots (`type` on parents).
 * Reuses the Claude deep sanitizer from the pin.
 */
export function sanitizeSchemaForMoonshot(schema: unknown): Record<string, unknown> {
	return toClaudeInputSchemaRoot(schema);
}
