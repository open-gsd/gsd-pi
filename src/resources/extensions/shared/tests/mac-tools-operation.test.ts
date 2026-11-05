import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopOwnershipLease, DesktopOwnershipManager, DesktopTerminalEvidence } from "../desktop-ownership.ts";
import { runMacAgentWithOwnership } from "../../mac-tools/index.ts";

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

describe("mac-tools terminal response ownership", () => {
	test("a terminal inspect failure is reported after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership("listWindows", () => ({ success: false, error: "application closed" }), manager),
			/terminal failure/,
		);
		assert.deepEqual(calls, ["acquire", "begin:inspect", "complete:operation-inspect", "release"]);
	});

	test("a terminal capture failure is reported after ownership is safely released", () => {
		const { calls, manager } = createManagerHarness();
		assert.throws(
			() => runMacAgentWithOwnership("screenshotWindow", () => ({ success: false, error: "capture unavailable" }), manager),
			/terminal failure/,
		);
		assert.deepEqual(calls, ["acquire", "begin:capture", "complete:operation-capture", "release"]);
	});

	test("failed action and focus commands keep durable uncertainty", () => {
		for (const command of ["clickElement", "activateApp"]) {
			const { calls, manager } = createManagerHarness();
			assert.throws(
				() => runMacAgentWithOwnership(command, () => ({ success: false, error: "dispatch result uncertain" }), manager),
				/ownership is quarantined/,
			);
			assert.deepEqual(calls, ["acquire", "begin:action", "quarantine:dispatch-uncertain"]);
		}
	});
});
