import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

const requireFromTest = createRequire(import.meta.url);

function overrideHomeEnv(homeDir: string): () => void {
  const original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  if (process.platform === "win32") {
    const parsedHome = parse(homeDir);
    process.env.HOMEDRIVE = parsedHome.root.replace(/[\\/]+$/, "");

    const homePath = homeDir.slice(parsedHome.root.length).replace(/\//g, "\\");
    process.env.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
  }

  return () => {
    if (original.HOME === undefined) delete process.env.HOME; else process.env.HOME = original.HOME;
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = original.USERPROFILE;
    if (original.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = original.HOMEDRIVE;
    if (original.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = original.HOMEPATH;
  };
}

function hasSyncedResourceFile(rootDir: string, relativePathWithoutExtension: string): boolean {
  return existsSync(join(rootDir, `${relativePathWithoutExtension}.js`)) ||
    existsSync(join(rootDir, `${relativePathWithoutExtension}.ts`));
}

function bundledSharedDir(): string {
  return existsSync(join(process.cwd(), "dist", "resources", "shared"))
    ? join(process.cwd(), "dist", "resources", "shared")
    : join(process.cwd(), "src", "resources", "shared");
}

function bundledSkillsDir(): string {
  return existsSync(join(process.cwd(), "dist", "resources", "skills"))
    ? join(process.cwd(), "dist", "resources", "skills")
    : join(process.cwd(), "src", "resources", "skills");
}

function currentPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
  return process.env.GSD_VERSION && process.env.GSD_VERSION !== "0.0.0"
    ? process.env.GSD_VERSION
    : packageJson.version;
}

function packagedGsdBrowserSkillPath(): string {
  return requireFromTest.resolve("@opengsd/gsd-browser/SKILL.md");
}

function packagedGsdBrowserSkill(): string {
  return readFileSync(packagedGsdBrowserSkillPath(), "utf-8");
}

test("getExtensionKey normalizes top-level .ts and .js entry names to the same key", async () => {
  const { getExtensionKey } = await import("../resource-loader.ts");
  const extensionsDir = "/tmp/extensions";

  assert.equal(
    getExtensionKey("/tmp/extensions/ask-user-questions.ts", extensionsDir),
    "ask-user-questions",
  );
  assert.equal(
    getExtensionKey("/tmp/extensions/ask-user-questions.js", extensionsDir),
    "ask-user-questions",
  );
  assert.equal(
    getExtensionKey("/tmp/extensions/gsd/index.js", extensionsDir),
    "gsd",
  );
});

test("hasStaleCompiledExtensionSiblings detects installed format drift against the bundled root", async (t) => {
  const { hasStaleCompiledExtensionSiblings } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-"));
  const extensionsDir = join(tmp, "extensions");
  const bundledDir = join(tmp, "bundled");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(join(extensionsDir, "gsd"), { recursive: true });
  writeFileSync(join(extensionsDir, "gsd", "index.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);

  writeFileSync(join(bundledDir, "ask-user-questions.js"), "export {};\n");
  writeFileSync(join(extensionsDir, "ask-user-questions.js"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);

  writeFileSync(join(extensionsDir, "ask-user-questions.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), true);

  writeFileSync(join(bundledDir, "ask-user-questions.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);
});

test("hasStaleCompiledExtensionSiblings detects nested bundled extension format drift", async (t) => {
  const { hasStaleCompiledExtensionSiblings } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-nested-"));
  const extensionsDir = join(tmp, "extensions");
  const bundledDir = join(tmp, "bundled");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  mkdirSync(join(extensionsDir, "gsd", "auto"), { recursive: true });
  mkdirSync(join(bundledDir, "gsd", "auto"), { recursive: true });

  writeFileSync(join(extensionsDir, "gsd", "index.ts"), "export {};\n");
  writeFileSync(join(extensionsDir, "gsd", "auto", "phases.ts"), "export {};\n");
  writeFileSync(join(bundledDir, "gsd", "index.js"), "export {};\n");
  writeFileSync(join(bundledDir, "gsd", "auto", "phases.js"), "export {};\n");

  assert.equal(
    hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir),
    true,
    "source .ts files under bundled subdirectories must trigger a resync when the bundle has .js",
  );
});

test("buildResourceLoader does not load any pi extensions from ~/.pi/agent/extensions", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-home-"));
  const piExtensionsDir = join(tmp, ".pi", "agent", "extensions");
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(piExtensionsDir, { recursive: true });
  writeFileSync(join(piExtensionsDir, "ask-user-questions.ts"), "export {};\n");
  writeFileSync(join(piExtensionsDir, "custom-extension.ts"), "export {};\n");

  const { buildResourceLoader } = await import("../resource-loader.ts");
  const loader = await buildResourceLoader(fakeAgentDir) as { additionalExtensionPaths?: string[] };
  const additionalExtensionPaths = loader.additionalExtensionPaths ?? [];

  assert.equal(
    additionalExtensionPaths.some((entryPath) => entryPath.endsWith("ask-user-questions.ts")),
    false,
    "pi extensions should not be loaded even if they duplicate a bundled extension",
  );
  assert.equal(
    additionalExtensionPaths.some((entryPath) => entryPath.endsWith("custom-extension.ts")),
    false,
    "pi extensions should not be loaded even if they are not bundled duplicates",
  );
});

test("buildResourceLoader includes caller-provided additional extension paths", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-cli-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const cliExtensionPath = join(tmp, "cli-extension.ts");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  writeFileSync(cliExtensionPath, "export {};\n");

  const { buildResourceLoader } = await import("../resource-loader.ts");
  const loader = await buildResourceLoader(fakeAgentDir, {
    additionalExtensionPaths: [cliExtensionPath],
  }) as { additionalExtensionPaths?: string[] };
  const additionalExtensionPaths = loader.additionalExtensionPaths ?? [];

  assert.equal(
    additionalExtensionPaths.includes(cliExtensionPath),
    true,
    "caller-provided extension paths should be threaded into the resource loader",
  );
});

test("buildResourceLoader loads user-installed extensions and lets them shadow bundled IDs", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-installed-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const bundledExtensionDir = join(fakeAgentDir, "extensions", "shared-id");
  const installedExtensionDir = join(tmp, ".gsd", "extensions", "installed-copy");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const manifest = JSON.stringify({
    id: "shared-id",
    name: "Shared ID",
    version: "1.0.0",
    description: "test",
    tier: "community",
    requires: { platform: "node" },
  });
  mkdirSync(bundledExtensionDir, { recursive: true });
  mkdirSync(join(installedExtensionDir, "dist"), { recursive: true });
  writeFileSync(join(bundledExtensionDir, "extension-manifest.json"), manifest);
  writeFileSync(join(installedExtensionDir, "extension-manifest.json"), manifest);
  writeFileSync(
    join(installedExtensionDir, "package.json"),
    JSON.stringify({ pi: { extensions: ["./dist/index.js"] } }),
  );
  writeFileSync(
    join(tmp, ".gsd", "extensions", "registry.json"),
    JSON.stringify({
      version: 1,
      entries: { "shared-id": { id: "shared-id", enabled: true, source: "user" } },
    }),
  );
  const bundledEntryPath = join(bundledExtensionDir, "index.ts");
  const installedEntryPath = join(installedExtensionDir, "dist", "index.js");
  writeFileSync(bundledEntryPath, "export default function() {};\n");
  writeFileSync(
    installedEntryPath,
    'export default function(pi) { pi.registerCommand("installed-command", { handler: async () => {} }); };\n',
  );

  const { buildResourceLoader } = await import("../resource-loader.ts");
  const loader = await buildResourceLoader(fakeAgentDir) as {
    reload(): Promise<void>;
    getExtensions(): { extensions: Array<{ path: string; commands: Map<string, unknown> }> };
  };
  await loader.reload();

  assert.deepEqual(
    loader.getExtensions().extensions.map((extension) => extension.path),
    [installedEntryPath],
    "the installed extension should replace the bundled extension with the same manifest ID",
  );
  assert.equal(
    loader.getExtensions().extensions[0]?.commands.has("installed-command"),
    true,
    "the installed extension's command should be registered",
  );
});

test("buildResourceLoader loads extensions installed by the slash command", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-installed-extension-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const installedExtensionDir = join(tmp, ".gsd", "extensions", "example-installed");
  const installedEntryPath = join(installedExtensionDir, "index.js");

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeAgentDir, { recursive: true });
  mkdirSync(installedExtensionDir, { recursive: true });
  writeFileSync(
    join(installedExtensionDir, "extension-manifest.json"),
    JSON.stringify({
      id: "example.installed",
      name: "Installed Extension",
      version: "1.0.0",
      description: "test extension",
      tier: "community",
      requires: { platform: "node" },
    }),
  );
  writeFileSync(
    join(installedExtensionDir, "package.json"),
    JSON.stringify({ type: "module", pi: { extensions: ["index.js"] } }),
  );
  writeFileSync(installedEntryPath, "export default function () {}\n");

  const { buildResourceLoader } = await import("../resource-loader.ts");
  const loader = await buildResourceLoader(fakeAgentDir);
  await loader.reload();

  assert.equal(
    loader.getExtensions().extensions.some((extension) => extension.path === installedEntryPath),
    true,
    "slash-command-installed extension should be part of the runtime extension set",
  );
});

test("initResources manifest tracks all bundled extension subdirectories including remote-questions (#2367)", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-manifest-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir, join(tmp, "skills"));

    const manifestPath = join(fakeAgentDir, "managed-resources.json");
    assert.equal(existsSync(manifestPath), true, "managed-resources.json should exist after initResources");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const installedDirs: string[] = manifest.installedExtensionDirs ?? [];

    assert.equal(
      manifest.packageName,
      "@opengsd/gsd-pi",
      "managed resource manifest should be scoped to the package that wrote it",
    );

    // remote-questions uses mod.ts (not index.ts) as its entry point and has an
    // extension-manifest.json — it must still appear in the manifest so that
    // pruneRemovedBundledExtensions can track it across upgrades.
    assert.ok(
      installedDirs.includes("remote-questions"),
      `installedExtensionDirs should include remote-questions but got: [${installedDirs.join(", ")}]`,
    );

    // Also verify that the synced remote-questions directory actually exists in the agent dir
    assert.equal(
      existsSync(join(fakeAgentDir, "extensions", "remote-questions")),
      true,
      "remote-questions directory should be synced to agent extensions",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("initResources syncs bundled skills to the GSD agent dir by default", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-skills-local-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(join(fakeAgentDir, "skills", "lint", "SKILL.md")),
    true,
    "bundled skills should sync under ~/.gsd/agent/skills by default",
  );
  assert.equal(
    existsSync(join(tmp, ".agents", "skills", "lint", "SKILL.md")),
    false,
    "initResources should not write bundled skills to ~/.agents/skills by default",
  );
});

// The bundled agent-browser skill has nested directories, so an exact copy of
// it exercises the recursive comparison in the ecosystem-dir cleanup (#2286).
function bundledAgentBrowserSkillDir(): string {
  return join(bundledSkillsDir(), "agent-browser");
}

test("initResources leaves a user-modified same-named skill in ~/.agents/skills untouched", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-user-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "agent-browser");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(bundledAgentBrowserSkillDir(), ecosystemSkillDir, { recursive: true });
  const userContent = "---\nname: agent-browser\ndescription: my local tweaks\n---\n";
  writeFileSync(join(ecosystemSkillDir, "SKILL.md"), userContent);

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    true,
    "a user-modified same-named skill must not be deleted from ~/.agents/skills",
  );
  assert.equal(
    readFileSync(join(ecosystemSkillDir, "SKILL.md"), "utf-8"),
    userContent,
    "the user's modified SKILL.md must survive initResources",
  );
  assert.equal(
    existsSync(join(ecosystemSkillDir, "references", "commands.md")),
    true,
    "the user's nested skill files must survive initResources",
  );
});

