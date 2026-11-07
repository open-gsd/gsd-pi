import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopOwnershipLease, DesktopOwnershipManager, DesktopTerminalEvidence } from "../../shared/desktop-ownership.ts";
import { isMacToolsContextInteractive, runMacAgentWithOwnership, waitForMacAgentProcessExit } from "../index.ts";

const lease = { driver: "mac-tools" } as DesktopOwnershipLease;
const evidence = {} as DesktopTerminalEvidence;

type ManagerHarness = {
	calls: string[];
	manager: DesktopOwnershipManager;
};

function createManagerHarness(): ManagerHarness {
	const calls: string[] = [];
	const manager: DesktopOwnershipManager = {
		acquire: () => { calls.push("acquire"); return lease; },
		currentLease: () => null,
		beginOperation: (_lease, kind) => { calls.push(`begin:${kind}`); return `operation-${kind}`; },
		completeOperation: (_lease, operationId) => { calls.push(`complete:${operationId}`); return evidence; },
		completeVerification: () => { throw new Error("unexpected verification"); },
		quarantine: (_lease, _operationId, reason) => { calls.push(`quarantine:${reason}`); },
		release: () => { calls.push("release"); },
	};
	return { calls, manager };
}

describe("mac-tools local desktop admission", () => {
	test("requires the trusted host signal and both local TTY streams", () => {
		assert.equal(isMacToolsContextInteractive(false, true, true), false);
		assert.equal(isMacToolsContextInteractive(true, false, true), false);
		assert.equal(isMacToolsContextInteractive(true, true, false), false);
		assert.equal(isMacToolsContextInteractive(true, true, true), true);
	});
});

describe("mac-tools terminal response ownership", () => {
	test("fails closed before execution when local desktop admission is omitted", () => {
		const { calls, manager } = createManagerHarness();
		let executed = false;

		assert.throws(() =>
			runMacAgentWithOwnership("listWindows", () => {
				executed = true;
				return { success: true };
			}, manager),
		);
		assert.equal(executed, false);
		assert.deepEqual(calls, []);
	});

	test("a terminal inspect failure preserves its reason after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		const response = runMacAgentWithOwnership(
			"listWindows",
			() => ({ success: false, error: "application closed" }),
			manager,
			true,
		);
		assert.equal(response.success, false);
		assert.equal(response.error, "application closed");
		assert.deepEqual(calls, ["acquire", "begin:inspect", "complete:operation-inspect", "release"]);
	});

	test("a terminal capture failure preserves its reason after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		const response = runMacAgentWithOwnership(
			"screenshotWindow",
			() => ({ success: false, error: "capture unavailable" }),
			manager,
			true,
		);
		assert.equal(response.success, false);
		assert.equal(response.error, "capture unavailable");
		assert.deepEqual(calls, ["acquire", "begin:capture", "complete:operation-capture", "release"]);
	});

	test("bounds and sanitizes terminal failure details", () => {
		const { calls, manager } = createManagerHarness();
		const response = runMacAgentWithOwnership(
			"screenshotWindow",
			() => ({ success: false, error: `capture failed\r\n${"x".repeat(400)}` }),
			manager,
			true,
		);
		assert.equal(response.success, false);
		assert.equal(response.error?.includes("\r"), false);
		assert.ok((response.error?.length ?? 0) <= 240);
		assert.ok(response.error?.startsWith("capture failed"));
		assert.deepEqual(calls, ["acquire", "begin:capture", "complete:operation-capture", "release"]);
	});

	test("quitApp quarantines a missing process identifier", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership("quitApp", () => ({ success: true, data: { quit: true, name: "TextEdit" } }), manager, true),
			/valid app process identifier/,
		);
		assert.deepEqual(calls, ["acquire", "begin:action", "quarantine:dispatch-uncertain"]);
	});

	test("quitApp keeps ownership until the injected process-exit check completes", () => {
		const { calls, manager } = createManagerHarness();
		const response = runMacAgentWithOwnership(
			"quitApp",
			() => ({ success: true, data: { quit: true, name: "TextEdit", pid: 123 } }),
			manager,
			true,
			(pid) => {
				assert.equal(pid, 123);
				assert.deepEqual(calls, ["acquire", "begin:action"]);
			},
		);
		assert.equal(response.data?.terminated, true);
		assert.deepEqual(calls, ["acquire", "begin:action", "complete:operation-action", "release"]);
	});

	test("quitApp quarantines when the app process has not exited before timeout", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership(
				"quitApp",
				() => ({ success: true, data: { quit: true, name: "TextEdit", pid: 123 } }),
				manager,
				true,
				() => { throw new Error("Timed out waiting for app process to exit"); },
			),
			/Timed out waiting for app process to exit/,
		);
		assert.deepEqual(calls, ["acquire", "begin:action", "quarantine:dispatch-uncertain"]);
	});

	test("process-exit polling waits through delayed termination", () => {
		let probes = 0;
		const sleeps: number[] = [];
		waitForMacAgentProcessExit(123, {
			timeoutMs: 100,
			pollIntervalMs: 10,
			isProcessRunning: () => ++probes < 3,
			sleep: (milliseconds) => sleeps.push(milliseconds),
			now: () => 0,
		});
		assert.equal(probes, 3);
		assert.deepEqual(sleeps, [10, 10]);
	});

	test("process-exit polling times out while the target remains alive", () => {
		let now = 0;
		assert.throws(
			() => waitForMacAgentProcessExit(123, {
				timeoutMs: 20,
				pollIntervalMs: 10,
				isProcessRunning: () => true,
				sleep: (milliseconds) => { now += milliseconds; },
				now: () => now,
			}),
			/Timed out waiting for app process 123 to exit/,
		);
	});

	test("failed action and focus commands keep durable uncertainty", () => {
		for (const command of ["clickElement", "activateApp"]) {
			const { calls, manager } = createManagerHarness();
			assert.throws(
				() => runMacAgentWithOwnership(command, () => ({ success: false, error: "dispatch result uncertain" }), manager, true),
				/dispatch result uncertain.*ownership is quarantined/,
			);
			assert.deepEqual(calls, ["acquire", "begin:action", "quarantine:dispatch-uncertain"]);
		}
	});
});
