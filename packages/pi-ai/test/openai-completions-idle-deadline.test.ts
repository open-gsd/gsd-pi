import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/stream.ts";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, resolveStreamIdleTimeoutMs } from "../src/utils/idle-deadline.ts";
import type { Model } from "../src/types.ts";

// Idle-chunk stall deadline (#2644): a stream body that goes silent must be
// converted into a classified retryable provider error (stopReason "error"),
// never a user abort, and never an indefinite hang.

const mockState = vi.hoisted(() => ({
	createImpl: null as null | ((params: unknown, requestOptions: { signal?: AbortSignal }) => Promise<unknown>),
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, requestOptions: { signal?: AbortSignal }) =>
					mockState.createImpl!(params, requestOptions),
			},
		};
	}
	return { default: FakeOpenAI };
});

function completionsModel(): Model<"openai-completions"> {
	return {
		id: "test/stalled",
		name: "Test Stalled",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

const CONTENT_CHUNK = {
	id: "chatcmpl-1",
	model: "test/stalled",
	choices: [{ index: 0, delta: { content: "hi" } }],
};

const STOP_CHUNK = {
	id: "chatcmpl-1",
	model: "test/stalled",
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A stream that yields `chunks` then hangs forever, rejecting its pending
 * read when the captured request signal aborts — what an aborted fetch body
 * does.
 */
function installHangAfterChunks(onRequestSignal: (signal: AbortSignal | undefined) => void) {
	mockState.createImpl = (_params, requestOptions) => {
		onRequestSignal(requestOptions?.signal);
		const hang = new Promise<never>((_, reject) => {
			const signal = requestOptions?.signal;
			if (signal?.aborted) {
				reject(new Error("Request was aborted"));
				return;
			}
			signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), { once: true });
		});
		const streamBody = {
			async *[Symbol.asyncIterator]() {
				yield CONTENT_CHUNK;
				await hang;
			},
		};
		const promise = Promise.resolve(streamBody) as Promise<typeof streamBody> & {
			withResponse: () => Promise<{ data: typeof streamBody; response: { status: number; headers: Headers } }>;
		};
		promise.withResponse = async () => ({ data: streamBody, response: { status: 200, headers: new Headers() } });
		return promise;
	};
}

describe("openai-completions idle-chunk deadline (#2644)", () => {
	const savedEnv = process.env.GSD_STREAM_IDLE_TIMEOUT_MS;

	beforeEach(() => {
		mockState.createImpl = null;
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.GSD_STREAM_IDLE_TIMEOUT_MS;
		else process.env.GSD_STREAM_IDLE_TIMEOUT_MS = savedEnv;
	});

	it("converts a stalled stream into a retryable provider error, aborting the request", async () => {
		process.env.GSD_STREAM_IDLE_TIMEOUT_MS = "60";
		let requestSignal: AbortSignal | undefined;
		installHangAfterChunks((signal) => {
			requestSignal = signal;
		});

		const response = stream(
			completionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		const message = await response.result();

		// Classified as a provider error — NOT a user abort — so the existing
		// recovery ladder can retry it.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/no stream data received for 0s/);
		expect(message.errorMessage).toMatch(/GSD_STREAM_IDLE_TIMEOUT_MS/);
		// The stall actually aborted the request (internal controller), while
		// the caller's signal was never touched.
		expect(requestSignal?.aborted).toBe(true);
	}, 5_000);

	it("never misclassifies a user abort while the deadline is armed", async () => {
		process.env.GSD_STREAM_IDLE_TIMEOUT_MS = "60000";
		installHangAfterChunks(() => {});
		const controller = new AbortController();

		const response = stream(
			completionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", signal: controller.signal },
		);
		const resultPromise = response.result();
		await sleep(10);
		controller.abort();
		const message = await resultPromise;

		expect(message.stopReason).toBe("aborted");
	}, 5_000);

	it("resets the deadline on every chunk, so bursty streams complete normally", async () => {
		process.env.GSD_STREAM_IDLE_TIMEOUT_MS = "200";
		mockState.createImpl = () => {
			const streamBody = {
				async *[Symbol.asyncIterator]() {
					for (let i = 0; i < 5; i++) {
						await sleep(60);
						yield CONTENT_CHUNK;
					}
					yield STOP_CHUNK;
				},
			};
			const promise = Promise.resolve(streamBody) as Promise<typeof streamBody> & {
				withResponse: () => Promise<{ data: typeof streamBody; response: { status: number; headers: Headers } }>;
			};
			promise.withResponse = async () => ({ data: streamBody, response: { status: 200, headers: new Headers() } });
			return promise;
		};

		const response = stream(
			completionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		const message = await response.result();

		expect(message.stopReason).toBe("stop");
		expect(message.content.some((c) => c.type === "text" && c.text.includes("hi"))).toBe(true);
	}, 5_000);

	it("deadline disabled (0) passes the caller's signal straight through", async () => {
		process.env.GSD_STREAM_IDLE_TIMEOUT_MS = "0";
		let requestSignal: AbortSignal | undefined;
		installHangAfterChunks((signal) => {
			requestSignal = signal;
		});
		const controller = new AbortController();

		const response = stream(
			completionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", signal: controller.signal },
		);
		const resultPromise = response.result();
		await sleep(10);
		controller.abort();
		const message = await resultPromise;

		// Off-mode is byte-identical to the pre-#2644 wiring: the user's own
		// signal is the request signal, and abort semantics are unchanged.
		expect(requestSignal).toBe(controller.signal);
		expect(message.stopReason).toBe("aborted");
	}, 5_000);
});

describe("resolveStreamIdleTimeoutMs", () => {
	const savedEnv = process.env.GSD_STREAM_IDLE_TIMEOUT_MS;

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.GSD_STREAM_IDLE_TIMEOUT_MS;
		else process.env.GSD_STREAM_IDLE_TIMEOUT_MS = savedEnv;
	});

	it("defaults to 10 minutes when unset, empty, or invalid", () => {
		expect(resolveStreamIdleTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		expect(resolveStreamIdleTimeoutMs({ GSD_STREAM_IDLE_TIMEOUT_MS: "" } as NodeJS.ProcessEnv)).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		);
		expect(resolveStreamIdleTimeoutMs({ GSD_STREAM_IDLE_TIMEOUT_MS: "not-a-number" } as NodeJS.ProcessEnv)).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		);
		expect(resolveStreamIdleTimeoutMs({ GSD_STREAM_IDLE_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv)).toBe(
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		);
	});

	it("honours an explicit value including 0 = disabled", () => {
		expect(resolveStreamIdleTimeoutMs({ GSD_STREAM_IDLE_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
		expect(resolveStreamIdleTimeoutMs({ GSD_STREAM_IDLE_TIMEOUT_MS: "45000" } as NodeJS.ProcessEnv)).toBe(45_000);
	});
});
