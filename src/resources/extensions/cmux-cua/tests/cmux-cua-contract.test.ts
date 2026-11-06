import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import registerCmuxCua, {
	cmuxCuaActionParameters,
	buildSnapshotBindings,
	formatAppOption,
	closeProxyAndVerifyExit,
	settleDesktopClose,
	decodeClickResult,
	decodePostClickWindowState,
	decodeEndSessionResult,
	decodeStartSessionResult,
	validateNativeToolInventory,
	approveAxTextSharing,
	beginInspection,
	registerCuaSessionCleanup,
	revokeCuaSessionState,
} from "../index.ts";

function envelope(structured: Record<string, unknown>) {
	return { isError: false, structured };
}

test("rejected accessibility labels cannot fall back to a role and expose values", () => {
	const bindings = buildSnapshotBindings({
		tree_markdown: "- [0] AXStaticText [id=password-field]\n- [1] AXStaticText [id=name-field]",
		elements: [
			{ element_index: 0, role: "AXStaticText", label: "Password", value: "sensitive-value" },
			{ element_index: 1, role: "AXStaticText", label: "Name", value: "public-value" },
		],
	} as any, { pid: 4521, windowId: 7, appName: "Test", title: "Test" } as any);

	assert.deepEqual(bindings.publicObservers.map((observer) => observer.label), ["Name"]);
	assert.deepEqual(bindings.publicObservers.map((observer) => observer.current_value), ["public-value"]);
	assert.equal(bindings.observers.size, 1);
});

test("duplicate AX selectors are excluded from postcondition observers", () => {
	for (const duplicateLabel of ["Duplicate two", "Password"]) {
		const bindings = buildSnapshotBindings({
			tree_markdown: "- [0] AXStaticText [id=shared-value]\n- [1] AXStaticText [id=shared-value]\n- [2] AXStaticText [id=unique-value]\n- [3] AXCheckBox [id=shared-value]",
			elements: [
				{ element_index: 0, role: "AXStaticText", label: "Duplicate one", value: "before-one" },
				{ element_index: 1, role: "AXStaticText", label: duplicateLabel, value: "before-two" },
				{ element_index: 2, role: "AXStaticText", label: "Unique value", value: "before-unique" },
				{ element_index: 3, role: "AXCheckBox", label: "Choice", value: "off", element_token: "x" },
			],
		} as any, { pid: 4521, windowId: 7, appName: "Test", title: "Test" } as any);

		assert.deepEqual(bindings.publicObservers.map((observer) => observer.label), ["Unique value", "Choice"]);
		assert.equal(bindings.observers.size, 2);
		assert.deepEqual(bindings.publicElements.map((element) => element.label), ["Choice"]);
		assert.equal(bindings.elements.size, 1);
	}
});

test("app chooser labels disambiguate running instances by PID", () => {
	const apps = [
		{ pid: 101, name: "Example", bundleId: "org.example.App" },
		{ pid: 202, name: "Example", bundleId: "org.example.App" },
	];
	const appOptions = apps.map(formatAppOption);
	const selectedAppLabel = appOptions[1];

	assert.deepEqual(appOptions, [
		"PID 101: Example (org.example.App)",
		"PID 202: Example (org.example.App)",
	]);
	assert.equal(new Set(appOptions).size, 2);
	assert.equal(apps[appOptions.indexOf(selectedAppLabel)]?.pid, 202);
});

