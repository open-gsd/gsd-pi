/** Claude tool-schema sanitizer kept from the v0.75.5 Google shared module. */
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


export function sanitizeToolSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(sanitizeToolSchema);
	const cleaned: Record<string, unknown> = { ...schema };
	delete cleaned.description;
	delete cleaned.examples;
	delete cleaned.default;
	if (cleaned.properties && typeof cleaned.properties === "object") {
		cleaned.properties = Object.fromEntries(
			Object.entries(cleaned.properties as Record<string, unknown>).map(([key, value]) => [key, sanitizeToolSchema(value)]),
		);
	}
	if (cleaned.items && typeof cleaned.items === "object") cleaned.items = sanitizeToolSchema(cleaned.items);
	if (Array.isArray(cleaned.allOf)) cleaned.allOf = cleaned.allOf.map(sanitizeToolSchema);
	if (Array.isArray(cleaned.anyOf)) cleaned.anyOf = cleaned.anyOf.map(sanitizeToolSchema);
	if (Array.isArray(cleaned.oneOf)) cleaned.oneOf = cleaned.oneOf.map(sanitizeToolSchema);
	return cleaned;
}
