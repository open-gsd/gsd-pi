import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopOwnershipLease, DesktopOwnershipManager, DesktopTerminalEvidence } from "../../shared/desktop-ownership.ts";
import { isMacToolsContextInteractive, runMacAgentWithOwnership } from "../index.ts";

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

	test("a terminal inspect failure is reported after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership("listWindows", () => ({ success: false, error: "application closed" }), manager, true),
			/terminal failure/,
		);
		assert.deepEqual(calls, ["acquire", "begin:inspect", "complete:operation-inspect", "release"]);
	});

	test("a terminal capture failure is reported after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership("screenshotWindow", () => ({ success: false, error: "capture unavailable" }), manager, true),
			/terminal failure/,
		);
		assert.deepEqual(calls, ["acquire", "begin:capture", "complete:operation-capture", "release"]);
	});

	test("failed action and focus commands keep durable uncertainty", () => {
		for (const command of ["clickElement", "activateApp"]) {
			const { calls, manager } = createManagerHarness();
			assert.throws(
				() => runMacAgentWithOwnership(command, () => ({ success: false, error: "dispatch result uncertain" }), manager, true),
				/ownership is quarantined/,
			);
			assert.deepEqual(calls, ["acquire", "begin:action", "quarantine:dispatch-uncertain"]);
		}
	});
});
