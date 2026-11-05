/**
 * Regression test for ollama cloud cost reporting: discovery must attach
 * real per-model rates to cloud-routed models and keep local models free.
 *
 * Behaviour test (same seam as ollama-auth-mode.test.ts): spin up a fake
 * Ollama endpoint, point OLLAMA_HOST at it, invoke probeAndRegister with a
 * mock pi, and assert the per-model `cost` passed to registerProvider.
 */
import { test, before, after, beforeEach } from "node:test";
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

const CLOUD_MODELS = [
	"glm-5.3-flash:cloud",
	"glm-5.3:cloud",
	"gemma4:cloud",
	"qwen3.5:397b-cloud",
];
const LOCAL_MODELS = ["qwen2.5-coder:7b"];

/** Mutable catalog served by the fake daemon (per-test control). */
let tagCatalog: string[] = [...CLOUD_MODELS, ...LOCAL_MODELS];

/** When true, /api/show answers 500 (pricing must not depend on it). */
let showFails = false;

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
					models: tagCatalog.map(fakeModelInfo),
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/api/show") {
			if (showFails) {
				res.writeHead(500);
				res.end(JSON.stringify({ error: "show failed" }));
				return;
			}
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
	// Discovery-internal metadata must not leak into the provider config.
	for (const model of models) {
		assert.equal("unpricedCloud" in model, false, `${model.id} must not carry discovery metadata`);
	}
});

test("cloud pricing survives a failing /api/show", async () => {
	// Pricing derives from the /api/tags name — a 500-ing /api/show must
	// cost capability fidelity, never cost data.
	showFails = true;
	const { spec } = await registerAndCaptureWarn();
	const byId = new Map(registeredModels(spec).map((m) => [m.id, m]));
	const cost = byId.get("glm-5.3:cloud")?.cost;
	assert.ok(cost, "cloud model must still register when /api/show fails");
	assert.equal(cost.input, 1.4);
	assert.equal(cost.output, 4.4);
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

beforeEach(() => {
	tagCatalog = [...CLOUD_MODELS, ...LOCAL_MODELS];
	showFails = false;
});

test("probeAndRegister reports unpriced cloud models through hooks", async () => {
	const seen: string[] = [];
	const { pi } = makeMockPi();
	const found = await probeAndRegister(pi, { onUnpricedCloudModel: (name) => seen.push(name) });
	assert.equal(found, true);
	// Only the unpriced cloud model — priced cloud and local models stay silent.
	assert.deepEqual(seen, ["qwen3.5:397b-cloud"]);
});

test("interactive session notifies (once) about unpriced cloud models", async () => {
	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];
	assert.equal(handlers.length, 1, "extension registers one session_start handler");

	const notifyCalls: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: (message: string, level?: string) => {
				notifyCalls.push([message, level]);
			},
		},
	};

	// First session_start: the notify must arrive via the async probe chain.
	await handlers[0]({}, ctx);
	for (let i = 0; i < 50; i++) {
		if (notifyCalls.length > 0) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(notifyCalls.length, 1, `expected exactly one notify, got ${notifyCalls.length}`);
	assert.ok(
		notifyCalls[0][0].includes("qwen3.5:397b-cloud"),
		`notify must name the unpriced model: ${notifyCalls[0]?.[0]}`,
	);
	assert.equal(notifyCalls[0][1], "warning");

	// A session switch re-fires session_start — the notice must not repeat.
	await handlers[0]({}, ctx);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(notifyCalls.length, 1, "interactive unpriced-model notice must be one-time per process");
});

test("headless session writes unpriced cloud models to stderr (worker forensics channel)", async () => {
	// Distinct unpriced model so the process-level once-set from the
	// interactive test cannot swallow this emission.
	tagCatalog = ["glm-5.3-flash:cloud", "brand-new-model:cloud"];

	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];

	const stderrChunks: string[] = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = ((chunk: Uint8Array | string) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	}) as typeof process.stderr.write;
	try {
		// hasUI: false identifies headless (ctx installs no UI bridge).
		await handlers[0]({}, { hasUI: false, ui: undefined });
	} finally {
		process.stderr.write = originalWrite;
	}

	const stderr = stderrChunks.join("");
	assert.ok(
		stderr.includes("brand-new-model:cloud"),
		`headless stderr must name the unpriced cloud model — got: ${stderr}`,
	);
	// Priced cloud model must not be flagged.
	assert.equal(stderr.includes("glm-5.3-flash"), false);
});

test("no cost notices when the daemon has no models (non-ollama users stay noise-free)", async () => {
	tagCatalog = [];

	const { pi, calls } = makeMockPi();
	ollamaExtension(pi);
	const handlers = calls.onHandlers.get("session_start") ?? [];

	const stderrChunks: string[] = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = ((chunk: Uint8Array | string) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	}) as typeof process.stderr.write;
	try {
		await handlers[0]({}, { hasUI: false, ui: undefined });
	} finally {
		process.stderr.write = originalWrite;
	}

	// Scope the assertion to cost notices — unrelated stderr output from
	// the extension is not this test's subject.
	const costNotices = stderrChunks.filter((c) => c.includes("[ollama]"));
	assert.equal(
		costNotices.length,
		0,
		`cost notices without a usable ollama catalog are noise — got: ${costNotices.join("")}`,
	);
});

test("unpriced-model notice is order-stable and never repeats an already-reported model", async () => {
	const capture = async (catalog: string[]) => {
		tagCatalog = catalog;
		const { pi, calls } = makeMockPi();
		ollamaExtension(pi);
		const handlers = calls.onHandlers.get("session_start") ?? [];
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: Uint8Array | string) => {
			stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await handlers[0]({}, { hasUI: false, ui: undefined });
		} finally {
			process.stderr.write = originalWrite;
		}
		return stderrChunks.join("");
	};

	// First probe: two unpriced models.
	let stderr = await capture(["order-z:cloud", "order-a:cloud"]);
	assert.ok(stderr.includes("order-a:cloud") && stderr.includes("order-z:cloud"), `first notice must name both, sorted — got: ${stderr}`);
	assert.equal(stderr.includes("order-"), true);

	// Same models, opposite order: nothing new to report, no second notice.
	stderr = await capture(["order-a:cloud", "order-z:cloud"]);
	assert.equal(
		stderr.includes("no price entry"),
		false,
		`re-probing the same unpriced models in a different order must not re-notice — got: ${stderr}`,
	);

	// A superset adds exactly the new model, not the already-reported ones.
	stderr = await capture(["order-z:cloud", "order-new:cloud", "order-a:cloud"]);
	assert.ok(stderr.includes("order-new:cloud"), `the new model must be named — got: ${stderr}`);
	assert.equal(
		stderr.includes("order-a:cloud"),
		false,
		`already-reported models must not repeat in the superset notice — got: ${stderr}`,
	);
});

test("a throwing notify never clobbers the ollama status set by a successful registration", async () => {
	tagCatalog = ["glm-5.3-flash:cloud", "notice-throw-fixture:cloud"];

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
			notify: () => {
				throw new Error("notify exploded");
			},
		},
	};

	await handlers[0]({}, ctx);
	for (let i = 0; i < 50; i++) {
		if (statusCalls.length > 0) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	// Give the failing notice chain time to (wrongly) run the catch branch.
	await new Promise((r) => setTimeout(r, 200));
	const last = statusCalls[statusCalls.length - 1];
	assert.deepEqual(
		last,
		["ollama", "Ollama"],
		"a display-layer throw must not make a successful registration look unavailable",
	);
});
