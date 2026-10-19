// question-channel — file protocol between headless subagent child and parent
//
// Regression coverage for #2713: requests are written atomically, answers are
// correlated by id, and waits terminate on answer, channel removal, or abort.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	listPendingRequests,
	questionChannelAnswerPath,
	questionChannelRequestPath,
	readQuestionAnswer,
	readQuestionRequest,
	waitForQuestionAnswer,
	writeQuestionAnswer,
	writeQuestionRequest,
} from "../question-channel.ts";

function makeChannel(): string {
	return mkdtempSync(join(tmpdir(), "gsd-question-channel-test-"));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch { /* ignore */ }
}

const QUESTIONS = [
	{
		id: "scope",
		header: "Scope",
		question: "Concise or detailed output?",
		options: [{ label: "Concise", description: "Short answer" }, { label: "Detailed", description: "Long answer" }],
	},
];

test("writeQuestionRequest roundtrips through readQuestionRequest", () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		assert.ok(request.id.length > 0);
		assert.ok(existsSync(questionChannelRequestPath(dir, request.id)));

		const parsed = readQuestionRequest(questionChannelRequestPath(dir, request.id));
		assert.ok(parsed);
		assert.equal(parsed.id, request.id);
		assert.deepEqual(parsed.questions, QUESTIONS);
	} finally {
		cleanup(dir);
	}
});

test("readQuestionRequest returns null for malformed files", () => {
	const dir = makeChannel();
	try {
		const badPath = questionChannelRequestPath(dir, "not-json");
		writeFileSync(badPath, "{not json");
		assert.equal(readQuestionRequest(badPath), null);
		assert.equal(readQuestionRequest(questionChannelRequestPath(dir, "missing")), null);
	} finally {
		cleanup(dir);
	}
});

test("writeQuestionAnswer + readQuestionAnswer roundtrip with content", () => {
	const dir = makeChannel();
	try {
		const answer = { id: "req-1", content: JSON.stringify({ answers: { scope: { answers: ["Concise"] } } }) };
		writeQuestionAnswer(dir, answer);
		const parsed = readQuestionAnswer(dir, "req-1");
		assert.ok(parsed);
		assert.equal(parsed.id, "req-1");
		assert.equal(parsed.cancelled, undefined);
		assert.ok(parsed.content?.includes("Concise"));
	} finally {
		cleanup(dir);
	}
});

test("waitForQuestionAnswer resolves with the correlated answer", async () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		const pending = waitForQuestionAnswer(dir, request.id, { pollMs: 10 });
		// Answer slightly later, simulating the parent's routing delay.
		setTimeout(() => {
			writeQuestionAnswer(dir, { id: request.id, cancelled: true, reason: "test" });
		}, 30);
		const answer = await pending;
		assert.ok(answer);
		assert.equal(answer.cancelled, true);
		assert.equal(answer.reason, "test");
	} finally {
		cleanup(dir);
	}
});

test("waitForQuestionAnswer returns null when the channel directory disappears", async () => {
	const dir = makeChannel();
	try {
		const request = writeQuestionRequest(dir, QUESTIONS);
		const pending = waitForQuestionAnswer(dir, request.id, { pollMs: 10 });
		setTimeout(() => rmSync(dir, { recursive: true, force: true }), 30);
		const answer = await pending;
		assert.equal(answer, null);
	} finally {
		cleanup(dir);
	}
});

test("waitForQuestionAnswer returns null when aborted", async () => {
	const dir = makeChannel();
	const request = writeQuestionRequest(dir, QUESTIONS);
	const controller = new AbortController();
	const pending = waitForQuestionAnswer(dir, request.id, { pollMs: 10, signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	assert.equal(await pending, null);
	cleanup(dir);
});

test("listPendingRequests skips handled and malformed entries", () => {
	const dir = makeChannel();
	try {
		const first = writeQuestionRequest(dir, QUESTIONS);
		const second = writeQuestionRequest(dir, QUESTIONS);
		writeFileSync(questionChannelRequestPath(dir, "garbage"), "nope");

		const handled = new Set<string>([first.id]);
		const pending = listPendingRequests(dir, handled);
		assert.deepEqual(pending.map((r) => r.id), [second.id]);

		// A second scan with both handled returns nothing (no double-dispatch).
		handled.add(second.id);
		assert.deepEqual(listPendingRequests(dir, handled), []);
		assert.equal(readQuestionAnswer(dir, second.id), null);
		assert.ok(existsSync(questionChannelAnswerPath(dir, second.id)) === false);
	} finally {
		cleanup(dir);
	}
});
