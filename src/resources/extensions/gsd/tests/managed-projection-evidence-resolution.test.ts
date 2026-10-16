// Recovery-evidence resolution without the native projection lock, and
// interrupted-resolution retry (#2815). File Purpose: verifies that once the
// ProjectionRootIdentityLock health latch degrades the store to plain fs
// (#2489), file-scoped retained evidence stays fully resolvable through
// resolveUnboundProjectionEvidence (discard/preserve/restore) with the native
// path's byte-verification guarantees; that a resolving record from a crashed
// attempt stays enumerable and safely resolvable instead of poisoning the
// index; and that a prepared native-mode resolution whose guard/exchange
// artifacts were removed converges on replay instead of wedging every managed
// open. The degraded cases run in native-enabled CI by tripping the real latch
// in process (and under GSD_NATIVE_DISABLE=1 they degrade naturally).

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  _latchProjectionRootIdentityLockForTest,
  _resetProjectionRootIdentityLockHealthForTest,
  isProjectionRootIdentityLockAvailable,
} from "@gsd/native/file-identity";

import {
  _setUnboundEvidenceExchangeFaultForTest,
  loadUnboundProjectionEvidence,
  previewUnboundProjectionEvidenceResolution,
  resolveUnboundProjectionEvidence,
  type UnboundProjectionEvidenceResolutionAction,
} from "../managed-projection-history.ts";

const nativeMode = isProjectionRootIdentityLockAvailable();

// With the addon present, trip the real health latch so every
// isProjectionRootIdentityLockAvailable() gate degrades exactly as it does
// after 3 consecutive transient failures; without it the store is already
// degraded. Reset afterwards so the latch never leaks between tests.
function degradeForTest(t: import("node:test").TestContext): void {
  if (isProjectionRootIdentityLockAvailable()) _latchProjectionRootIdentityLockForTest();
  t.after(() => _resetProjectionRootIdentityLockHealthForTest());
}

const REVIEWED = "reviewed evidence bytes\n";

interface EvidenceFixture {
  base: string;
  rootPath: string;
  logicalPath: string;
  evidencePath: string;
  evidenceId: string;
  contentDigest: string;
  indexPath: string;
}

// Seeds a retained file-scope evidence record the way the persisted index
// stores it, mirroring the engine's evidenceId/digest derivations.
function seedEvidenceFixture(prefix: string): EvidenceFixture {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const rootPath = join(base, ".gsd");
  const logicalPath = "notes/result.md";
  const evidencePath = `notes/.gsd-projection-remove-${randomUUID()}`;
  const indexPath = join(rootPath, "migration", "unbound-projection-evidence.json");
  mkdirSync(dirname(join(rootPath, evidencePath)), { recursive: true });
  writeFileSync(join(rootPath, evidencePath), REVIEWED);
  const stat = lstatSync(join(rootPath, evidencePath), { bigint: true });
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath, kind: "quarantine", logicalPath, scope: "file" }))
    .digest("hex")}`;
  const contentDigest = `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`;
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify([{
    evidenceId,
    evidencePath,
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest,
    kind: "quarantine",
    logicalPath,
    scope: "file",
    transition: "retained",
  }])}\n`);
  return { base, rootPath, logicalPath, evidencePath, evidenceId, contentDigest, indexPath };
}

function cleanupFixture(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function readIndex(base: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(
    join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
    "utf8",
  )) as Array<Record<string, unknown>>;
}

