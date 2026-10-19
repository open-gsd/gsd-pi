// gsd-pi — fake LLM provider: abort handling.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FAKE_MODEL } from "../models/fake-model.js";
import type { Context } from "../types.js";
import { createFakeProvider } from "./fake.js";

const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function providerFor(t: { after: (fn: () => void) => void }, turns: unknown[]) {
	const dir = mkdtempSync(join(tmpdir(), "gsd-fake-llm-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const transcriptPath = join(dir, "transcript.jsonl");
	writeFileSync(transcriptPath, turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n");
	return createFakeProvider({ transcriptPath });
}

test("fake provider: a request on an aborted signal ends aborted and consumes no turn", async (t) => {
	const provider = providerFor(t, [{ turn: 1, emit: { kind: "text", text: "first answer" } }]);
	const controller = new AbortController();
	controller.abort();

	const aborted = await provider.stream(FAKE_MODEL, CONTEXT, { signal: controller.signal }).result();

	assert.equal(aborted.stopReason, "aborted");
	assert.equal(aborted.errorMessage, "Request was aborted");

	// The scripted turn is still there for the next request.
	const next = await provider.stream(FAKE_MODEL, CONTEXT).result();
	assert.equal(next.stopReason, "stop");
	assert.deepEqual(next.content, [{ type: "text", text: "first answer" }]);
});

test("fake provider: aborting a hanging request ends it as aborted without waiting out the delay", async (t) => {
	const provider = providerFor(t, [{ turn: 1, emit: { kind: "timeout", delayMs: 60_000 } }]);
	const controller = new AbortController();

	const pending = provider.stream(FAKE_MODEL, CONTEXT, { signal: controller.signal }).result();
	setTimeout(() => controller.abort(), 20);
	const startedAt = Date.now();
	const message = await pending;

	assert.equal(message.stopReason, "aborted");
	assert.ok(Date.now() - startedAt < 5_000, "the abort must end the request, not the 60 s delay");
});