test("initResources reclaims an exact bundled skill copy from ~/.agents/skills", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-exact-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "agent-browser");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(bundledAgentBrowserSkillDir(), ecosystemSkillDir, { recursive: true });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    false,
    "an exact unmodified bundled skill copy should be reclaimed from ~/.agents/skills",
  );
});

test("initResources leaves a symlinked ecosystem skill entry untouched", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-symlink-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const symlinkTargetDir = join(tmp, "my-own-skills", "agent-browser");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "agent-browser");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(bundledAgentBrowserSkillDir(), symlinkTargetDir, { recursive: true });
  mkdirSync(join(tmp, ".agents", "skills"), { recursive: true });
  symlinkSync(symlinkTargetDir, ecosystemSkillDir);

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    true,
    "a symlinked ecosystem skill entry must not be removed",
  );
  assert.equal(
    lstatSync(ecosystemSkillDir).isSymbolicLink(),
    true,
    "the symlink itself must survive initResources",
  );
  assert.equal(
    existsSync(join(symlinkTargetDir, "SKILL.md")),
    true,
    "the symlink target directory must survive initResources",
  );
});

test("initResources emits a diagnostic when skipping a user-modified ecosystem skill", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-warn-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "lint");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  const consoleErrors = t.mock.method(console, "error", () => {});

  t.after(() => {
    consoleErrors.mock.restore();
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(join(bundledSkillsDir(), "lint"), ecosystemSkillDir, { recursive: true });
  writeFileSync(join(ecosystemSkillDir, "SKILL.md"), "user modified\n");

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    true,
    "the user-modified skill must survive initResources",
  );
  assert.ok(
    consoleErrors.mock.calls.some((call) =>
      call.arguments.some((arg) => {
        const message = String(arg);
        return message.includes("WARN") && message.includes(ecosystemSkillDir);
      }),
    ),
    `initResources should emit a WARN diagnostic naming ${ecosystemSkillDir}`,
  );
});

