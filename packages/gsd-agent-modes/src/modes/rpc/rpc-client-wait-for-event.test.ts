/**
 * RpcClient.waitForEvent — bounded wait for an observed event type.
 *
 * Regression background: `gsd headless` must wait for the RPC child's
 * `extensions_ready` event before sending the first command, so that
 * session_start handlers (headless provider registration, e.g. the ollama
 * probe) have finished and auto-mode snapshots a populated model registry.
 * The event can arrive before the waiter attaches, so the client buffers
 * observed event types; the wait must also be bounded so a wedged
 * session_start handler cannot wedge the first command invisibly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcClient } from "./rpc-client.js";

/**
 * Drive the same JSONL path a spawned child's stdout would take.
 * handleLine is private; the test reaches it the way the line reader does.
 */
function feed(client: RpcClient, line: unknown): void {
	(client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(line));
}

test("waitForEvent resolves immediately when the event was already observed", async () => {
	const client = new RpcClient();
	feed(client, { type: "extensions_ready" });

	const seen = await client.waitForEvent("extensions_ready", 1_000);
	assert.equal(seen, true, "an already-arrived event must resolve from the buffer");
});

test("waitForEvent resolves when the event arrives after the wait starts", async () => {
	const client = new RpcClient();
	const seenPromise = client.waitForEvent("extensions_ready", 1_000);

	feed(client, { type: "message_start" });
	let resolved = false;
	seenPromise.then(() => {
		resolved = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(resolved, false, "unrelated events must not resolve the wait");

	feed(client, { type: "extensions_ready" });
	assert.equal(await seenPromise, true, "the matching event must resolve the wait");
});

test("waitForEvent resolves false on timeout and stays resolved", async () => {
	const client = new RpcClient();
	const seen = await client.waitForEvent("extensions_ready", 50);
	assert.equal(seen, false, "a timeout must resolve false, never reject");

	// A late event after the timeout must not resurrect the settled wait.
	feed(client, { type: "extensions_ready" });
	assert.equal(await client.waitForEvent("extensions_ready", 50), true, "later waiters see the buffered event");
});

test("waitForEvent does not mistake a response for an event", async () => {
	const client = new RpcClient();
	feed(client, { type: "response", id: "req_1", success: true, data: {} });

	const seen = await client.waitForEvent("extensions_ready", 50);
	assert.equal(seen, false, "a response line must not be recorded as an event type");
});