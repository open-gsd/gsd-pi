import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

// When the addon cannot be loaded, native.js falls back to a throw-on-call
// proxy whose every property reads back as an arrow function. A bare
// `typeof !== "function"` guard passes on that proxy, so `new Lock(...)` used
// to die with a bare "X is not a constructor" TypeError instead of the
// intended unavailable error. These guards must detect the proxy via
// isNativeAddonLoaded() and fail closed with the documented messages.
test("file-identity and directory-sync throw the intended unavailable errors when the addon is missing", () => {
  const script = `
    const { acquireSqliteFileIdentityLock, acquireProjectionRootIdentityLock } = require("./dist/file-identity");
    const { syncDirectoryEntry } = require("./dist/directory-sync");
    const { isNativeAddonLoaded } = require("./dist/native");
    const attempt = (fn) => {
      try {
        fn();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    process.stdout.write(JSON.stringify({
      loaded: isNativeAddonLoaded(),
      sqlite: attempt(() => acquireSqliteFileIdentityLock("/tmp/gsd-fallback-probe.db", false)),
      projection: attempt(() => acquireProjectionRootIdentityLock("/tmp/gsd-fallback-probe", "0", "0")),
      sync: attempt(() => syncDirectoryEntry("/tmp/gsd-fallback-probe")),
    }));
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    env: { ...process.env, GSD_NATIVE_DISABLE: "1" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.loaded, false);
  // Exact-message equality also proves the failure is NOT the proxy's
  // "not a constructor" TypeError or its generic "is not available" throw.
  assert.equal(output.sqlite, "native SQLite file identity locking is unavailable");
  assert.equal(output.projection, "native projection root identity locking is unavailable");
  assert.equal(output.sync, "native directory durability is unavailable");
});

// Stale-binary guard: the installed/loaded addon must actually export the
// N-API surface these modules depend on. If the engine binary predates these
// exports (e.g. an optionalDependencies pin pointing at an older engine), the
// real addon loads successfully but the constructors are missing — this test
// fails loudly instead of letting every new flow degrade at runtime.
test("loaded addon exposes the file-identity and directory-sync N-API exports", () => {
  const script = `
    const { native, isNativeAddonLoaded } = require("./dist/native");
    process.stdout.write(JSON.stringify({
      loaded: isNativeAddonLoaded(),
      sqliteLock: typeof native.SqliteFileIdentityLock,
      projectionLock: typeof native.ProjectionRootIdentityLock,
      syncDirectoryEntry: typeof native.syncDirectoryEntry,
    }));
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    env: { ...process.env, GSD_NATIVE_PREFER_LOCAL: "1" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(
    output.loaded,
    true,
    "native addon did not load — run `pnpm --filter @gsd/native run build:native:dev` first",
  );
  assert.equal(output.sqliteLock, "function", "addon is stale: SqliteFileIdentityLock export missing");
  assert.equal(output.projectionLock, "function", "addon is stale: ProjectionRootIdentityLock export missing");
  assert.equal(output.syncDirectoryEntry, "function", "addon is stale: syncDirectoryEntry export missing");
});

test("projection root lock permits root writes, excludes a second owner, and reacquires after close", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-native-projection-root-"));
  const previousNativePreference = process.env.GSD_NATIVE_PREFER_LOCAL;
  let lock;
  t.after(() => {
    try {
      lock?.close();
    } finally {
      if (previousNativePreference === undefined) {
        delete process.env.GSD_NATIVE_PREFER_LOCAL;
      } else {
        process.env.GSD_NATIVE_PREFER_LOCAL = previousNativePreference;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  const stat = lstatSync(root, { bigint: true });
  process.env.GSD_NATIVE_PREFER_LOCAL = "1";
  const { acquireProjectionRootIdentityLock } = require("../../dist/file-identity");
  lock = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());

  assert.throws(
    () => acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString()),
    /locking failed/,
  );
  lock.writeFile("PROJECT.md", Buffer.from("# Project\n"));
  assert.equal(lock.readFile("PROJECT.md").toString(), "# Project\n");
  assert.ok(lock.listDirectory("").includes("PROJECT.md"));

  for (let acquisition = 2; acquisition <= 4; acquisition++) {
    lock.close();
    lock = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
    assert.equal(lock.readFile("PROJECT.md").toString(), "# Project\n", `acquisition ${acquisition}`);
  }
});