test("initResources leaves an ecosystem skill with a nested symlink entry untouched", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-nested-link-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "agent-browser");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  const consoleErrors = t.mock.method(console, "error", () => {});

  t.after(() => {
    consoleErrors.mock.restore();
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(bundledAgentBrowserSkillDir(), ecosystemSkillDir, { recursive: true });
  // Same relative file set, and the link target is byte-identical to the
  // bundled file — only the entry itself being a symlink makes it user-owned.
  const linkedName = join("references", "commands.md");
  rmSync(join(ecosystemSkillDir, linkedName));
  symlinkSync(
    join(bundledAgentBrowserSkillDir(), linkedName),
    join(ecosystemSkillDir, linkedName),
  );

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    true,
    "a skill tree containing a nested symlink must not be deleted from ~/.agents/skills",
  );
  assert.equal(
    lstatSync(join(ecosystemSkillDir, linkedName)).isSymbolicLink(),
    true,
    "the nested symlink itself must survive initResources",
  );
  assert.ok(
    consoleErrors.mock.calls.some((call) =>
      call.arguments.some((arg) => String(arg).includes(ecosystemSkillDir)),
    ),
    `initResources should emit a WARN diagnostic naming ${ecosystemSkillDir}`,
  );
});

test("initResources leaves an ecosystem skill containing a FIFO untouched without hanging", async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is not available on Windows");
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-ecosystem-fifo-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemSkillDir = join(tmp, ".agents", "skills", "agent-browser");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  const consoleErrors = t.mock.method(console, "error", () => {});

  t.after(() => {
    consoleErrors.mock.restore();
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(bundledAgentBrowserSkillDir(), ecosystemSkillDir, { recursive: true });
  // Same relative file set as the bundle, but the entry is a FIFO — reading it
  // would block forever, so the compare must reject it before any read.
  const fifoRelPath = join("references", "commands.md");
  const fifoPath = join(ecosystemSkillDir, fifoRelPath);
  rmSync(fifoPath);
  const mkfifo = spawnSync("mkfifo", [fifoPath]);
  assert.equal(mkfifo.status, 0, `mkfifo failed: ${mkfifo.stderr?.toString()}`);
  assert.equal(statSync(fifoPath).isFIFO(), true, "test setup should create a FIFO");

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemSkillDir),
    true,
    "a skill tree containing a FIFO must not be deleted from ~/.agents/skills",
  );
  assert.equal(
    statSync(fifoPath).isFIFO(),
    true,
    "the FIFO itself must survive initResources",
  );
  assert.ok(
    consoleErrors.mock.calls.some((call) =>
      call.arguments.some((arg) => String(arg).includes(ecosystemSkillDir)),
    ),
    `initResources should emit a WARN diagnostic naming ${ecosystemSkillDir}`,
  );
});

