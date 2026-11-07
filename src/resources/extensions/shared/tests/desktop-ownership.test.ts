import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import {
	assertDesktopDriverProcessAllowed,
	captureDesktopProcessIdentity,
	createDesktopOwnershipManager,
	DesktopOwnershipError,
	isDesktopProcessIdentityAlive,
	isDesktopProcessIdentityExited,
	type DesktopProcessIdentity,
	type DesktopTerminalEvidence,
	withDesktopOperation,
} from "../desktop-ownership.ts";

function makeLockDirectory(): string {
	return mkdtempSync(path.join(userInfo().homedir, "gsd-desktop-ownership-"));
}

function cleanupLockDirectory(safetyDirectory: string): void {
	rmSync(safetyDirectory, { recursive: true, force: true });
}

const supportsPosixDesktopOwnership =
	(process.platform === "darwin" || process.platform === "linux") && typeof process.getuid === "function";
const posixLockSkipReason =
	supportsPosixDesktopOwnership && existsSync("/bin/ps")
		? undefined
		: "Requires Darwin/Linux flock, process.getuid, and /bin/ps";
const processLivenessSkipReason = posixLockSkipReason;

describe("desktop ownership manager", () => {
	test("does not touch the ownership path until a lease is requested", (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));

		createDesktopOwnershipManager(lockDirectory);
		assert.equal(existsSync(path.join(lockDirectory, "state.json")), false);
		assert.equal(existsSync(path.join(lockDirectory, "desktop-ownership.lock")), false);
	});

	test("rejects symlinked safety directories and journals", { skip: posixLockSkipReason }, (t) => {
		const baseDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(baseDirectory));
		const targetDirectory = path.join(baseDirectory, "target");
		mkdirSync(targetDirectory, { mode: 0o700 });
		const linkedDirectory = path.join(baseDirectory, "linked");
		symlinkSync(targetDirectory, linkedDirectory);
		assert.throws(
			() => createDesktopOwnershipManager(linkedDirectory).acquire("mac-tools", "operation"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "lock-unavailable",
		);

		const journalDirectory = path.join(baseDirectory, "journal");
		mkdirSync(journalDirectory, { mode: 0o700 });
		const targetFile = path.join(baseDirectory, "external-state");
		writeFileSync(targetFile, "{}", { mode: 0o600 });
		symlinkSync(targetFile, path.join(journalDirectory, "state.json"));
		assert.throws(
			() => createDesktopOwnershipManager(journalDirectory).acquire("mac-tools", "operation"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "state-corrupt",
		);
	});

	test("serializes independent managers using the same lock directory", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const owner = createDesktopOwnershipManager(lockDirectory);
		const contender = createDesktopOwnershipManager(lockDirectory);
		const lease = owner.acquire("cmux-cua", "session");
		const endSessionId = owner.beginOperation(lease, "session-end");
		const endSessionEvidence = owner.completeOperation(lease, endSessionId);
		const moduleUrl = new URL("../desktop-ownership.ts", import.meta.url).href;
		const childScript = [
			`import { createDesktopOwnershipManager } from ${JSON.stringify(moduleUrl)};`,
			"const manager = createDesktopOwnershipManager(process.argv[1]);",
			"try { manager.acquire('mac-tools', 'operation'); process.exit(1); }",
			"catch (error) { process.exit(error?.code === 'busy' ? 0 : 2); }",
		].join("\n");
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childScript, lockDirectory], {
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.equal(child.status, 0, child.stderr);

		owner.release(lease, endSessionEvidence);
		const nextLease = contender.acquire("mac-tools", "operation");
		const operationId = contender.beginOperation(nextLease, "inspect");
		const terminalEvidence = contender.completeOperation(nextLease, operationId);
		contender.release(nextLease, terminalEvidence);
	});

	test("requires a terminal operation result before releasing a lease", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);
		const lease = manager.acquire("mac-tools", "operation");
		const operationId = manager.beginOperation(lease, "action");

		assert.throws(
			() => manager.release(lease, {} as DesktopTerminalEvidence),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "in-flight",
		);
		const evidence = manager.completeOperation(lease, operationId);
		assert.throws(
			() => manager.release(lease, {} as DesktopTerminalEvidence),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "terminal-evidence-required",
		);
		manager.release(lease, evidence);
	});

	test("quarantines uncertain work across manager instances", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const owner = createDesktopOwnershipManager(lockDirectory);
		const contender = createDesktopOwnershipManager(lockDirectory);
		const lease = owner.acquire("cmux-cua", "session");
		const operationId = owner.beginOperation(lease, "action");

		owner.quarantine(lease, operationId, "dispatch-uncertain");
		assert.throws(
			() => owner.release(lease, {} as DesktopTerminalEvidence),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "quarantined",
		);
		assert.throws(
			() => contender.acquire("mac-tools", "operation"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "busy",
		);
	});

	test("reclaims a dead-process mutex but preserves durable quarantine", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const moduleUrl = new URL("../desktop-ownership.ts", import.meta.url).href;
		const childScript = [
			`import { createDesktopOwnershipManager } from ${JSON.stringify(moduleUrl)};`,
			"const manager = createDesktopOwnershipManager(process.argv[1]);",
			"const lease = manager.acquire('cmux-cua', 'session');",
			"manager.beginOperation(lease, 'action');",
			"process.exit(0);",
		].join("\n");
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childScript, lockDirectory], {
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.equal(child.status, 0, child.stderr);

		const manager = createDesktopOwnershipManager(lockDirectory);
		assert.throws(
			() => manager.acquire("mac-tools", "operation"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "quarantined",
		);
		const state = JSON.parse(readFileSync(path.join(lockDirectory, "state.json"), "utf8")) as {
			status: string;
			quarantineReason: string | null;
		};
		assert.equal(state.status, "quarantined");
		assert.equal(state.quarantineReason, "stale-owner");
		assert.throws(
			() => manager.acquire("cmux-cua", "session"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "quarantined",
		);
	});

	test("blocks new actions until a dispatched action has an observed postcondition", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);
		const lease = manager.acquire("cmux-cua", "session");
		const actionId = manager.beginOperation(lease, "action");
		manager.completeOperation(lease, actionId, { requiresVerification: true });

		assert.throws(
			() => manager.beginOperation(lease, "action"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "verification-required",
		);
		const verificationId = manager.beginOperation(lease, "verify");
		manager.completeVerification(lease, verificationId, true);
		const endSessionId = manager.beginOperation(lease, "session-end");
		const endEvidence = manager.completeOperation(lease, endSessionId);
		manager.release(lease, endEvidence);
	});

	test("quarantines a contradicted postcondition", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);
		const lease = manager.acquire("cmux-cua", "session");
		const actionId = manager.beginOperation(lease, "action");
		manager.completeOperation(lease, actionId, { requiresVerification: true });
		const verificationId = manager.beginOperation(lease, "verify");

		assert.throws(
			() => manager.completeVerification(lease, verificationId, false),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "quarantined",
		);
		assert.throws(
			() => manager.beginOperation(lease, "action"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "quarantined",
		);
	});

	test("fails closed before lease access when trusted local admission is omitted", (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);
		let executed = false;

		assert.throws(
			() => withDesktopOperation("mac-tools", "inspect", () => { executed = true; }, manager),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
		assert.equal(executed, false);
		assert.equal(manager.currentLease(), null);
	});

	test("releases an operation-scoped lease only after a validated callback returns", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);
		const result = withDesktopOperation("mac-tools", "inspect", () => "terminal-result", manager, true);
		assert.equal(result, "terminal-result");
		assert.equal(manager.currentLease(), null);
	});

	test("keeps ownership quarantined when an operation outcome is uncertain", { skip: posixLockSkipReason }, (t) => {
		const lockDirectory = makeLockDirectory();
		t.after(() => cleanupLockDirectory(lockDirectory));
		const manager = createDesktopOwnershipManager(lockDirectory);

		assert.throws(() => {
			withDesktopOperation("mac-tools", "action", () => {
				throw new Error("simulated uncertain dispatch");
			}, manager, true);
		});
		assert.throws(
			() => manager.acquire("cmux-cua", "session"),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "busy",
		);
	});
});

