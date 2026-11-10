import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { createDesktopOwnershipManager } from "../../shared/desktop-ownership.ts";
import registerCmuxCua, { act, discoverNativeContract, inspect, type ConnectedCuaSession } from "../index.ts";

// Real required names, NOT invented padding to reach 39. Without a canonical full
// inventory/schema fixture, supported-version acceptance remains explicitly open.
const partialInventory = ["check_permissions", "click", "end_session", "get_window_state", "list_apps", "list_windows", "start_session"].map((name) => ({
	name, description: "Synthetic protocol metadata", inputSchema: { type: "object" as const, properties: {} },
}));
const selectedWindow = { targetId: "synthetic-window", pid: 71001, windowId: 42, appName: "Synthetic App", title: "Synthetic Window" };
const context = { hasUI: false, isLocalInteractiveDesktop: false } as ExtensionContext;
function snapshot(value = "before", overrides: Record<string, unknown> = {}) {
	return {
		pid: selectedWindow.pid, window_id: selectedWindow.windowId, snapshot_id: "synthetic-snapshot",
		tree_markdown: "- [0] AXButton [id=synthetic-control]\n- [1] AXStaticText [id=synthetic-status]\n- [2] AXStaticText [id=synthetic-private]",
		element_count: 3,
		elements: [
			{ element_index: 0, role: "AXButton", label: "Synthetic Go", element_token: "fx-cap" },
			{ element_index: 1, role: "AXStaticText", label: "Synthetic Status", value },
			{ element_index: 2, role: "AXStaticText", label: "Password", value: "synthetic-redacted-value" },
		],
		...overrides,
	};
}
function result(structuredContent: Record<string, unknown>) { return { content: [], structuredContent }; }
function containsExactPid(value: unknown, pid: number): boolean {
	if (value === pid || value === String(pid)) return true;
	if (Array.isArray(value)) return value.some((entry) => containsExactPid(entry, pid));
	if (value !== null && typeof value === "object") return Object.values(value).some((entry) => containsExactPid(entry, pid));
	return false;
}
function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
type FixtureOptions = {
	name?: string;
	version?: string;
	list?: (cursor: string | undefined) => unknown;
	call?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
};
function fixtureTempParent(): string {
	// The real guard rejects symlink/writable ancestors. Canonical macOS temp is
	// suitable; world-writable /tmp is not. Like the guard's own tests, use an
	// owned temporary home child on those platforms, and remove only that child.
	const temporary = realpathSync(tmpdir());
	let current = path.parse(temporary).root;
	for (const component of path.relative(current, temporary).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		if ((lstatSync(current).mode & 0o022) !== 0) return realpathSync(userInfo().homedir);
	}
	return temporary;
}
function supportsGuardFixture(platform: string, hasGetuid: boolean, hasPs: boolean): boolean {
	return (platform === "darwin" || platform === "linux") && hasGetuid && hasPs;
}
const guardSkip = supportsGuardFixture(process.platform, typeof process.getuid === "function", existsSync("/bin/ps"))
	? false : "POSIX desktop ownership guard requires getuid and /bin/ps";
