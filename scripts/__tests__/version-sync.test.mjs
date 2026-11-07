// Project/App: gsd-pi
// File Purpose: Regression coverage for release version surface sync.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PLATFORM_PACKAGE_DIRS,
  RELEASE_WORKSPACE_PACKAGE_DIRS,
  resolveEngineOptionalDependencyVersion,
  syncVersionSurfaces,
  verifyVersionSync,
} = require("../lib/version-sync.cjs");

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeHermesVersionFiles(root, version) {
  const hermesDir = join(root, "integrations", "hermes");
  mkdirSync(join(hermesDir, "open_gsd_hermes"), { recursive: true });
  writeFileSync(
    join(hermesDir, "pyproject.toml"),
    `[project]\nname = "open-gsd-hermes"\nversion = "${version}"\n`,
  );
  writeFileSync(
    join(hermesDir, "open_gsd_hermes", "gsd_client.py"),
    `payload = {"clientInfo": {"name": "open-gsd-hermes", "version": "${version}"}}\n`,
  );
}

function createVersionSyncFixture(root, version) {
  const optionalDependencies = Object.fromEntries(
    PLATFORM_PACKAGE_DIRS.map((dir) => [
      `@opengsd/engine-${dir.replace("native/npm/", "")}`,
      version,
    ]),
  );

  writeJson(join(root, "package.json"), {
    name: "@opengsd/gsd-pi",
    version,
    optionalDependencies,
  });

  for (const packageDir of [...RELEASE_WORKSPACE_PACKAGE_DIRS, ...PLATFORM_PACKAGE_DIRS, "pkg"]) {
    mkdirSync(join(root, packageDir), { recursive: true });
    writeJson(join(root, packageDir, "package.json"), {
      name: packageDir.replaceAll("/", "-"),
      version,
    });
  }

  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
}

test("resolveEngineOptionalDependencyVersion keeps prerelease publishes on stable engine packages", () => {
  // dev and next channels both reuse the stable engine packages — neither
  // builds per-platform engines, so the suffix must be stripped to the base
  // X.Y.Z that actually exists on npm.
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-dev.adee50b"), "1.0.2");
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-next.adee50b"), "1.0.2");
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2"), "1.0.2");
  // A non-dev/next prerelease (e.g. a real custom channel) is left intact.
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-rc.1"), "1.0.2-rc.1");
});

test("version sync keeps daemon and excludes retired cloud products", () => {
  assert.ok(RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/daemon"));
  assert.ok(!RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/cloud-mcp-gateway"));
  assert.ok(!RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/gsd-cloud"));
});

test("syncVersionSurfaces rewrites internal deps to the stamped prerelease version", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-version-sync-"));
  const devVersion = "1.0.2-dev.abc1234";

  try {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "@opengsd/gsd-pi", version: "1.0.2" }, null, 2)}\n`,
    );

    mkdirSync(join(root, "packages", "rpc-client"), { recursive: true });
    writeFileSync(
      join(root, "packages", "rpc-client", "package.json"),
      `${JSON.stringify({
        name: "@opengsd/rpc-client",
        version: "1.0.2",
      }, null, 2)}\n`,
    );

    mkdirSync(join(root, "packages", "daemon"), { recursive: true });
    writeFileSync(
      join(root, "packages", "daemon", "package.json"),
      `${JSON.stringify({
        name: "@opengsd/daemon",
        version: "1.0.2",
        dependencies: {
          "@opengsd/rpc-client": "^1.0.2",
        },
      }, null, 2)}\n`,
    );

    syncVersionSurfaces(root, devVersion);

    const rpcClient = JSON.parse(readFileSync(join(root, "packages", "rpc-client", "package.json"), "utf8"));
    const daemon = JSON.parse(readFileSync(join(root, "packages", "daemon", "package.json"), "utf8"));

    assert.equal(rpcClient.version, devVersion);
    assert.equal(daemon.version, devVersion);
    assert.equal(daemon.dependencies["@opengsd/rpc-client"], "workspace:*");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncVersionSurfaces updates bundled open-gsd-hermes version files for stable releases", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-hermes-version-sync-"));
  const releaseVersion = "1.6.0";

  try {
    createVersionSyncFixture(root, "1.5.0");
    writeHermesVersionFiles(root, "1.2.0");

    syncVersionSurfaces(root, releaseVersion);

    assert.match(
      readFileSync(join(root, "integrations", "hermes", "pyproject.toml"), "utf8"),
      /version = "1\.6\.0"/,
    );
    assert.match(
      readFileSync(join(root, "integrations", "hermes", "open_gsd_hermes", "gsd_client.py"), "utf8"),
      /"version": "1\.6\.0"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyVersionSync reports stale bundled open-gsd-hermes versions on stable releases", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-hermes-version-verify-"));

  try {
    createVersionSyncFixture(root, "1.6.0");
    writeHermesVersionFiles(root, "1.2.0");

    assert.deepEqual(verifyVersionSync(root), [
      "integrations/hermes/pyproject.toml version is 1.2.0, expected 1.6.0",
      "integrations/hermes/open_gsd_hermes/gsd_client.py clientInfo version is 1.2.0, expected 1.6.0",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncVersionSurfaces leaves open-gsd-hermes on stable Python metadata during prerelease stamps", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-hermes-prerelease-sync-"));

  try {
    createVersionSyncFixture(root, "1.5.0");
    writeHermesVersionFiles(root, "1.5.0");

    syncVersionSurfaces(root, "1.6.0-dev.abc1234");

    assert.match(
      readFileSync(join(root, "integrations", "hermes", "pyproject.toml"), "utf8"),
      /version = "1\.5\.0"/,
    );
    assert.match(
      readFileSync(join(root, "integrations", "hermes", "open_gsd_hermes", "gsd_client.py"), "utf8"),
      /"version": "1\.5\.0"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeOpenclawManifest(root, version) {
  const dir = join(root, "integrations", "openclaw");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "openclaw.plugin.json"),
    `{\n  "id": "open-gsd-openclaw",\n  "name": "Open GSD",\n  "version": "${version}"\n}\n`,
  );
}

test("syncVersionSurfaces updates the open-gsd-openclaw plugin manifest on every channel", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-openclaw-version-sync-"));

  try {
    createVersionSyncFixture(root, "1.5.0");
    writeOpenclawManifest(root, "1.5.0");

    syncVersionSurfaces(root, "1.6.0");
    assert.match(
      readFileSync(join(root, "integrations", "openclaw", "openclaw.plugin.json"), "utf8"),
      /"version": "1\.6\.0"/,
    );

    // The package.json in integrations/openclaw is stamped on prerelease
    // channels too, so the manifest must follow it, unlike the Hermes files.
    syncVersionSurfaces(root, "1.7.0-dev.abc1234");
    assert.match(
      readFileSync(join(root, "integrations", "openclaw", "openclaw.plugin.json"), "utf8"),
      /"version": "1\.7\.0-dev\.abc1234"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyVersionSync reports a stale open-gsd-openclaw plugin manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-openclaw-version-verify-"));

  try {
    createVersionSyncFixture(root, "1.6.0");
    writeOpenclawManifest(root, "1.5.0");

    assert.deepEqual(verifyVersionSync(root), [
      "integrations/openclaw/openclaw.plugin.json version is 1.5.0, expected 1.6.0",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
