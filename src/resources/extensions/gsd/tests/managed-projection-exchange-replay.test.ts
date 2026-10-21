// Journaled exchange replay convergence tests.
// File Purpose: Verifies that resumeProjectionExchange reconciles persisted
// exchange state against current disk state before replaying it, and that
// deterministic replay failures degrade to retained evidence instead of
// wedging the journal (#2193, #2108).

import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireProjectionRootIdentityLock,
  type ProjectionRootIdentityLock,
} from "@gsd/native/file-identity";

import {
  _recoverManagedProjectionMutationsForTest,
  loadManagedProjectionPaths,
  loadUnboundProjectionEvidence,
} from "../managed-projection-history.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";

interface ExchangeFixture {
  base: string;
  rootPath: string;
  logicalPath: string;
  temporaryPath: string;
  replacementPath: string;
  guardPath: string;
  journalPath: string;
  placeholderIdentity: string;
  temporaryIdentity: string;
  replacementIdentity: string;
  guardIdentity: string;
}

// Builds the on-disk state of a write mutation interrupted between its two
// journaled exchanges: the canonical target holds the empty placeholder from
// the first swap, the displaced canonical content sits in the replacement
// slot, and the staging temp holds the intended content. The journal claims
// the second swap (left = target placeholder, right = staging temp) is still
// in flight.
function prepareExchangeFixture(prefix: string): ExchangeFixture {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const rootPath = join(base, ".gsd");
  mkdirSync(join(rootPath, "notes"), { recursive: true });
  assert.equal(openDatabase(join(rootPath, "gsd.db")), true);
  const logicalPath = "notes/result.md";
  const temporaryPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
  const replacementPath = `${temporaryPath}.replaced`;
  const guardPath = "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000002";
  const journalPath = join(
    rootPath,
    "migration",
    "projection-mutations",
    "00000000-0000-0000-0000-000000000003.json",
  );
  const stat = lstatSync(rootPath, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(rootPath, stat.dev.toString(), stat.ino.toString());
  try {
    const placeholderIdentity = handle.prepareFileTemporary(logicalPath, Buffer.alloc(0));
    const scratch = join(rootPath, "notes", ".gsd-projection-tmp-00000000-0000-0000-0000-000000000004");
    writeFileSync(scratch, "reviewed\n");
    renameSync(scratch, join(rootPath, replacementPath));
    const replacementIdentity = handle.pathIdentity(replacementPath);
    const temporaryIdentity = handle.prepareFileTemporary(temporaryPath, Buffer.from("replacement\n"));
    const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
    return {
      base,
      rootPath,
      logicalPath,
      temporaryPath,
      replacementPath,
      guardPath,
      journalPath,
      placeholderIdentity,
      temporaryIdentity,
      replacementIdentity,
      guardIdentity,
    };
  } finally {
    handle.close();
  }
}

function cleanupFixture(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function writeExchangeJournal(
  fixture: ExchangeFixture,
  overrides: {
    temporaryPath?: string;
    temporaryIdentity?: string;
    exchangeState?: Record<string, string>;
  } = {},
): void {
  const temporaryPath = overrides.temporaryPath ?? fixture.temporaryPath;
  const temporaryIdentity = overrides.temporaryIdentity ?? fixture.temporaryIdentity;
  mkdirSync(join(fixture.rootPath, "migration", "projection-mutations"), { recursive: true });
  writeFileSync(fixture.journalPath, `${JSON.stringify({
    logicalPath: fixture.logicalPath,
    operation: "write",
    legacyCleanup: false,
    content: Buffer.from("replacement\n").toString("base64"),
    encoding: "base64",
    temporaryPath,
    temporaryIdentity,
    replacementPath: `${fixture.temporaryPath}.replaced`,
    replacementIdentity: fixture.replacementIdentity,
    quarantinePath: null,
    quarantineIdentity: null,
    placeholderIdentity: fixture.placeholderIdentity,
    exchangeGuardPath: fixture.guardPath,
    exchangeGuardIdentity: fixture.guardIdentity,
    exchangeState: overrides.exchangeState ?? {
      leftPath: fixture.logicalPath,
      rightPath: temporaryPath,
      leftIdentity: fixture.placeholderIdentity,
      rightIdentity: temporaryIdentity,
      guardPath: fixture.guardPath,
      guardIdentity: fixture.guardIdentity,
    },
  })}\n`);
}

// A real identity-lock handle whose exchangePaths fails with the given error,
// exactly as the native engine reports a deterministic or transient exchange
// failure. Every other operation is forwarded to the real handle so evidence
// retention, journal writes, and digests run against real disk state.
function handleFailingExchangePaths(
  rootPath: string,
  fault: Error,
): ProjectionRootIdentityLock {
  const stat = lstatSync(rootPath, { bigint: true });
  const real = acquireProjectionRootIdentityLock(rootPath, stat.dev.toString(), stat.ino.toString());
  return new Proxy(real, {
    get(target, property): unknown {
      if (property === "exchangePaths") return () => { throw fault; };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

test("converged journaled exchange replay retires the entry without re-exchanging", (t) => {
  const fixture = prepareExchangeFixture("gsd-exchange-replay-converged-");
  t.after(() => cleanupFixture(fixture.base));

  // The swap already landed on disk; only the clearing persist never ran. A
  // racer then placed an unexpected occupant on the (normally consumed) guard
  // path, so a blind replay would fail on the guard identity.
  const stat = lstatSync(fixture.rootPath, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(fixture.rootPath, stat.dev.toString(), stat.ino.toString());
  try {
    handle.exchangePaths(
      fixture.logicalPath,
      fixture.temporaryPath,
      fixture.placeholderIdentity,
      fixture.temporaryIdentity,
      fixture.guardPath,
      fixture.guardIdentity,
    );
  } finally {
    handle.close();
  }
  writeFileSync(join(fixture.rootPath, fixture.guardPath), "racing occupant\n");
  writeExchangeJournal(fixture);

  assert.ok(loadManagedProjectionPaths(fixture.base).includes(fixture.logicalPath));
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), "replacement\n");
  assert.equal(existsSync(fixture.journalPath), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("journaled exchange replay re-binds drifted staging identity when content matches", (t) => {
  const fixture = prepareExchangeFixture("gsd-exchange-replay-rebind-");
  t.after(() => cleanupFixture(fixture.base));

  // Same staging content under a new identity (the volume-serial flip shape).
  const scratch = join(fixture.rootPath, "notes", ".gsd-projection-tmp-00000000-0000-0000-0000-000000000005");
  writeFileSync(scratch, "replacement\n");
  renameSync(scratch, join(fixture.rootPath, fixture.temporaryPath));
  writeExchangeJournal(fixture);

  assert.ok(loadManagedProjectionPaths(fixture.base).includes(fixture.logicalPath));
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), "replacement\n");
  assert.equal(existsSync(fixture.journalPath), false);
  assert.equal(existsSync(join(fixture.rootPath, fixture.temporaryPath)), false);
  assert.equal(existsSync(join(fixture.rootPath, fixture.replacementPath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("journaled exchange replay re-stages diverged staging content under a fresh path", (t) => {
  const fixture = prepareExchangeFixture("gsd-exchange-replay-restage-");
  t.after(() => cleanupFixture(fixture.base));

  // Staging content diverged: the journal cannot prove what the temp holds.
  const scratch = join(fixture.rootPath, "notes", ".gsd-projection-tmp-00000000-0000-0000-0000-000000000005");
  writeFileSync(scratch, "tampered\n");
  renameSync(scratch, join(fixture.rootPath, fixture.temporaryPath));
  writeExchangeJournal(fixture);

  assert.ok(loadManagedProjectionPaths(fixture.base).includes(fixture.logicalPath));
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), "replacement\n");
  assert.equal(existsSync(fixture.journalPath), false);
  // The diverged staging artifact and the displaced replacement stay on disk
  // as reviewable evidence instead of being silently discarded.
  assert.equal(existsSync(join(fixture.rootPath, fixture.temporaryPath)), true);
  assert.deepEqual(
    loadUnboundProjectionEvidence(fixture.base).map((entry) => entry.evidencePath).sort(),
    [fixture.temporaryPath, fixture.replacementPath].sort(),
  );
});

test("deterministic journaled exchange failure retains evidence and retires the entry on first failure", (t) => {
  const fixture = prepareExchangeFixture("gsd-exchange-replay-identity-changed-");
  t.after(() => cleanupFixture(fixture.base));
  writeExchangeJournal(fixture);

  const fault = new Error("projection identity changed during journaled exchange");
  assert.throws(
    () => _recoverManagedProjectionMutationsForTest(
      () => handleFailingExchangePaths(fixture.rootPath, fault),
      fixture.base,
    ),
    /managed projection target identity changed; recovery evidence retained/u,
  );
  assert.equal(existsSync(fixture.journalPath), false);
  assert.deepEqual(
    loadUnboundProjectionEvidence(fixture.base).map((entry) => entry.evidencePath).sort(),
    [fixture.logicalPath, fixture.temporaryPath, fixture.replacementPath, fixture.guardPath].sort(),
  );
});

test("transient journaled exchange failure keeps the entry and propagates for retry", (t) => {
  const fixture = prepareExchangeFixture("gsd-exchange-replay-transient-");
  t.after(() => cleanupFixture(fixture.base));
  writeExchangeJournal(fixture);

  const fault = new Error("projection root operation failed: sharing violation (os error 32)");
  assert.throws(
    () => _recoverManagedProjectionMutationsForTest(
      () => handleFailingExchangePaths(fixture.rootPath, fault),
      fixture.base,
    ),
    (error: unknown) => error === fault,
  );
  assert.equal(existsSync(fixture.journalPath), true);
  const replayed = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as { exchangeState: unknown };
  assert.notEqual(replayed.exchangeState, null);

  // The retained entry stays owned by the existing retry schedule: the next
  // recovery pass without the fault converges and retires it.
  assert.ok(loadManagedProjectionPaths(fixture.base).includes(fixture.logicalPath));
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), "replacement\n");
  assert.equal(existsSync(fixture.journalPath), false);
});
