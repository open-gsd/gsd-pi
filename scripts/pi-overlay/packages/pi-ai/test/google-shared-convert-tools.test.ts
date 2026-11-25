import { describe, expect, it } from "vitest";
import { convertMessages, convertTools } from "../src/providers/google-shared.ts";
import type { Context, Model, Tool } from "../src/types.ts";

function makeTool(parameters: Record<string, unknown>): Tool {
	return {
		name: "test_tool",
		description: "A test tool",
		parameters: parameters as Tool["parameters"],
	};
}

function makeGoogleModel(overrides: Partial<Model<"google-generative-ai">>): Model<"google-generative-ai"> {
	return {
		id: "gemini-3-pro",
		name: "Test model",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1024,
		maxTokens: 1024,
		...overrides,
	};
}

describe("google-shared convertTools", () => {
	it("strips JSON Schema meta keys from parameters when useParameters=true", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				$id: "urn:bash-tool",
				$comment: "A bash tool for demonstration",
				$defs: {
					commandDef: { type: "string" },
				},
				definitions: {
					legacyDef: { type: "number" },
				},
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
		expect(decl?.parameters).not.toHaveProperty("$schema");
		expect(decl?.parameters).not.toHaveProperty("$id");
		expect(decl?.parameters).not.toHaveProperty("$comment");
		expect(decl?.parameters).not.toHaveProperty("$defs");
		expect(decl?.parameters).not.toHaveProperty("definitions");
	});

	it("recursively strips nested JSON Schema meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					deep: {
						$schema: "http://json-schema.org/draft-07/schema#",
						$id: "urn:nested",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				deep: {
					type: "string",
				},
			},
		});
	});

	it("strips unsupported $ref keys from Claude parameters", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					refProp: {
						$ref: "#/$defs/someDef",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				refProp: {
					type: "string",
				},
			},
		});
	});

	it("does not mutate the original Tool.parameters object", () => {
		const originalParameters = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		};
		const tools = [makeTool(originalParameters)];

		convertTools(tools, true);

		expect(originalParameters).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("strips $schema from parametersJsonSchema when useParameters=false", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, false);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
		expect(decl?.parametersJsonSchema).not.toHaveProperty("$schema");
	});

	it("handles tools without $schema gracefully", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		});
	});

	it("returns undefined for empty tool list", () => {
		expect(convertTools([])).toBeUndefined();
		expect(convertTools([], true)).toBeUndefined();
	});

	it("collapses anyOf const literals to enum for OpenAPI parameters", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					runtime: {
						anyOf: [
							{ const: "bash", type: "string" },
							{ const: "node", type: "string" },
							{ const: "python", type: "string" },
						],
						description: "Interpreter: bash (-c), node (-e), or python3 (-c).",
					},
				},
				required: ["runtime"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				runtime: {
					type: "string",
					enum: ["bash", "node", "python"],
				},
			},
			required: ["runtime"],
		});
		expect(JSON.stringify(decl?.parameters)).not.toContain('"const"');
	});

	it("collapses oneOf const literals to enum for OpenAPI parameters", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					mode: {
						oneOf: [{ const: "build" }, { const: "query" }],
						description: "build = recompute graph, query = inspect edges",
					},
				},
				required: ["mode"],
			}),
		];

		const result = convertTools(tools, true);
		const runtime = (result?.[0]?.functionDeclarations?.[0]?.parameters as Record<string, unknown>)
			?.properties as Record<string, unknown>;
		expect(runtime?.mode).toEqual({
			type: "string",
			enum: ["build", "query"],
		});
	});

	it("converts TypeBox Record patternProperties to additionalProperties", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					values: {
						type: "object",
						patternProperties: {
							"^(.*)$": { type: "string" },
						},
					},
				},
				required: ["values"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				values: {
					type: "object",
					additionalProperties: { type: "string" },
				},
			},
			required: ["values"],
		});
		expect(JSON.stringify(decl?.parameters)).not.toContain("patternProperties");
	});

	it("strips patternProperties from parametersJsonSchema when useParameters=false", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					metadata: {
						type: "object",
						patternProperties: {
							"^(.*)$": {},
						},
					},
				},
			}),
		];

		const result = convertTools(tools, false);
		const schema = result?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema as Record<string, unknown>;
		const metadata = (schema?.properties as Record<string, unknown>)?.metadata as Record<string, unknown>;

		expect(metadata).toEqual({
			type: "object",
			additionalProperties: {},
		});
		expect(JSON.stringify(schema)).not.toContain("patternProperties");
	});

	it("merges top-level anyOf object variants for Claude parameters", () => {
		const tools = [
			makeTool({
				anyOf: [
					{
						type: "object",
						properties: {
							kind: { const: "milestone" },
							content: { type: "string" },
						},
						required: ["kind", "content"],
					},
					{
						type: "object",
						properties: {
							kind: { const: "project" },
							content: { type: "string" },
						},
						required: ["kind", "content"],
					},
				],
			}),
		];

		const result = convertTools(tools, true);
		expect(result?.[0]?.functionDeclarations?.[0]?.parameters).toEqual({
			type: "object",
			properties: {
				kind: { type: "string", enum: ["milestone", "project"] },
				content: { type: "string" },
			},
			required: ["kind", "content"],
		});
	});

	it("simplifies heterogeneous anyOf unions for Claude parameters", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					keyFiles: {
						anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
						description: "Key files created or modified",
					},
					verificationEvidence: {
						type: "array",
						items: {
							anyOf: [
								{
									type: "object",
									properties: {
										command: { type: "string" },
										exitCode: { type: "number" },
									},
									required: ["command", "exitCode"],
								},
								{ type: "string" },
							],
						},
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const parameters = result?.[0]?.functionDeclarations?.[0]?.parameters as Record<string, unknown>;
		const properties = parameters?.properties as Record<string, unknown>;

		expect(JSON.stringify(parameters)).not.toMatch(/\b(anyOf|oneOf|allOf|patternProperties|\$ref)\b/);
		expect(properties?.keyFiles).toEqual({
			type: "array",
			items: { type: "string" },
		});
		expect(properties?.verificationEvidence).toEqual({
			type: "array",
			items: {
				type: "object",
				properties: {
					command: { type: "string" },
					exitCode: { type: "number" },
				},
				required: ["command", "exitCode"],
			},
		});
	});

	it("converts empty additionalProperties objects to true for Claude parameters", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					metadata: {
						type: "object",
						patternProperties: {
							"^(.*)$": {},
						},
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const metadata = (
			(result?.[0]?.functionDeclarations?.[0]?.parameters as Record<string, unknown>)?.properties as Record<
				string,
				unknown
			>
		)?.metadata;

		expect(metadata).toEqual({
			type: "object",
			additionalProperties: true,
		});
	});
});

