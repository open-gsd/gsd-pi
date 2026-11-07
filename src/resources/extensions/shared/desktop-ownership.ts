import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

export type DesktopDriver = "mac-tools" | "cmux-cua";
export type DesktopLeaseScope = "operation" | "session";
export type DesktopOperationKind = "session-start" | "session-end" | "connection-close" | "inspect" | "capture" | "action" | "verify"
export type DesktopQuarantineReason =
	| "dispatch-uncertain"
	| "terminal-unverified"
	| "cleanup-failed"
	| "stale-owner"
	| "invalid-state";
export type DesktopOwnershipErrorCode =
	| "child-process"
	| "busy"
	| "in-flight"
	| "verification-required"
	| "quarantined"
	| "invalid-lease"
	| "terminal-evidence-required"
	| "lock-unavailable"
	| "state-corrupt";

export class DesktopOwnershipError extends Error {
	readonly code: DesktopOwnershipErrorCode;

	constructor(code: DesktopOwnershipErrorCode, message: string) {
		super(message);
		this.name = "DesktopOwnershipError";
		this.code = code;
	}
}

export interface DesktopOwnershipLease {
	readonly driver: DesktopDriver;
	readonly scope: DesktopLeaseScope;
	readonly connectionGeneration: string;
}

export interface DesktopProcessIdentity {
	readonly pid: number;
	readonly startToken: string;
}

export interface DesktopTerminalEvidence {
	readonly kind: DesktopOperationKind;
}

interface OwnershipState {
	version: 1;
	ownerTokenHash: string;
	ownerPid: number;
	ownerProcessStart: string;
	driver: DesktopDriver;
	scope: DesktopLeaseScope;
	connectionGeneration: string;
	status: "active" | "in-flight" | "awaiting-verification" | "verification-in-flight" | "quarantined" | "released";
	invocationId: string | null;
	operationId: string | null;
	operationKind: DesktopOperationKind | null;
	quarantineReason: DesktopQuarantineReason | null;
}

interface ActiveLease {
	lease: DesktopOwnershipLease;
	ownerTokenHash: string;
	safetyDirectory: string;
	lockPath: string;
	lockDescriptor: number;
	lastTerminalOperationId: string | null;
	lastTerminalKind: DesktopOperationKind | null;
}

interface TerminalEvidenceRecord {
	lease: DesktopOwnershipLease;
	invocationId: string;
	kind: DesktopOperationKind;
}

export interface DesktopOwnershipManager {
	acquire(driver: DesktopDriver, scope: DesktopLeaseScope, connectionGeneration?: string): DesktopOwnershipLease;
	currentLease(): DesktopOwnershipLease | null;
	beginOperation(lease: DesktopOwnershipLease, kind: DesktopOperationKind): string;
	completeOperation(
		lease: DesktopOwnershipLease,
		operationId: string,
		options?: { requiresVerification?: boolean },
	): DesktopTerminalEvidence;
	completeVerification(lease: DesktopOwnershipLease, verificationId: string, matched: boolean): DesktopTerminalEvidence;
	quarantine(
		lease: DesktopOwnershipLease,
		operationId: string | null,
		reason: DesktopQuarantineReason,
	): void;
	release(lease: DesktopOwnershipLease, evidence: DesktopTerminalEvidence): void;
}

const STATE_FILE = "state.json";
const MUTEX_FILE = "desktop-ownership.lock";
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const MAX_STATE_BYTES = 4_096;

function defaultSafetyDirectory(): string {
	try {
		const account = userInfo();
		if (account.uid !== currentUid() || !path.isAbsolute(account.homedir)) {
			throw ownershipError("lock-unavailable");
		}
		return path.join(account.homedir, "Library", "Application Support", "gsd-desktop-safety");
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("lock-unavailable");
	}
}

function ownershipError(code: DesktopOwnershipErrorCode): DesktopOwnershipError {
	switch (code) {
		case "child-process":
			return new DesktopOwnershipError(code, "Native desktop access is disabled in headless and child processes.");
		case "busy":
			return new DesktopOwnershipError(code, "The native desktop is owned by another process.");
		case "in-flight":
			return new DesktopOwnershipError(code, "A native desktop operation is still in flight.");
		case "verification-required":
			return new DesktopOwnershipError(code, "A dispatched desktop action must be verified before another action.");
		case "quarantined":
			return new DesktopOwnershipError(code, "Native desktop ownership is quarantined pending supported terminal evidence.");
		case "invalid-lease":
			return new DesktopOwnershipError(code, "The native desktop lease is invalid or no longer owned by this process.");
		case "terminal-evidence-required":
			return new DesktopOwnershipError(code, "Releasing desktop ownership requires current operation-specific terminal evidence.");
		case "lock-unavailable":
			return new DesktopOwnershipError(code, "The native desktop ownership guard is unavailable; access is blocked.");
		case "state-corrupt":
			return new DesktopOwnershipError(code, "The native desktop ownership state is invalid; access is blocked.");
	}
}

