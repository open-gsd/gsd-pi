import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const windowsOnly = { skip: process.platform !== "win32" };
const left = "milestones";
const right = ".gsd-projection-remove-test";
const guard = ".gsd-projection-exchange-test";

function fixture(t, directory) {
  const root = mkdtempSync(join(tmpdir(), "gsd-exchange-"));
  let lock;
  t.after(() => {
    try { lock?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const [name, content] of [[left, "left"], [right, "right"]]) {
    if (directory) mkdirSync(join(root, name, "nested"), { recursive: true });
    writeFileSync(join(root, name, ...(directory ? ["nested", "content.md"] : [])), content);
  }
  const { acquireProjectionRootIdentityLock } = require("../../dist/file-identity");
  function open() {
    lock?.close();
    const stat = lstatSync(root, { bigint: true });
    lock = acquireProjectionRootIdentityLock(realpathSync(root), stat.dev.toString(), stat.ino.toString());
    return lock;
  }
  open();
  const leftId = lock.pathIdentity(left);
  const rightId = lock.pathIdentity(right);
  const guardId = directory
    ? lock.prepareDirectoryPlaceholder(guard)
    : lock.prepareFileTemporary(guard, Buffer.alloc(0));
  return {
    root, open, leftId, rightId, guardId,
    close() { lock.close(); lock = undefined; },
    content(name) { return readFileSync(join(root, name, ...(directory ? ["nested", "content.md"] : [])), "utf8"); },
    exchange(handle) { handle.exchangePaths(left, right, leftId, rightId, guard, guardId); },
  };
}

// #2774: the Windows rotation deleted its own directory placeholder as a
// regular file. Exercise the real native addon on Windows, including each
// restart point in the rotation; the existing Rust exchange tests are Unix-only.
for (const directory of [true, false]) {
  for (const state of ["fresh", "guard removed", "right staged", "left moved", "complete"]) {
    test(`Windows ${directory ? "tree" : "file"} exchange resumes from ${state}`, windowsOnly, (t) => {
      const f = fixture(t, directory);
      f.close();
      if (state !== "fresh") {
        if (directory) rmdirSync(join(f.root, guard));
        else unlinkSync(join(f.root, guard));
      }
      if (["right staged", "left moved", "complete"].includes(state)) renameSync(join(f.root, right), join(f.root, guard));
      if (["left moved", "complete"].includes(state)) renameSync(join(f.root, left), join(f.root, right));
      if (state === "complete") renameSync(join(f.root, guard), join(f.root, left));

      const lock = f.open();
      f.exchange(lock);
      assert.equal(lock.pathIdentity(left), f.rightId);
      assert.equal(lock.pathIdentity(right), f.leftId);
      assert.equal(f.content(left), "right");
      assert.equal(f.content(right), "left");
      assert.equal(existsSync(join(f.root, guard)), false);
      f.exchange(lock); // Replaying an already-completed journal is harmless.
      assert.equal(f.content(left), "right");
      assert.equal(f.content(right), "left");
    });
  }
}

test("Windows tree exchange preserves a non-empty placeholder", windowsOnly, (t) => {
  const f = fixture(t, true);
  writeFileSync(join(f.root, guard, "unexpected.md"), "retain this");
  const lock = f.open();
  assert.throws(() => f.exchange(lock));
  assert.equal(lock.pathIdentity(left), f.leftId);
  assert.equal(lock.pathIdentity(right), f.rightId);
  assert.equal(lock.pathIdentity(guard), f.guardId);
  assert.equal(readFileSync(join(f.root, guard, "unexpected.md"), "utf8"), "retain this");
  assert.equal(f.content(left), "left");
  assert.equal(f.content(right), "right");
});