test("initResources syncs the gsd-browser skill from the installed gsd-browser package", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-browser-skill-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const { collectGsdBrowserPackageSkillReferences, initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);
  const packageSkill = packagedGsdBrowserSkill();

  assert.equal(
    readFileSync(join(fakeAgentDir, "skills", "gsd-browser", "SKILL.md"), "utf-8"),
    packageSkill,
    "managed gsd-browser skill should come from @opengsd/gsd-browser, not Pi's bundled skills",
  );

  const supportRefs = collectGsdBrowserPackageSkillReferences(packageSkill);
  assert.ok(supportRefs.includes("docs/mcp.md"), "test package skill should reference MCP docs");

  const packageSkillDir = dirname(packagedGsdBrowserSkillPath());

  for (const relPath of supportRefs) {
    const targetPath = join(fakeAgentDir, "skills", "gsd-browser", relPath);
    const packagePath = join(packageSkillDir, relPath);
    const packageShipsRef = existsSync(packagePath);

    assert.equal(
      existsSync(targetPath),
      packageShipsRef,
      `${relPath} install state should match whether @opengsd/gsd-browser ships it`,
    );

    if (packageShipsRef && relPath.startsWith("scripts/") && relPath.endsWith(".sh")) {
      assert.notEqual(statSync(targetPath).mode & 0o111, 0, `${relPath} should be executable`);
    }
  }
});