function currentUid(): number {
	if (typeof process.getuid !== "function") throw ownershipError("lock-unavailable");
	return process.getuid();
}

function isDesktopDriver(value: unknown): value is DesktopDriver {
	return value === "mac-tools" || value === "cmux-cua";
}

function isLeaseScope(value: unknown): value is DesktopLeaseScope {
	return value === "operation" || value === "session";
}

function isOperationKind(value: unknown): value is DesktopOperationKind {
	return (
		value === "session-start" ||
		value === "session-end" ||
		value === "connection-close" ||
		value === "inspect" ||
		value === "capture" ||
		value === "action" ||
		value === "verify"
	);
}

function isQuarantineReason(value: unknown): value is DesktopQuarantineReason {
	return (
		value === "dispatch-uncertain" ||
		value === "terminal-unverified" ||
		value === "cleanup-failed" ||
		value === "stale-owner" ||
		value === "invalid-state"
	);
}

function parseOwnershipState(value: unknown): OwnershipState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw ownershipError("state-corrupt");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.ownerTokenHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.ownerTokenHash) ||
		typeof record.ownerPid !== "number" ||
		!Number.isInteger(record.ownerPid) ||
		record.ownerPid <= 0 ||
		typeof record.ownerProcessStart !== "string" ||
		!record.ownerProcessStart ||
		!isDesktopDriver(record.driver) ||
		!isLeaseScope(record.scope) ||
		typeof record.connectionGeneration !== "string" ||
		!record.connectionGeneration ||
		(record.status !== "active" &&
			record.status !== "in-flight" &&
			record.status !== "awaiting-verification" &&
			record.status !== "verification-in-flight" &&
			record.status !== "quarantined" &&
			record.status !== "released") ||
		(record.invocationId !== null && typeof record.invocationId !== "string") ||
		(record.operationId !== null && typeof record.operationId !== "string") ||
		(record.operationKind !== null && !isOperationKind(record.operationKind)) ||
		(record.quarantineReason !== null && !isQuarantineReason(record.quarantineReason)) ||
		(record.status === "active" && (record.invocationId !== null || record.operationId !== null || record.operationKind !== null || record.quarantineReason !== null)) ||
		(record.status === "released" && (record.invocationId !== null || record.operationId !== null || record.operationKind !== null || record.quarantineReason !== null)) ||
		(record.status === "in-flight" && (record.invocationId === null || record.operationId === null || record.invocationId !== record.operationId || record.operationKind === null || record.quarantineReason !== null)) ||
		(record.status === "awaiting-verification" && (record.invocationId === null || record.operationId !== null || record.operationKind !== "action" || record.quarantineReason !== null)) ||
		(record.status === "verification-in-flight" && (record.invocationId === null || record.operationId === null || record.operationKind !== "verify" || record.quarantineReason !== null)) ||
		(record.status === "quarantined" && record.quarantineReason === null)
	) {
		throw ownershipError("state-corrupt");
	}
	return record as unknown as OwnershipState;
}

function ensureSafetyDirectory(directory: string): string {
	try {
		const absoluteDirectory = path.resolve(directory);
		const root = path.parse(absoluteDirectory).root;
		let current = root;
		const components = path.relative(root, absoluteDirectory).split(path.sep).filter(Boolean);
		for (let index = 0; index < components.length; index += 1) {
			current = path.join(current, components[index]);
			let entry;
			try {
				entry = lstatSync(current);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				mkdirSync(current, { mode: 0o700 });
				entry = lstatSync(current);
			}
			if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022) !== 0) {
				throw ownershipError("lock-unavailable");
			}
			if (index === components.length - 1 && (entry.uid !== currentUid() || (entry.mode & 0o077) !== 0)) {
				throw ownershipError("lock-unavailable");
			}
		}
		return absoluteDirectory;
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("lock-unavailable");
	}
}