describe("desktop driver process admission", () => {
	test("binds process liveness to the captured PID generation", { skip: processLivenessSkipReason }, () => {
		const identity = captureDesktopProcessIdentity(process.pid);
			assert.ok(identity);
		assert.equal(isDesktopProcessIdentityAlive(identity), true);
		assert.equal(isDesktopProcessIdentityExited(identity), false);
		const staleGeneration = { ...identity, startToken: `${identity.startToken}-stale` } satisfies DesktopProcessIdentity;
		assert.equal(isDesktopProcessIdentityAlive(staleGeneration), false);
		assert.equal(isDesktopProcessIdentityExited(staleGeneration), true);
	});

	test("rejects standard subagent and parallel-worker processes", () => {
		assert.throws(
			() => assertDesktopDriverProcessAllowed({ GSD_SUBAGENT_CHILD: "1" }, [], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
		assert.throws(
			() => assertDesktopDriverProcessAllowed({ GSD_PARALLEL_WORKER: "1" }, [], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
	});

	test("rejects direct headless workers even if a marker is missing", () => {
		assert.throws(
			() => assertDesktopDriverProcessAllowed({}, ["/path/to/gsd", "headless", "--json", "auto"], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
	});

	test("rejects GSD-owned headless RPC children and non-interactive CLI entry points", () => {
		const blockedInvocations: Array<[NodeJS.ProcessEnv, string[]]> = [
			[{ GSD_HEADLESS: "1" }, ["node", "rpc-client.js", "--mode", "rpc"]],
			[{}, ["node", "gsd.js", "--print", "prompt"]],
			[{}, ["node", "pi.js", "-p", "prompt"]],
			[{}, ["node", "gsd.js", "--append-system-prompt", "--", "--mode", "rpc"]],
			[{}, ["node", "gsd.js", "--append-system-prompt", "--", "--print"]],
			[{}, ["node", "pi.js", "--host", "--print", "prompt"]],
			[{}, ["node", "pi.js", "--host", "--mode", "rpc"]],
			[{}, ["node", "gsd.js", "--host", "--append-system-prompt", "--print", "prompt"]],
			[{}, ["node", "gsd.js", "--host", "--model", "--mode", "rpc"]],
			[{}, ["node", "pi.js", "--system-prompt", "--append-system-prompt", "--print", "prompt"]],
			[{}, ["node", "pi.js", "--system-prompt", "--model", "--mode", "rpc"]],
			[{}, ["node", "pi.js", "-e", "--append-system-prompt", "--print", "prompt"]],
			[{}, ["node", "pi.js", "--mode", "rpc"]],
			[{}, ["node", "pi.js", "--mode=text"]],
			[{}, ["node", "pi.js", "--system-prompt", "--", "--mode", "rpc"]],
			[{}, ["node", "pi.js", "--system-prompt", "--", "--print"]],
			[{}, ["node", "pi.js", "--", "--mode", "rpc"]],
			[{}, ["node", "pi.js", "--", "--print"]],
		];
		for (const [env, argv] of blockedInvocations) {
			assert.throws(
				() => assertDesktopDriverProcessAllowed(env, argv, true),
				(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
			);
		}
	});

	test("fails closed when a consumed prompt value resembles a non-interactive flag", () => {
		assert.throws(
			() => assertDesktopDriverProcessAllowed({}, ["node", "gsd.js", "--append-system-prompt", "--print"], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
		assert.throws(
			() => assertDesktopDriverProcessAllowed({}, ["node", "pi.js", "-e", "--append-system-prompt", "--print"], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
		assert.doesNotThrow(() => assertDesktopDriverProcessAllowed({}, ["node", "gsd.js", "--append-system-prompt", "safe prompt"], true));
	});

	test("fails closed when parser-specific values resemble non-interactive flags", () => {
		assert.throws(
			() => assertDesktopDriverProcessAllowed({}, ["node", "pi.js", "--system-prompt", "--print"], true),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
	});

	test("allows terminal-supervised auto and blocks auto without an interactive TTY", () => {
		assert.doesNotThrow(() => assertDesktopDriverProcessAllowed({}, ["node", "gsd.js", "auto"], true));
		assert.throws(
			() => assertDesktopDriverProcessAllowed({}, ["node", "gsd.js", "auto"], false),
			(error: unknown) => error instanceof DesktopOwnershipError && error.code === "child-process",
		);
	});
});