test("initResources refreshes a stale managed gsd-browser package skill during resource refresh", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-browser-skill-stale-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const {
    collectGsdBrowserPackageSkillReferences,
    hasStaleGsdBrowserPackageSkill,
    initResources,
  } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);
  const packageSkill = packagedGsdBrowserSkill();
  const packageSkillDir = dirname(packagedGsdBrowserSkillPath());
  const missingSupportRef = collectGsdBrowserPackageSkillReferences(packageSkill)
    .find((relPath) => !existsSync(join(packageSkillDir, relPath)));

  if (missingSupportRef) {
    const placeholderPath = join(fakeAgentDir, "skills", "gsd-browser", missingSupportRef);
    mkdirSync(dirname(placeholderPath), { recursive: true });
    writeFileSync(placeholderPath, "stale placeholder\n");
  }

  writeFileSync(
    join(fakeAgentDir, "skills", "gsd-browser", "SKILL.md"),
    "---\nname: gsd-browser\ndescription: stale\n---\n",
  );
  rmSync(join(fakeAgentDir, "skills", "gsd-browser", "docs", "mcp.md"), { force: true });
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({
      gsdVersion: currentPackageVersion(),
      packageName: "@opengsd/gsd-pi",
      contentHash: "force-refresh",
    }),
  );

  assert.equal(
    hasStaleGsdBrowserPackageSkill(join(fakeAgentDir, "skills")),
    true,
    "test setup should simulate a stale managed gsd-browser skill under a current manifest",
  );

  initResources(fakeAgentDir);

  assert.equal(
    readFileSync(join(fakeAgentDir, "skills", "gsd-browser", "SKILL.md"), "utf-8"),
    packageSkill,
    "resource refresh must update stale package-owned gsd-browser skills",
  );
  if (missingSupportRef) {
    assert.equal(
      existsSync(join(fakeAgentDir, "skills", "gsd-browser", missingSupportRef)),
      false,
      "resource refresh must prune stale placeholder support files not shipped by @opengsd/gsd-browser",
    );
  }
});

test("syncGsdBrowserPackageSkill preserves existing managed skill when the package is unresolvable", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-browser-skill-preserve-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources, setGsdBrowserPackageSkillPathForTests } = await import("../resource-loader.ts");
  t.after(() => setGsdBrowserPackageSkillPathForTests(undefined));

  // Seed a known-good managed install from the real package while it is
  // still resolvable.
  initResources(fakeAgentDir);
  const targetSkillPath = join(fakeAgentDir, "skills", "gsd-browser", "SKILL.md");
  assert.equal(
    existsSync(targetSkillPath),
    true,
    "test setup should install the managed gsd-browser skill",
  );
  const installedContent = readFileSync(targetSkillPath, "utf-8");

  // Now make the package unresolvable without mutating shared node_modules.
  setGsdBrowserPackageSkillPathForTests(null);

  // Force a sync attempt by deleting the manifest so initResources cannot
  // short-circuit on the fingerprint.
  rmSync(join(fakeAgentDir, "managed-resources.json"), { force: true });
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(targetSkillPath),
    true,
    "existing managed gsd-browser skill must be preserved when the package is unresolvable",
  );
  assert.equal(
    readFileSync(targetSkillPath, "utf-8"),
    installedContent,
    "existing managed gsd-browser SKILL.md content must be preserved when the package is unresolvable",
  );
});

test("hasStaleGsdBrowserPackageSkill does not report stale when the package is unresolvable", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-browser-skill-unresolvable-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const {
    hasStaleGsdBrowserPackageSkill,
    initResources,
    setGsdBrowserPackageSkillPathForTests,
  } = await import("../resource-loader.ts");
  t.after(() => setGsdBrowserPackageSkillPathForTests(undefined));
  initResources(fakeAgentDir);

  setGsdBrowserPackageSkillPathForTests(null);

  assert.equal(
    hasStaleGsdBrowserPackageSkill(join(fakeAgentDir, "skills")),
    false,
    "hasStale must agree with sync (no-op on unresolvable package) so launches do not run wasted full resyncs",
  );
});

