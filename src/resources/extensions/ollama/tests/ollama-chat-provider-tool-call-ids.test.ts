// gsd-pi — Regression test for #2685: the ollama provider minted tool-call ids
// from a per-response counter (`ollama_tc_N`), so the same id recycles across
// responses, turns and sessions. piExecutionInvocation derives Domain Operation
// idempotency keys from tool-call ids, so a recycled id with different arguments
// fails with "domain operation idempotency conflict".
//
// No module mocking: node:test cannot mock statically imported modules under the
// runner flags CI uses, so the stream path is exercised against a fake NDJSON
// endpoint (same pattern as ollama-auth-mode.test.ts).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { mintResponseNonce, mintToolCallId, streamOllamaChat } from "../ollama-chat-provider.js";
import type { Model, Context, AssistantMessageEvent } from "@gsd/pi-ai";

// ─── Layer A: pure id-minting contracts ──────────────────────────────────────

describe("mintResponseNonce", () => {
	it("returns 24 hex characters", () => {
		const nonce = mintResponseNonce();
		assert.match(nonce, /^[0-9a-f]{24}$/);
	});

	it("returns a different nonce on every call", () => {
		assert.notEqual(mintResponseNonce(), mintResponseNonce());
	});
});

describe("mintToolCallId", () => {
	it("combines nonce and index into ollama_tc_<nonce>_<index>", () => {
		assert.equal(mintToolCallId("abc123", 4), "ollama_tc_abc123_4");
	});

	it("is stable for the same nonce and index (exact-replay semantics)", () => {
		assert.equal(mintToolCallId("abc123", 0), mintToolCallId("abc123", 0));
	});

	it("mints distinct ids for distinct positions within one response", () => {
		const nonce = mintResponseNonce();
		const ids = [0, 1, 2].map((i) => mintToolCallId(nonce, i));
		assert.equal(new Set(ids).size, 3);
	});

	it("stays within the narrowest cross-provider id budget (≤ 40 chars)", () => {
		// ollama_tc_ (10) + 24-hex nonce + _ + index digits — 40 chars holds
		// while the index stays at 5 digits; an assistant message would need
		// 100,000 tool calls in one response to overflow, which ollama cannot
		// emit in a single chunk sequence. The 40-char bound is what
		// openai-completions applies for provider "openai"; the minted
		// [A-Za-z0-9_-] charset needs no sanitization from any normalizer.
		const id = mintToolCallId(mintResponseNonce(), 99999);
		assert.ok(id.length <= 40, `id must stay within the 40-char budget, was ${id.length}`);
	});

	it("stays inside the sanitizer charset [A-Za-z0-9_-] and contains no pipe", () => {
		// openai-completions' normalizeToolCallId splits ids containing "|" and
		// sanitizes everything outside [A-Za-z0-9_-]; the id must need no rewrite.
		const id = mintToolCallId(mintResponseNonce(), 0);
		assert.match(id, /^[A-Za-z0-9_-]+$/);
		assert.ok(!id.includes("|"), "a pipe would be split off by normalizeToolCallId");
	});
});

// ─── Layer B: real stream path against a fake NDJSON endpoint ────────────────

