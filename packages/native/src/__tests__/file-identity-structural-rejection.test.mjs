import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// #2648: on Windows the lock raised a bare "projection root contains an
// unsupported node" from seven distinct sites (and a bare "unsupported
// reparse point" from four more), so a structural rejection could not be
// traced to a node once the tree had changed. Every rejection must name the
// node and say what was wrong with it, and must stay out of the transient
// family that feeds the #2355 health latch.
//
// These sites are #[cfg(windows)] Rust; the POSIX branches are separate code
// and keep their existing wording.
const windowsOnly = { skip: process.platform !== "win32" };

const REASONS = [
  "expected a regular file, found a directory",
  "expected a directory, found a file",
  "node is a reparse point (symbolic link or junction)",
  "symbolic links and junctions are not followed",
];

function openFixture(t) {
  // The root sits under a directory literally named like a transient marker:
  // path text must never classify a structural rejection as transient.
  const base = mkdtempSync(join(tmpdir(), "gsd-native-structural-"));
  const root = join(base, "EBUSY", ".gsd");
  mkdirSync(root, { recursive: true });
  const previousNativePreference = process.env.GSD_NATIVE_PREFER_LOCAL;
  process.env.GSD_NATIVE_PREFER_LOCAL = "1";
  const fileIdentity = require("../../dist/file-identity");
  fileIdentity._resetProjectionRootIdentityLockHealthForTest();
  let lock;
  t.after(() => {
    try {
      lock?.close();
    } finally {
      if (previousNativePreference === undefined) delete process.env.GSD_NATIVE_PREFER_LOCAL;
      else process.env.GSD_NATIVE_PREFER_LOCAL = previousNativePreference;
      rmSync(base, { recursive: true, force: true });
    }
  });
  return {
    base,
    root,
    fileIdentity,
    open() {
      const stat = lstatSync(root, { bigint: true });
      lock = fileIdentity.acquireProjectionRootIdentityLock(
        realpathSync(root),
        stat.dev.toString(),
        stat.ino.toString(),
      );
      return lock;
    },
  };
}

function rejection(operation) {
  try {
    operation();
  } catch (error) {
    return error.message;
  }
  assert.fail("expected the projection root lock to reject the node");
}

function assertNamesNode(message, family, nodeName) {
  assert.match(message, new RegExp(`projection root contains an unsupported ${family}`, "u"));
  assert.ok(message.includes(nodeName), `rejection must name ${nodeName}: ${message}`);
  const tail = message.split(": ").pop();
  assert.ok(REASONS.includes(tail), `rejection must end with the reason, got: ${message}`);
}

test("a directory occupying a file target is rejected by name", windowsOnly, (t) => {
  const fixture = openFixture(t);
  mkdirSync(join(fixture.root, "migration", "unbound-projection-evidence.json"), { recursive: true });
  mkdirSync(join(fixture.root, "STATE.md"));
  const lock = fixture.open();

  const read = rejection(() => lock.readFile("migration/unbound-projection-evidence.json"));
  assertNamesNode(read, "node", "unbound-projection-evidence.json");
  assert.match(read, /while opening projection file at .*: expected a regular file, found a directory$/u);

  const remove = rejection(() => lock.removeFile("STATE.md"));
  assertNamesNode(remove, "node", "STATE.md");
  assert.match(remove, /: expected a regular file, found a directory$/u);
});

test("a file occupying a directory target is rejected by name", windowsOnly, (t) => {
  const fixture = openFixture(t);
  writeFileSync(join(fixture.root, "milestones"), "not a directory\n");
  const lock = fixture.open();

  for (const operation of [() => lock.removeTree("milestones"), () => lock.removeDirectory("milestones")]) {
    const message = rejection(operation);
    assertNamesNode(message, "node", "milestones");
    assert.match(message, /: expected a directory, found a file$/u);
  }
});

test("a junction inside the projection root is rejected by name on read and removal", windowsOnly, (t) => {
  const fixture = openFixture(t);
  const outside = join(fixture.base, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(fixture.root, "linked"), "junction");
  const lock = fixture.open();

  for (const operation of [
    () => lock.pathExists("linked"),
    () => lock.pathKind("linked"),
    () => lock.listDirectory("linked"),
  ]) {
    const message = rejection(operation);
    assertNamesNode(message, "reparse point", "linked");
  }
  for (const operation of [
    () => lock.removeFile("linked"),
    () => lock.removeDirectory("linked"),
    () => lock.removeTree("linked"),
  ]) {
    const message = rejection(operation);
    assertNamesNode(message, "node", "linked");
    assert.match(message, /: node is a reparse point \(symbolic link or junction\)$/u);
  }
});

// The kind mismatches outside the "unsupported node" family were path-less
// too: a write or quarantine onto a directory said only "projection target is
// not a regular file", and listing a regular file surfaced the raw
// "parameter is incorrect" (os error 87).
test("a kind mismatch on a write, quarantine or listing target names the target", windowsOnly, (t) => {
  const fixture = openFixture(t);
  mkdirSync(join(fixture.root, "STATE.md"));
  writeFileSync(join(fixture.root, "milestones"), "not a directory\n");
  const lock = fixture.open();

  for (const operation of [
    () => lock.writeFile("STATE.md", Buffer.from("# State\n")),
    () => lock.quarantineFile("STATE.md", ".gsd-projection-remove-00000000-0000-0000-0000-000000000001"),
  ]) {
    const message = rejection(operation);
    assert.match(message, /projection target is not a regular file at .*STATE\.md: found a directory$/u);
  }

  const listing = rejection(() => lock.listDirectory("milestones"));
  assert.match(listing, /projection target is not a directory at .*milestones: found a regular file$/u);
  assert.doesNotMatch(listing, /os error 87/u);

  // The occupants are untouched and the lock is still healthy.
  assert.equal(lock.pathKind("STATE.md"), "directory");
  assert.equal(lock.pathKind("milestones"), "file");
  assert.equal(fixture.fileIdentity.isProjectionRootIdentityLockAvailable(), true);
});

test("repeated structural rejections never trip the transient health latch", windowsOnly, (t) => {
  const fixture = openFixture(t);
  mkdirSync(join(fixture.root, "STATE.md"));
  const lock = fixture.open();

  // Well past the latch threshold, on one operation, from a root whose path
  // contains "EBUSY": the store must stay fail-closed, not degrade to plain-fs.
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.match(rejection(() => lock.readFile("STATE.md")), /unsupported node/u);
  }
  assert.equal(fixture.fileIdentity.isProjectionRootIdentityLockAvailable(), true);
});