function verifyPrivateDirectory(directory: string): void {
	try {
		const entry = lstatSync(directory);
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			entry.uid !== currentUid() ||
			(entry.mode & 0o077) !== 0
		) {
			throw ownershipError("lock-unavailable");
		}
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("lock-unavailable");
	}
}

function verifyPrivateFile(filePath: string, maxBytes: number): void {
	try {
		const entry = lstatSync(filePath);
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			entry.uid !== currentUid() ||
			entry.nlink !== 1 ||
			(entry.mode & 0o777) !== 0o600 ||
			entry.size > maxBytes
		) {
			throw ownershipError("state-corrupt");
		}
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("state-corrupt");
	}
}

function fsyncDirectory(directory: string): void {
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

type FlockFunction = (descriptor: number, operation: number) => number;

let cachedFlock: FlockFunction | null = null;

function getFlock(): FlockFunction {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw ownershipError("lock-unavailable");
	}
	if (cachedFlock) return cachedFlock;
	try {
		const koffi = createRequire(import.meta.url)("koffi") as {
			load: (libraryPath: string) => { func: (signature: string) => unknown };
		};
		const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
		const library = koffi.load(libraryPath);
		cachedFlock = library.func("int flock(int fd, int operation)") as FlockFunction;
		return cachedFlock;
	} catch {
		throw ownershipError("lock-unavailable");
	}
}

function openKernelMutex(safetyDirectory: string): { path: string; descriptor: number } {
	const lockPath = path.join(safetyDirectory, MUTEX_FILE);
	const noFollow = fsConstants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw ownershipError("lock-unavailable");
	let descriptor: number;
	try {
		descriptor = openSync(
			lockPath,
			fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow,
			0o600,
		);
	} catch {
		throw ownershipError("lock-unavailable");
	}
	try {
		const fdStat = fstatSync(descriptor);
		const pathStat = lstatSync(lockPath);
		if (
			!fdStat.isFile() ||
			!pathStat.isFile() ||
			pathStat.isSymbolicLink() ||
			fdStat.dev !== pathStat.dev ||
			fdStat.ino !== pathStat.ino ||
			fdStat.uid !== currentUid() ||
			fdStat.nlink !== 1 ||
			(fdStat.mode & 0o777) !== 0o600
		) {
			throw ownershipError("lock-unavailable");
		}
		if (getFlock()(descriptor, LOCK_EX | LOCK_NB) !== 0) throw ownershipError("busy");
		const afterLock = lstatSync(lockPath);
		if (
			afterLock.isSymbolicLink() ||
			afterLock.dev !== fdStat.dev ||
			afterLock.ino !== fdStat.ino
		) {
			getFlock()(descriptor, LOCK_UN);
			throw ownershipError("lock-unavailable");
		}
		return { path: lockPath, descriptor };
	} catch (error) {
		closeSync(descriptor);
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("lock-unavailable");
	}
}

function releaseKernelMutex(descriptor: number): void {
	let unlockResult = -1;
	let unlockError: unknown;
	try {
		unlockResult = getFlock()(descriptor, LOCK_UN);
	} catch (error) {
		unlockError = error;
	}
	try {
		closeSync(descriptor);
	} catch (error) {
		unlockError ??= error;
	}
	if (unlockError || unlockResult !== 0) throw ownershipError("lock-unavailable");
}

function verifyKernelMutex(active: ActiveLease): void {
	try {
		const opened = fstatSync(active.lockDescriptor);
		const named = lstatSync(active.lockPath);
		if (
			!opened.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			opened.dev !== named.dev ||
			opened.ino !== named.ino ||
			opened.uid !== currentUid() ||
			opened.nlink !== 1 ||
			(opened.mode & 0o777) !== 0o600
		) {
			throw ownershipError("invalid-lease");
		}
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("invalid-lease");
	}
}

function processStartToken(pid: number): string | null {
	if (pid <= 0) return null;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
		return null;
	}
	try {
		const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,stat="], {
			encoding: "utf8",
			timeout: 1_000,
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		}).trim();
		const parts = output.split(/\s+/);
		if (parts.length < 6) return null;
		const status = parts[parts.length - 1];
		if (status.startsWith("Z")) return "dead";
		return parts.slice(0, -1).join(" ");
	} catch {
		return null;
	}
}

export function captureDesktopProcessIdentity(pid: number): DesktopProcessIdentity | null {
	const startToken = processStartToken(pid);
	if (!startToken || startToken === "dead") return null;
	return Object.freeze({ pid, startToken });
}