test("hasStaleGsdBrowserPackageSkill does not flag SKILL.md references the package itself does not ship", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-browser-skill-missing-refs-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const {
    collectGsdBrowserPackageSkillReferences,
    hasStaleGsdBrowserPackageSkill,
    initResources,
  } = await import("../resource-loader.ts");

  initResources(fakeAgentDir);
  const skillsDir = join(fakeAgentDir, "skills");
  const installedSkill = readFileSync(
    join(skillsDir, "gsd-browser", "SKILL.md"),
    "utf-8",
  );

  // Sanity: the published package SKILL.md does reference at least one
  // file the npm tarball does not actually ship (this regression exists
  // precisely because upstream omits these supports). If a future package
  // version ships every referenced path, this test's premise no longer
  // applies and there is nothing to guard against.
  const refs = collectGsdBrowserPackageSkillReferences(installedSkill);
  const browserPkgRoot = join(process.cwd(), "node_modules", "@opengsd", "gsd-browser");
  const missingFromPackage = refs.filter((rel) => !existsSync(join(browserPkgRoot, rel)));
  if (missingFromPackage.length === 0) {
    return; // upstream now ships everything; nothing to assert.
  }

  assert.equal(
    hasStaleGsdBrowserPackageSkill(skillsDir),
    false,
    "hasStale must not loop forever on SKILL.md references the package itself does not ship",
  );
});

test("bundled skill frontmatter is valid YAML", () => {
  const skillsDir = join(process.cwd(), "src", "resources", "skills");
  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(skillNames.length > 0, "expected bundled skills to be present");

  const skillSources: Array<{ label: string; content: string }> = [];

  for (const skillName of skillNames) {
    const skillPath = join(skillsDir, skillName, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    skillSources.push({
      label: `${skillName}/SKILL.md`,
      content: readFileSync(skillPath, "utf-8"),
    });
  }

  // The managed gsd-browser skill is sourced from @opengsd/gsd-browser at
  // install time rather than the bundled `src/resources/skills` tree, so the
  // bundled-only walk above would let an invalid SKILL.md in the package
  // through. Include it here so a future regression in the published package
  // fails this guard before being copied to ~/.gsd/agent/skills/gsd-browser.
  skillSources.push({
    label: "@opengsd/gsd-browser/SKILL.md",
    content: packagedGsdBrowserSkill(),
  });

  for (const { label, content } of skillSources) {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);

    assert.ok(frontmatter, `${label} should include YAML frontmatter`);
    assert.doesNotThrow(
      () => parseYaml(frontmatter[1]),
      `${label} frontmatter should parse as YAML`,
    );
  }

  const gsdBrowserSkill = packagedGsdBrowserSkill();
  const gsdBrowserFrontmatter = gsdBrowserSkill.match(/^---\n([\s\S]*?)\n---/);

  assert.ok(gsdBrowserFrontmatter, "gsd-browser/SKILL.md should include YAML frontmatter");
  assert.doesNotThrow(
    () => parseYaml(gsdBrowserFrontmatter[1]),
    "gsd-browser/SKILL.md frontmatter should parse as YAML",
  );
});

test("initResources syncs top-level shared resources used by extension imports", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-shared-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir, join(tmp, "skills"));

  assert.equal(
    hasSyncedResourceFile(join(fakeAgentDir, "shared"), "gsd-pi-logo"),
    true,
    "top-level resources/shared files must sync under ~/.gsd/agent/shared",
  );
  assert.equal(
    hasSyncedResourceFile(join(fakeAgentDir, "shared"), "package-manager-detection"),
    true,
    "extension imports like ../../shared/package-manager-detection.js must resolve after fresh install",
  );
});

test("initResources steady-state extension match skips refresh for non-extension drift", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-fast-path-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const skillsDir = join(tmp, "skills");

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir, skillsDir);

  const manifest = JSON.parse(readFileSync(join(fakeAgentDir, "managed-resources.json"), "utf-8"));
  assert.equal(typeof manifest.contentHash, "string", "test setup should have a current content hash");

  const sharedDir = join(fakeAgentDir, "shared");
  rmSync(sharedDir, { recursive: true, force: true });
  writeFileSync(sharedDir, "not a directory");

  assert.doesNotThrow(
    () => initResources(fakeAgentDir, skillsDir),
    "matching manifest and extensions should skip the refresh path",
  );
  assert.equal(
    readFileSync(sharedDir, "utf-8"),
    "not a directory",
    "matching manifest hash should skip the refresh path",
  );
});