describe("cmux CUA consent and inspection invalidation", () => {
	test("requires separate AX-text sharing approval and remembers it only for the session", async () => {
		const session = { axTextSharingApproved: false };
		const prompts: string[] = [];
		const ctx = {
			hasUI: true,
			ui: { confirm: async (title: string, message: string) => { prompts.push(`${title}: ${message}`); return true; } },
		} as unknown as Parameters<typeof approveAxTextSharing>[1];

		assert.equal(await approveAxTextSharing(session, ctx), true);
		assert.equal(session.axTextSharingApproved, true);
		assert.equal(await approveAxTextSharing(session, ctx), true);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /accessibility text/i);
		assert.match(prompts[0], /conversation history/i);
	});

	test("fails closed when AX-text sharing is denied or no UI is available", async () => {
		const deniedSession = { axTextSharingApproved: false };
		const deniedContext = {
			hasUI: true,
			ui: { confirm: async () => false },
		} as unknown as Parameters<typeof approveAxTextSharing>[1];
		assert.equal(await approveAxTextSharing(deniedSession, deniedContext), false);
		assert.equal(deniedSession.axTextSharingApproved, false);

		let promptCount = 0;
		const headlessContext = {
			hasUI: false,
			ui: { confirm: async () => { promptCount += 1; return true; } },
		} as unknown as Parameters<typeof approveAxTextSharing>[1];
		assert.equal(await approveAxTextSharing({ axTextSharingApproved: false }, headlessContext), false);
		assert.equal(promptCount, 0);
	});

	test("invalidates an old inspection grant before any reinspection failure", () => {
		const session = { grant: { id: "old-grant" }, hadAction: false };
		beginInspection(session);
		assert.equal(session.grant, null);
	});

	test("revokes session-local CUA state before a fork", async () => {
		const handlers = new Map<string, () => Promise<void>>();
		const api = {
			on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); },
		} as unknown as Pick<ExtensionAPI, "on">;
		const session = { stopping: false, grant: { id: "live-grant" }, target: { id: "selected-window" }, axTextSharingApproved: true };
		let cleanupCount = 0;
		registerCuaSessionCleanup(api, async () => { cleanupCount += 1; revokeCuaSessionState(session); });

		assert.ok(handlers.has("session_before_fork"));
		await handlers.get("session_before_fork")?.();
		assert.equal(cleanupCount, 1);
		assert.equal(session.stopping, true);
		assert.equal(session.grant, null);
		assert.equal(session.target, null);
		assert.equal(session.axTextSharingApproved, false);
	});
});