function guardTest(name: string, run: (t: TestContext) => Promise<void>): void {
	test(name, { skip: guardSkip }, run);
}
// Protocol setup initializes no filesystem root, ownership guard or lease.
async function protocolFixture(options: FixtureOptions = {}) {
	const client = new Client({ name: "synthetic-conformance", version: "1.0.0" });
	const server = new Server({ name: options.name ?? "cmux-cua", version: options.version ?? "0.7.1" }, { capabilities: { tools: {} } });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const cursors: Array<string | undefined> = [];
	const binding = { expectedGeneration: "SYNTHETIC-generation-1", peerGeneration: "SYNTHETIC-generation-1", assertions: 0 };
	// Malformed peer replies intentionally remain unknown until this fixture-only
	// SDK boundary. These casts never validate or admit production peer data.
	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		cursors.push(request.params?.cursor);
		return (options.list ? await options.list(request.params?.cursor) : { tools: partialInventory }) as ListToolsResult;
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const args = request.params.arguments ?? {};
		calls.push({ name: request.params.name, args });
		if (options.call) return await options.call(request.params.name, args) as CallToolResult;
		if (request.params.name === "get_window_state") return result(snapshot(calls.length === 1 ? "before" : "after"));
		if (request.params.name === "click") return result({ path: "ax", verified: false, effect: "unverifiable" });
		throw new Error("unexpected synthetic tool call");
	});
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		return {
			client, server, calls, cursors, binding,
			async close() {
				// Fixture transport cleanup is NEVER proof of OS proxy exit.
				await client.close();
				await server.close();
			},
		};
	} catch (error) {
		await client.close();
		await server.close();
		throw error;
	}
}
// Source inspect/act retains the actual isolated guard on qualified POSIX hosts.
async function fixture(options: FixtureOptions = {}) {
	assert.equal(guardSkip, false, "POSIX desktop ownership guard requires getuid and /bin/ps");
	const protocol = await protocolFixture(options);
	let root: string | undefined;
	try {
		root = mkdtempSync(path.join(fixtureTempParent(), "cmux-cua-conformance-"));
		const manager = createDesktopOwnershipManager(path.join(root, "guard"));
		const lease = manager.acquire("cmux-cua", "session", "SYNTHETIC-connection-1");
		const { client, binding } = protocol;
		const session: ConnectedCuaSession = {
			client, ownershipManager: manager, lease,
			assertPeerBound: () => {
				binding.assertions += 1;
				if (binding.peerGeneration !== binding.expectedGeneration) throw new Error("synthetic peer generation changed");
			},
			target: { ...selectedWindow }, grant: null, axTextSharingApproved: true, hadAction: false,
		};
		const fixtureRoot = root;
		return {
			...protocol, session, manager, root: fixtureRoot,
			async close() {
				await protocol.close();
				rmSync(fixtureRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await protocol.close();
		if (root) rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
	const output = await inspect(f.session, context);
	return {
		output,
		params: { grant_id: output.grant_id, target_id: output.elements[0].target_id, operation: "click", postcondition: { kind: "ax-value-equals", observer_id: output.observers[0].observer_id, expected: "after" } },
	};
}
function assertQuarantined(f: Awaited<ReturnType<typeof fixture>>) {
	assert.throws(() => f.manager.beginOperation(f.session.lease, "inspect"), { code: "quarantined" });
	// A live kernel mutex denies the contender as busy before journal inspection.
	assert.throws(() => createDesktopOwnershipManager(path.join(f.root, "guard")).acquire("mac-tools", "operation"), { code: "busy" });
}

test("PID redaction compares exact scalar values without rejecting opaque UUID substrings", () => {
	const opaqueId = `000${selectedWindow.pid}-0000-4000-8000-000000000000`;
	assert.equal(opaqueId.includes(String(selectedWindow.pid)), true);
	assert.equal(containsExactPid({ grant_id: opaqueId, nested: [{ observer_id: opaqueId }] }, selectedWindow.pid), false);
	assert.equal(containsExactPid({ nested: [{ pid: selectedWindow.pid }] }, selectedWindow.pid), true);
	assert.equal(containsExactPid({ nested: [{ pid: String(selectedWindow.pid) }] }, selectedWindow.pid), true);
});
test("default-off registration touches no API, discovery or desktop path", () => {
	let accesses = 0;
	registerCmuxCua(new Proxy({}, { get() { accesses += 1; throw new Error("default-off touched API"); } }) as ExtensionAPI);
	assert.equal(accesses, 0);
});
test("protocol fixture stays guard-free across the deterministic platform qualification boundary", async (t) => {
	for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
		for (const hasGetuid of [false, true]) for (const hasPs of [false, true]) {
			assert.equal(supportsGuardFixture(platform, hasGetuid, hasPs), (platform === "darwin" || platform === "linux") && hasGetuid && hasPs);
		}
	}
	const f = await protocolFixture();
	t.after(() => f.close());
	assert.deepEqual(Object.keys(f).sort(), ["binding", "calls", "client", "close", "cursors", "server"]);
	await assert.rejects(discoverNativeContract(f.client), /identity\/version/);
	assert.deepEqual(f.calls, []);
});
test("real SDK protocol cancellation remains guard-free and never replays", async (t) => {
	const entered = barrier();
	const finish = barrier();
	const f = await protocolFixture({ call: async () => {
		entered.resolve();
		await finish.promise;
		return result({ synthetic: true });
	} });
	t.after(async () => { finish.resolve(); await f.close(); });
	const controller = new AbortController();
	const pending = f.client.callTool({ name: "get_window_state", arguments: {} }, undefined, { signal: controller.signal, timeout: 5_000 });
	const rejected = assert.rejects(pending);
	await entered.promise;
	controller.abort();
	await rejected;
	finish.resolve();
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].name, "get_window_state");
});
test("real SDK discovery paginates the partial supported-version contract without inventing tools", async (t) => {
	const f = await protocolFixture({ list: (cursor) => cursor ? { tools: partialInventory.slice(3) } : { tools: partialInventory.slice(0, 3), nextCursor: "synthetic-page-2" } });
	t.after(() => f.close());
	assert.deepEqual(f.client.getServerVersion(), { name: "cmux-cua", version: "0.7.1" });
	await assert.rejects(discoverNativeContract(f.client), /identity\/version/);
	assert.deepEqual(f.cursors, [undefined, "synthetic-page-2"]);
	assert.deepEqual(f.calls, []);
});
for (const [label, options, expected] of [
	["wrong version", { version: "0.0.0" }, /identity\/version/],
	["wrong server", { name: "synthetic-other-server" }, /identity\/version/],
	["missing tools", { list: () => ({ tools: [] }) }, /identity\/version/],
	["malformed tools", { list: () => ({ tools: [{ name: "click", inputSchema: "invalid" }] }) }, /invalid|expected|object/i],
	["duplicate real names", { list: () => ({ tools: Array.from({ length: 39 }, () => partialInventory[1]) }) }, /malformed/],
	["repeated cursor", { list: () => ({ tools: [], nextCursor: "same" }) }, /cursor repeated/],
	["pagination limit", { list: (cursor: string | undefined) => ({ tools: [], nextCursor: String(Number(cursor ?? 0) + 1) }) }, /pagination exceeded/],
] as const) {
	test(`real SDK discovery rejects ${label}`, async (t) => {
		const f = await protocolFixture(options);
		t.after(() => f.close());
		await assert.rejects(discoverNativeContract(f.client), expected);
		assert.equal(f.calls.length, 0);
		assert.ok(f.cursors.length <= 8);
	});
}
guardTest("source inspect-click-verify redacts metadata and quarantines even a matching UI", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const { output, params } = await ready(f);
	const originalGrant = f.session.grant!;
	const serialized = JSON.stringify(output);
	for (const forbidden of ["fx-cap", "synthetic-redacted-value", "synthetic-status", "tree_markdown", "snapshot_id", "element_token"]) {
		assert.equal(serialized.includes(forbidden), false, forbidden);
	}
	assert.equal(containsExactPid(output, selectedWindow.pid), false);
	assert.ok(Buffer.byteLength(serialized) <= 32 * 1024);
	assert.deepEqual(await act(f.session, params), { status: "quarantined", ui_postcondition_met: true, backend_quiescence: "unproven", target_id: params.target_id, observer_id: params.postcondition.observer_id });
	const readArgs = { pid: selectedWindow.pid, window_id: selectedWindow.windowId, capture_mode: "ax", include_screenshot: false, max_elements: 200, max_depth: 8 };
	assert.deepEqual(f.calls, [
		{ name: "get_window_state", args: readArgs },
		{ name: "click", args: { pid: selectedWindow.pid, window_id: selectedWindow.windowId, element_token: "fx-cap", action: "press", button: "left", count: 1, delivery_mode: "background" } },
		{ name: "get_window_state", args: readArgs },
	]);
	assert.equal(f.binding.assertions, 5);
	assertQuarantined(f);
	await assert.rejects(inspect(f.session, context), /backend-quiescence/);
	// A candidate fresh grant cannot override dispatched-action quarantine.
	f.session.grant = { ...originalGrant, id: "synthetic-fresh-grant", consumed: false, expiresAt: Date.now() + 10_000 };
	await assert.rejects(act(f.session, { ...params, grant_id: "synthetic-fresh-grant" }), /already dispatched/);
	assert.equal(f.calls.length, 3);
});
for (const mode of ["stale target", "stale observer", "extra action key", "already satisfied"] as const) {
	guardTest(`source action rejects ${mode} before dispatch`, async (t) => {
		const f = await fixture();
		t.after(() => f.close());
		const { params } = await ready(f);
		const invalid = {
			...params,
			...(mode === "stale target" ? { target_id: "old-target" } : {}),
			...(mode === "extra action key" ? { text: "synthetic-disallowed" } : {}),
			postcondition: { ...params.postcondition, ...(mode === "stale observer" ? { observer_id: "old-observer" } : {}), ...(mode === "already satisfied" ? { expected: "before" } : {}) },
		};
		await assert.rejects(act(f.session, invalid), /stale|contract/);
		assert.equal(f.session.grant, null);
		assert.equal(f.calls.length, 1);
	});
}
guardTest("a second real inspection invalidates the previous target/grant", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const first = await ready(f);
	const second = await ready(f);
	assert.notEqual(first.params.grant_id, second.params.grant_id);
	assert.notEqual(first.params.target_id, second.params.target_id);
	await assert.rejects(act(f.session, first.params), /absent or expired/);
	assert.equal(f.calls.length, 2);
});
guardTest("grant expiry uses the actual source deadline and real clock", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const { params } = await ready(f);
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, f.session.grant!.expiresAt - Date.now()) + 20));
	await assert.rejects(act(f.session, params), /absent or expired/);
	assert.equal(f.calls.length, 1);
});
for (const [label, raw] of [
	["MCP image", { content: [{ type: "image", data: "U1lOVEhFVElD", mimeType: "image/png" }], structuredContent: snapshot() }],
	["screenshot metadata", result(snapshot("before", { screenshot_file_path: "synthetic-not-a-file" }))],
	["oversize structured data", result(snapshot("before", { synthetic_padding: "x".repeat(32 * 1024) }))],
	["oversize text", { content: [{ type: "text", text: "x".repeat(32 * 1024 + 1) }], structuredContent: snapshot() }],
	["MCP error", { ...result(snapshot()), isError: true }],
	["wrong window", result(snapshot("before", { window_id: 43 }))],
	["degraded snapshot", result(snapshot("before", { degraded: true }))],
] as const) {
	guardTest(`source native read rejects ${label} without a grant or retry`, async (t) => {
		const f = await fixture({ call: () => raw });
		t.after(() => f.close());
		await assert.rejects(inspect(f.session, context));
		assert.equal(f.session.grant, null);
		assertQuarantined(f);
		await assert.rejects(inspect(f.session, context));
		assert.equal(f.calls.length, 1);
	});
}
guardTest("explicit synthetic binding detects a changed peer before dispatch", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const { params } = await ready(f);
	f.binding.peerGeneration = "SYNTHETIC-generation-2";
	await assert.rejects(act(f.session, params), /synthetic peer generation/);
	assert.equal(f.calls.length, 1);
	assertQuarantined(f);
});
guardTest("missing peer assertion cannot silently create an unbound read", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const { assertPeerBound: _assertPeerBound, ...unbound } = f.session;
	// Deliberately malformed runtime input; the public type also requires binding.
	await assert.rejects(inspect(unbound as ConnectedCuaSession, context), /assertPeerBound/);
	assert.equal(f.calls.length, 0);
	assertQuarantined(f);
});
for (const mode of ["abort", "disconnect", "timeout"] as const) {
	guardTest(`real SDK ${mode} of an ambiguous click never replays or releases`, async (t) => {
		const entered = barrier();
		const finish = barrier();
		const f = await fixture({ call: async (name) => {
			if (name === "get_window_state") return result(snapshot());
			entered.resolve();
			await finish.promise;
			return result({ path: "ax", verified: false, effect: "unverifiable" });
		} });
		t.after(async () => { finish.resolve(); await f.close(); });
		const { params } = await ready(f);
		const controller = new AbortController();
		const pending = act(f.session, params, controller.signal);
		const rejected = mode === "timeout" ? assert.rejects(pending, /timed out/i) : assert.rejects(pending);
		await entered.promise;
		if (mode === "abort") controller.abort();
		if (mode === "disconnect") await f.server.close();
		await rejected; // Actual production 15-second SDK timeout, no test scheduler.
		finish.resolve();
		assert.equal(f.session.hadAction, true);
		assertQuarantined(f);
		await assert.rejects(act(f.session, params), /already dispatched/);
		await assert.rejects(inspect(f.session, context), /backend-quiescence/);
		assert.deepEqual(f.calls.map((call) => call.name), ["get_window_state", "click"]);
	});
}
// Portable source partitions; neither the synthetic peer assertion nor SDK
// callbacks establish native peer identity or exercise the private start queue.
for (const stage of ["application", "window"] as const) {
	for (const outcome of ["cancelled", "unknown option"] as const) {
		guardTest(`source partition selection/${stage}/${outcome} stops before snapshot`, async (t) => {
			const f = await fixture({ call: (name) => {
				if (name === "list_apps") return result({ apps: [{ pid: selectedWindow.pid, running: true, name: selectedWindow.appName, bundle_id: "synthetic.app" }] });
				if (name === "list_windows") return result({ windows: [{ pid: selectedWindow.pid, window_id: selectedWindow.windowId, is_on_screen: true, app_name: selectedWindow.appName, title: selectedWindow.title }] });
				throw new Error("unexpected snapshot after failed selection");
			} });
			t.after(() => f.close());
			f.session.target = null;
			let selections = 0;
			const ctx: ExtensionContext = { ...context, hasUI: true, isLocalInteractiveDesktop: true, ui: { ...context.ui, select: async (_title, options) => {
				selections += 1;
				if (selections === (stage === "application" ? 1 : 2)) return outcome === "cancelled" ? undefined : "not an offered option";
				return options[0];
			} } };
			await assert.rejects(inspect(f.session, ctx), outcome === "cancelled" ? /selection was cancelled/ : /not in the current .* snapshot/);
			assert.deepEqual(f.calls.map((call) => call.name), stage === "application" ? ["list_apps"] : ["list_apps", "list_windows"]);
			assert.equal(selections, stage === "application" ? 1 : 2);
			assert.equal(f.session.target, null);
			assert.equal(f.session.grant, null);
			assert.equal(f.session.hadAction, false);
		});
	}
}
for (const outcome of ["mismatch", "suspected noop", "degraded", "wrong observer role", "duplicate observer"] as const) {
	guardTest(`source partition verification/${outcome} cannot authorize another action`, async (t) => {
		let reads = 0;
		const f = await fixture({ call: (name) => {
			if (name === "click") return result({ path: "ax", verified: false, effect: outcome === "suspected noop" ? "suspected_noop" : "unverifiable" });
			if (name !== "get_window_state") throw new Error("unexpected tool");
			reads += 1;
			if (reads === 1) return result(snapshot());
			const after = snapshot(outcome === "mismatch" ? "different" : "after", outcome === "degraded" ? { degraded: true } : {});
			if (outcome === "wrong observer role") after.elements[1].role = "AXButton";
			if (outcome === "duplicate observer") after.elements.push({ ...after.elements[1] });
			return result(after);
		} });
		t.after(() => f.close());
		const { params } = await ready(f);
		if (outcome === "degraded") await assert.rejects(act(f.session, params), /incomplete or degraded/);
		else {
			const output = await act(f.session, params);
			assert.equal(output.status, "quarantined");
			assert.equal(output.ui_postcondition_met, false);
			assert.equal(output.backend_quiescence, "unproven");
		}
		assert.deepEqual(f.calls.map((call) => call.name), ["get_window_state", "click", "get_window_state"]);
		assertQuarantined(f);
		await assert.rejects(act(f.session, params), /already dispatched/);
		assert.equal(f.calls.length, 3);
	});
}
for (const partition of ["unknown operation", "unknown postcondition", "oversized expected value"] as const) {
	guardTest(`source partition action-validation/${partition} rejects without dispatch`, async (t) => {
		const f = await fixture();
		t.after(() => f.close());
		const { params } = await ready(f);
		if (partition === "unknown operation") params.operation = "unknown-operation";
		if (partition === "unknown postcondition") params.postcondition.kind = "unknown-condition";
		if (partition === "oversized expected value") params.postcondition.expected = "x".repeat(129);
		await assert.rejects(act(f.session, params), /outside the click-only contract|postcondition is malformed/);
		assert.equal(f.calls.length, 1);
		assert.equal(f.binding.assertions, 1);
		assert.equal(f.session.hadAction, false);
		assert.equal(f.session.grant, null);
	});
}
for (const stage of ["inspection", "verification"] as const) {
	guardTest(`source partition cancellation/${stage} uses SDK AbortSignal without replay`, async (t) => {
		const entered = barrier();
		const finish = barrier();
		let reads = 0;
		const f = await fixture({ call: async (name) => {
			if (name === "click") return result({ path: "ax", verified: false, effect: "unverifiable" });
			reads += 1;
			if (reads === (stage === "inspection" ? 1 : 2)) { entered.resolve(); await finish.promise; }
			return result(snapshot(reads === 1 ? "before" : "after"));
		} });
		t.after(async () => { finish.resolve(); await f.close(); });
		const controller = new AbortController();
		const abortReason = new Error(`fixture-${stage}-abort`);
		const params = stage === "verification" ? (await ready(f)).params : undefined;
		const pending = params ? act(f.session, params, controller.signal) : inspect(f.session, context, controller.signal);
		// The SDK may wrap signal.reason; a generic MCP timeout must not pass.
		const rejected = assert.rejects(pending, new RegExp(abortReason.message));
		await entered.promise;
		controller.abort(abortReason);
		await rejected;
		finish.resolve();
		assert.equal(f.session.grant, null);
		assert.equal(f.session.hadAction, stage === "verification");
		assertQuarantined(f);
		await assert.rejects(inspect(f.session, context));
		if (params) await assert.rejects(act(f.session, params), /already dispatched/);
		assert.deepEqual(f.calls.map((call) => call.name), stage === "inspection" ? ["get_window_state"] : ["get_window_state", "click", "get_window_state"]);
	});
}
guardTest("source partition cancellation/pre-aborted-inspection sends no native request", async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(inspect(f.session, context, controller.signal));
	assert.equal(f.calls.length, 0);
	assert.equal(f.session.grant, null);
	assert.equal(f.session.hadAction, false);
	assertQuarantined(f);
});
for (const stage of ["inspection", "verification"] as const) {
	guardTest(`source partition protocol-error/${stage} preserves failure boundary`, async (t) => {
		let reads = 0;
		const f = await fixture({ call: (name) => {
			if (name === "click") return result({ path: "ax", verified: false, effect: "unverifiable" });
			reads += 1;
			if (reads === (stage === "inspection" ? 1 : 2)) throw new Error("synthetic-provider-private-body");
			return result(snapshot());
		} });
		t.after(() => f.close());
		const params = stage === "verification" ? (await ready(f)).params : undefined;
		await assert.rejects(params ? act(f.session, params) : inspect(f.session, context));
		assert.equal(f.session.grant, null);
		assert.equal(f.session.hadAction, stage === "verification");
		assertQuarantined(f);
		await assert.rejects(inspect(f.session, context));
		assert.equal(f.calls.length, stage === "inspection" ? 1 : 3);
		// Exported helpers reject SDK errors; publicError redaction is private.
	});
}
for (const partition of ["wrong elements type", "oversized element count"] as const) {
	guardTest(`source partition response-bounds/${partition} fails closed through SDK`, async (t) => {
		const raw = result(snapshot("before", partition === "wrong elements type" ? { elements: {} } : { element_count: 201 }));
		const f = await fixture({ call: () => raw });
		t.after(() => f.close());
		await assert.rejects(inspect(f.session, context), /incomplete or degraded/);
		assert.equal(f.session.grant, null);
		assert.equal(f.session.hadAction, false);
		assertQuarantined(f);
		await assert.rejects(inspect(f.session, context));
		assert.equal(f.calls.length, 1);
	});
}
guardTest("source partition response-bounds/malformed-click-escalation never reaches verification", async (t) => {
	const f = await fixture({ call: (name) => name === "click" ? result({ path: "ax", verified: false, effect: "unverifiable", escalation: [] }) : result(snapshot()) });
	t.after(() => f.close());
	const { params } = await ready(f);
	await assert.rejects(act(f.session, params), /escalation metadata is malformed/);
	assertQuarantined(f);
	assert.equal(f.session.hadAction, true);
	assert.equal(f.session.grant, null);
	await assert.rejects(act(f.session, params), /already dispatched/);
	assert.deepEqual(f.calls.map((call) => call.name), ["get_window_state", "click"]);
});
guardTest("source partition redaction/raw-snapshot strips provider fields and oversize observer values", async (t) => {
	const state = snapshot("x".repeat(129), { provider_payload: "synthetic-provider-private-body" });
	state.tree_markdown += "\n- [3] AXStaticText [id=synthetic-public]";
	state.elements.push({ element_index: 3, role: "AXStaticText", label: "Public Status", value: "before" });
	state.element_count = state.elements.length;
	const f = await fixture({ call: () => result(state) });
	t.after(() => f.close());
	const output = await inspect(f.session, context);
	assert.doesNotMatch(JSON.stringify(output), /synthetic-provider-private-body|synthetic-redacted-value|fx-cap/);
	assert.ok(!JSON.stringify(output).includes("x".repeat(129)));
	assert.equal(output.observers.length, 1);
	assert.equal(output.observers[0].label, "Public Status");
	assert.equal(containsExactPid(output, selectedWindow.pid), false);
	assert.equal(f.session.hadAction, false);
});
for (const stage of ["pre-aborted", "in-flight"] as const) {
	test(`source partition discovery/cancellation-${stage} uses SDK listTools without a guard`, async (t) => {
		const entered = barrier();
		const finish = barrier();
		const f = await protocolFixture({ list: async () => { entered.resolve(); await finish.promise; return { tools: partialInventory }; } });
		t.after(async () => { finish.resolve(); await f.close(); });
		const controller = new AbortController();
		const abortReason = new Error(`fixture-discovery-${stage}-abort`);
		if (stage === "pre-aborted") controller.abort(abortReason);
		const pending = discoverNativeContract(f.client, controller.signal);
		const rejected = assert.rejects(pending, new RegExp(abortReason.message));
		if (stage === "in-flight") { await entered.promise; controller.abort(abortReason); }
		await rejected;
		finish.resolve();
		assert.equal(f.cursors.length, stage === "pre-aborted" ? 0 : 1);
		assert.equal(f.calls.length, 0);
		assert.equal(f.binding.assertions, 0);
	});
}

guardTest("real guard excludes a competing driver during a source read; clean guard close evidence permits reacquisition", async (t) => {
	const entered = barrier();
	const finish = barrier();
	const f = await fixture({ call: async () => { entered.resolve(); await finish.promise; return result(snapshot()); } });
	const pending = inspect(f.session, context);
	t.after(async () => { finish.resolve(); await pending.catch(() => {}); await f.close(); });
	await entered.promise;
	const competitor = createDesktopOwnershipManager(path.join(f.root, "guard"));
	assert.throws(() => competitor.acquire("mac-tools", "operation"), { code: "busy" });
	finish.resolve();
	await pending;
	assert.throws(() => competitor.acquire("mac-tools", "operation"), { code: "busy" });
	// Guard-only terminal evidence, NOT a fixture-close/PID/OS-exit claim.
	const closeId = f.manager.beginOperation(f.session.lease, "connection-close");
	const evidence = f.manager.completeOperation(f.session.lease, closeId);
	f.manager.release(f.session.lease, evidence);
	const lease = competitor.acquire("mac-tools", "operation");
	const readId = competitor.beginOperation(lease, "inspect");
	competitor.release(lease, competitor.completeOperation(lease, readId));
});
