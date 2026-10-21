/**
 * Integration tests for npm pack and install.
 *
 * These tests spawn child processes (npm pack, node)
 * and are resource-intensive. Run separately from unit tests.
 *
 * Prerequisite: npm run build must be run first.
 *
 * Run with: npm run build && npm run test:integration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createGunzip } from "node:zlib";
import { killChildProcess } from "./child-process-guard.ts";

const projectRoot = process.cwd();

if (!existsSync(join(projectRoot, "dist"))) {
  throw new Error("dist/ not found — run: npm run build");
}

type NpmSandbox = {
  env: NodeJS.ProcessEnv;
  installPrefix: string;
  rootDir: string;
};

function createNpmSandbox(prefix: string): NpmSandbox {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const cacheDir = join(rootDir, "npm-cache");
  const installPrefix = join(rootDir, "install-prefix");

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(installPrefix, { recursive: true });

  return {
    rootDir,
    installPrefix,
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: cacheDir,
      npm_config_cache: cacheDir,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  };
}

function buildQuietNpmEnv(sandbox: NpmSandbox): NodeJS.ProcessEnv {
  return {
    ...sandbox.env,
    NPM_CONFIG_LOGLEVEL: "error",
    npm_config_loglevel: "error",
    NPM_CONFIG_FUND: "false",
    npm_config_fund: "false",
    NPM_CONFIG_AUDIT: "false",
    npm_config_audit: "false",
  };
}

function formatCommand(args: string[]): string {
  return `npm ${args.join(" ")}`;
}

function runNpmQuiet(args: string[], sandbox: NpmSandbox): string {
  try {
    return execFileSync("npm", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      env: buildQuietNpmEnv(sandbox),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as {
      signal?: NodeJS.Signals | null;
      status?: number | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : (err.stdout ?? "");
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : (err.stderr ?? "");
    throw new Error(
      [
        `${formatCommand(args)} failed`,
        `status=${err.status ?? "<none>"} signal=${err.signal ?? "<none>"}`,
        stdout.trim() ? `stdout:\n${stdout.trim().slice(-4000)}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim().slice(-4000)}` : "",
      ].filter(Boolean).join("\n\n"),
    );
  }
}

function runNodeScript(relativePath: string): void {
  execFileSync(process.execPath, [join(projectRoot, relativePath)], {
    cwd: projectRoot,
    stdio: "pipe",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function packTarball(sandbox: NpmSandbox): string {
  const packDestination = join(sandbox.rootDir, "pack-output");

  mkdirSync(packDestination, { recursive: true });
  runNodeScript("scripts/prepack-resolve-workspace.cjs");
  try {
    const packOutput = runNpmQuiet(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDestination],
      sandbox,
    );
    const metadata = JSON.parse(packOutput);
    const filename = Array.isArray(metadata) ? metadata[0]?.filename : undefined;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error(`npm pack returned no filename metadata: ${packOutput.slice(0, 1000)}`);
    }
    return isAbsolute(filename) ? filename : join(packDestination, filename);
  } finally {
    runNodeScript("scripts/postpack-restore-workspace.cjs");
  }
}

/** List file paths inside a .tgz using Node built-ins only (no tar CLI or npm package). */
function listTarEntries(tarballPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files: string[] = [];
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const input = createReadStream(tarballPath);
    gunzip.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    gunzip.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = 0;
      while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header.every(b => b === 0)) break; // end-of-archive sentinel
        const name   = header.subarray(0,   100).toString("utf8").replace(/\0.*/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*/, "");
        const type   = String.fromCharCode(header[156]);
        const size   = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim(), 8) || 0;
        if (name && type !== "5") files.push(prefix ? `${prefix}/${name}` : name);
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      resolve(files);
    });
    input.on("error", reject);
    gunzip.on("error", reject);
    input.pipe(gunzip);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. npm pack produces valid tarball with correct file layout
// ═══════════════════════════════════════════════════════════════════════════