export function isDesktopProcessIdentityAlive(identity: DesktopProcessIdentity): boolean {
	return processStartToken(identity.pid) === identity.startToken;
}

export function isDesktopProcessIdentityExited(identity: DesktopProcessIdentity): boolean {
	const currentStart = processStartToken(identity.pid);
	return currentStart === "dead" || (currentStart !== null && currentStart !== identity.startToken);
}

function writeAtomicFile(directory: string, filePath: string, content: string, maxBytes: number): void {
	const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
	let descriptor: number | null = null;
	try {
		try {
			verifyPrivateFile(filePath, maxBytes);
		} catch (error) {
			if ((error as DesktopOwnershipError).code !== "state-corrupt") throw error;
			try {
				lstatSync(filePath);
				throw error;
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			}
		}
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, content, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		renameSync(temporaryPath, filePath);
		fsyncDirectory(directory);
	} catch (error) {
		if (descriptor !== null) closeSync(descriptor);
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The owner-only directory and journal remain fail-closed on cleanup failure.
		}
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("lock-unavailable");
	}
}

function readJournal(safetyDirectory: string): OwnershipState | null {
	const statePath = path.join(safetyDirectory, STATE_FILE);
	if (typeof fsConstants.O_NOFOLLOW !== "number") throw ownershipError("state-corrupt");
	let descriptor: number;
	try {
		descriptor = openSync(statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw ownershipError("state-corrupt");
	}
	try {
		const entry = fstatSync(descriptor);
		const named = lstatSync(statePath);
		if (
			!entry.isFile() ||
			named.isSymbolicLink() ||
			entry.dev !== named.dev ||
			entry.ino !== named.ino ||
			entry.uid !== currentUid() ||
			entry.nlink !== 1 ||
			(entry.mode & 0o777) !== 0o600 ||
			entry.size > MAX_STATE_BYTES
		) {
			throw ownershipError("state-corrupt");
		}
		const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_STATE_BYTES) throw ownershipError("state-corrupt");
		const afterRead = lstatSync(statePath);
		if (afterRead.isSymbolicLink() || afterRead.dev !== entry.dev || afterRead.ino !== entry.ino) {
			throw ownershipError("state-corrupt");
		}
		return parseOwnershipState(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown);
	} catch (error) {
		if (error instanceof DesktopOwnershipError) throw error;
		throw ownershipError("state-corrupt");
	} finally {
		closeSync(descriptor);
	}
}

function writeJournal(safetyDirectory: string, state: OwnershipState): void {
	const statePath = path.join(safetyDirectory, STATE_FILE);
	writeAtomicFile(safetyDirectory, statePath, JSON.stringify(state), MAX_STATE_BYTES);
}

function readOwnedState(active: ActiveLease, lease: DesktopOwnershipLease): OwnershipState {
	if (active.lease !== lease) throw ownershipError("invalid-lease");
	verifyKernelMutex(active);
	const state = readJournal(active.safetyDirectory);
	if (
		!state ||
		state.ownerTokenHash !== active.ownerTokenHash ||
		state.driver !== lease.driver ||
		state.scope !== lease.scope ||
		state.connectionGeneration !== lease.connectionGeneration
	) {
		throw ownershipError("invalid-lease");
	}
	return state;
}

// Do not parse option arity here: GSD, Pi, and extensions have different
// value-taking flags, so a consumed argument can hide a later noninteractive
// mode. Any explicit --print/-p or noninteractive --mode marker fails closed.
function isNonInteractiveCliInvocation(argv: readonly string[]): boolean {
	const command = argv[2];
	if (command === "headless") return true;

	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--mode") {
			const mode = argv[index + 1];
			if (mode !== "interactive") return true;
			continue;
		}
		if (argument.startsWith("--mode=") && argument.slice("--mode=".length) !== "interactive") return true;
		if (argument === "--print" || argument === "-p" || argument.startsWith("--print=")) return true;
	}
	return false;
}

export function assertDesktopDriverProcessAllowed(
	env: NodeJS.ProcessEnv,
	argv: readonly string[],
	isLocalInteractiveDesktop: boolean,
): void {
	if (
		!isLocalInteractiveDesktop ||
		env.GSD_SUBAGENT_CHILD === "1" ||
		env.GSD_PARALLEL_WORKER === "1" ||
		env.GSD_HEADLESS === "1" ||
		argv.some((argument) => argument === "headless") ||
		isNonInteractiveCliInvocation(argv)
	) {
		throw ownershipError("child-process");
	}
}

