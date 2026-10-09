// gsd-pi — Regression test: ollama tool-call ids must be unique per invocation (#2685)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, AssistantMessageEvent, Context, Model } from "@gsd/pi-ai";
import { streamOllamaChat } from "../ollama-chat-provider.js";

/**
 * Ollama's raw tool_calls carry no id, so the provider mints one. Minting it
 * from the per-response stream index (`ollama_tc_<contentIndex>`) recycles the
 * same short id across responses, turns, sessions and crash resumes. GSD uses
 * `pi:<tool>:<toolCallId>` as a Domain Operation idempotency key, so a recycled
 * id makes a fresh call collide with a previously committed operation.
 *
 * Contract under test: every streamOllamaChat invocation mints ids from a
 * namespace unique to that invocation, so ids never repeat across responses.
 */

function modelStub(): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions" as Api,
		provider: "ollama",
		baseUrl: "http://localhost:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	};
}

const emptyContext: Context = { messages: [] } as unknown as Context;

/** Scripted NDJSON responses served one per /api/chat POST. */
async function startScriptedOllama(responses: string[][]): Promise<Server> {
	const server = createServer((req, res) => {
		const next = responses.shift() ?? [];
		res.writeHead(200, { "Content-Type": "application/x-ndjson" });
		for (const line of next) res.write(line + "\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return server;
}

/** Point the client at the scripted server for the duration of one test. */
async function withScriptedOllama(
	t: { after: (fn: () => void | Promise<void>) => void },
	responses: string[][],
	run: () => Promise<void>,
): Promise<void> {
	const server = await startScriptedOllama(responses);
	const prevHost = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(() => {
		if (prevHost === undefined) delete process.env.OLLAMA_HOST;
		else process.env.OLLAMA_HOST = prevHost;
		server.close();
	});
	await run();
}

function toolCallChunk(...names: string[]): string {
	return JSON.stringify({
		model: "test-model",
		done: true,
		done_reason: "stop",
		message: {
			role: "assistant",
			content: "",
			tool_calls: names.map((name) => ({ function: { name, arguments: {} } })),
		},
	});
}

async function runStream(): Promise<{
	events: AssistantMessageEvent[];
	messageIds: string[];
}> {
	const stream = streamOllamaChat(modelStub(), emptyContext);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	const messageIds = message.content
		.filter((block) => block.type === "toolCall")
		.map((block) => (block as { id: string }).id);
	return { events, messageIds };
}

function toolCallEventIds(events: AssistantMessageEvent[]): string[] {
	return events
		.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => e.type === "toolcall_end")
		.map((e) => e.toolCall.id);
}

describe("ollama tool-call id uniqueness (#2685)", () => {
	it("mints distinct tool-call ids across two provider responses", async (t) => {
		await withScriptedOllama(t, [[toolCallChunk("gsd_plan_task")], [toolCallChunk("gsd_plan_task")]], async () => {
			const first = await runStream();
			const second = await runStream();

			const firstIds = toolCallEventIds(first.events);
			const secondIds = toolCallEventIds(second.events);
			assert.equal(firstIds.length, 1, "one tool call per scripted response");
			assert.equal(secondIds.length, 1, "one tool call per scripted response");
			assert.equal(first.messageIds[0], firstIds[0], "message content carries the minted id");
			assert.notEqual(
				firstIds[0],
				secondIds[0],
				"ids recycled across responses collide as Domain Operation idempotency keys",
			);
		});
	});

	it("mints distinct ids for multiple tool calls within one response", async (t) => {
		await withScriptedOllama(t, [[toolCallChunk("gsd_plan_task", "gsd_slice_complete")]], async () => {
		const { events, messageIds } = await runStream();
		const ids = toolCallEventIds(events);
		assert.equal(ids.length, 2);
		assert.notEqual(ids[0], ids[1], "two tool calls in one response must not share an id");
		assert.deepEqual(messageIds, ids);
		for (const id of ids) {
			assert.ok(id.startsWith("ollama_tc_"), `id keeps the ollama_tc_ prefix: ${id}`);
			// Nonce segment: 24 hex chars (96 bits — the per-response stream index
			// alone was the bug). `ollama_tc_` + nonce + `_` + index must stay
			// within OpenAI's 40-char tool-call id limit so replays to
			// openai-provider models cannot truncate away the index.
			assert.match(id, /^ollama_tc_[0-9a-f]{24}_(\d+)$/, `id shape: ${id}`);
			assert.ok(id.length <= 40, `id fits the 40-char cross-provider limit: ${id}`);
		}
	});
	});

	it("keeps toolcall_* event contentIndex correlation intact", async (t) => {
		const textThenTools: string[] = [
			JSON.stringify({ model: "test-model", done: false, message: { role: "assistant", content: "Let me " } }),
			JSON.stringify({ model: "test-model", done: false, message: { role: "assistant", content: "check." } }),
			toolCallChunk("gsd_plan_task", "gsd_slice_complete"),
		];
		await withScriptedOllama(t, [textThenTools], async () => {
			const { events, messageIds } = await runStream();
			const starts = events.filter((e) => e.type === "toolcall_start");
			assert.deepEqual(
				starts.map((e) => (e as { contentIndex: number }).contentIndex),
				[1, 2],
				"chunk correlation stays on contentIndex (after the text block), independent of the id",
			);
			// start/delta/end of each call share one contentIndex, and the end
			// event's toolCall id is what lands in the final message.
			for (let i = 0; i < 2; i++) {
				const end = events.find(
					(e): e is Extract<AssistantMessageEvent, { type: "toolcall_end" }> =>
						e.type === "toolcall_end" && e.contentIndex === i + 1,
				);
				assert.ok(end, `toolcall_end for contentIndex ${i + 1}`);
				assert.equal(end.toolCall.id, messageIds[i]);
			}
			const deltas = events.filter((e) => e.type === "toolcall_delta");
			assert.deepEqual(
				deltas.map((e) => (e as { contentIndex: number }).contentIndex),
				[1, 2],
			);
		});
	});
});
