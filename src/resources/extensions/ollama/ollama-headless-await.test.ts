/**
 * Regression test: headless RPC workers (parallel orchestration, `gsd
 * headless`) install a UI bridge, so `ctx.hasUI === true` in a session that
 * has no human in the loop. The awaited-probe branch must therefore key on
 * the GSD_HEADLESS marker, not on the absence of a UI — otherwise workers
 * race their own provider registration and auto-mode snapshots an empty
 * registry ("unknown/unknown" banner, worst case a model-policy deny).
 *
 * Behaviour tests:
 *   1. session_start with hasUI=true and GSD_HEADLESS=1 registers the
 *      provider before the handler's promise resolves (awaited probe).
 *   2. session_start with hasUI=true and no GSD_HEADLESS keeps the
 *      fire-and-forget probe (interactive TUI fast startup).
 *   3. session_start with hasUI=false (print mode) still awaits the probe.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import ollamaExtension, { probeAndRegister } from "./index.js";

type RegisterCall = [string, Record<string, unknown>];

function makeMockPi() {
	const calls: {
		registerProvider: RegisterCall[];
		unregisterProvider: string[];
		registerTool: unknown[];
		onHandlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	} = {
		registerProvider: [],
		unregisterProvider: [],
		registerTool: [],
		onHandlers: new Map(),
	};
	const pi = {
		registerProvider(id: string, spec: Record<string, unknown>) {
			calls.registerProvider.push([id, spec]);
		},
		unregisterProvider(id: string) {
			calls.unregisterProvider.push(id);
		},
		registerTool(tool: unknown) {
			calls.registerTool.push(tool);
		},
		registerCommand() {
			/* no-op */
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (!calls.onHandlers.has(event)) calls.onHandlers.set(event, []);
			calls.onHandlers.get(event)!.push(handler);
		},
	} as unknown as Parameters<typeof probeAndRegister>[0];
	return { pi, calls };
}

let server: Server;
let serverMode: "empty" | "loaded" = "empty";
let savedHost: string | undefined;
let savedHeadless: string | undefined;

before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200);
			res.end("Ollama is running");
			return;
		}
		if (req.method === "GET" && req.url === "/api/tags") {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (serverMode === "empty") {
				res.end(JSON.stringify({ models: [] }));
			} else {
				res.end(
					JSON.stringify({
						models: [
							{
								name: "llama3:latest",
								modified_at: new Date().toISOString(),
								size: 1_000_000,
								digest: "abc",
								details: {
									parent_model: "",
									format: "gguf",
									family: "llama",
									families: ["llama"],
									parameter_size: "8B",
									quantization_level: "Q4_0",
								},
							},
						],
					}),
				);
			}
			return;
		}
		if (req.method === "POST" && req.url === "/api/show") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					modelfile: "",
					parameters: "",
					template: "",
					details: {
						parent_model: "",
						format: "gguf",
						family: "llama",
						families: ["llama"],
						parameter_size: "8B",
						quantization_level: "Q4_0",
					},
					model_info: { "llama.context_length": 8192 },
					capabilities: [],
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	savedHost = process.env.OLLAMA_HOST;
	savedHeadless = process.env.GSD_HEADLESS;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (savedHost === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = savedHost;
	if (savedHeadless === undefined) delete process.env.GSD_HEADLESS;
	else process.env.GSD_HEADLESS = savedHeadless;
});

/** Reset the module-level registration flag between cases. */
async function resetRegistration(pi: Parameters<typeof probeAndRegister>[0]) {
	serverMode = "empty";
	await probeAndRegister(pi);
}

test("headless RPC worker (hasUI=true, GSD_HEADLESS=1) registers the provider before session_start resolves", async () => {
	await resetRegistration(makeMockPi().pi);
	serverMode = "loaded";
	process.env.GSD_HEADLESS = "1";
	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];
	assert.equal(handlers.length, 1, "extension registers one session_start handler");

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: () => {},
		},
	};

	await handlers[0]({}, ctx);
	assert.equal(
		calls.registerProvider.length,
		1,
		"provider must be registered by the time the session_start handler resolves in headless mode",
	);
});

test("interactive session (hasUI=true, no GSD_HEADLESS) keeps the fire-and-forget probe", async () => {
	await resetRegistration(makeMockPi().pi);
	serverMode = "loaded";
	delete process.env.GSD_HEADLESS;
	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];

	const statusCalls: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (slot: string, value: string | undefined) => {
				statusCalls.push([slot, value]);
			},
			notify: () => {},
		},
	};

	await handlers[0]({}, ctx);
	assert.equal(
		calls.registerProvider.length,
		0,
		"interactive handler must not block on the probe (fast TUI startup)",
	);
	// The probe still completes asynchronously and reports the status.
	for (let i = 0; i < 50; i++) {
		if (statusCalls.length > 0) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.deepEqual(statusCalls, [["ollama", "Ollama"]]);
});

test("no-UI session (print mode) still awaits the probe", async () => {
	await resetRegistration(makeMockPi().pi);
	serverMode = "loaded";
	delete process.env.GSD_HEADLESS;
	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];

	const ctx = {
		hasUI: false,
		ui: {
			setStatus: () => {},
			notify: () => {},
		},
	};

	await handlers[0]({}, ctx);
	assert.equal(
		calls.registerProvider.length,
		1,
		"provider must be registered by the time the session_start handler resolves without a UI",
	);
});