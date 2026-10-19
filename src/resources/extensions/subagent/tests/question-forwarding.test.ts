// question-forwarding — parent-side watcher and routing for #2713
//
// A headless child writes a request file into the question channel; the
// watcher routes it and writes the correlated answer file back. These tests
// stub the remote channel and use a UI-less parent context, so routing is
// deterministic without a terminal.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	listPendingRequests,
	questionChannelRequestPath,
	readQuestionAnswer,
	writeQuestionRequest,
} from "../../shared/question-channel.ts";
import type { Question } from "../../shared/tui.ts";
import {
	routeForwardedQuestion,
	startQuestionChannelWatcher,
} from "../question-forwarding.ts";

function makeChannel(): string {
	return mkdtempSync(join(tmpdir(), "gsd-question-forwarding-test-"));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch { /* ignore */ }
}

const QUESTIONS: Question[] = [
	{
		id: "mode",
		header: "Mode",
		question: "Concise or detailed?",
		options: [
			{ label: "Concise", description: "Short" },
			{ label: "Detailed", description: "Long" },
		],
	},
];

test("routeForwardedQuestion cancels explicitly when parent has no UI and no remote", async () => {
	const outcome = await routeForwardedQuestion(QUESTIONS, {
		questionCtx: { hasUI: false },
		remote: { configured: false, tryRemoteQuestions: async () => null },
	});
	assert.equal(outcome.cancelled, true);
	assert.match(outcome.reason ?? "", /no parent UI or remote channel/);
});

test("routeForwardedQuestion returns remote content for a headless parent with remote", async () => {
	const outcome = await routeForwardedQuestion(QUESTIONS, {
		questionCtx: { hasUI: false },
		remote: {
			configured: true,
			tryRemoteQuestions: async () => ({
				content: [{ type: "text" as const, text: JSON.stringify({ answers: { mode: { answers: ["Concise"] } } }) }],
				details: { remote: true, channel: "test" },
			}),
		},
	});
	assert.equal(outcome.cancelled, undefined);
	assert.ok(outcome.content?.includes("Concise"));
});

test("watcher answers a child request through the parent's remote channel", async () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		const watcher = startQuestionChannelWatcher({
			channelDir: dir,
			agentName: "tester",
			questionCtx: { hasUI: false },
			pollMs: 10,
			remote: {
				configured: true,
				tryRemoteQuestions: async () => ({
					content: [{ type: "text" as const, text: JSON.stringify({ answers: { mode: { answers: ["Detailed"] } } }) }],
				}),
			},
		});
		try {
			const answer = await (async () => {
				for (let i = 0; i < 100; i++) {
					const found = readQuestionAnswer(dir, request.id);
					if (found) return found;
					await new Promise((r) => setTimeout(r, 20));
				}
				return null;
			})();
			assert.ok(answer, "watcher must answer the request");
			assert.equal(answer.id, request.id);
			assert.equal(answer.cancelled, undefined);
			assert.ok(answer.content?.includes("Detailed"), "answer content must carry the routed answer text");
		} finally {
			await watcher.stop();
		}
	} finally {
		cleanup(dir);
	}
});

test("watcher answers each request exactly once (no duplicate dispatch)", async () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		let dispatches = 0;
		const watcher = startQuestionChannelWatcher({
			channelDir: dir,
			agentName: "tester",
			questionCtx: { hasUI: false },
			pollMs: 10,
			remote: {
				configured: true,
				tryRemoteQuestions: async () => {
					dispatches++;
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ answers: { mode: { answers: ["Concise"] } } }) }],
					};
				},
			},
		});
		try {
			for (let i = 0; i < 100; i++) {
				if (readQuestionAnswer(dir, request.id)) break;
				await new Promise((r) => setTimeout(r, 20));
			}
			// Keep polling well past the answer to prove no re-dispatch happens.
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(dispatches, 1, `remote dispatch must happen exactly once, saw ${dispatches}`);
			const answerFiles = readdirSync(dir).filter((f) => f.endsWith(".answer.json"));
			assert.equal(answerFiles.length, 1);
		} finally {
			await watcher.stop();
		}
	} finally {
		cleanup(dir);
	}
});