describe("cmux CUA pinned contract", () => {
	test("server identity, tool count, required names, and uniqueness are enforced", () => {
		const requiredNames = ["check_permissions", "click", "end_session", "get_window_state", "list_apps", "list_windows", "start_session"];
		const tools = [...requiredNames, ...Array.from({ length: 32 }, (_, index) => `fixture-${index}`)].map((name) => ({
			name,
			description: "fixture metadata",
			inputSchema: { type: "object", properties: {} },
		}));
		assert.doesNotThrow(() => validateNativeToolInventory("cmux-cua", "0.7.1", tools));
		assert.throws(() => validateNativeToolInventory("other-server", "0.7.1", tools), /pinned source/);
		assert.throws(() => validateNativeToolInventory("cmux-cua", "0.7.2", tools), /pinned source/);
		assert.throws(() => validateNativeToolInventory("cmux-cua", "0.7.1", tools.slice(0, -1)), /pinned source/);
		assert.throws(() => validateNativeToolInventory("cmux-cua", "0.7.1", tools.filter((tool) => tool.name !== "click").concat({ ...tools[38], name: "fixture-extra" })), /pinned native CUA tool is missing/);
		const duplicate = [...tools];
		duplicate[38] = { ...duplicate[38], name: "click" };
		assert.throws(() => validateNativeToolInventory("cmux-cua", "0.7.1", duplicate), /malformed/);
	});

	test("start session accepts only fresh, invocation-prefixed active sessions", () => {
		assert.equal(decodeStartSessionResult(envelope({
			session: "gsd-owned-mcp-4521-run-7",
			active: true,
			revived: false,
		}), "gsd-owned-mcp-4521-"), "gsd-owned-mcp-4521-run-7");
		assert.throws(() => decodeStartSessionResult(envelope({
			session: "other-mcp-4521-run-7",
			active: true,
			revived: false,
		}), "gsd-owned-mcp-4521-"), /identity/);
		assert.throws(() => decodeStartSessionResult(envelope({
			session: "gsd-owned-mcp-4521-run-7",
			active: true,
			revived: true,
		}), "gsd-owned-mcp-4521-"), /fresh/);
		assert.throws(() => decodeStartSessionResult(envelope({
			session: "gsd-owned-mcp-4521-",
			active: true,
			revived: false,
		}), "gsd-owned-mcp-4521-"), /suffix/);
	});

	test("proxy PID generation is captured before SDK close can clear the transport handle", async () => {
		let transportPid: number | null = 4521;
		const events: string[] = [];
		const identity = { pid: 4521, startToken: "gen-1" };
		const result = await closeProxyAndVerifyExit({
			currentPid: () => { events.push("read-pid"); return transportPid; },
			knownIdentity: null,
			captureIdentity: (pid) => { events.push(`capture-${pid}`); return identity; },
			closeClient: async () => { events.push("client-close"); transportPid = null; },
			closeTransport: async () => { events.push("transport-close"); },
			isExited: (candidate) => {
				events.push(`check-${candidate.pid}`);
				assert.equal(candidate, identity);
				return true;
			},
			budgetMs: 1_000,
		});
		assert.deepEqual(events, ["read-pid", "capture-4521", "client-close", "transport-close", "check-4521"]);
		assert.equal(result.identity, identity);
		assert.equal(result.exited, true);
	});

	test("the cleanup deadline includes client and transport close operations", async () => {
		const identity = { pid: 4521, startToken: "gen-1" };
		for (const stalledClose of ["client", "transport"] as const) {
			const calls: string[] = [];
			let exitChecks = 0;
			const startedAt = Date.now();
			const delayedClose = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
			const result = await closeProxyAndVerifyExit({
				currentPid: () => identity.pid,
				knownIdentity: identity,
				closeClient: () => {
					calls.push("client");
					return stalledClose === "client" ? delayedClose() : Promise.resolve();
				},
				closeTransport: () => {
					calls.push("transport");
					return stalledClose === "transport" ? delayedClose() : Promise.resolve();
				},
				isExited: () => { exitChecks += 1; return true; },
				budgetMs: 25,
			});
			assert.deepEqual(calls, ["client", "transport"]);
			assert.equal(exitChecks, 0);
			assert.equal(result.exited, false);
			assert.ok(Date.now() - startedAt < 200, "stalled close must not extend cleanup beyond its budget");
		}
	});

	test("missing, indeterminate, and failed exit checks cannot become positive process-exit evidence", async () => {
		let closed = false;
		const close = async () => { closed = true; };
		const missing = await closeProxyAndVerifyExit({
			currentPid: () => null,
			knownIdentity: null,
			captureIdentity: () => null,
			closeClient: close,
			closeTransport: close,
			isExited: () => true,
			budgetMs: 25,
		});
		assert.equal(closed, true);
		assert.equal(missing.exited, false);

		let closedAfterPidFailure = false;
		const pidLookupFailure = await closeProxyAndVerifyExit({
			currentPid: () => { throw new Error("transport handle unavailable"); },
			knownIdentity: null,
			closeClient: async () => { closedAfterPidFailure = true; },
			closeTransport: async () => { closedAfterPidFailure = true; },
			isExited: () => true,
			budgetMs: 25,
		});
		assert.equal(closedAfterPidFailure, true);
		assert.equal(pidLookupFailure.exited, false);

		const identity = { pid: 4521, startToken: "gen-1" };
		const unresolved = await closeProxyAndVerifyExit({
			currentPid: () => 4521,
			knownIdentity: identity,
			closeClient: close,
			closeTransport: close,
			isExited: () => false,
			budgetMs: 25,
		});
		assert.equal(unresolved.exited, false);
		const failedCheck = await closeProxyAndVerifyExit({
			currentPid: () => 4521,
			knownIdentity: identity,
			closeClient: close,
			closeTransport: close,
			isExited: () => { throw new Error("identity lookup unavailable"); },
			budgetMs: 25,
		});
		assert.equal(failedCheck.exited, false);
		const exited = await closeProxyAndVerifyExit({
			currentPid: () => 4521,
			knownIdentity: identity,
			closeClient: close,
			closeTransport: close,
			isExited: () => true,
			budgetMs: 25,
		});
		assert.equal(exited.exited, true);
	});

	test("both session cleanup paths require terminal evidence, confirmed exit, and no uncertain action", () => {
		const lease = {} as Parameters<typeof settleDesktopClose>[1];
		const evidence = {} as NonNullable<Parameters<typeof settleDesktopClose>[2]>;
		const calls: string[] = [];
		const manager = {
			release: () => { calls.push("release"); },
			quarantine: (_lease: unknown, _operationId: unknown, reason: string) => { calls.push(`quarantine:${reason}`); },
		} as unknown as Parameters<typeof settleDesktopClose>[0];

		assert.equal(settleDesktopClose(manager, lease, evidence, true, false, false), "released");
		assert.deepEqual(calls, ["release"]);
		calls.length = 0;
		assert.equal(settleDesktopClose(manager, lease, evidence, false, false, false), "quarantined");
		assert.deepEqual(calls, ["quarantine:cleanup-failed"]);
		calls.length = 0;
		assert.equal(settleDesktopClose(manager, lease, undefined, true, false, false), "quarantined");
		assert.deepEqual(calls, ["quarantine:cleanup-failed"]);
		calls.length = 0;
		assert.equal(settleDesktopClose(manager, lease, evidence, true, true, false), "quarantined");
		assert.deepEqual(calls, ["quarantine:cleanup-failed"]);
		calls.length = 0;
		assert.equal(settleDesktopClose(manager, lease, evidence, true, false, true), "quarantined");
		assert.deepEqual(calls, ["quarantine:terminal-unverified"]);
	});

	test("session end requires matching terminal identity", () => {
		assert.doesNotThrow(() => decodeEndSessionResult(envelope({ session: "gsd-owned", active: false }), "gsd-owned"));
		assert.throws(() => decodeEndSessionResult(envelope({ session: "other", active: false }), "gsd-owned"), /terminate/);
		assert.throws(() => decodeEndSessionResult(envelope({ session: "gsd-owned", active: true }), "gsd-owned"), /terminate/);
	});

	test("click acknowledgment never counts as success without a separate AX verification", () => {
		assert.deepEqual(decodeClickResult(envelope({ path: "ax", verified: false, effect: "unverifiable" })), { effect: "unverifiable" });
		assert.deepEqual(decodeClickResult(envelope({ path: "ax", verified: false, effect: "suspected_noop" })), { effect: "suspected_noop" });
		assert.throws(() => decodeClickResult(envelope({ path: "ax", verified: true, effect: "success" })), /acknowledgment/);
		assert.throws(() => decodeClickResult(envelope({ path: "ax", verified: false, effect: "success" })), /unknown/);
	});

	test("post-click state decoder accepts one raw MCP response", () => {
		const target = { targetId: "target-1", pid: 4521, windowId: 7, appName: "Test", title: "Window" };
		const state = {
			pid: 4521,
			window_id: 7,
			snapshot_id: "snapshot-1",
			tree_markdown: "",
			element_count: 0,
			elements: [],
			degraded: false,
		};
		const rawMcpResult = {
			isError: false,
			content: [{ type: "text", text: "{}" }],
			structuredContent: state,
		};
		assert.deepEqual(decodePostClickWindowState(rawMcpResult, target), state);
	});

	test("action schema is click-only and runtime remains closed pending G-03", () => {
		const schemaText = JSON.stringify(cmuxCuaActionParameters);
		assert.match(schemaText, /click/);
		assert.doesNotMatch(schemaText, /type_text|text_entry|coordinates/i);
		const registered: string[] = [];
		const fakeApi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
			on: () => { throw new Error("closed G-03 gate must register no lifecycle handlers"); },
		} as unknown as ExtensionAPI;
		registerCmuxCua(fakeApi);
		assert.deepEqual(registered, []);
	});
});
