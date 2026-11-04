/**
 * Regression test for ollama cost reporting at the provider seam: the
 * final /api/chat chunk's token counts must be priced from the model's
 * registered rates via calculateCost — the same contract as every other
 * pi-ai provider. Previously buildUsage hardcoded cost 0, so ollama
 * sessions always summed to $0 no matter what the model cost.
 *
 * Behaviour test: real HTTP against a local fake ollama endpoint streaming
 * NDJSON /api/chat responses.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Api, Context, Model } from "@gsd/pi-ai";
import { streamOllamaChat } from "./ollama-chat-provider.js";

const PROMPT_TOKENS = 1000;
const OUTPUT_TOKENS = 500;

let server: Server;
let savedHost: string | undefined;

before(async () => {
	// POST /api/chat streams two NDJSON chunks: one content delta, then
	// the final done chunk carrying the token counts ollama bills on.
	server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/api/chat") {
			res.writeHead(200, { "Content-Type": "application/x-ndjson" });
			res.write(`${JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false })}\n`);
			res.end(
				`${JSON.stringify({
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
					prompt_eval_count: PROMPT_TOKENS,
					eval_count: OUTPUT_TOKENS,
					total_duration: 1_000_000,
					load_duration: 100_000,
					prompt_eval_duration: 200_000,
					eval_duration: 700_000,
				})}\n`,
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	savedHost = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (savedHost === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = savedHost;
});

function fakeModel(
	id: string,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Model<Api> {
	return {
		id,
		name: id,
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 8192,
		maxTokens: 1024,
	} as Model<Api>;
}

const CONTEXT: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

async function streamOnce(model: Model<Api>) {
	const stream = streamOllamaChat(model, CONTEXT);
	let message;
	for await (const event of stream) {
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error("stream errored");
	}
	assert.ok(message, "stream must complete with a done event");
	return message;
}

test("priced model: final-chunk token counts are costed from the model's rates", async () => {
	const message = await streamOnce(
		fakeModel("glm-5.3:cloud", { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 }),
	);
	assert.equal(message.usage.input, PROMPT_TOKENS);
	assert.equal(message.usage.output, OUTPUT_TOKENS);
	// 1000 * $1.40/M + 500 * $4.40/M = $0.0014 + $0.0022
	assert.ok(Math.abs(message.usage.cost.total - 0.0036) < 1e-12, `expected ~$0.0036, got ${message.usage.cost.total}`);
	assert.ok(Math.abs(message.usage.cost.input - 0.0014) < 1e-12);
	assert.ok(Math.abs(message.usage.cost.output - 0.0022) < 1e-12);
});

test("flash sibling prices at its own rates, not the base model's", async () => {
	const message = await streamOnce(
		fakeModel("glm-5.3-flash:cloud", { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 }),
	);
	// 1000 * $0.15/M + 500 * $0.50/M = $0.00015 + $0.00025
	assert.ok(Math.abs(message.usage.cost.total - 0.0004) < 1e-12, `expected ~$0.0004, got ${message.usage.cost.total}`);
});

test("zero-cost (local) model reports $0", async () => {
	const message = await streamOnce(
		fakeModel("qwen2.5-coder:7b", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	);
	assert.equal(message.usage.cost.total, 0);
});
