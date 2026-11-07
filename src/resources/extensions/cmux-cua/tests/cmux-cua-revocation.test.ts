import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, openSession, admit, recordTerminal, revoke } from "../revocation-quiescence.ts";

describe("session-scoped revocation (offline model)", () => {
	test("epoch is invalid before queued work is aborted, while the admitted action is still open", () => {
		const reg = createRegistry();
		const epoch = openSession(reg, "s1");
		assert.deepEqual(admit(reg, "s1", epoch, "A"), { admitted: true });
		// B is queued behind A; revoke must invalidate the epoch without waiting for A.
		revoke(reg, "s1");
		assert.deepEqual(admit(reg, "s1", epoch, "B"), { admitted: false, reason: "revoked" });
	});

	test("delayed or reconnect-delivered request with the revoked epoch is rejected", () => {
		const reg = createRegistry();
		const oldEpoch = openSession(reg, "s1");
		revoke(reg, "s1");
		// Reopened session gets a new epoch; the old one must not be admitted again.
		const newEpoch = openSession(reg, "s1");
		assert.notEqual(newEpoch, oldEpoch);
		assert.deepEqual(admit(reg, "s1", oldEpoch, "late"), { admitted: false, reason: "stale-epoch" });
	});

	test("revoking one session leaves an unrelated session admitting", () => {
		const reg = createRegistry();
		const e1 = openSession(reg, "s1");
		const e2 = openSession(reg, "s2");
		revoke(reg, "s1");
		assert.deepEqual(admit(reg, "s2", e2, "B"), { admitted: true });
		assert.deepEqual(admit(reg, "s1", e1, "A"), { admitted: false, reason: "revoked" });
	});

	test("ownership is not releasable while admitted work lacks terminal proof", () => {
		const reg = createRegistry();
		const epoch = openSession(reg, "s1");
		admit(reg, "s1", epoch, "A");
		const outcome = revoke(reg, "s1");
		assert.equal(outcome.ownershipReleasable, false);
		assert.equal(outcome.openOperations, 1);
	});

	test("acknowledgement or non-quiescent evidence does not close an operation", () => {
		const reg = createRegistry();
		const epoch = openSession(reg, "s1");
		admit(reg, "s1", epoch, "A");
		recordTerminal(reg, "s1", "A", false);
		assert.equal(revoke(reg, "s1").ownershipReleasable, false);
	});

	test("ownership becomes releasable only after terminal quiescence proof", () => {
		const reg = createRegistry();
		const epoch = openSession(reg, "s1");
		admit(reg, "s1", epoch, "A");
		recordTerminal(reg, "s1", "A", true);
		const outcome = revoke(reg, "s1");
		assert.equal(outcome.ownershipReleasable, true);
		assert.equal(outcome.openOperations, 0);
	});

	test("unknown session is rejected", () => {
		const reg = createRegistry();
		assert.deepEqual(admit(reg, "nope", 1, "A"), { admitted: false, reason: "unknown-session" });
	});

	test("reopening a revoked session does not discard unquiesced work from the prior epoch", () => {
		const reg = createRegistry();
		const epoch = openSession(reg, "s1");
		admit(reg, "s1", epoch, "A");
		revoke(reg, "s1");
		// Reopen must not clear A: it is still physically open until it has terminal proof.
		openSession(reg, "s1");
		assert.equal(revoke(reg, "s1").ownershipReleasable, false);
	});
});
