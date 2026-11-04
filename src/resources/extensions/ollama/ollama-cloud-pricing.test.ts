/**
 * Regression test for ollama cloud cost reporting: discovery must attach
 * real per-model rates to cloud-routed models and keep local models free.
 *
 * Behaviour test (same seam as ollama-auth-mode.test.ts): spin up a fake
 * Ollama endpoint, point OLLAMA_HOST at it, invoke probeAndRegister with a
 * mock pi, and assert the per-model `cost` passed to registerProvider.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { probeAndRegister } from "./index.js";

type RegisterCall = [string, Record<string, unknown>];

function makeMockPi() {
	const calls: { registerProvider: RegisterCall[]; unregisterProvider: string[] } = {
		registerProvider: [],
		unregisterProvider: [],
	};
	const pi = {
		registerProvider(id: string, spec: Record<string, unknown>) {
			calls.registerProvider.push([id, spec]);
		},
		unregisterProvider(id: string) {
			calls.unregisterProvider.push(id);
		},
	} as unknown as Parameters<typeof probeAndRegister>[0];
	return { pi, calls };
}

const CLOUD_MODELS = [
	"glm-5.3-flash:cloud",
	"glm-5.3:cloud",
	"gemma4:cloud",
	"qwen3.5:397b-cloud",
];
const LOCAL_MODELS = ["qwen2.5-coder:7b"];

function fakeModelInfo(name: string) {
	return {
		name,
		model: name,
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
	};
}

let server: Server;
let savedHost: string | undefined;
let savedDebug: string | undefined;
let savedWarn: typeof console.warn | undefined;

before(async () => {
	// Fake Ollama endpoint:
	//   GET /          → 200 (isRunning probe)
	//   GET /api/tags  → cloud-routed + local models
	//   POST /api/show → minimal capability info
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("Ollama is running");
			return;
		}
		if (req.method === "GET" && req.url === "/api/tags") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					models: [...CLOUD_MODELS, ...LOCAL_MODELS].map(fakeModelInfo),
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/api/show") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					modelfile: "",
					parameters: "",
					template: "",
					details: fakeModelInfo("x").details,
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
	process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (savedHost === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = savedHost;
	if (savedDebug === undefined) delete process.env.GSD_DEBUG;
	else process.env.GSD_DEBUG = savedDebug;
	if (savedWarn) console.warn = savedWarn;
});

/** Run one registration with GSD_DEBUG on and capture console.warn output. */
async function registerAndCaptureWarn() {
	savedDebug = process.env.GSD_DEBUG;
	process.env.GSD_DEBUG = "1";
	const warnings: string[] = [];
	savedWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		const { pi, calls } = makeMockPi();
		const found = await probeAndRegister(pi);
		assert.equal(found, true, "probeAndRegister should find the fake daemon");
		assert.equal(calls.registerProvider.length, 1, "registerProvider should be called exactly once");
		return { spec: calls.registerProvider[0][1], warnings };
	} finally {
		if (savedDebug === undefined) delete process.env.GSD_DEBUG;
		else process.env.GSD_DEBUG = savedDebug;
		if (savedWarn) console.warn = savedWarn;
	}
}

type RegisteredModel = { id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };

function registeredModels(spec: Record<string, unknown>): RegisteredModel[] {
	return spec.models as RegisteredModel[];
}

test("cloud-routed models register with their official per-model rates", async () => {
	const { spec } = await registerAndCaptureWarn();
	const models = registeredModels(spec);
	const byId = new Map(models.map((m) => [m.id, m]));

	// Flash siblings keep their own rates — the ~10x trap.
	assert.deepEqual(byId.get("glm-5.3:cloud")?.cost, { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(byId.get("glm-5.3-flash:cloud")?.cost, { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 });
	// gemma4 has an official row (models.dev lacks it — ollama.com is the source).
	assert.deepEqual(byId.get("gemma4:cloud")?.cost, { input: 0.14, output: 0.4, cacheRead: 0, cacheWrite: 0 });
});

test("local models register at zero cost", async () => {
	const { spec } = await registerAndCaptureWarn();
	const byId = new Map(registeredModels(spec).map((m) => [m.id, m]));
	assert.deepEqual(byId.get("qwen2.5-coder:7b")?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("unpriced cloud model registers at zero cost with a GSD_DEBUG warning", async () => {
	const { spec, warnings } = await registerAndCaptureWarn();
	const byId = new Map(registeredModels(spec).map((m) => [m.id, m]));
	assert.deepEqual(byId.get("qwen3.5:397b-cloud")?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(
		warnings.some((w) => w.includes("qwen3.5:397b-cloud") && w.includes("price")),
		true,
		"unpriced cloud model must be named in a debug warning — a silent $0 is indistinguishable from 'local and free'",
	);
	// The warning must not fire for priced cloud or local models.
	assert.equal(warnings.some((w) => w.includes("glm-5.3")), false);
	assert.equal(warnings.some((w) => w.includes("qwen2.5-coder:7b")), false);
});