test("degraded file-scope discard verifies the reviewed bytes before removal", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-discard-");
  t.after(() => cleanupFixture(fixture.base));

  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  assert.equal(preview.destinationPath, null);

  // Bytes diverging from the reviewed content must refuse and survive.
  writeFileSync(join(fixture.rootPath, fixture.evidencePath), "tampered\n");
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /consent does not match the reviewed content/u,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), "tampered\n");
  assert.equal(loadUnboundProjectionEvidence(fixture.base).length, 1);

  // The exact reviewed bytes consent to the discard.
  writeFileSync(join(fixture.rootPath, fixture.evidencePath), REVIEWED);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "discard", preview.consent);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded restore republishes the reviewed bytes and resolves", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-restore-");
  t.after(() => cleanupFixture(fixture.base));

  const destination = join(fixture.rootPath, fixture.logicalPath);
  // An occupied destination with different content refuses, unchanged.
  mkdirSync(join(fixture.rootPath, "notes"), { recursive: true });
  writeFileSync(destination, "current render\n");
  const blocked = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "restore",
  );
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "restore",
      blocked.consent,
    ),
    /destination already contains different content/u,
  );
  assert.equal(readFileSync(destination, "utf8"), "current render\n");
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), true);

  // With the target free, restore lands the reviewed bytes and retires the record.
  unlinkSync(destination);
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "restore",
  );
  assert.equal(preview.destinationPath, fixture.logicalPath);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "restore", preview.consent);
  assert.equal(readFileSync(destination, "utf8"), REVIEWED);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded preserve retains the reviewed bytes under migration and resolves", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-preserve-");
  t.after(() => cleanupFixture(fixture.base));

  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "preserve",
  );
  assert.match(preview.destinationPath ?? "", /^migration\/preserved-projection-evidence\//u);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "preserve", preview.consent);
  assert.equal(
    readFileSync(join(fixture.rootPath, preview.destinationPath!), "utf8"),
    REVIEWED,
  );
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded canonical restore retires the record in place after verification", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-canonical-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(join(rootPath, "state.md"), REVIEWED);
  const stat = lstatSync(join(rootPath, "state.md"), { bigint: true });
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: "state.md", kind: "canonical", logicalPath: "state.md", scope: "file" }))
    .digest("hex")}`;
  writeFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
    evidenceId,
    evidencePath: "state.md",
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest: `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`,
    kind: "canonical",
    logicalPath: "state.md",
    scope: "file",
    transition: "retained",
  }])}\n`);

  const preview = previewUnboundProjectionEvidenceResolution(base, evidenceId, "restore");
  assert.equal(preview.destinationPath, "state.md");
  resolveUnboundProjectionEvidence(base, evidenceId, "restore", preview.consent);
  // The reviewed bytes stay in place; only the protecting record retires.
  assert.equal(readFileSync(join(rootPath, "state.md"), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("a canonical restore replay keeps the restored bytes in place", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-canonical-replay-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(join(rootPath, "state.md"), REVIEWED);
  const stat = lstatSync(join(rootPath, "state.md"), { bigint: true });
  const digest = `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`;
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: "state.md", kind: "canonical", logicalPath: "state.md", scope: "file" }))
    .digest("hex")}`;
  // A crash after the deleting marker of a canonical restore: destination and
  // evidence path are the same file. The replay must retire the record
  // without unlinking the restored bytes it just verified.
  writeFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
    evidenceId,
    evidencePath: "state.md",
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest: digest,
    kind: "canonical",
    logicalPath: "state.md",
    scope: "file",
    transition: "resolving",
    resolution: {
      action: "restore",
      currentIdentity: `${stat.dev}:${stat.ino}`,
      contentDigest: digest,
      destinationPath: "state.md",
      guardPath: ".gsd-projection-remove-11111111-2222-4333-8444-555555555555",
      guardIdentity: null,
      stagingPath: null,
      stagingIdentity: null,
      exchangePath: ".gsd-projection-exchange-11111111-2222-4333-8444-555555555555",
      exchangeIdentity: null,
      phase: "deleting",
    },
  }])}\n`);

  resolveUnboundProjectionEvidence(
    base,
    evidenceId,
    "restore",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(readFileSync(join(rootPath, "state.md"), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("the in-flight gate roots the exchange artifact under the projection root", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-gate-root-");
  t.after(() => cleanupFixture(fixture.base));

  const exchangePath = `notes/.gsd-projection-exchange-${randomUUID()}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "exchange placeholder\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      "discard:sha256:0",
    ),
    /in-flight evidence resolution/u,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), REVIEWED);
});

test("a mid-rotation missing guard placeholder is not re-prepared", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-midrotation-");
  t.after(() => cleanupFixture(fixture.base));

  // Windows rotation state: the guard placeholder was renamed into the pivot,
  // so the guard path is missing while the pivot holds its identity, and the
  // reviewed content is still at the evidence path. The engine resumes that
  // exchange itself; the heal must not re-prepare over it.
  const token = (label: string): string => {
    const hex = createHash("sha256").update(`${label}\0${fixture.evidenceId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  const guardPath = `notes/.gsd-projection-remove-${token("guard")}`;
  const exchangePath = `notes/.gsd-projection-exchange-${token("exchange")}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "guard placeholder bytes\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: "1:1",
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  // The engine cannot resume this triple on Unix (the rotation branch is
  // Windows-only), so the replay fails — but the heal must leave the
  // journaled identities untouched for the state the engine can resume.
  assert.throws(
    () => loadUnboundProjectionEvidence(fixture.base),
    /identity changed/u,
  );
  const replayed = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(replayed[0]!.transition, "resolving");
  assert.equal(
    (replayed[0]!.resolution as Record<string, unknown>).guardIdentity,
    `${pivotStat.dev}:${pivotStat.ino}`,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), REVIEWED);
});

test("an externally cleaned guard with an intact pivot replays to completion", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-cleaned-guard-");
  t.after(() => cleanupFixture(fixture.base));

  // External cleanup removed only the guard placeholder; the exchange pivot
  // still holds its own placeholder. That state is not a rotation state the
  // engine resumes (the pivot holds the exchange identity, not the guard's),
  // so the heal resets the guard identity and the exchange replays to
  // completion with a fresh guard placeholder.
  const token = (label: string): string => {
    const hex = createHash("sha256").update(`${label}\0${fixture.evidenceId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  const guardPath = `notes/.gsd-projection-remove-${token("guard")}`;
  const exchangePath = `notes/.gsd-projection-exchange-${token("exchange")}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "exchange placeholder bytes\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: "9:9",
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.equal(existsSync(join(fixture.rootPath, exchangePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a partially persisted heal re-resets the exchange identity on replay", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-partial-heal-");
  t.after(() => cleanupFixture(fixture.base));

  // Crash between the two heal reset persists: the guard identity was
  // already reset (null) while the exchange identity is still journaled.
  // There is no journaled exchange left to resume, so the replay must reset
  // the exchange identity too and converge in one pass.
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: "1:1",
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("native replay completes a plain-fs deleting marker and removes the reviewed source", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-marker-");
  t.after(() => cleanupFixture(fixture.base));

  // Crash window of a degraded discard: the deleting marker is persisted, the
  // unlink never ran. The next native recovery must remove the reviewed bytes
  // under the lock (not just retire the record and leak the file).
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a resolving record from a crashed attempt stays enumerable and resolvable while degraded", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-resolving-");
  t.after(() => cleanupFixture(fixture.base));

  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  // Pre-#2815 the whole index read refused the record; now it lists.
  const listed = loadUnboundProjectionEvidence(fixture.base);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.transition, "resolving");

  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "discard", preview.consent);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded resolution refuses a record mid-native-protocol instead of reviewing placeholders", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-inflight-");
  t.after(() => cleanupFixture(fixture.base));

  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  const guardPath = `notes/.gsd-projection-remove-${randomUUID()}`;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: entries[0]!.evidenceIdentity,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);
  // The prepared guard artifact still exists: the exchange window may hold the
  // real bytes there, so degraded resolution must refuse rather than review
  // the evidence path as if it were the content holder.
  writeFileSync(join(fixture.rootPath, guardPath), "prepared placeholder\n");

  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      "discard:sha256:0".repeat(8),
    ),
    /in-flight evidence resolution/u,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), REVIEWED);
});

test("degraded resolution completes a persisted deleting marker idempotently", (t) => {
  degradeForTest(t);
  // Discard marker: the removal phase was persisted, the crash hit before the
  // unlink. The replay finishes both halves without fresh consent.
  const discard = seedEvidenceFixture("gsd-evidence-plainfs-marker-");
  t.after(() => cleanupFixture(discard.base));
  const entries = readIndex(discard.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(discard.indexPath, `${JSON.stringify(entries)}\n`);
  resolveUnboundProjectionEvidence(
    discard.base,
    discard.evidenceId,
    "discard",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(existsSync(join(discard.rootPath, discard.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(discard.base), []);

  // Preserve marker with a verified destination: the source goes, the
  // preserved copy stays. A changed destination refuses the completion.
  const preserve = seedEvidenceFixture("gsd-evidence-plainfs-marker-2-");
  t.after(() => cleanupFixture(preserve.base));
  const preservedRelative = "migration/preserved-projection-evidence/abc";
  mkdirSync(dirname(join(preserve.rootPath, preservedRelative)), { recursive: true });
  writeFileSync(join(preserve.rootPath, preservedRelative), REVIEWED);
  const preserveEntries = readIndex(preserve.base) as Array<Record<string, unknown>>;
  preserveEntries[0]!.transition = "resolving";
  preserveEntries[0]!.resolution = {
    action: "preserve",
    currentIdentity: preserveEntries[0]!.evidenceIdentity,
    contentDigest: preserveEntries[0]!.contentDigest,
    destinationPath: preservedRelative,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(preserve.indexPath, `${JSON.stringify(preserveEntries)}\n`);
  resolveUnboundProjectionEvidence(
    preserve.base,
    preserve.evidenceId,
    "preserve",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(existsSync(join(preserve.rootPath, preserve.evidencePath)), false);
  assert.equal(readFileSync(join(preserve.rootPath, preservedRelative), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(preserve.base), []);

  // A destination that no longer holds the reviewed bytes must stop the replay.
  const changed = seedEvidenceFixture("gsd-evidence-plainfs-marker-3-");
  t.after(() => cleanupFixture(changed.base));
  mkdirSync(dirname(join(changed.rootPath, preservedRelative)), { recursive: true });
  writeFileSync(join(changed.rootPath, preservedRelative), "rewritten elsewhere\n");
  const changedEntries = readIndex(changed.base) as Array<Record<string, unknown>>;
  changedEntries[0]!.transition = "resolving";
  changedEntries[0]!.resolution = {
    action: "preserve",
    currentIdentity: changedEntries[0]!.evidenceIdentity,
    contentDigest: changedEntries[0]!.contentDigest,
    destinationPath: preservedRelative,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(changed.indexPath, `${JSON.stringify(changedEntries)}\n`);
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      changed.base,
      changed.evidenceId,
      "preserve",
      "consent is not re-asked for a replayed deletion",
    ),
    /completed destination changed/u,
  );
  assert.equal(readFileSync(join(changed.rootPath, changed.evidencePath), "utf8"), REVIEWED);
});

test("degraded tree-scope restrictions are unchanged (empty-tree discard only)", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-tree-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  const logicalPath = "notes/result.md";
  const indexPath = join(rootPath, "migration", "unbound-projection-evidence.json");

  const seedTreeEvidence = (evidencePath: string, occupied: boolean): string => {
    mkdirSync(join(rootPath, evidencePath), { recursive: true });
    if (occupied) writeFileSync(join(rootPath, evidencePath, "child.md"), "kept\n");
    const stat = lstatSync(join(rootPath, evidencePath), { bigint: true });
    const evidenceId = `evidence:sha256:${createHash("sha256")
      .update(JSON.stringify({ evidencePath, kind: "quarantine", logicalPath, scope: "tree" }))
      .digest("hex")}`;
    mkdirSync(join(rootPath, "migration"), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify([{
      evidenceId,
      evidencePath,
      evidenceIdentity: `${stat.dev}:${stat.ino}`,
      contentDigest: `sha256:${createHash("sha256").update(occupied ? "kept\n" : "").digest("hex")}`,
      kind: "quarantine",
      logicalPath,
      scope: "tree",
      transition: "retained",
    }])}\n`);
    return evidenceId;
  };

  // Non-empty tree discard and tree preserve/restore keep requiring the lock.
  const occupiedId = seedTreeEvidence(`notes/.gsd-projection-remove-${randomUUID()}`, true);
  const occupiedPreview = previewUnboundProjectionEvidenceResolution(base, occupiedId, "discard");
  assert.throws(
    () => resolveUnboundProjectionEvidence(base, occupiedId, "discard", occupiedPreview.consent),
    /required to discard non-empty evidence/u,
  );
  const occupiedPreserve = previewUnboundProjectionEvidenceResolution(base, occupiedId, "preserve");
  assert.throws(
    () => resolveUnboundProjectionEvidence(base, occupiedId, "preserve", occupiedPreserve.consent),
    /required to preserve or restore evidence/u,
  );
  assert.equal(loadUnboundProjectionEvidence(base).length, 1);

  // The historical allowance holds: an empty tree discards without the lock.
  const emptyId = seedTreeEvidence(`notes/.gsd-projection-remove-${randomUUID()}`, false);
  const emptyPreview = previewUnboundProjectionEvidenceResolution(base, emptyId, "discard");
  resolveUnboundProjectionEvidence(base, emptyId, "discard", emptyPreview.consent);
  // Only the occupied evidence directory remains on disk, and the index is clear.
  assert.equal(readdirSync(join(rootPath, "notes")).length, 1);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("an interrupted native resolution whose artifacts vanished converges on replay", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-retry-");
  t.after(() => cleanupFixture(fixture.base));
  t.after(() => _setUnboundEvidenceExchangeFaultForTest(null));

  // Drive a real resolution and interrupt it the way the report describes:
  // the guard/exchange placeholders are prepared and persisted, then removed
  // by a one-time external cleanup before the exchange runs.
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  let cleaned = false;
  _setUnboundEvidenceExchangeFaultForTest((exchange) => {
    if (!cleaned) {
      cleaned = true;
      const seeded = readIndex(fixture.base) as Array<Record<string, unknown>>;
      const resolution = seeded[0]!.resolution as { guardPath: string; exchangePath: string };
      unlinkSync(join(fixture.rootPath, resolution.guardPath));
      unlinkSync(join(fixture.rootPath, resolution.exchangePath));
    }
    exchange();
  });
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /identity changed/u,
  );
  // The attempt left the record resolving at "prepared" with identities
  // pointing at artifacts that no longer exist (read without a managed open,
  // which is exactly what used to replay the doomed exchange).
  const stuck = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(stuck[0]!.transition, "resolving");
  assert.equal((stuck[0]!.resolution as Record<string, unknown>).phase, "prepared");
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), true);

  // The next managed open must converge instead of replaying a doomed
  // exchange forever: the record resolves and the reviewed bytes go.
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a completed exchange replays idempotently instead of being re-prepared", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-exchanged-");
  t.after(() => cleanupFixture(fixture.base));
  t.after(() => _setUnboundEvidenceExchangeFaultForTest(null));

  // Crash in the window after the exchange consumed its pivot but before the
  // JS persisted the new phase: the content already sits at the guard path and
  // the exchange path is gone. The replay must recognize the completed state
  // and finish, not re-prepare over it (#2815 codex finding).
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  let crashed = false;
  _setUnboundEvidenceExchangeFaultForTest((exchange) => {
    exchange();
    if (!crashed) {
      crashed = true;
      throw new Error("crashed after the exchange consumed its pivot");
    }
  });
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /crashed after the exchange/u,
  );
  const exchanged = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(exchanged[0]!.transition, "resolving");

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
});

for (const action of ["discard", "preserve", "restore"] as const satisfies readonly UnboundProjectionEvidenceResolutionAction[]) {
  test(`native ${action} resolution is unchanged`, { skip: !nativeMode }, (t) => {
    const fixture = seedEvidenceFixture(`gsd-evidence-native-${action}-`);
    t.after(() => cleanupFixture(fixture.base));

    const preview = previewUnboundProjectionEvidenceResolution(
      fixture.base,
      fixture.evidenceId,
      action,
    );
    resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, action, preview.consent);
    if (action === "discard") {
      assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
    } else {
      const landed = action === "restore"
        ? join(fixture.rootPath, fixture.logicalPath)
        : join(fixture.rootPath, preview.destinationPath!);
      assert.equal(readFileSync(landed, "utf8"), REVIEWED);
      assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
    }
    assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  });
}