test("watcher queues concurrent requests and answers both with correct correlation", async () => {
	const dir = makeChannel();
	try {
		const first = writeQuestionRequest(dir, [{ ...QUESTIONS[0], id: "q1" }]);
		const second = writeQuestionRequest(dir, [{ ...QUESTIONS[0], id: "q2" }]);
		const watcher = startQuestionChannelWatcher({
			channelDir: dir,
			agentName: "tester",
			questionCtx: { hasUI: false },
			pollMs: 10,
			remote: {
				configured: true,
				tryRemoteQuestions: async (questions) => ({
					content: [{ type: "text" as const, text: JSON.stringify({ answers: { [questions[0]!.id]: { answers: ["answered"] } } }) }],
				}),
			},
		});
		try {
			for (let i = 0; i < 150; i++) {
				if (readQuestionAnswer(dir, first.id) && readQuestionAnswer(dir, second.id)) break;
				await new Promise((r) => setTimeout(r, 20));
			}
			const a1 = readQuestionAnswer(dir, first.id);
			const a2 = readQuestionAnswer(dir, second.id);
			assert.ok(a1, "first request must be answered");
			assert.ok(a2, "second request must be answered");
			assert.ok(a1.content?.includes("q1"), "answers must not cross between requests");
			assert.ok(a2.content?.includes("q2"), "answers must not cross between requests");
		} finally {
			await watcher.stop();
		}
	} finally {
		cleanup(dir);
	}
});

test("stop() aborts in-flight routing and the pending request is answered cancelled", async () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		const watcher = startQuestionChannelWatcher({
			channelDir: dir,
			agentName: "tester",
			questionCtx: { hasUI: false },
			pollMs: 10,
			remote: {
				configured: true,
				tryRemoteQuestions: async (_questions, signal) => {
					// Block until aborted, like a long remote poll.
					await new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return null;
				},
			},
		});
		// Wait until routing actually started (handled set marked, remote called).
		for (let i = 0; i < 100; i++) {
			if (listPendingRequests(dir, new Set()).length === 0) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		await watcher.stop();
		const answer = readQuestionAnswer(dir, request.id);
		assert.ok(answer, "stopping the watcher must still answer the request");
		assert.equal(answer.cancelled, true);
	} finally {
		cleanup(dir);
	}
});

test("watcher skips a request the child removed before its routing turn", async () => {
	const dir = makeChannel();
	try {
		// Two requests; whichever routes first blocks until released. The test
		// then removes the OTHER request before its turn — the watcher must
		// skip it instead of routing a request nobody waits on anymore.
		// The question id equals the request id so the stub can report exactly
		// which request it is routing.
		const writeRequestWithId = (id: string) => {
			writeFileSync(
				questionChannelRequestPath(dir, id),
				JSON.stringify({ id, questions: [{ ...QUESTIONS[0], id }], createdAt: new Date().toISOString() }),
			);
			return id;
		};
		let dispatches = 0;
		let releaseRouting: () => void = () => {};
		const routingBlocked = new Promise<void>((resolve) => {
			releaseRouting = resolve;
		});
		let unblockRouting: () => void = () => {};
		const routingDone = new Promise<void>((resolve) => {
			unblockRouting = resolve;
		});
		let resolveFirstRouted: (id: string) => void = () => {};
		const firstRouted = new Promise<string>((resolve) => {
			resolveFirstRouted = resolve;
		});

		const idA = writeRequestWithId("req-a");
		const idB = writeRequestWithId("req-b");
		const watcher = startQuestionChannelWatcher({
			channelDir: dir,
			agentName: "tester",
			questionCtx: { hasUI: false },
			pollMs: 5,
			remote: {
				configured: true,
				tryRemoteQuestions: async (questions) => {
					dispatches++;
					const id = questions[0]?.id ?? "";
					if (dispatches === 1) {
						resolveFirstRouted(id);
						await routingBlocked;
					}
					return null;
				},
			},
		});
		try {
			const routedId = await firstRouted;
			const otherId = routedId === idA ? idB : idA;
			rmSync(questionChannelRequestPath(dir, otherId));
			releaseRouting();
			unblockRouting();
			await watcher.stop();
			assert.equal(dispatches, 1, "only the live request may be routed; the removed one must be skipped");
			assert.equal(readQuestionAnswer(dir, otherId), null, "a removed request must not be answered");
		} finally {
			releaseRouting();
			unblockRouting();
			await watcher.stop();
		}
	} finally {
		cleanup(dir);
	}
});
