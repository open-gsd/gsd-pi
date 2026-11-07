// Pure, offline contract for the G-03 pre-initialize gate (phase 1).
// Nothing here is wired into the runtime entrypoint: the default export in
// index.ts still returns before tool or lifecycle registration while
// G03_RUNTIME_ADMISSION_ENABLED is false. Real host peer binding is out of scope
// for offline tests and is injected through PeerBindingDependencies.

export const HARD_KILL_ENV = "CMUX_COMPUTER_USE_MCP_DISABLED";

export type HardKillDecision =
	| { allowed: true }
	| { allowed: false; reason: "hard-kill-env" };

// Adapter-side hard kill. Applied before spawn, before registration and before
// every dispatch. A set value of "1" blocks; any other value does not.
export function evaluateHardKill(env: NodeJS.ProcessEnv): HardKillDecision {
	if (env[HARD_KILL_ENV] === "1") return { allowed: false, reason: "hard-kill-env" };
	return { allowed: true };
}

export interface PeerProof {
	nonce: string;
	hostSignature: string;
	daemonGeneration: string;
	protocolVersion: string;
	connectionId: string;
}

export interface PeerBindingExpectation {
	nonce: string;
	daemonGeneration: string;
	protocolVersion: string;
	connectionId: string;
}

export interface PeerBindingDependencies {
	// Returns the proof presented on this connection before MCP initialize.
	readProof(connectionId: string): Promise<PeerProof | null>;
	// Verifies the signature of the proof against the pinned host identity.
	verifySignature(proof: PeerProof): Promise<boolean>;
}

export type PeerBindingResult =
	| { ok: true }
	| { ok: false; reason: "missing-proof" | "wrong-nonce" | "wrong-connection" | "wrong-generation" | "wrong-protocol" | "bad-signature" };

// Pre-initialize binding check. Returns before any MCP initialize, capability,
// schema or token is exchanged. Reconnects must present a fresh nonce; a proof
// bound to an earlier connection is rejected by the connectionId comparison.
export async function verifyPreInitBinding(
	expected: PeerBindingExpectation,
	deps: PeerBindingDependencies,
): Promise<PeerBindingResult> {
	const proof = await deps.readProof(expected.connectionId);
	if (!proof) return { ok: false, reason: "missing-proof" };
	if (proof.connectionId !== expected.connectionId) return { ok: false, reason: "wrong-connection" };
	if (proof.nonce !== expected.nonce) return { ok: false, reason: "wrong-nonce" };
	if (proof.daemonGeneration !== expected.daemonGeneration) return { ok: false, reason: "wrong-generation" };
	if (proof.protocolVersion !== expected.protocolVersion) return { ok: false, reason: "wrong-protocol" };
	if (!(await deps.verifySignature(proof))) return { ok: false, reason: "bad-signature" };
	return { ok: true };
}
