import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ensureWorkspaceBuildsPath = require.resolve("../../scripts/ensure-workspace-builds.cjs");
const { newestSrcMtime, detectStalePackages, isDistResourcesStale } = require(ensureWorkspaceBuildsPath);

describe("newestSrcMtime", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gsd-mtime-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns 0 for a non-existent directory", () => {
    assert.equal(newestSrcMtime(join(tmp, "does-not-exist")), 0);
  });

  it("returns 0 when directory has no .ts files", () => {
    writeFileSync(join(tmp, "index.js"), "");
    writeFileSync(join(tmp, "config.json"), "");
    assert.equal(newestSrcMtime(tmp), 0);
  });

  it("returns the mtime of a single .ts file", () => {
    const file = join(tmp, "index.ts");
    writeFileSync(file, "");
    const mtime = new Date("2024-01-15T10:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });

  it("returns the max mtime across multiple .ts files", () => {
    const older = join(tmp, "a.ts");
    const newer = join(tmp, "b.ts");
    writeFileSync(older, "");
    writeFileSync(newer, "");
    utimesSync(older, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    utimesSync(newer, new Date("2024-06-01T00:00:00Z"), new Date("2024-06-01T00:00:00Z"));
    assert.equal(newestSrcMtime(tmp), new Date("2024-06-01T00:00:00Z").getTime());
  });

  it("recurses into subdirectories", () => {
    const subdir = join(tmp, "nested", "deep");
    mkdirSync(subdir, { recursive: true });
    const file = join(subdir, "util.ts");
    writeFileSync(file, "");
    const mtime = new Date("2024-03-01T00:00:00Z");
    utimesSync(file, mtime, mtime);
    assert.equal(newestSrcMtime(tmp), mtime.getTime());
  });

  it("skips node_modules entirely", () => {
    const nm = join(tmp, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    const nmFile = join(nm, "index.ts");
    writeFileSync(nmFile, "");
    const future = new Date("2099-01-01T00:00:00Z");
    utimesSync(nmFile, future, future);
    assert.equal(newestSrcMtime(tmp), 0);
  });
});

describe("detectStalePackages", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gsd-stale-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Helper to create a fake workspace package with src/ and dist/ directories.
   * Sets timestamps to simulate npm tarball extraction where src/ files can be
   * 1 second newer than dist/ files.
   */
  function createFakePackage(
    packagesDir: string,
    pkgName: string,
    opts: { srcNewerThanDist?: boolean; missingDist?: boolean } = {},
  ): void {
    const pkgDir = join(packagesDir, pkgName);
    const srcDir = join(pkgDir, "src");
    const distDir = join(pkgDir, "dist");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");

    if (!opts.missingDist) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "index.js"), "export const x = 1;");
    }

    if (opts.srcNewerThanDist && !opts.missingDist) {
      // Simulate npm tarball extraction: src/ is 1 second newer than dist/
      const distTime = new Date("2024-06-01T00:00:00Z");
      const srcTime = new Date("2024-06-01T00:00:01Z");
      utimesSync(join(distDir, "index.js"), distTime, distTime);
      utimesSync(join(srcDir, "index.ts"), srcTime, srcTime);
    }
  }

  it("detects missing dist/ as stale regardless of .git presence", () => {
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("detects stale src > dist timestamps in a git repo (dev clone)", () => {
    // Simulate a git repo by creating .git directory
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("skips staleness check when not in a git repo (npm tarball install)", () => {
    // No .git directory — simulates npm install from tarball
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { srcNewerThanDist: true });

    // Even though src/ is newer than dist/, the script should NOT detect it
    // as stale because we're in an npm tarball (no .git directory).
    // The timestamp difference is an artifact of npm tarball extraction.
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, [], "should not detect staleness in npm tarball installs (no .git)");
  });

  it("still detects missing dist/ in npm tarball installs", () => {
    // No .git directory — simulates npm install from tarball
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg", { missingDist: true });

    // Missing dist/ should always be detected, even in npm installs
    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, ["test-pkg"]);
  });

  it("returns empty array when dist/ is up to date", () => {
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const packagesDir = join(tmp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    createFakePackage(packagesDir, "test-pkg");
    // Default: timestamps are equal (both set by writeFileSync at ~same time)

    const result = detectStalePackages(tmp, ["test-pkg"]);
    assert.deepEqual(result, []);
  });
});

describe("stale dist/resources", () => {
  let tmp: string;

  const BUILT_AT = new Date("2024-06-01T00:00:00Z");
  const BEFORE_BUILD = new Date("2024-05-01T00:00:00Z");
  const AFTER_BUILD = new Date("2024-07-01T00:00:00Z");

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gsd-stale-resources-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Fake checkout: one prompt under src/resources and a built dist/resources
   * whose fingerprint file (written last by copy-resources) is dated BUILT_AT.
   */
  function createFakeCheckout(opts: { git?: boolean; sourceChangedAt?: Date; fingerprint?: boolean } = {}): void {
    if (opts.git !== false) mkdirSync(join(tmp, ".git"));
    const promptDir = join(tmp, "src", "resources", "extensions", "gsd", "prompts");
    mkdirSync(promptDir, { recursive: true });
    const prompt = join(promptDir, "plan.md");
    writeFileSync(prompt, "plan");
    const sourceChangedAt = opts.sourceChangedAt ?? BEFORE_BUILD;
    utimesSync(prompt, sourceChangedAt, sourceChangedAt);

    const distResources = join(tmp, "dist", "resources");
    mkdirSync(join(distResources, "extensions"), { recursive: true });
    if (opts.fingerprint !== false) {
      const fingerprint = join(distResources, ".managed-resources-content-hash");
      writeFileSync(fingerprint, "abc\n");
      utimesSync(fingerprint, BUILT_AT, BUILT_AT);
    }
  }

  it("reports a fresh dist/resources as not stale", () => {
    createFakeCheckout();
    assert.equal(isDistResourcesStale(tmp), false);
  });

  it("reports stale when a src/resources file is newer than dist/resources", () => {
    createFakeCheckout({ sourceChangedAt: AFTER_BUILD });
    assert.equal(isDistResourcesStale(tmp), true);
  });

  it("reports stale when the last rebuild did not finish (no fingerprint file)", () => {
    createFakeCheckout({ fingerprint: false });
    assert.equal(isDistResourcesStale(tmp), true);
  });

  it("never reports stale without .git (npm tarball install)", () => {
    createFakeCheckout({ git: false, sourceChangedAt: AFTER_BUILD });
    assert.equal(isDistResourcesStale(tmp), false);
  });

  it("does not report stale when dist/resources does not exist (loader uses src/resources)", () => {
    createFakeCheckout({ sourceChangedAt: AFTER_BUILD });
    rmSync(join(tmp, "dist"), { recursive: true });
    assert.equal(isDistResourcesStale(tmp), false);
  });

  /**
   * Runs a copy of the real preflight script inside the fake checkout. The
   * fake copy-resources script records that the preflight started a rebuild.
   */
  function runPreflight(): boolean {
    mkdirSync(join(tmp, "packages"));
    mkdirSync(join(tmp, "scripts"));
    copyFileSync(ensureWorkspaceBuildsPath, join(tmp, "scripts", "ensure-workspace-builds.cjs"));
    writeFileSync(
      join(tmp, "scripts", "copy-resources.cjs"),
      "require('node:fs').writeFileSync('rebuilt', process.cwd())\n",
    );
    spawnSync(process.execPath, [join(tmp, "scripts", "ensure-workspace-builds.cjs")], {
      env: { ...process.env, CI: "false" },
      stdio: "pipe",
    });
    return existsSync(join(tmp, "rebuilt"));
  }

  it("preflight rebuilds a stale dist/resources", () => {
    createFakeCheckout({ sourceChangedAt: AFTER_BUILD });
    assert.equal(runPreflight(), true);
  });

  it("preflight leaves a fresh dist/resources alone", () => {
    createFakeCheckout();
    assert.equal(runPreflight(), false);
  });
});
