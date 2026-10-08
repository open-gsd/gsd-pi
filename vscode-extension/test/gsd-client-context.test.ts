import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, deferred } from "./copilot-test-harness.ts";
import { progressFixture, PRIVATE_SENTINEL } from "./project-context-fixtures.ts";

for (const command of ["switch", "new", "fork"] as const) {
	for (const outcome of ["success", "cancelled", "failure", "malformed"] as const) {
		test(`client ${command}: ${outcome} invalidates reads and conservatively tracks trust`, async (t) => {
			const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
			assert.equal(c.isProjectContextTrusted, true);
			const generation = c.projectContextGeneration;
			const read = c.getProjectProgress(); const readCommand = h.processes[0].lastCommand();
			const rejection = assert.rejects(read, /GSD.*(context|restart|retry)/i);
			const mutation = command === "switch" ? c.switchSession("/session") : command === "new" ? c.newSession() : c.forkSession("entry");
			assert.ok(c.projectContextGeneration > generation); assert.equal(c.isProjectContextTrusted, false);
			const mutationCommand = h.processes[0].lastCommand();
			h.processes[0].respond(readCommand, progressFixture());
			if (outcome === "failure") {
				const failure = assert.rejects(mutation);
				h.processes[0].respond(mutationCommand, undefined, { success: false, error: PRIVATE_SENTINEL }); await failure;
			} else {
				h.processes[0].respond(mutationCommand, outcome === "malformed" ? {} : { cancelled: outcome === "cancelled", text: "" }); await mutation;
			}
			await rejection;
			assert.equal(c.isProjectContextTrusted, outcome === "cancelled");
		});
	}
}

test("client: new/fork/cancelled switch never upgrade an untrusted context", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const switcher = c.switchSession("/session"); h.processes[0].respond(h.processes[0].lastCommand(), { cancelled: false }); await switcher;
	for (const mutation of [() => c.newSession(), () => c.forkSession("entry"), () => c.switchSession("/other")]) {
		const pending = mutation(); h.processes[0].respond(h.processes[0].lastCommand(), { cancelled: true, text: "" }); await pending;
		assert.equal(c.isProjectContextTrusted, false);
	}
});

test("client: overlapping mutations cannot restore prior trust", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const a = c.switchSession("/a"); const ca = h.processes[0].lastCommand();
	const b = c.newSession(); const cb = h.processes[0].lastCommand();
	h.processes[0].respond(cb, { cancelled: true }); await b;
	h.processes[0].respond(ca, { cancelled: true }); await a;
	assert.equal(c.isProjectContextTrusted, false);
});

test("client: stop/start fences late responses, events, errors and exits", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const old = h.processes[0]; const generation = c.projectContextGeneration;
	const pending = c.getProjectProgress(); const staleRead = old.lastCommand(); const rejected = assert.rejects(pending);
	await c.stop(); await rejected; await c.start();
	assert.ok(c.projectContextGeneration > generation); assert.equal(c.isProjectContextTrusted, true);
	const events: unknown[] = []; const errors: unknown[] = []; const connections: unknown[] = [];
	c.onEvent((x: unknown) => events.push(x)); c.onError((x: unknown) => errors.push(x)); c.onConnectionChange((x: unknown) => connections.push(x));
	const read = c.getProjectProgress(); const current = h.processes[1].lastCommand();
	old.respond(staleRead, progressFixture()); old.stderr.emit("data", Buffer.from(PRIVATE_SENTINEL));
	old.emit("error", new Error(PRIVATE_SENTINEL)); old.exit(1, "SIGTERM");
	h.processes[1].respond(current, progressFixture());
	assert.equal((await read).phase, "executing");
	assert.deepEqual(events, []); assert.deepEqual(errors, []); assert.deepEqual(connections, []);
	assert.equal(c.isConnected, true); assert.equal(c.isProjectContextTrusted, true);
});

test("client: late UI answers cannot be written to replacement process or session", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const answer = deferred<unknown>(); h.vscode.window.showQuickPick = () => answer.promise;
	h.processes[0].stdout.emit("data", Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "old-ui", method: "select", options: ["private"] }) + "\n"));
	await c.stop(); await c.start(); answer.resolve(PRIVATE_SENTINEL);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(h.processes[1].commands.length, 0);
});

test("client: old mutation completion cannot change replacement process trust", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const mutation = c.switchSession("/session"); const rejection = assert.rejects(mutation);
	await c.stop(); await c.start(); await rejection;
	assert.equal(c.isProjectContextTrusted, true);
});

test("client: malformed JSON values on stdout are ignored without breaking pending reads", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const read = c.getProjectProgress();
	h.processes[0].stdout.emit("data", Buffer.from("null\n[]\n17\n"));
	h.processes[0].respond(h.processes[0].lastCommand(), progressFixture());
	assert.equal((await read).phase, "executing");
});


test("client: late UI answers are fenced by session mutation even on the same process", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const answer = deferred<unknown>(); h.vscode.window.showInputBox = () => answer.promise;
	const proc = h.processes[0];
	proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "old-ui", method: "input" }) + "\n"));
	const mutation = c.newSession(); proc.respond(proc.lastCommand(), { cancelled: true }); await mutation;
	const count = proc.commands.length; answer.resolve(PRIVATE_SENTINEL);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(proc.commands.length, count);
});

test("client: mutation crossing startup cannot upgrade trust when spawn completes", async (t) => {
	const h = createHarness(); const c = h.client;
	const starting = c.start(); t.after(() => c.stop());
	const mutation = c.newSession(); const proc = h.processes[0];
	proc.respond(proc.lastCommand(), { cancelled: true });
	await starting; await mutation;
	assert.equal(c.isConnected, true); assert.equal(c.isProjectContextTrusted, false);
});

test("client: old stop completion cannot reject replacement process requests", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const stopping = c.stop(); await c.start();
	const read = c.getProjectProgress(); const proc = h.processes.at(-1)!;
	await stopping; proc.respond(proc.lastCommand(), progressFixture());
	assert.equal((await read).phase, "executing"); assert.equal(c.isProjectContextTrusted, true);
});

test("client: runtime errors invalidate trust and reject pending reads without exposing text", async (t) => {
	const h = createHarness(); const c = h.client; await c.start(); t.after(() => c.stop());
	const read = c.getProjectProgress(); const rejection = assert.rejects(read, (error: any) => {
		assert.equal(error.message.includes(PRIVATE_SENTINEL), false); return true;
	});
	h.processes[0].emit("error", new Error(PRIVATE_SENTINEL)); await rejection;
	assert.equal(c.isProjectContextTrusted, false); assert.equal(c.isConnected, false);
});