describe("google-shared convertMessages", () => {
	it("adds the Gemini 3 unsigned function call thought-signature sentinel", () => {
		const model = makeGoogleModel({
			id: "gemini-3-pro",
		});
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read_file",
							arguments: { path: "README.md" },
						},
					],
					api: "anthropic-messages",
					provider: "google-antigravity",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
			],
		};

		const contents = convertMessages(model, context);

		expect(contents[0]?.parts?.[0]).toMatchObject({
			functionCall: {
				name: "read_file",
				args: { path: "README.md" },
			},
			thoughtSignature: "skip_thought_signature_validator",
		});
	});

	it("keeps tool result images outside functionResponse for non-Gemini models", () => {
		const model = makeGoogleModel({
			id: "claude-sonnet-4-5",
			provider: "google-antigravity",
		});
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [
						{ type: "text", text: "captured" },
						{ type: "image", mimeType: "image/png", data: "abc123" },
					],
					isError: false,
					timestamp: 0,
				},
			],
		};

		const contents = convertMessages(model, context);

		expect(contents).toHaveLength(2);
		expect(contents[0]?.parts?.[0]?.functionResponse).toMatchObject({
			name: "screenshot",
			response: { output: "captured" },
			id: "call-1",
		});
		expect(contents[0]?.parts?.[0]?.functionResponse).not.toHaveProperty("parts");
		expect(contents[1]?.parts).toEqual([
			{ text: "Tool result image:" },
			{ inlineData: { mimeType: "image/png", data: "abc123" } },
		]);
	});

	it("replaces user image parts with placeholders for text-only models", () => {
		const model = makeGoogleModel({
			id: "text-only-model",
			input: ["text"],
		});
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{ type: "image", mimeType: "image/png", data: "abc123" },
					],
					timestamp: 0,
				},
			],
		};

		const contents = convertMessages(model, context);

		expect(contents).toEqual([
			{
				role: "user",
				parts: [
					{ text: "describe this" },
					{ text: "(image omitted: model does not support images)" },
				],
			},
		]);
	});
});
