/**
 * Regression test for #3445: gsd update must print both current and latest
 * versions for diagnostics, and bypass npm cache.
 * Regression test for #4145: gsd update must use bun when installed via Bun.
 * Regression test: gsd update must use pnpm when installed via pnpm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";

import { runUpdate } from "../update-cmd.ts";
import { handleUpdate } from "../resources/extensions/gsd/commands-handlers.ts";
import { compareSemver, GSD_BROWSER_PACKAGE_NAME, GSD_BROWSER_REGISTRY_URL, resolveInstalledPackageVersion } from "../update-check.js";
import { reconcileGsdBrowserPathAfterInstall } from "../resources/shared/gsd-browser-path-sync.ts";

function writeFakeClaude(binDir: string, output: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  const content = process.platform === "win32"
    ? `@echo off\r\necho ${output}\r\n`
    : `#!/bin/sh\necho "${output}"\n`;
  writeFileSync(script, content);
  if (process.platform !== "win32") chmodSync(script, 0o755);
}

function writeFakeGsdBrowser(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, process.platform === "win32" ? "gsd-browser.cmd" : "gsd-browser");
  const content = process.platform === "win32"
    ? `@echo off\r\necho gsd-browser ${version}\r\n`
    : `#!/bin/sh\necho "gsd-browser ${version}"\n`;
  writeFileSync(script, content);
  if (process.platform !== "win32") chmodSync(script, 0o755);
  return script;
}

function resolveGsdBrowserPathVersionFromEnv(env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync("gsd-browser", ["--version"], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function writeFakeNpmGlobalBin(dir: string, globalBinDir: string): void {
  mkdirSync(dir, { recursive: true });
  const npm = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
  const content = process.platform === "win32"
    ? `@echo off\r\nif "%1"=="bin" if "%2"=="-g" (\r\n  echo ${globalBinDir}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`
    : `#!/bin/sh\nif [ "$1" = "bin" ] && [ "$2" = "-g" ]; then\n  echo "${globalBinDir}"\n  exit 0\nfi\nexit 1\n`;
  writeFileSync(npm, content);
  if (process.platform !== "win32") chmodSync(npm, 0o755);
}

test("update-cmd prints latest version before comparison (#3445)", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalStdoutWrite = process.stdout.write;
  const writes: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-diagnostics-"));

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  try {
    process.env.GSD_VERSION = "1.2.3";
    globalThis.fetch = async () => Response.json({ version: "1.2.3" });
    (process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };

    await runUpdate({ agentDir: join(tmp, "agent"), skillsDir: join(tmp, "skills") });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdoutWrite;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
  }

  const output = writes.join("");
  const latestPrintIdx = output.indexOf("Latest version:");
  const comparisonIdx = output.indexOf("Already up to date.");
  assert.ok(latestPrintIdx !== -1, "Must print latest version");
  assert.ok(latestPrintIdx < comparisonIdx, "Must print latest BEFORE comparison result");
});

test("update-cmd refreshes managed resources when already up to date (#52)", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalStdoutWrite = process.stdout.write;
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-refresh-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(fakeAgentDir, { recursive: true });

  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: "3.0.0", packageName: "gsd-pi", syncedAt: Date.now() }),
  );

  try {
    process.env.GSD_VERSION = "1.0.1";
    globalThis.fetch = async () => Response.json({ version: "1.0.1" });
    (process.stdout as any).write = () => true;

    await runUpdate({ agentDir: fakeAgentDir, skillsDir: join(tmp, "skills") });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdoutWrite;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
  }

  const manifest = JSON.parse(readFileSync(join(fakeAgentDir, "managed-resources.json"), "utf-8"));
  assert.equal(manifest.gsdVersion, "1.0.1");
  assert.equal(manifest.packageName, "@opengsd/gsd-pi");
});

test("update-cmd prints Claude Code Runtime floor advisory after normal update result", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalStdoutWrite = process.stdout.write;
  const originalPath = process.env.PATH;
  const writes: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-claude-floor-"));
  const agentDir = join(tmp, "agent");
  const binDir = join(tmp, "bin");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "claude-code" }));
  writeFakeClaude(binDir, "2.1.100 (Claude Code)");

  try {
    process.env.GSD_VERSION = "1.2.3";
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    globalThis.fetch = async () => Response.json({ version: "1.2.3" });
    (process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };

    await runUpdate({ agentDir, skillsDir: join(tmp, "skills") });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdoutWrite;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }

  const output = writes.join("");
  const updateIdx = output.indexOf("Already up to date.");
  const advisoryIdx = output.indexOf("Claude Code Runtime is below GSD's validated floor");
  assert.ok(updateIdx !== -1, "expected normal update result");
  assert.ok(advisoryIdx !== -1, "expected Claude Code Runtime advisory");
  assert.ok(advisoryIdx > updateIdx, "advisory should appear after the normal update result");
});

test("update-cmd supports browser-only update checks", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const writes: string[] = [];
  const browserVersion = resolveInstalledPackageVersion(GSD_BROWSER_PACKAGE_NAME) ?? "0.1.27";

  try {
    globalThis.fetch = async () => Response.json({ version: browserVersion });
    (process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };

    await runUpdate({ target: "browser" });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdoutWrite;
  }

  const output = writes.join("");
  assert.match(output, /Current gsd-browser version:/);
  assert.match(output, /Latest gsd-browser version:/);
  assert.match(output, /gsd-browser is already up to date/);
});

test("update-check exports resolveInstallCommand (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  assert.equal(typeof resolveInstallCommand, "function", "resolveInstallCommand must be exported from update-check");
});

test("resolveInstallCommand returns bun command when running under Bun (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    (process.versions as Record<string, string | undefined>).bun = "1.0.0";
    assert.equal(resolveInstallCommand("@opengsd/gsd-pi@latest"), "bun add -g @opengsd/gsd-pi@latest");
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand returns npm command when not running under Bun (#4145)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
        env: {} as any,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );
  } finally {
    if (orig !== undefined) {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand pins Windows npm updates to the running global prefix (#490)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@opengsd\\gsd-pi\\dist\\loader.js",
        env: {} as any,
        platform: "win32",
        // Simulate the npm.cmd sibling that lives at the global prefix root.
        existsFn: (p) => p === "C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd",
      }),
      'npm --prefix "C:\\Users\\me\\AppData\\Roaming\\npm" install -g @opengsd/gsd-pi@latest',
    );
  } finally {
    if (orig !== undefined) {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand falls back to plain npm for Windows non-global layouts (npx cache, local node_modules)", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;

    // npx cache: directory above node_modules has no npm.cmd sibling.
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@opengsd\\gsd-pi\\dist\\loader.js",
        env: {} as any,
        platform: "win32",
        existsFn: () => false,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );

    // Local project node_modules: same story — no npm.cmd at the project root.
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "C:\\Users\\me\\projects\\app\\node_modules\\@opengsd\\gsd-pi\\dist\\loader.js",
        env: {} as any,
        platform: "win32",
        existsFn: () => false,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );
  } finally {
    if (orig !== undefined) {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand returns pnpm command when installed via pnpm", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "/Users/me/Library/pnpm/global/5/node_modules/.pnpm/@opengsd+gsd-pi@1.0.0/node_modules/@opengsd/gsd-pi/dist/loader.js",
        env: {} as any,
      }),
      "pnpm add -g @opengsd/gsd-pi@latest",
    );
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("resolveInstallCommand ignores unrelated paths with pnpm directory names", async () => {
  const { resolveInstallCommand } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  try {
    delete (process.versions as Record<string, string | undefined>).bun;
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "/home/user/projects/pnpm/app/node_modules/@opengsd/gsd-pi/dist/loader.js",
        env: {} as any,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
        env: { npm_execpath: "/opt/tools/pnpm/wrapper/npm-cli.js" } as any,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );
    assert.equal(
      resolveInstallCommand("@opengsd/gsd-pi@latest", {
        argv1: "/opt/library/pnpm/wrapper/npm-cli.js",
        env: {} as any,
      }),
      "npm install -g @opengsd/gsd-pi@latest",
    );
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
  }
});

test("/gsd update handler fetches latest version through the registry endpoint (#3806)", async () => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const fetchUrls: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  try {
    process.env.GSD_VERSION = "1.2.3";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return Response.json({ version: "1.2.3" });
    };

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
  }

  assert.deepEqual(fetchUrls, ["https://registry.npmjs.org/@opengsd%2fgsd-pi/latest"]);
  assert.ok(notifications.some((notification) => notification.message.includes("Already up to date")));
});

test("/gsd update handler warns after update result when Claude Code Runtime is below floor", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalGsdHome = process.env.GSD_HOME;
  const originalPath = process.env.PATH;
  const notifications: Array<{ message: string; level: string }> = [];
  const tmp = mkdtempSync(join(tmpdir(), "gsd-command-claude-floor-"));
  const agentDir = join(tmp, "agent");
  const binDir = join(tmp, "bin");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "claude-code" }));
  writeFakeClaude(binDir, "2.1.100 (Claude Code)");

  try {
    process.env.GSD_VERSION = "1.2.3";
    process.env.GSD_HOME = tmp;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    globalThis.fetch = async () => Response.json({ version: "1.2.3" });

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
    if (originalGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = originalGsdHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }

  const updateIdx = notifications.findIndex((notification) => notification.message.includes("Already up to date"));
  const advisoryIdx = notifications.findIndex((notification) => notification.message.includes("Claude Code Runtime is below GSD's validated floor"));
  assert.ok(updateIdx !== -1, "expected normal update result");
  assert.ok(advisoryIdx !== -1, "expected Claude Code Runtime advisory");
  assert.equal(notifications[advisoryIdx]?.level, "warning");
  assert.ok(advisoryIdx > updateIdx, "advisory should appear after the normal update result");
});

test("/gsd update browser handler fetches latest gsd-browser version", async () => {
  const originalFetch = globalThis.fetch;
  const originalGsdHome = process.env.GSD_HOME;
  const originalPath = process.env.PATH;
  const originalBrowserPathVersion = process.env.GSD_BROWSER_PATH_VERSION;
  const fetchUrls: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const browserVersion = resolveInstalledPackageVersion(GSD_BROWSER_PACKAGE_NAME) ?? "0.1.27";
  const tmp = mkdtempSync(join(tmpdir(), "gsd-command-browser-floor-"));
  const agentDir = join(tmp, "agent");
  const binDir = join(tmp, "bin");

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "claude-code" }));
    writeFakeClaude(binDir, "2.1.100 (Claude Code)");
    process.env.GSD_HOME = tmp;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    process.env.GSD_BROWSER_PATH_VERSION = browserVersion;
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return Response.json({ version: browserVersion });
    };

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any, "browser");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(tmp, { recursive: true, force: true });
    if (originalGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = originalGsdHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalBrowserPathVersion === undefined) {
      delete process.env.GSD_BROWSER_PATH_VERSION;
    } else {
      process.env.GSD_BROWSER_PATH_VERSION = originalBrowserPathVersion;
    }
  }

  assert.deepEqual(fetchUrls, ["https://registry.npmjs.org/@opengsd%2fgsd-browser/latest"]);
  assert.ok(notifications.some((notification) => notification.message.includes("Already up to date")));
  assert.equal(
    notifications.some((notification) => notification.message.includes("Claude Code Runtime is below GSD's validated floor")),
    false,
  );
});

test("/gsd update handler suggests pnpm when installed via pnpm", async () => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalUserAgent = process.env.npm_config_user_agent;
  const originalPath = process.env.PATH;
  const notifications: Array<{ message: string; level: string }> = [];

  try {
    process.env.GSD_VERSION = "1.0.0";
    process.env.npm_config_user_agent = "pnpm/10.12.1 npm/? node/v24.0.0";
    process.env.PATH = "";
    globalThis.fetch = async () => Response.json({ version: "9.9.9" });

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
    if (originalUserAgent === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = originalUserAgent;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }

  assert.ok(
    notifications.some((notification) =>
      notification.message.includes("Try manually: pnpm add -g @opengsd/gsd-pi@latest")
    ),
  );
});

test("/gsd update handler ignores unrelated pnpm directory names", async () => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.GSD_VERSION;
  const originalUserAgent = process.env.npm_config_user_agent;
  const originalExecPath = process.env.npm_execpath;
  const originalPnpmHome = process.env.PNPM_HOME;
  const originalBunInstall = process.env.BUN_INSTALL;
  const originalPath = process.env.PATH;
  const originalArgv1 = process.argv[1];
  const originalBun = (process.versions as Record<string, string | undefined>).bun;
  const notifications: Array<{ message: string; level: string }> = [];

  try {
    process.env.GSD_VERSION = "1.0.0";
    delete process.env.npm_config_user_agent;
    delete process.env.npm_execpath;
    delete process.env.PNPM_HOME;
    delete process.env.BUN_INSTALL;
    delete (process.versions as Record<string, string | undefined>).bun;
    process.env.PATH = "";
    process.argv[1] = "/home/user/projects/pnpm/app/node_modules/@opengsd/gsd-pi/dist/loader.js";
    globalThis.fetch = async () => Response.json({ version: "9.9.9" });

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION;
    } else {
      process.env.GSD_VERSION = originalVersion;
    }
    if (originalUserAgent === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = originalUserAgent;
    }
    if (originalExecPath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = originalExecPath;
    }
    if (originalPnpmHome === undefined) {
      delete process.env.PNPM_HOME;
    } else {
      process.env.PNPM_HOME = originalPnpmHome;
    }
    if (originalBunInstall === undefined) {
      delete process.env.BUN_INSTALL;
    } else {
      process.env.BUN_INSTALL = originalBunInstall;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    process.argv[1] = originalArgv1;
    if (originalBun === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = originalBun;
    }
  }

  assert.ok(
    notifications.some((notification) =>
      notification.message.includes("Try manually: npm install -g @opengsd/gsd-pi@latest")
    ),
  );
});

test("isBunInstall detects bun install via argv[1] even when process.versions.bun is undefined (#4145)", async () => {
  const { isBunInstall } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  const origArgv1 = process.argv[1];
  const origBunInstall = process.env.BUN_INSTALL;
  try {
    // Simulate running under Node (not Bun) — matches the real-world shim case
    // where the bun-installed symlink's target has #!/usr/bin/env node.
    delete (process.versions as Record<string, string | undefined>).bun;
    delete process.env.BUN_INSTALL;

    // argv[1] preserves the unresolved symlink path, not the realpath target.
    process.argv[1] = join(process.env.HOME ?? "/home/user", ".bun", "bin", "gsd");
    assert.equal(isBunInstall(), true, "should detect bun install from ~/.bun/bin/ argv[1]");

    // Custom BUN_INSTALL location
    process.env.BUN_INSTALL = "/opt/bun";
    process.argv[1] = "/opt/bun/bin/gsd";
    assert.equal(isBunInstall(), true, "should detect bun install from $BUN_INSTALL/bin/ argv[1]");

    // Non-bun path must NOT match
    delete process.env.BUN_INSTALL;
    process.argv[1] = "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js";
    assert.equal(isBunInstall(), false, "npm global install path should not match");

    // Prefix false-positive guard: /.bun/bin-other should not match /.bun/bin
    process.argv[1] = join(process.env.HOME ?? "/home/user", ".bun", "bin-other", "gsd");
    assert.equal(isBunInstall(), false, "sibling dir with bin prefix should not match");
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
    process.argv[1] = origArgv1;
    if (origBunInstall === undefined) {
      delete process.env.BUN_INSTALL;
    } else {
      process.env.BUN_INSTALL = origBunInstall;
    }
  }
});

test("isBunInstall returns true when running under Bun runtime (#4145)", async () => {
  const { isBunInstall } = await import("../update-check.js");
  const orig = (process.versions as Record<string, string | undefined>).bun;
  const origArgv1 = process.argv[1];
  try {
    (process.versions as Record<string, string | undefined>).bun = "1.0.0";
    // Even with a non-bun argv[1], runtime detection wins
    process.argv[1] = "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js";
    assert.equal(isBunInstall(), true);
  } finally {
    if (orig === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      (process.versions as Record<string, string | undefined>).bun = orig;
    }
    process.argv[1] = origArgv1;
  }
});

test("runBrowserUpdate uses PATH version as current when it is newer than bundled", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalBrowserPathVersion = process.env.GSD_BROWSER_PATH_VERSION;
  const writes: string[] = [];

  t.after(() => {
    if (originalBrowserPathVersion === undefined) {
      delete process.env.GSD_BROWSER_PATH_VERSION;
    } else {
      process.env.GSD_BROWSER_PATH_VERSION = originalBrowserPathVersion;
    }
  });

  try {
    // PATH has 99.0.0 and registry reports the same — should be "up to date"
    process.env.GSD_BROWSER_PATH_VERSION = "99.0.0";
    globalThis.fetch = async (input) => {
      assert.equal(String(input), GSD_BROWSER_REGISTRY_URL);
      return Response.json({ version: "99.0.0" });
    };
    (process.stdout as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };

    await runUpdate({ target: "browser" });
  } finally {
    globalThis.fetch = originalFetch;
    (process.stdout as any).write = originalStdoutWrite;
  }

  const output = writes.join("");
  assert.match(output, /Current gsd-browser version:.*99\.0\.0/);
  assert.match(output, /gsd-browser is already up to date/);
});

test("/gsd update browser uses PATH version as current when it is newer than bundled", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalBrowserPathVersion = process.env.GSD_BROWSER_PATH_VERSION;
  const notifications: Array<{ message: string; level: string }> = [];

  t.after(() => {
    if (originalBrowserPathVersion === undefined) {
      delete process.env.GSD_BROWSER_PATH_VERSION;
    } else {
      process.env.GSD_BROWSER_PATH_VERSION = originalBrowserPathVersion;
    }
  });

  try {
    process.env.GSD_BROWSER_PATH_VERSION = "99.0.0";
    globalThis.fetch = async () => Response.json({ version: "99.0.0" });

    await handleUpdate({
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as any, "browser");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(notifications.some((n) => n.message.includes("Already up to date")));
});

test("isPnpmInstall detects pnpm user agent, exec path, and PNPM_HOME", async () => {
  const { isPnpmInstall } = await import("../update-check.js");

  assert.equal(
    isPnpmInstall("/usr/local/bin/gsd", { npm_config_user_agent: "pnpm/10.12.1 npm/? node/v24.0.0" } as any),
    true,
  );
  assert.equal(
    isPnpmInstall("/usr/local/bin/gsd", { npm_execpath: "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs" } as any),
    true,
  );
  assert.equal(
    isPnpmInstall("/custom/pnpm-home/gsd", { PNPM_HOME: "/custom/pnpm-home" } as any),
    true,
  );
  assert.equal(
    isPnpmInstall("/usr/local/bin/gsd", { PNPM_HOME: "/custom/pnpm-home", npm_execpath: "/custom/pnpm-home/wrapper/npm-cli.js" } as any),
    true,
  );
  assert.equal(
    isPnpmInstall("/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js", {} as any),
    false,
  );
});

test("reconcileGsdBrowserPathAfterInstall syncs stale managed PATH binary", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink PATH shadowing scenario");
  }

  const tmp = mkdtempSync(join(tmpdir(), "gsd-browser-path-sync-"));
  const homeDir = join(tmp, "home");
  const managedBinDir = join(homeDir, ".gsd-browser", "bin");
  const pathBinDir = join(tmp, "path-bin");
  const globalBinDir = join(tmp, "global-bin");
  const fakeNpmDir = join(tmp, "fake-npm");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const managedCli = writeFakeGsdBrowser(managedBinDir, "1.0.0");
  writeFakeGsdBrowser(globalBinDir, "2.0.0");
  mkdirSync(pathBinDir, { recursive: true });
  symlinkSync(managedCli, join(pathBinDir, "gsd-browser"));
  writeFakeNpmGlobalBin(fakeNpmDir, globalBinDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${pathBinDir}${delimiter}${fakeNpmDir}`,
    npm_config_user_agent: undefined,
    npm_execpath: undefined,
    PNPM_HOME: undefined,
  };

  const result = reconcileGsdBrowserPathAfterInstall({
    latestVersion: "2.0.0",
    compareSemver,
    resolvePathVersion: resolveGsdBrowserPathVersionFromEnv,
    env,
    argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
  });

  assert.equal(result.action, "synced");
  assert.equal(resolveGsdBrowserPathVersionFromEnv(env), "2.0.0");
  assert.match(result.message ?? "", /Synced PATH-resolved gsd-browser/);
});

test("reconcileGsdBrowserPathAfterInstall reports shadowing for non-home targets", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink PATH shadowing scenario");
  }

  const tmp = mkdtempSync(join(tmpdir(), "gsd-browser-path-shadow-"));
  const staleBinDir = join(tmp, "usr", "local", "bin");
  const globalBinDir = join(tmp, "global-bin");
  const fakeNpmDir = join(tmp, "fake-npm");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFakeGsdBrowser(staleBinDir, "1.0.0");
  writeFakeGsdBrowser(globalBinDir, "2.0.0");
  writeFakeNpmGlobalBin(fakeNpmDir, globalBinDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, "home"),
    PATH: `${staleBinDir}${delimiter}${fakeNpmDir}`,
    npm_config_user_agent: undefined,
    npm_execpath: undefined,
    PNPM_HOME: undefined,
  };

  const result = reconcileGsdBrowserPathAfterInstall({
    latestVersion: "2.0.0",
    compareSemver,
    resolvePathVersion: resolveGsdBrowserPathVersionFromEnv,
    env,
    argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
  });

  assert.equal(result.action, "shadowed");
  assert.equal(resolveGsdBrowserPathVersionFromEnv(env), "1.0.0");
  assert.match(result.message ?? "", /Move your package manager global bin directory ahead/);
});

test("reconcileGsdBrowserPathAfterInstall reports synced when copy succeeds even if PATH version probe is inconclusive", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink PATH shadowing scenario");
  }

  const tmp = mkdtempSync(join(tmpdir(), "gsd-browser-path-sync-unverified-"));
  const homeDir = join(tmp, "home");
  const managedBinDir = join(homeDir, ".gsd-browser", "bin");
  const pathBinDir = join(tmp, "path-bin");
  const globalBinDir = join(tmp, "global-bin");
  const fakeNpmDir = join(tmp, "fake-npm");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const managedCli = writeFakeGsdBrowser(managedBinDir, "1.0.0");
  writeFakeGsdBrowser(globalBinDir, "2.0.0");
  mkdirSync(pathBinDir, { recursive: true });
  symlinkSync(managedCli, join(pathBinDir, "gsd-browser"));
  writeFakeNpmGlobalBin(fakeNpmDir, globalBinDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${pathBinDir}${delimiter}${fakeNpmDir}`,
    npm_config_user_agent: undefined,
    npm_execpath: undefined,
    PNPM_HOME: undefined,
  };

  // Pretend the post-sync version probe cannot read the new version (timeout,
  // shell cache, etc.) by returning null on the second call. The first call —
  // before sync — sees the old binary; the second — after sync — returns null.
  let probeCalls = 0;
  const flakyResolvePathVersion = (probeEnv: NodeJS.ProcessEnv): string | null => {
    probeCalls += 1;
    return probeCalls === 1 ? resolveGsdBrowserPathVersionFromEnv(probeEnv) : null;
  };

  const result = reconcileGsdBrowserPathAfterInstall({
    latestVersion: "2.0.0",
    compareSemver,
    resolvePathVersion: flakyResolvePathVersion,
    env,
    argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
  });

  // The copy actually succeeded — the post-sync probe being inconclusive
  // must not flip the result to "shadowed".
  assert.equal(result.action, "synced");
  assert.equal(resolveGsdBrowserPathVersionFromEnv(env), "2.0.0");
  assert.match(result.message ?? "", /Synced PATH-resolved gsd-browser/);
});

test("reconcileGsdBrowserPathAfterInstall does not throw when PATH entry vanishes between resolve and sync", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink PATH shadowing scenario");
  }

  const tmp = mkdtempSync(join(tmpdir(), "gsd-browser-path-vanish-"));
  const homeDir = join(tmp, "home");
  const pathBinDir = join(tmp, "path-bin");
  const globalBinDir = join(tmp, "global-bin");
  const fakeNpmDir = join(tmp, "fake-npm");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFakeGsdBrowser(globalBinDir, "2.0.0");
  mkdirSync(pathBinDir, { recursive: true });
  // Write a stale binary on PATH so resolvePathBinary finds it, then delete it
  // before reconciliation reads it via lstatSync. resolvePathBinary uses
  // existsSync which can race with deletion in real systems; simulate that
  // here by leaving an entry that disappears between the two reads.
  writeFakeGsdBrowser(pathBinDir, "1.0.0");
  writeFakeNpmGlobalBin(fakeNpmDir, globalBinDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${pathBinDir}${delimiter}${fakeNpmDir}`,
    npm_config_user_agent: undefined,
    npm_execpath: undefined,
    PNPM_HOME: undefined,
  };

  // Patch resolvePathVersion to remove the PATH binary the moment it is first
  // queried — that mimics the entry vanishing between resolution and the
  // lstatSync call inside reconcileGsdBrowserPathAfterInstall.
  let firstCall = true;
  const racyResolvePathVersion = (probeEnv: NodeJS.ProcessEnv): string | null => {
    if (firstCall) {
      firstCall = false;
      const version = resolveGsdBrowserPathVersionFromEnv(probeEnv);
      rmSync(join(pathBinDir, "gsd-browser"), { force: true });
      return version;
    }
    return resolveGsdBrowserPathVersionFromEnv(probeEnv);
  };

  // The reconciliation must not throw even if the PATH entry disappears.
  assert.doesNotThrow(() => {
    reconcileGsdBrowserPathAfterInstall({
      latestVersion: "2.0.0",
      compareSemver,
      resolvePathVersion: racyResolvePathVersion,
      env,
      argv1: "/usr/local/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
    });
  });
});