export function createDesktopOwnershipManager(requestedSafetyDirectory?: string): DesktopOwnershipManager {
	let safetyDirectory: string | null = null;
	let active: ActiveLease | null = null;
	const terminalEvidence = new WeakMap<object, TerminalEvidenceRecord>();

	function getSafetyDirectory(): string {
		if (!safetyDirectory) safetyDirectory = ensureSafetyDirectory(requestedSafetyDirectory ?? defaultSafetyDirectory());
		return safetyDirectory;
	}

	function assertActiveLease(lease: DesktopOwnershipLease): ActiveLease {
		if (!active || active.lease !== lease) throw ownershipError("invalid-lease");
		return active;
	}

	return {
		acquire(driver, scope, requestedGeneration) {
			if (active) throw ownershipError("busy");
			const safeDirectory = getSafetyDirectory();
			const mutex = openKernelMutex(safeDirectory);
			const lockPath = mutex.path;
			const lockDescriptor = mutex.descriptor;
			const processStart = processStartToken(process.pid);
			if (!processStart || processStart === "dead") {
				releaseKernelMutex(lockDescriptor);
				throw ownershipError("lock-unavailable");
			}
			const ownerTokenHash = createHash("sha256").update(randomUUID()).digest("hex");

			let priorState: OwnershipState | null;
			try {
				priorState = readJournal(safeDirectory);
			} catch (error) {
				try {
					releaseKernelMutex(lockDescriptor);
				} catch {
					// The invalid journal remains the durable fail-closed gate.
				}
				throw error;
			}
			if (priorState && priorState.status !== "released") {
				const quarantine: OwnershipState = {
					...priorState,
					status: "quarantined",
					quarantineReason: priorState.quarantineReason ?? "stale-owner",
				};
				try {
					writeJournal(safeDirectory, quarantine);
				} finally {
					releaseKernelMutex(lockDescriptor);
				}
				throw ownershipError("quarantined");
			}

			const lease: DesktopOwnershipLease = Object.freeze({
				driver,
				scope,
				connectionGeneration: requestedGeneration ?? randomUUID(),
			});
			const initialState: OwnershipState = {
				version: 1,
				ownerTokenHash,
				ownerPid: process.pid,
				ownerProcessStart: processStart,
				driver,
				scope,
				connectionGeneration: lease.connectionGeneration,
				status: "active",
				invocationId: null,
				operationId: null,
				operationKind: null,
				quarantineReason: null,
			};
			try {
				writeJournal(safeDirectory, initialState);
			} catch (error) {
				try {
					releaseKernelMutex(lockDescriptor);
				} catch {
					// No dispatch occurred; the journal failure itself denies future access.
				}
				throw error;
			}
			active = {
				lease,
				ownerTokenHash,
				safetyDirectory: safeDirectory,
				lockPath,
				lockDescriptor,
				lastTerminalOperationId: null,
				lastTerminalKind: null,
			};
			return lease;
		},

		currentLease() {
			return active?.lease ?? null;
		},

		beginOperation(lease, kind) {
			const current = assertActiveLease(lease);
			const state = readOwnedState(current, lease);
			if (state.status === "quarantined") throw ownershipError("quarantined");
			if (state.status === "awaiting-verification" && kind !== "verify") {
				throw ownershipError("verification-required");
			}
			if (state.status !== "active" && state.status !== "awaiting-verification") {
				throw ownershipError("in-flight");
			}
			const operationId = randomUUID();
			const verification = state.status === "awaiting-verification";
			const invocationId = verification ? state.invocationId : operationId;
			writeJournal(current.safetyDirectory, {
				...state,
				status: verification ? "verification-in-flight" : "in-flight",
				invocationId,
				operationId,
				operationKind: kind,
				quarantineReason: null,
			});
			current.lastTerminalOperationId = null;
			current.lastTerminalKind = null;
			return operationId;
		},

		completeOperation(lease, operationId, options = {}) {
			const current = assertActiveLease(lease);
			const state = readOwnedState(current, lease);
			if (state.status === "quarantined") throw ownershipError("quarantined");
			if (state.status !== "in-flight" || state.operationId !== operationId || !state.operationKind) {
				throw ownershipError("in-flight");
			}
			if (options.requiresVerification && state.operationKind !== "action") {
				throw ownershipError("invalid-lease");
			}
			const unresolved = options.requiresVerification === true;
			writeJournal(current.safetyDirectory, {
				...state,
				status: unresolved ? "awaiting-verification" : "active",
				invocationId: unresolved ? operationId : null,
				operationId: null,
				operationKind: unresolved ? "action" : null,
				quarantineReason: null,
			});
			const evidence = Object.freeze({ kind: state.operationKind });
			terminalEvidence.set(evidence, { lease, invocationId: operationId, kind: state.operationKind });
			current.lastTerminalOperationId = operationId;
			current.lastTerminalKind = state.operationKind;
			return evidence;
		},

		completeVerification(lease, verificationId, matched) {
			const current = assertActiveLease(lease);
			const state = readOwnedState(current, lease);
			if (
				state.status !== "verification-in-flight" ||
				state.operationId !== verificationId ||
				!state.invocationId
			) {
				throw ownershipError("in-flight");
			}
			if (!matched) {
				writeJournal(current.safetyDirectory, {
					...state,
					status: "quarantined",
					quarantineReason: "terminal-unverified",
				});
				throw ownershipError("quarantined");
			}
			writeJournal(current.safetyDirectory, {
				...state,
				status: "active",
				invocationId: null,
				operationId: null,
				operationKind: null,
				quarantineReason: null,
			});
			const evidence = Object.freeze({ kind: "verify" as const });
			terminalEvidence.set(evidence, { lease, invocationId: verificationId, kind: "verify" });
			current.lastTerminalOperationId = verificationId;
			current.lastTerminalKind = "verify";
			return evidence;
		},

		quarantine(lease, operationId, reason) {
			const current = assertActiveLease(lease);
			const state = readOwnedState(current, lease);
			if (
				(state.status === "in-flight" || state.status === "verification-in-flight") &&
				operationId !== null &&
				state.operationId !== operationId
			) {
				throw ownershipError("invalid-lease");
			}
			if (state.status === "quarantined") return;
			writeJournal(current.safetyDirectory, {
				...state,
				status: "quarantined",
				invocationId: state.invocationId ?? operationId,
				operationId: state.operationId,
				quarantineReason: reason,
			});
		},

		release(lease, evidence) {
			const current = assertActiveLease(lease);
			const state = readOwnedState(current, lease);
			if (state.status === "quarantined") throw ownershipError("quarantined");
			if (state.status !== "active" || state.invocationId !== null || state.operationId !== null) {
				throw ownershipError(state.status === "awaiting-verification" ? "verification-required" : "in-flight");
			}
			const evidenceRecord = terminalEvidence.get(evidence as object);
			if (
				!evidenceRecord ||
				evidenceRecord.lease !== lease ||
				evidenceRecord.invocationId !== current.lastTerminalOperationId ||
				evidenceRecord.kind !== current.lastTerminalKind ||
				(lease.scope === "session" && evidenceRecord.kind !== "session-end" && evidenceRecord.kind !== "connection-close")
			) {
				throw ownershipError("terminal-evidence-required");
			}
			const releasedState: OwnershipState = {
				...state,
				status: "released",
				invocationId: null,
				operationId: null,
				operationKind: null,
				quarantineReason: null,
			};
			writeJournal(current.safetyDirectory, releasedState);
			releaseKernelMutex(current.lockDescriptor);
			active = null;
		},
	};
}

export const desktopOwnershipManager = createDesktopOwnershipManager();

export function withDesktopOperation<T>(
	driver: DesktopDriver,
	kind: DesktopOperationKind,
	execute: () => T,
	manager: DesktopOwnershipManager = desktopOwnershipManager,
	isInteractive: boolean = false,
): T {
	assertDesktopDriverProcessAllowed(process.env, process.argv, isInteractive);
	let lease = manager.currentLease();
	let acquiredHere = false;
	if (!lease) {
		lease = manager.acquire(driver, "operation");
		acquiredHere = true;
	} else if (lease.driver !== driver) {
		throw ownershipError("busy");
	}

	const operationId = manager.beginOperation(lease, kind);
	try {
		const result = execute();
		const evidence = manager.completeOperation(lease, operationId);
		if (acquiredHere) manager.release(lease, evidence);
		return result;
	} catch (error) {
		try {
			manager.quarantine(lease, operationId, "dispatch-uncertain");
		} catch {
			// The persisted in-flight state still prevents another process from acquiring the desktop.
		}
		throw error;
	}
}
