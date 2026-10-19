import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.ts";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Message } from "../src/types.ts";

const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

async function capturePayload(context: Context): Promise<unknown> {
	let capturedPayload: unknown;
	const s = streamBedrock(baseModel, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return capturedPayload;
}

describe("bedrock convertMessages skips unknown content types", () => {
	it("skips unknown user content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips unknown assistant content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips user messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "unknown", data: "foo" }] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("skips assistant messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "unknown", data: "foo" }] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});
});

function bedrockAssistantToolCall(id: string): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "browser_click", arguments: { selector: "#missing" } }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: baseModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const TEST_IMAGE = { type: "image" as const, data: "dGVzdA==", mimeType: "image/png" };

/**
 * Bedrock Claude rejects tool results with status=error whose content carries
 * non-text blocks (same constraint as the Anthropic Messages API), and the
 * poisoned result is replayed every turn, wedging the session (#2438). The
 * transport must serialize error tool results text-only and hoist images into
 * sibling content after the tool_result run. Success-path results are
 * unchanged.
 */
describe("bedrock convertMessages error tool result image splitting", () => {
	it("keeps image blocks out of error tool result content and hoists them into sibling content", async () => {
		const messages: Message[] = [
			bedrockAssistantToolCall("toolu_01"),
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

		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: any[] }> };
		expect(p.messages).toHaveLength(2);
		expect(p.messages[1].role).toBe("user");

		const content = p.messages[1].content;
		const toolResults = content.filter((b) => "toolResult" in b);
		expect(toolResults).toHaveLength(1);
		const tr = toolResults[0].toolResult as { toolUseId: string; status: string; content: any[] };
		expect(tr.toolUseId).toBe("toolu_01");
		expect(tr.status).toBe("error");

		// The error tool result itself must not carry any image block.
		const serialized = JSON.stringify(tr.content);
		expect(serialized).not.toContain('"image"');
		expect(serialized).not.toContain('"format"');
		// Text survives, with a note where the image was omitted.
		expect(serialized).toContain("Click failed: selector not found");
		expect(serialized).toContain("image omitted from tool error");

		// The image is hoisted into sibling content after the tool result run.
		const imageBlocks = content.filter((b) => "image" in b);
		expect(imageBlocks).toHaveLength(1);
		expect(content[content.length - 1].image.format).toBe("png");
	});

	it("leaves success-path tool results with images unchanged (no hoisting)", async () => {
		const messages: Message[] = [
			bedrockAssistantToolCall("toolu_02"),
			{
				role: "toolResult",
				toolCallId: "toolu_02",
				toolName: "browser_screenshot",
				content: [
					{ type: "text", text: "Screenshot captured" },
					{ ...TEST_IMAGE },
				],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: any[] }> };
		expect(p.messages).toHaveLength(2);
		const content = p.messages[1].content;
		expect(content).toHaveLength(1);
		const tr = content[0].toolResult as { toolUseId: string; status: string; content: any[] };
		expect(tr.toolUseId).toBe("toolu_02");
		expect(tr.status).toBe("success");
		// Unchanged: text then image inside the tool result content.
		expect(tr.content).toHaveLength(2);
		expect(tr.content[0]).toEqual({ text: "Screenshot captured" });
		expect(tr.content[1].image.format).toBe("png");
		// Exact image bytes survive (a dropped or corrupted screenshot must fail).
		expect(Buffer.from(tr.content[1].image.source.bytes).toString("base64")).toBe("dGVzdA==");
		expect(content.filter((b) => "image" in b)).toHaveLength(0);
	});

	it("hoists only after the whole run when errors and successes interleave", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "toolu_04a", name: "browser_click", arguments: { selector: "#a" } },
					{ type: "toolCall", id: "toolu_04b", name: "browser_screenshot", arguments: {} },
					{ type: "toolCall", id: "toolu_04c", name: "browser_navigate", arguments: { url: "http://x" } },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_04a",
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
				toolCallId: "toolu_04b",
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
				toolCallId: "toolu_04c",
				toolName: "browser_navigate",
				content: [
					{ type: "text", text: "Navigation failed: net::ERR_ABORTED" },
					{ ...TEST_IMAGE },
				],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: any[] }> };
		expect(p.messages).toHaveLength(2);

		const content = p.messages[1].content;
		// Exact block order: toolResults first, then hoisted error images. A
		// per-result hoist would interleave images and fail this assertion.
		const kinds = content.map((b) => ("toolResult" in b ? "toolResult" : "image"));
		expect(kinds).toEqual(["toolResult", "toolResult", "toolResult", "image", "image"]);

		const toolResults = content.filter((b) => "toolResult" in b) as Array<{
			toolResult: { toolUseId: string; status: string; content: any[] };
		}>;
		expect(toolResults.map((t) => t.toolResult.toolUseId)).toEqual([
			"toolu_04a",
			"toolu_04b",
			"toolu_04c",
		]);
		expect(toolResults.map((t) => t.toolResult.status)).toEqual(["error", "success", "error"]);
		for (const t of toolResults) {
			const serialized = JSON.stringify(t.toolResult.content);
			if (t.toolResult.status === "error") {
				expect(serialized).not.toContain('"image"');
			} else {
				expect(serialized).toContain('"image"');
			}
		}
		// Hoisted images carry the original bytes, in encounter order.
		expect(Buffer.from(content[3].image.source.bytes).toString("base64")).toBe("dGVzdA==");
		expect(Buffer.from(content[4].image.source.bytes).toString("base64")).toBe("dGVzdA==");
	});

	it("leaves error tool results without images unchanged", async () => {
		const messages: Message[] = [
			bedrockAssistantToolCall("toolu_03"),
			{
				role: "toolResult",
				toolCallId: "toolu_03",
				toolName: "browser_click",
				content: [{ type: "text", text: "Click failed: timeout" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: any[] }> };
		const content = p.messages[1].content;
		expect(content).toHaveLength(1);
		const tr = content[0].toolResult as { status: string; content: any[] };
		expect(tr.status).toBe("error");
		expect(tr.content).toEqual([{ text: "Click failed: timeout" }]);
	});
});
