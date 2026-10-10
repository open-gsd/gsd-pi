import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, makeToken } from "./copilot-test-harness.ts";
import { progressFixture, snapshotFixture, invalidProgressFixtures, invalidSnapshotFixtures, blockerFixture, PRIVATE_SENTINEL } from "./project-context-fixtures.ts";

async function rejectWithoutChat(promise: Promise<unknown>, h: ReturnType<typeof createHarness>) {
	await assert.rejects(promise, (error: any) => {
		assert.equal(String(error.message).includes(PRIVATE_SENTINEL), false);
		assert.match(error.message, /GSD|workspace/);
		return true;
	});
	assert.deepEqual(h.textParts, []);
	assert.deepEqual(h.results, []);
}

for (const kind of ["progress", "snapshot"] as const) {
	const fixture = kind === "progress" ? progressFixture : snapshotFixture;
	const invalid = kind === "progress" ? invalidProgressFixtures : invalidSnapshotFixtures;
	function tool(h: ReturnType<typeof createHarness>) { return new (kind === "progress" ? h.ProjectProgressTool : h.ProjectSnapshotTool)(h.client); }

	test(`${kind}: accepted payload is serialized unchanged`, async (t) => {
		const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
		const payload = fixture();
		const invocation = tool(h).invoke({ input: {} }, makeToken());
		h.processes[0].respond(h.processes[0].lastCommand(), payload);
		await invocation;
		assert.equal(h.textParts.length, 1); assert.equal(h.results.length, 1);
		assert.equal(h.textParts[0], JSON.stringify(payload, null, 2));
	});

	test(`${kind}: full optional native payload preserves output`, async (t) => {
		const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
		const payload: any = fixture();
		if (kind === "progress") {
			payload.blockerRows = [blockerFixture]; payload.requirements = { active: 0, validated: 0, deferred: 0, outOfScope: 0 };
			payload.milestoneDetails = [{ id: "M1", title: "Milestone", status: "active", truncated: true, slices: [{ id: "S1", title: "Slice", status: "pending", truncated: false, tasks: [] }] }];
			payload.milestoneDetailsTruncated = false; payload.milestoneDetailsTasksTruncated = true;
		} else {
			payload.lifecycleStatusVersion = 1; payload.milestones.items[0].lifecycleStatus = "ready";
			payload.blockers = [blockerFixture]; payload.blockersTruncated = false; payload.openQuestionsTruncated = true;
			payload.openQuestions = [{ questionId: "Q1", questionText: "Resolve", createdAt: "now" }];
		}
		const invocation = tool(h).invoke({ input: undefined }, makeToken());
		h.processes[0].respond(h.processes[0].lastCommand(), payload); await invocation;
		assert.equal(h.textParts[0], JSON.stringify(payload, null, 2));
	});

	for (const input of [null, [], { projectPath: PRIVATE_SENTINEL }]) {
		test(`${kind}: rejects input parameters without RPC or private error text`, async (t) => {
			const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
			await rejectWithoutChat(tool(h).invoke({ input }, makeToken()), h);
			assert.equal(h.processes[0].commands.length, 0);
		});
	}

	test(`${kind}: disconnected context rejects before RPC`, async () => {
		const h = createHarness(); await rejectWithoutChat(tool(h).invoke({ input: {} }, makeToken()), h);
		assert.equal(h.processes.length, 0);
	});

	for (const [name, payload] of invalid()) {
		test(`${kind}: rejects ${name} before any chat construction`, async (t) => {
			const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
			const invocation = tool(h).invoke({ input: {} }, makeToken());
			h.processes[0].respond(h.processes[0].lastCommand(), payload);
			await rejectWithoutChat(invocation, h);
		});
	}

	for (const extra of [
		{ success: false, error: PRIVATE_SENTINEL }, { success: "true", error: PRIVATE_SENTINEL },
		{ command: "get_messages" }, { success: true, error: PRIVATE_SENTINEL },
		{ success: undefined }, { command: undefined }, { success: true, isError: true },
	]) {
		test(`${kind}: rejects incompatible RPC envelope ${JSON.stringify(extra)}`, async (t) => {
			const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
			const invocation = tool(h).invoke({ input: {} }, makeToken());
			h.processes[0].respond(h.processes[0].lastCommand(), fixture(), extra);
			await rejectWithoutChat(invocation, h);
		});
	}

	for (const roots of [[], ["/other"], ["/project", "/other"]]) {
		test(`${kind}: disallowed root sends no RPC`, async (t) => {
			const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
			h.vscode.workspace.workspaceFolders = roots.map(fsPath => ({ uri: { fsPath } }));
			await rejectWithoutChat(tool(h).invoke({ input: {} }, makeToken()), h);
			assert.equal(h.processes[0].commands.length, 0);
		});
	}

	test(`${kind}: already cancelled sends no RPC`, async (t) => {
		const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
		const token = makeToken(); token.cancel();
		await rejectWithoutChat(tool(h).invoke({ input: {} }, token), h);
		assert.equal(h.processes[0].commands.length, 0);
	});

	for (const change of ["root", "multi-root", "cancel", "disconnect", "restart", "switch", "new", "fork"] as const) {
		test(`${kind}: post-await ${change} fence prevents chat`, async (t) => {
			const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
			const token = makeToken(); const proc = h.processes[0];
			const invocation = tool(h).invoke({ input: {} }, token);
			const rejection = rejectWithoutChat(invocation, h);
			proc.respond(proc.lastCommand(), fixture());
			if (change === "root") h.vscode.workspace.workspaceFolders[0].uri.fsPath = "/other";
			if (change === "multi-root") h.vscode.workspace.workspaceFolders.push({ uri: { fsPath: "/other" } });
			if (change === "cancel") token.cancel();
			if (change === "disconnect" || change === "restart") { await h.client.stop(); if (change === "restart") await h.client.start(); }
			if (change === "switch" || change === "new" || change === "fork") {
				const mutation = change === "switch" ? h.client.switchSession("/arbitrary/session") : change === "new" ? h.client.newSession() : h.client.forkSession("entry");
				proc.respond(proc.lastCommand(), { cancelled: true, text: "" }); await mutation;
			}
			await rejection;
		});
	}

	test(`${kind}: successful switch blocks native reads until restart`, async (t) => {
		const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
		const switching = h.client.switchSession("/arbitrary/session");
		h.processes[0].respond(h.processes[0].lastCommand(), { cancelled: false }); await switching;
		const invocation = tool(h).invoke({ input: {} }, makeToken());
		// The old implementation sends a read; settle it to prove the privacy regression.
		if (h.processes[0].lastCommand().type !== "switch_session") h.processes[0].respond(h.processes[0].lastCommand(), fixture());
		await rejectWithoutChat(invocation, h);
		await h.client.stop(); await h.client.start();
		const retry = tool(h).invoke({ input: {} }, makeToken());
		h.processes.at(-1)!.respond(h.processes.at(-1)!.lastCommand(), fixture());
		await retry; assert.equal(h.textParts.length, 1);
	});
}
