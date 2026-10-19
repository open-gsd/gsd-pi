import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { getModel } from "../src/models.js";
import {
	collectForbiddenUnionSchemaPaths,
	requiresMoonshotToolSchemaSanitization,
	requiresMoonshotToolSchemaSanitizationAnthropic,
	sanitizeSchemaForMoonshot,
} from "../src/utils/moonshot-tool-schema.js";

describe("moonshot tool schema sanitizer", () => {
	it("detects Moonshot and Kimi providers", () => {
		// models.dev 2026-09 refresh: moonshotai dropped kimi-k2.5; kimi-k2.6 is the surviving direct-provider entry.
		expect(requiresMoonshotToolSchemaSanitization(getModel("moonshotai", "kimi-k2.6")!)).toBe(true);
		expect(requiresMoonshotToolSchemaSanitization(getModel("openrouter", "moonshotai/kimi-k2.5")!)).toBe(true);
		expect(requiresMoonshotToolSchemaSanitization(getModel("openai", "gpt-4.1")!)).toBe(false);
		expect(requiresMoonshotToolSchemaSanitizationAnthropic(getModel("kimi-coding", "kimi-for-coding")!)).toBe(
			true,
		);
		expect(requiresMoonshotToolSchemaSanitizationAnthropic(getModel("anthropic", "claude-sonnet-4-5")!)).toBe(
			false,
		);
	});

	it("flattens root anyOf object unions to a single object schema", () => {
		const schema = {
			anyOf: [
				{
					type: "object",
					properties: { kind: { const: "milestone" }, content: { type: "string" } },
					required: ["kind", "content"],
				},
				{
					type: "object",
					properties: { kind: { const: "project" }, content: { type: "string" } },
					required: ["kind", "content"],
				},
			],
		};

		const sanitized = sanitizeSchemaForMoonshot(schema);
		expect(sanitized).toEqual({
			type: "object",
			properties: {
				kind: { type: "string", enum: ["milestone", "project"] },
				content: { type: "string" },
			},
			required: ["kind", "content"],
		});
		expect(collectForbiddenUnionSchemaPaths(sanitized)).toEqual([]);
	});

	it("collapses nested TypeBox literal unions to enum", () => {
		const schema = Type.Object({
			runtime: Type.Union([Type.Literal("bash"), Type.Literal("node"), Type.Literal("python")]),
		});

		const sanitized = sanitizeSchemaForMoonshot(schema);
		expect(sanitized.type).toBe("object");
		expect((sanitized.properties as Record<string, unknown>).runtime).toEqual({
			type: "string",
			enum: ["bash", "node", "python"],
		});
		expect(collectForbiddenUnionSchemaPaths(sanitized)).toEqual([]);
	});

	it("removes parent type alongside anyOf by flattening heterogeneous unions", () => {
		const schema = {
			type: "object",
			properties: {
				keyFiles: {
					type: "string",
					anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
					description: "Key files",
				},
			},
		};

		const sanitized = sanitizeSchemaForMoonshot(schema);
		expect(collectForbiddenUnionSchemaPaths(sanitized)).toEqual([]);
		expect((sanitized.properties as Record<string, unknown>).keyFiles).toEqual({
			type: "array",
			items: { type: "string" },
			description: "Key files",
		});
	});
});
