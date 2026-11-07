import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHardKill, verifyPreInitBinding, HARD_KILL_ENV, type PeerProof } from "../pre-init-binding.ts";

const expected = {
	nonce: "nonce-1",
	daemonGeneration: "gen-7",
	protocolVersion: "2026-11-01",
	connectionId: "conn-A",
};

function proof(overrides: Partial<PeerProof> = {}): PeerProof {
	return {
		nonce: "nonce-1",
		hostSignature: "sig",
		daemonGeneration: "gen-7",
		protocolVersion: "2026-11-01",
		connectionId: "conn-A",
		...overrides,
	};
}

function deps(p: PeerProof | null, signatureOk = true) {
	return {
		readProof: async () => p,
		verifySignature: async () => signatureOk,
	};
}

describe("hard kill (adapter layer)", () => {
	test("blocks when the kill variable is exactly 1", () => {
		assert.deepEqual(evaluateHardKill({ [HARD_KILL_ENV]: "1" }), { allowed: false, reason: "hard-kill-env" });
	});

	test("does not block for any other value", () => {
		for (const value of ["0", "", "true", " 1"]) {
			assert.deepEqual(evaluateHardKill({ [HARD_KILL_ENV]: value }), { allowed: true });
		}
		assert.deepEqual(evaluateHardKill({}), { allowed: true });
	});
});

describe("pre-initialize peer binding", () => {
	test("accepts a valid proof bound to this connection", async () => {
		assert.deepEqual(await verifyPreInitBinding(expected, deps(proof())), { ok: true });
	});

	test("rejects when no proof is presented before initialize", async () => {
		assert.deepEqual(await verifyPreInitBinding(expected, deps(null)), { ok: false, reason: "missing-proof" });
	});

	test("rejects a proof from a different connection (reconnect with old proof)", async () => {
		assert.deepEqual(
			await verifyPreInitBinding(expected, deps(proof({ connectionId: "conn-B" }))),
			{ ok: false, reason: "wrong-connection" },
		);
	});

	test("rejects a replayed proof with a stale nonce", async () => {
		assert.deepEqual(
			await verifyPreInitBinding(expected, deps(proof({ nonce: "nonce-0" }))),
			{ ok: false, reason: "wrong-nonce" },
		);
	});

	test("rejects a proof from a different daemon generation", async () => {
		assert.deepEqual(
			await verifyPreInitBinding(expected, deps(proof({ daemonGeneration: "gen-6" }))),
			{ ok: false, reason: "wrong-generation" },
		);
	});

	test("rejects a different protocol version", async () => {
		assert.deepEqual(
			await verifyPreInitBinding(expected, deps(proof({ protocolVersion: "2025-01-01" }))),
			{ ok: false, reason: "wrong-protocol" },
		);
	});

	test("rejects a bad signature even when all fields match", async () => {
		assert.deepEqual(await verifyPreInitBinding(expected, deps(proof(), false)), { ok: false, reason: "bad-signature" });
	});
});