test("npm pack produces tarball with required files", async (t) => {
  const sandbox = createNpmSandbox("gsd-pack-test-");
  const tarballPath = packTarball(sandbox);

  assert.ok(existsSync(tarballPath), "tarball created");

  t.after(() => {
    rmSync(tarballPath, { force: true });
    rmSync(sandbox.rootDir, { recursive: true, force: true });
  });

  const files = await listTarEntries(tarballPath);

  // Critical files must be present
  assert.ok(files.some(f => f.includes("dist/loader.js")), "tarball contains dist/loader.js");
  assert.ok(files.some(f => f.includes("dist/cli.js")), "tarball contains dist/cli.js");
  assert.ok(files.some(f => f.includes("dist/app-paths.js")), "tarball contains dist/app-paths.js");
  assert.ok(files.some(f => f.includes("dist/wizard.js")), "tarball contains dist/wizard.js");
  assert.ok(files.some(f => f.includes("dist/resource-loader.js")), "tarball contains dist/resource-loader.js");
  assert.ok(files.some(f => f.includes("pkg/package.json")), "tarball contains pkg/package.json");
  assert.ok(files.some(f => f.includes("src/resources/extensions/gsd/index.ts")), "tarball contains bundled gsd extension");
  assert.ok(files.some(f => f.includes("scripts/postinstall.js")), "tarball contains postinstall script");
  assert.ok(files.some(f => f.includes("scripts/install/deps.js")), "tarball contains modular installer deps");

  // pkg/package.json must have piConfig
  const pkgJson = readFileSync(join(projectRoot, "pkg", "package.json"), "utf-8");
  const pkg = JSON.parse(pkgJson);
  assert.equal(pkg.piConfig?.name, "gsd", "pkg/package.json piConfig.name is gsd");
  assert.equal(pkg.piConfig?.configDir, ".gsd", "pkg/package.json piConfig.configDir is .gsd");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. npm pack → install → gsd binary resolves
// ═══════════════════════════════════════════════════════════════════════════

test("tarball installs and gsd binary resolves", async (t) => {
  const sandbox = createNpmSandbox("gsd-install-test-");
  const tarballPath = packTarball(sandbox);

  t.after(() => {
    rmSync(tarballPath, { force: true });
    rmSync(sandbox.rootDir, { recursive: true, force: true });
  });

  // Install from tarball into a temp prefix
  runNpmQuiet(["install", "--prefix", sandbox.installPrefix, tarballPath, "--no-save"], sandbox);

  // Verify the gsd bin exists in the installed package
  const binName = process.platform === "win32" ? "gsd.cmd" : "gsd";
  const installedBin = join(sandbox.installPrefix, "node_modules", ".bin", binName);
  assert.ok(existsSync(installedBin), `gsd binary exists in node_modules/.bin/ (${binName})`);

  // Verify loader.js is executable (has shebang)
  const installedLoader = join(sandbox.installPrefix, "node_modules", "@opengsd", "gsd-pi", "dist", "loader.js");
  const loaderContent = readFileSync(installedLoader, "utf-8");
  if (process.platform !== "win32") {
    assert.ok(loaderContent.startsWith("#!/usr/bin/env node"), "loader.js has node shebang");
  }

  // Verify bundled resources are present
  const installedGsdExt = join(
    sandbox.installPrefix,
    "node_modules",
    "@opengsd",
    "gsd-pi",
    "src",
    "resources",
    "extensions",
    "gsd",
    "index.ts",
  );
  assert.ok(existsSync(installedGsdExt), "bundled gsd extension present in installed package");

  await t.test("installed SDK docs ignore the branding shim (#2809)", () => {
    const installedRoot = join(sandbox.installPrefix, "node_modules", "@opengsd", "gsd-pi");
    const sdkRoot = join(installedRoot, "packages", "pi-coding-agent");
    const docProbe = String.raw`
      import assert from "node:assert/strict";
      import { readFileSync, readdirSync, realpathSync } from "node:fs";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";

      const installedRoot = realpathSync(process.argv[1]);
      process.env.PI_PACKAGE_DIR = join(installedRoot, "pkg");
      const sdkRoot = join(installedRoot, "packages", "pi-coding-agent");
      const { getReadmePath, getDocsPath, getExamplesPath } =
        await import(pathToFileURL(join(sdkRoot, "dist", "config.js")).href);

      for (const [name, actual] of [
        ["README.md", getReadmePath()],
        ["docs", getDocsPath()],
        ["examples", getExamplesPath()],
      ]) {
        assert.equal(actual, join(sdkRoot, name), name + " must resolve inside the installed SDK");
      }
      assert.notEqual(getReadmePath(), join(installedRoot, "README.md"));
      assert.match(readFileSync(getReadmePath(), "utf-8"), /\[docs\/sdk\.md\]\(docs\/sdk\.md\)/);
      assert.doesNotThrow(() => readFileSync(join(getDocsPath(), "sdk.md")), "readable SDK docs");
      assert.doesNotThrow(() => readdirSync(join(getExamplesPath(), "sdk")), "readable SDK examples");
    `;
    const probe = (root = installedRoot) => spawnSync(process.execPath, ["--input-type=module", "--eval", docProbe, root], {
      cwd: sandbox.installPrefix,
      env: sandbox.env,
      encoding: "utf-8",
      timeout: 30_000,
    });

    const installed = probe();
    assert.ifError(installed.error);
    assert.equal(installed.status, 0, installed.stderr);

    // Exercise symlinked install paths on Linux too (e.g. /var on macOS).
    const linkedRoot = join(sandbox.rootDir, "linked-install");
    symlinkSync(installedRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const linked = probe(linkedRoot);
    assert.ifError(linked.error);
    assert.equal(linked.status, 0, linked.stderr);

    // Remove each directory from the disposable install, never the checkout.
    // Reuse the identical child probe so missing packed assets cannot pass.
    for (const directory of ["docs", "examples"]) {
      const original = join(sdkRoot, directory);
      const removed = join(sandbox.rootDir, "removed-" + directory);
      renameSync(original, removed);
      try {
        const missing = probe();
        assert.ifError(missing.error);
        assert.equal(missing.status, 1, missing.stderr);
        assert.match(missing.stderr, /ERR_ASSERTION/);
        assert.match(missing.stderr, /ENOENT/);
        assert.match(missing.stderr, new RegExp("readable SDK " + directory));
      } finally {
        renameSync(removed, original);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Launch → extensions load → no errors on stderr
// ═══════════════════════════════════════════════════════════════════════════

test("gsd launches and loads extensions without errors", async () => {
  // Launch gsd with all optional keys set (skip wizard) and capture stderr.
  // Kill after 5 seconds — we just need to see if extensions load.
  // Assumes build already done.
  const output = await new Promise<string>((resolve) => {
    let stderr = "";
    const child = spawn("node", ["dist/loader.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BRAVE_API_KEY: "test",
        BRAVE_ANSWERS_KEY: "test",
        CONTEXT7_API_KEY: "test",
        JINA_API_KEY: "test",
        TAVILY_API_KEY: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Close stdin immediately so it's non-TTY
    child.stdin.end();

    // Give it 5s to start up
    const timer = setTimeout(() => {
      killChildProcess(child, "SIGTERM");
    }, 5000);

    child.on("close", () => {
      clearTimeout(timer);
      resolve(stderr);
    });
  });

  // No extension load errors
  assert.ok(
    !output.includes("[gsd] Extension load error"),
    `no extension load errors on stderr (got: ${output.slice(0, 500)})`,
  );

  // No crash / unhandled errors
  assert.ok(
    !output.includes("Error: Cannot find module"),
    "no missing module errors",
  );
  assert.ok(
    !output.includes("ERR_MODULE_NOT_FOUND"),
    "no ERR_MODULE_NOT_FOUND",
  );
});

test("gsd exits early with a clear message when synced resources are newer than the binary", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "gsd-version-skew-"));
  const fakeAgentDir = join(fakeHome, ".gsd", "agent");
  mkdirSync(fakeAgentDir, { recursive: true });
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: "999.0.0", packageName: "@opengsd/gsd-pi" }),
  );

  t.after(() => { rmSync(fakeHome, { recursive: true, force: true }); });

  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    const child = spawn("node", ["dist/loader.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: fakeHome,
        BRAVE_API_KEY: "test",
        BRAVE_ANSWERS_KEY: "test",
        CONTEXT7_API_KEY: "test",
        JINA_API_KEY: "test",
        TAVILY_API_KEY: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.end();
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });

  assert.equal(result.code, 1, "startup exits with code 1 on version skew");
  assert.match(result.stderr, /Version mismatch detected/, "prints a friendly skew header");
  assert.match(result.stderr, /npm install -g @opengsd\/gsd-pi@latest|gsd upgrade/, "prints upgrade guidance");
  assert.doesNotMatch(result.stderr, /\[gsd\] Extension load error/, "fails before extension loading");
});

test("installer help exits cleanly", () => {
  const result = spawnSync("node", ["scripts/install.js", "--help"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--yes/);
});
