import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Message } from "../src/types.ts";

const model = getModel("anthropic", "claude-sonnet-4-6");

async function captureMessages(messages: Message[]): Promise<Array<Record<string, unknown>>> {
	const context: Context = { systemPrompt: "You are a helpful assistant.", messages };
	const s = streamAnthropic(model, context, { apiKey: "test-key" });
	for await (const event of s) {
		if (event.type === "error") break;
	}
	const params = mockState.createParams!;
	expect(Array.isArray(params.messages)).toBe(true);
	return params.messages as Array<Record<string, unknown>>;
}

function assistantToolCall(id: string): Message {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "browser_click",
				arguments: { selector: "button:has-text('Nonexistent')" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const TEST_IMAGE = { type: "image" as const, data: "cG5nLWRhdGE=", mimeType: "image/png" };

/**
 * The Anthropic Messages API rejects tool_result content containing non-text
 * blocks when is_error is true ("all content must be type `text` if `is_error`
 * is true"), and the poisoned result is persisted and replayed every turn,
 * wedging the session (#2438). The transport must serialize error tool results
 * text-only and hoist the images into sibling content after the whole
 * consecutive tool_result run, keeping tool_use/tool_result pairing intact.
 * Success-path results must be unchanged.
 */
describe("Anthropic error tool_result image splitting", () => {
	it("keeps image blocks out of is_error tool_result content and hoists them into sibling content", async () => {
		const messages: Message[] = [
			assistantToolCall("toolu_01"),
			{
				role: "toolResult",
				toolCallId: "toolu_01",
				toolName: "browser_click",
				content: [
					{ type: "text", text: "Click failed: selector not found" },
					{ ...TEST_IMAGE },
				],
				details: { error: "selector not found" },
				isError: true,
				timestamp: Date.now(),
			},
		];

		const out = await captureMessages(messages);
		expect(out).toHaveLength(2);
		expect(out[0].role).toBe("assistant");
		expect(out[1].role).toBe("user");

		const userContent = out[1].content as Array<Record<string, unknown>>;
		const toolResults = userContent.filter((b) => b.type === "tool_result");
		expect(toolResults).toHaveLength(1);

		const tr = toolResults[0] as { tool_use_id: string; is_error: boolean; content: unknown };
		expect(tr.tool_use_id).toBe("toolu_01");
		expect(tr.is_error).toBe(true);

		// The is_error tool_result itself must not carry any image block.
		const serialized = JSON.stringify(tr.content);
		expect(serialized).not.toContain('"type":"image"');
		expect(serialized).not.toContain('"type": "image"');
		// Text survives, with a note where the image was omitted.
		expect(serialized).toContain("Click failed: selector not found");
		expect(serialized).toContain("image omitted from tool error");

		// The image is hoisted into sibling content after the tool_result run.
		const imageBlocks = userContent.filter((b) => b.type === "image");
		expect(imageBlocks).toHaveLength(1);
		const lastBlock = userContent[userContent.length - 1];
		expect(lastBlock.type).toBe("image");
		expect((lastBlock as any).source).toEqual({
			type: "base64",
			media_type: "image/png",
			data: "cG5nLWRhdGE=",
		});
	});

	it("preserves pairing and hoists only after the whole run when errors and successes interleave", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "toolu_02a", name: "browser_click", arguments: { selector: "#a" } },
					{
						type: "toolCall",
						id: "toolu_02b",
						name: "browser_screenshot",
						arguments: {},
					},
					{ type: "toolCall", id: "toolu_02c", name: "browser_navigate", arguments: { url: "http://x" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.id,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_02a",
				toolName: "browser_click",
				content: [
					{ type: "text", text: "Click failed: selector not found" },
					{ ...TEST_IMAGE },
				],
				isError: true,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_02b",
				toolName: "browser_screenshot",
				content: [
					{ type: "text", text: "Screenshot captured" },
					{ ...TEST_IMAGE },
				],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_02c",
				toolName: "browser_navigate",
				content: [
					{ type: "text", text: "Navigation failed: net::ERR_ABORTED" },
					{ ...TEST_IMAGE },
				],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const out = await captureMessages(messages);
		expect(out).toHaveLength(2);
		const userContent = out[1].content as Array<Record<string, any>>;

		// Exact block order: every tool_result first (pairing intact, nothing
		// interleaved between them), then all hoisted images from the error
		// results in encounter order. A per-result hoist would interleave
		// images between tool_results and fail this assertion.
		const blockTypes = userContent.map((b) => b.type);
		expect(blockTypes).toEqual(["tool_result", "tool_result", "tool_result", "image", "image"]);

		const toolResults = userContent.filter((b) => b.type === "tool_result") as Array<{
			tool_use_id: string;
			is_error: boolean;
			content: unknown;
		}>;
		expect(toolResults.map((t) => t.tool_use_id)).toEqual(["toolu_02a", "toolu_02b", "toolu_02c"]);
		expect(toolResults.map((t) => t.is_error)).toEqual([true, false, true]);
		// Neither error tool_result carries an image; the success result keeps its own.
		for (const t of toolResults) {
			const serialized = JSON.stringify(t.content);
			if (t.is_error) {
				expect(serialized).not.toContain('"type":"image"');
			} else {
				expect(serialized).toContain('"type":"image"');
			}
		}

		// Both hoisted images follow the run, in encounter order.
		expect(userContent[3].source).toEqual({
			type: "base64",
			media_type: "image/png",
			data: "cG5nLWRhdGE=",
		});
		expect(userContent[4].source).toEqual({
			type: "base64",
			media_type: "image/png",
			data: "cG5nLWRhdGE=",
		});
	});

	it("leaves success-path tool results with images byte-identical (no hoisting)", async () => {
		const messages: Message[] = [
			assistantToolCall("toolu_03"),
			{
				role: "toolResult",
				toolCallId: "toolu_03",
				toolName: "browser_screenshot",
				content: [
					{ type: "text", text: "Screenshot captured" },
					{ ...TEST_IMAGE },
				],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const out = await captureMessages(messages);
		expect(out).toHaveLength(2);
		const userContent = out[1].content as Array<Record<string, unknown>>;
		expect(userContent).toHaveLength(1);

		const tr = userContent[0] as { tool_use_id: string; is_error: boolean; content: unknown };
		expect(tr.tool_use_id).toBe("toolu_03");
		expect(tr.is_error).toBe(false);
		// Unchanged: content block array with text then image inside the tool_result.
		expect(tr.content).toEqual([
			{ type: "text", text: "Screenshot captured" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "cG5nLWRhdGE=" },
			},
		]);
	});

	it("leaves error tool results without images unchanged", async () => {
		const messages: Message[] = [
			assistantToolCall("toolu_04"),
			{
				role: "toolResult",
				toolCallId: "toolu_04",
				toolName: "browser_click",
				content: [{ type: "text", text: "Click failed: timeout" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const out = await captureMessages(messages);
		expect(out).toHaveLength(2);
		const userContent = out[1].content as Array<Record<string, unknown>>;
		expect(userContent).toHaveLength(1);
		const tr = userContent[0] as { is_error: boolean; content: unknown };
		expect(tr.is_error).toBe(true);
		expect(tr.content).toBe("Click failed: timeout");
	});
});