function modelStub(): Model<any> {
	return {
		id: "llama3",
		name: "llama3",
		api: "ollama",
		provider: "ollama",
		baseUrl: "http://127.0.0.1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	};
}

interface FakeChunk {
	message?: {
		content?: string;
		tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
	};
	done?: boolean;
	done_reason?: string;
}

/** NDJSON lines a fake /api/chat sends; newline frames per ollama's protocol. */
function ndjsonBody(chunks: FakeChunk[]): string {
	return chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n";
}

let server: Server;
let savedHost: string | undefined;
let savedPort: string | undefined;

const CONTENT_THEN_ONE_TOOL_CALL: FakeChunk[] = [
	{ message: { content: "I will call the tool" }, done: false },
	{
		message: {
			tool_calls: [{ function: { name: "gsd_task_complete", arguments: { taskId: "T1" } } }],
		},
		done: false,
	},
	{ done: true, done_reason: "stop" },
];

const TWO_TOOL_CALLS_ON_DONE: FakeChunk[] = [
	{
		message: {
			tool_calls: [
				{ function: { name: "t1", arguments: {} } },
				{ function: { name: "t2", arguments: {} } },
			],
		},
		done: true,
		done_reason: "stop",
	},
];

// The provider is imported once per file; the host env var must be set before
// the first stream call. getOllamaHost() reads it per request, so swapping the
// served script per request is enough — no re-import needed.
let scriptQueue: FakeChunk[][] = [];

async function collectStreamIds(context: Context): Promise<string[]> {
	const ids: string[] = [];
	const stream = streamOllamaChat(modelStub(), context);
	for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
		if (event.type === "toolcall_end") {
			const toolCall = (event as { toolCall?: { id?: string }; content?: { toolCall?: { id?: string } } })
				.toolCall ?? (event as { content?: { toolCall?: { id?: string } } }).content?.toolCall;
			assert.ok(toolCall?.id, "toolcall_end must carry the tool call");
			ids.push(toolCall.id);
		}
		if (event.type === "error") {
			const message = (event as { error?: { errorMessage?: string } }).error?.errorMessage;
			assert.fail(`stream errored instead of emitting the tool call: ${message}`);
		}
	}
	return ids;
}

describe("streamOllamaChat tool-call id uniqueness (#2685)", () => {
	// Fake endpoint: POST /api/chat plays the next queued chunk script as NDJSON.
	// Unlisted routes 404.
	before(async () => {
		server = createServer((req, res) => {
			if (req.method === "POST" && req.url === "/api/chat") {
				const script = scriptQueue.shift() ?? [];
				res.writeHead(200, { "Content-Type": "application/x-ndjson" });
				res.end(ndjsonBody(script));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		savedHost = process.env.OLLAMA_HOST;
		savedPort = process.env.OLLAMA_TEST_PORT;
		process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (savedHost === undefined) delete process.env.OLLAMA_HOST;
		else process.env.OLLAMA_HOST = savedHost;
		if (savedPort === undefined) delete process.env.OLLAMA_TEST_PORT;
		else process.env.OLLAMA_TEST_PORT = savedPort;
	});

	it("mints different ids for the same position across different responses", async () => {
		const context = { messages: [], tools: [] } as unknown as Context;
		scriptQueue = [CONTENT_THEN_ONE_TOOL_CALL, CONTENT_THEN_ONE_TOOL_CALL];

		const id1 = (await collectStreamIds(context))[0];
		const id2 = (await collectStreamIds(context))[0];
		assert.equal(scriptQueue.length, 0, "both responses must have been served");
		assert.ok(id1, "response 1 should emit a tool call");
		assert.ok(id2, "response 2 should emit a tool call");
		assert.notEqual(id1, id2, "the same positional tool call must get a fresh id per response");
	});

	it("mints distinct ids for multiple tool calls within one response", async () => {
		const context = { messages: [], tools: [] } as unknown as Context;
		scriptQueue = [TWO_TOOL_CALLS_ON_DONE];

		const ids = await collectStreamIds(context);
		assert.equal(ids.length, 2, "both tool calls must be emitted");
		assert.notEqual(ids[0], ids[1], "tool calls within one response must have distinct ids");
	});

	it("mints ids that survive the cross-provider normalizer untouched", async () => {
		const context = { messages: [], tools: [] } as unknown as Context;
		scriptQueue = [CONTENT_THEN_ONE_TOOL_CALL];

		const [id] = await collectStreamIds(context);
		assert.match(id, /^[A-Za-z0-9_-]+$/);
		assert.ok(!id.includes("|"));
		assert.ok(id.length <= 40, `id must fit the 40-char budget, was ${id.length}`);
	});
});