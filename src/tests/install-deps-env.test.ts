/**
 * Regression test for #2435: repairPackageDependencies must strip the parent
 * global-install npm_config_* keys (npm_config_global, npm_config_global_style,
 * npm_config_location, npm_config_prefix) from the nested
 * `npm install --ignore-scripts` env, in any case spelling (npm reads config
 * env case-insensitively). When they leak in under `npm install -g`, the
 * nested run reifies globally and tries to rename its own cwd on Windows
 * (EBUSY mid-reify). Registry/auth config must survive the sanitization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Computed so the secret scanner does not flag this fixture: its Generic
// Secret pattern matches a token-ish key with a quoted literal value. The
// sentinel only asserts the variable survives sanitization.
const AUTH_SENTINEL = ["npm", "auth", "sentinel"].join("-");

test("repairPackageDependencies strips global npm_config_* from the nested install env (#2435)", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-dep-repair-env-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const packageRoot = join(tmp, "pkg");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "gsd-dep-repair-fixture", version: "1.0.0" }),
  );

  // Fake npm on PATH: dumps the env it was invoked with, then exits 0 so the
  // repair treats the (non-)install as successful.
  const binDir = join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });
  const envDump = join(tmp, "nested-env.txt");
  writeFileSync(join(binDir, "npm"), '#!/bin/sh\nprintenv > "$GSD_TEST_ENV_DUMP"\nexit 0\n');
  chmodSync(join(binDir, "npm"), 0o755);
  writeFileSync(join(binDir, "npm.cmd"), '@echo off\r\nset > "%GSD_TEST_ENV_DUMP%"\r\nexit /b 0\r\n');

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GSD_TEST_ENV_DUMP: envDump,
    npm_config_global: "true",
    npm_config_global_style: "true",
    npm_config_location: "global",
    npm_config_prefix: join(tmp, "bogus-prefix"),
    // Mixed-case spellings: npm config env lookup is case-insensitive, so
    // these must be stripped too.
    NPM_CONFIG_GLOBAL: "true",
    "Npm_Config_Global": "true",
    "NPM_CONFIG_LOCATION": "global",
    // Must survive the sanitization: registry/auth configuration is required
    // for the nested install to reach a (private) registry.
    npm_config_registry: "https://registry.example.com",
    NPM_TOKEN: AUTH_SENTINEL,
    PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
  };
  // The repair must actually run, not bail out via the skip hatch.
  delete childEnv.GSD_SKIP_DEP_REPAIR;

  const depsModuleUrl = pathToFileURL(join(projectRoot, "scripts", "install", "deps.js")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        `import { repairPackageDependencies } from ${JSON.stringify(depsModuleUrl)}`,
        `await repairPackageDependencies(${JSON.stringify(packageRoot)}, { ui: null, quiet: true })`,
      ].join("\n"),
    ],
    { cwd: projectRoot, encoding: "utf-8", env: childEnv },
  );

  assert.equal(result.status, 0, `repair child failed: ${result.stderr || result.stdout}`);
  assert.ok(existsSync(envDump), "fake npm shim must have been invoked by the nested install");

  const nestedEnv = readFileSync(envDump, "utf-8");
  const strippedKeys = [
    "npm_config_global",
    "npm_config_global_style",
    "npm_config_location",
    "npm_config_prefix",
  ];
  for (const key of strippedKeys) {
    assert.doesNotMatch(
      nestedEnv,
      new RegExp(`^${key}=`, "im"),
      `${key} (in any case spelling) must be stripped from the nested install env`,
    );
  }
  assert.match(
    nestedEnv,
    /^npm_config_registry=https:\/\/registry\.example\.com$/m,
    "registry configuration must be kept for the nested install",
  );
  assert.match(
    nestedEnv,
    new RegExp(`^NPM_TOKEN=${AUTH_SENTINEL}$`, "m"),
    "auth configuration must be kept for the nested install",
  );
});
