// ask-user-questions-forwarding — child-side question channel forwarding (#2713)
//
// A headless subagent child must forward ask_user_questions to its interactive
// parent through the question channel instead of answering remote-only or
// erroring with "UI not available". These tests drive forwardViaQuestionChannel
// against a real temporary channel directory.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	readQuestionRequest,
	writeQuestionAnswer,
} from "../../shared/question-channel.ts";
import { forwardViaQuestionChannel } from "../../ask-user-questions.ts";

function makeChannel(): string {
	return mkdtempSync(join(tmpdir(), "gsd-ask-forwarding-test-"));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch { /* ignore */ }
}

function listRequestFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".request.json"));
}

async function waitForRequestFile(dir: string): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const entries = listRequestFiles(dir);
		if (entries.length > 0) return join(dir, entries[0]!);
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("child never wrote a request file");
}

const QUESTIONS = [
	{
		id: "scope",
		header: "Scope",
		question: "Concise or detailed output?",
		options: [{ label: "Concise", description: "Short answer" }, { label: "Detailed", description: "Long answer" }],
	},
];

test("forwardViaQuestionChannel returns null when no channel directory exists", async () => {
	assert.equal(
		await forwardViaQuestionChannel(join(tmpdir(), "gsd-missing-channel-zz"), QUESTIONS, undefined, { pollMs: 5 }),
		null,
	);
});

test("forwardViaQuestionChannel writes a request and resolves with the parent answer", async () => {
	const dir = makeChannel();
	try {
		const pending = forwardViaQuestionChannel(dir, QUESTIONS, undefined, { pollMs: 5 });

		const requestPath = await waitForRequestFile(dir);
		const request = readQuestionRequest(requestPath);
		assert.ok(request, "request file must be a readable question request");
		assert.deepEqual(request.questions, QUESTIONS);

		writeQuestionAnswer(dir, {
			id: request.id,
			content: JSON.stringify({ answers: { scope: { answers: ["Concise"] } } }),
		});

		const result = await pending;
		assert.ok(result, "a live channel must produce a result");
		assert.equal(result.details.cancelled, false);
		assert.ok(result.content[0]?.text.includes("Concise"));
		assert.equal(result.details.response?.answers["scope"]?.selected, "Concise");
	} finally {
		cleanup(dir);
	}
});

test("forwardViaQuestionChannel returns a cancelled result when the parent cancels", async () => {
	const dir = makeChannel();
	try {
		const pending = forwardViaQuestionChannel(dir, QUESTIONS, undefined, { pollMs: 5 });
		const request = readQuestionRequest(await waitForRequestFile(dir));
		assert.ok(request);
		writeQuestionAnswer(dir, { id: request.id, cancelled: true, reason: "no routing available" });
		const result = await pending;
		assert.ok(result);
		assert.equal(result.details.cancelled, true);
		assert.match(result.content[0]?.text ?? "", /cancelled by the parent/);
		assert.match(result.content[0]?.text ?? "", /no routing available/);
	} finally {
		cleanup(dir);
	}
});

test("forwardViaQuestionChannel returns interrupted result and removes the request on abort", async () => {
	const dir = makeChannel();
	const controller = new AbortController();
	const pending = forwardViaQuestionChannel(dir, QUESTIONS, controller.signal, { pollMs: 5 });
	const requestPath = await waitForRequestFile(dir);
	controller.abort();
	const result = await pending;
	assert.ok(result);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.interrupted, true);
	assert.equal(existsSync(requestPath), false, "aborted child must remove its pending request");
	cleanup(dir);
});

test("forwardViaQuestionChannel returns null when the parent dies (channel removed)", async () => {
	const dir = makeChannel();
	const pending = forwardViaQuestionChannel(dir, QUESTIONS, undefined, { pollMs: 5 });
	await waitForRequestFile(dir);
	rmSync(dir, { recursive: true, force: true });
	assert.equal(await pending, null, "a dead channel must fall back to headless behavior");
	cleanup(dir);
});
