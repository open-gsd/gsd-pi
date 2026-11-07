// Pure, offline model of session-scoped revocation and operation quiescence (phase 2).
// Not wired into the runtime: G03_RUNTIME_ADMISSION_ENABLED in index.ts stays false.
// The model answers one question: after revoke(), can any request still be admitted,
// and can ownership be released while admitted work lacks terminal proof?

export interface SessionState {
	epoch: number;
	revoked: boolean;
	// Operations admitted under this epoch and not yet terminal.
	admittedOpen: Set<string>;
	// Operations that reached terminal success or failure with quiescence proof.
	quiesced: Set<string>;
}

export interface RevocationRegistry {
	sessions: Map<string, SessionState>;
}

export function createRegistry(): RevocationRegistry {
	return { sessions: new Map() };
}

export function openSession(reg: RevocationRegistry, sessionId: string): number {
	const existing = reg.sessions.get(sessionId);
	if (existing && !existing.revoked) return existing.epoch;
	const epoch = (existing?.epoch ?? 0) + 1;
	// Work admitted under an earlier epoch stays open until terminal proof, even if the session is reopened.
	const carriedOpen = existing ? new Set(existing.admittedOpen) : new Set<string>();
	const quiesced = existing ? new Set(existing.quiesced) : new Set<string>();
	reg.sessions.set(sessionId, { epoch, revoked: false, admittedOpen: carriedOpen, quiesced });
	return epoch;
}

export type AdmitResult =
	| { admitted: true }
	| { admitted: false; reason: "unknown-session" | "stale-epoch" | "revoked" };

// Admission requires the current, non-revoked epoch. A request that carries an older
// epoch (delayed, or delivered after reconnect) is rejected even if the session was reopened.
export function admit(reg: RevocationRegistry, sessionId: string, epoch: number, operationId: string): AdmitResult {
	const s = reg.sessions.get(sessionId);
	if (!s) return { admitted: false, reason: "unknown-session" };
	if (s.revoked) return { admitted: false, reason: "revoked" };
	if (epoch !== s.epoch) return { admitted: false, reason: "stale-epoch" };
	s.admittedOpen.add(operationId);
	return { admitted: true };
}

// Terminal proof for an admitted operation. Only proof closes it; acknowledgement,
// timeout or process exit do not.
export function recordTerminal(reg: RevocationRegistry, sessionId: string, operationId: string, quiescent: boolean): void {
	const s = reg.sessions.get(sessionId);
	if (!s || !s.admittedOpen.has(operationId)) return;
	if (!quiescent) return;
	s.admittedOpen.delete(operationId);
	s.quiesced.add(operationId);
}

export interface RevokeOutcome {
	epochInvalidated: boolean;
	// Queued work is aborted only after the epoch is invalid; open operations stay quarantined.
	ownershipReleasable: boolean;
	openOperations: number;
}

// Revocation invalidates the epoch first and does not depend on queued work completing.
// Ownership is releasable only when no admitted operation lacks terminal proof.
export function revoke(reg: RevocationRegistry, sessionId: string): RevokeOutcome {
	const s = reg.sessions.get(sessionId);
	if (!s) return { epochInvalidated: false, ownershipReleasable: true, openOperations: 0 };
	s.revoked = true;
	s.epoch += 1;
	return {
		epochInvalidated: true,
		ownershipReleasable: s.admittedOpen.size === 0,
		openOperations: s.admittedOpen.size,
	};
}