test("initResources repairs missing bundled extension files with a current manifest", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-extension-drift-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const skillsDir = join(tmp, "skills");

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir, skillsDir);

  const extensionsDir = join(fakeAgentDir, "extensions", "gsd");
  const extensionSuffix = existsSync(join(extensionsDir, "auto.ts")) ? ".ts" : ".js";
  const missingFile = join(extensionsDir, `debug-logger${extensionSuffix}`);
  const corruptedFile = join(extensionsDir, `auto${extensionSuffix}`);
  const originalCorruptedContent = readFileSync(corruptedFile, "utf-8");

  rmSync(missingFile);
  writeFileSync(corruptedFile, "CORRUPTED\n");

  initResources(fakeAgentDir, skillsDir);

  assert.equal(existsSync(missingFile), true, "missing bundled extension files should be restored");
  assert.equal(
    readFileSync(corruptedFile, "utf-8"),
    originalCorruptedContent,
    "a repair sync should overwrite other drifted extension files",
  );
});

test("initResources restores missing top-level shared resources during resource refresh", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-shared-stale-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const {
    hasMissingBundledResourceFiles,
    initResources,
  } = await import("../resource-loader.ts");
  initResources(fakeAgentDir, join(tmp, "skills"));

  rmSync(join(fakeAgentDir, "shared"), { recursive: true, force: true });
  const packageVersion = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf-8"),
  ).version;
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({
      gsdVersion: process.env.GSD_VERSION && process.env.GSD_VERSION !== "0.0.0"
        ? process.env.GSD_VERSION
        : packageVersion,
      packageName: "@opengsd/gsd-pi",
      contentHash: "force-refresh",
    }),
  );

  assert.equal(
    hasMissingBundledResourceFiles(
      join(fakeAgentDir, "shared"),
      bundledSharedDir(),
    ),
    true,
    "test setup should simulate a current manifest with missing shared files",
  );

  initResources(fakeAgentDir, join(tmp, "skills"));

  assert.equal(
    hasSyncedResourceFile(join(fakeAgentDir, "shared"), "package-manager-detection"),
    true,
    "resource refresh must restore missing top-level shared files",
  );
});

test("initResources restores missing bundled skills during resource refresh", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-skill-stale-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHome = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHome();
    rmSync(tmp, { recursive: true, force: true });
  });

  const {
    hasMissingBundledResourceFiles,
    initResources,
  } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  rmSync(join(fakeAgentDir, "skills", "tdd"), { recursive: true, force: true });
  const packageVersion = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf-8"),
  ).version;
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({
      gsdVersion: process.env.GSD_VERSION && process.env.GSD_VERSION !== "0.0.0"
        ? process.env.GSD_VERSION
        : packageVersion,
      packageName: "@opengsd/gsd-pi",
      contentHash: "force-refresh",
    }),
  );

  assert.equal(
    hasMissingBundledResourceFiles(
      join(fakeAgentDir, "skills"),
      bundledSkillsDir(),
    ),
    true,
    "test setup should simulate a current manifest with missing bundled skills",
  );

  initResources(fakeAgentDir);

  assert.equal(
    existsSync(join(fakeAgentDir, "skills", "tdd", "SKILL.md")),
    true,
    "resource refresh must restore missing bundled skills",
  );
});

test("initResources removes exact bundled skill orphans from the ecosystem dir", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-skills-clean-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemLintDir = join(tmp, ".agents", "skills", "lint");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  cpSync(join(process.cwd(), "src", "resources", "skills", "lint"), ecosystemLintDir, { recursive: true });

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(join(fakeAgentDir, "skills", "lint", "SKILL.md")),
    true,
    "bundled skill should exist in the GSD-owned skills dir after cleanup",
  );
  assert.equal(
    existsSync(ecosystemLintDir),
    false,
    "exact bundled skill copies should be removed from ~/.agents/skills",
  );
});

test("initResources preserves user-owned non-symlink ecosystem skill name collisions", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-skills-ambiguous-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const ecosystemLintDir = join(tmp, ".agents", "skills", "lint");
  const ecosystemLintFile = join(ecosystemLintDir, "SKILL.md");
  const restoreHomeEnv = overrideHomeEnv(tmp);
  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(ecosystemLintDir, { recursive: true });
  writeFileSync(
    ecosystemLintFile,
    "---\nname: lint\ndescription: User-owned lint skill.\n---\n\n# Custom lint\n",
  );

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(ecosystemLintFile),
    true,
    "user-owned ecosystem skill collisions that are not exact bundled copies must be preserved",
  );
  assert.equal(
    readFileSync(ecosystemLintFile, "utf-8").includes("# Custom lint"),
    true,
    "the user-owned collision's content must be untouched",
  );
});

test("initResources prunes stale top-level extension siblings next to bundled compiled extensions", async (t) => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-sync-"));
  const fakeAgentDir = join(tmp, "agent");
  const bundledTsPath = join(fakeAgentDir, "extensions", "ask-user-questions.ts");
  const bundledJsPath = join(fakeAgentDir, "extensions", "ask-user-questions.js");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  initResources(fakeAgentDir, join(tmp, "skills"));

  const bundledPath = existsSync(bundledJsPath)
    ? bundledJsPath
    : bundledTsPath;
  const staleSiblingPath = bundledPath.endsWith(".js")
    ? bundledTsPath
    : bundledJsPath;
  const siblingWasBundled = existsSync(staleSiblingPath);
  const staleContent = "export {};\n";

  assert.equal(existsSync(bundledPath), true, "bundled top-level extension should exist");

  // Simulate a stale opposite-format sibling left from a previous sync/build mismatch.
  writeFileSync(staleSiblingPath, staleContent);
  assert.equal(existsSync(staleSiblingPath), true);

  // Force a full resync so this test exercises the prune/copy path rather than
  // the early-return manifest fast path.
  const manifestPath = join(fakeAgentDir, "managed-resources.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.contentHash = "force-resync";
  writeFileSync(manifestPath, JSON.stringify(manifest));

  initResources(fakeAgentDir, join(tmp, "skills"));

  if (siblingWasBundled) {
    assert.equal(existsSync(staleSiblingPath), true, "bundled sibling should be restored during sync");
    assert.notEqual(readFileSync(staleSiblingPath, "utf-8"), staleContent, "bundled sibling should overwrite stale contents");
  } else {
    assert.equal(existsSync(staleSiblingPath), false, "stale top-level sibling should be removed during sync");
  }
  assert.equal(existsSync(bundledPath), true, "bundled extension should remain after cleanup");
});

test("pruneRemovedBundledExtensions removes stale subdirectory extensions not in current bundle", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-prune-dirs-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    // First sync — seeds the agent dir and writes the manifest.
    initResources(fakeAgentDir, join(tmp, "skills"));

    // Simulate a stale subdirectory extension left from a previous GSD version.
    // This mirrors the mcporter scenario: it was bundled before, synced to
    // ~/.gsd/agent/extensions/, then removed from the bundle in a newer version.
    const staleExtDir = join(fakeAgentDir, "extensions", "mcporter");
    mkdirSync(staleExtDir, { recursive: true });
    writeFileSync(join(staleExtDir, "index.ts"), 'export default { name: "mcporter" };\n');
    assert.equal(existsSync(staleExtDir), true, "stale subdir extension should exist before prune");

    // Read the manifest to verify subdirectory extensions are tracked.
    const manifestPath = join(fakeAgentDir, "managed-resources.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // The manifest must record installed extension directories so the pruner
    // can detect when one has been removed from the bundle.
    assert.ok(
      Array.isArray(manifest.installedExtensionDirs),
      "manifest should contain installedExtensionDirs array",
    );

    // Treat mcporter as a previously bundled dir so prune is manifest-based (#1853).
    if (!manifest.installedExtensionDirs.includes("mcporter")) {
      manifest.installedExtensionDirs = [...manifest.installedExtensionDirs, "mcporter"];
    }

    // Bump the manifest version to force a re-sync (simulates upgrading GSD).
    manifest.gsdVersion = "0.0.0-force-resync";
    manifest.contentHash = "0000000000000000";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // Second sync — the bundle no longer contains mcporter/, so it must be pruned.
    initResources(fakeAgentDir, join(tmp, "skills"));

    assert.equal(
      existsSync(staleExtDir),
      false,
      "stale subdirectory extension (mcporter/) should be pruned after upgrade",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruneRemovedBundledExtensions preserves user-created extension directories (#1853)", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-user-ext-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir, join(tmp, "skills"));

    const userExtDir = join(fakeAgentDir, "extensions", "my-local-ext");
    mkdirSync(userExtDir, { recursive: true });
    writeFileSync(join(userExtDir, "index.js"), "export default function (pi) {}\n");

    const manifestPath = join(fakeAgentDir, "managed-resources.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.ok(!manifest.installedExtensionDirs?.includes("my-local-ext"));
    manifest.gsdVersion = "0.0.0-force-resync";
    manifest.contentHash = "0000000000000000";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    initResources(fakeAgentDir, join(tmp, "skills"));

    assert.equal(existsSync(userExtDir), true, "user-created extension must survive boot prune");
    assert.equal(
      readFileSync(join(userExtDir, "index.js"), "utf-8"),
      "export default function (pi) {}\n",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
