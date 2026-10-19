// Project/App: gsd-pi
// File Purpose: Unit tests for cmux integration, layout, and CLI isolation.
import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildCmuxProgress,
  buildCmuxStatusLabel,
  CmuxClient,
  detectCmuxEnvironment,
  markCmuxPromptShown,
  resetCmuxPromptState,
  resolveCmuxConfig,
  shouldPromptToEnableCmux,
} from "../../cmux/index.ts";
import { autoEnableCmuxPreferences } from "../commands-cmux.ts";
import type { CmuxStateInput } from "../../shared/cmux-events.ts";

test("detectCmuxEnvironment requires workspace, surface, and socket", () => {
  const detected = detectCmuxEnvironment(
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    },
    (path) => path === "/tmp/cmux.sock",
    () => true,
  );
  assert.equal(detected.available, true);
  assert.equal(detected.cliAvailable, true);
});

test("resolveCmuxConfig enables only when preference and environment are both active", () => {
  const config = resolveCmuxConfig(
    { cmux: { enabled: true, notifications: true, sidebar: true, splits: true } },
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    },
    () => true,
    () => true,
  );
  assert.equal(config.enabled, true);
  assert.equal(config.notifications, true);
  assert.equal(config.sidebar, true);
  assert.equal(config.splits, true);
});

test("shouldPromptToEnableCmux only prompts once per session", () => {
  resetCmuxPromptState();
  assert.equal(shouldPromptToEnableCmux({}, {}, () => false, () => true), false);

  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      },
      () => true,
      () => true,
    ),
    true,
  );
  markCmuxPromptShown();
  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      },
      () => true,
      () => true,
    ),
    false,
  );
  resetCmuxPromptState();
});

describe("autoEnableCmuxPreferences", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(tmpdir(), "cmux-auto-test-"));
    fs.mkdirSync(path.join(tmp, ".gsd"), { recursive: true });
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes cmux.enabled true when preferences file exists with no cmux config", () => {
    const prefsPath = path.join(tmp, ".gsd", "preferences.md");
    fs.writeFileSync(prefsPath, [
      "---",
      "version: 1",
      "---",
      "",
      "# GSD Skill Preferences",
    ].join("\n"));

    const result = autoEnableCmuxPreferences();
    assert.equal(result, true);

    const content = fs.readFileSync(prefsPath, "utf-8");
    assert.ok(content.includes("enabled: true"), "should write enabled: true");
    assert.ok(content.includes("notifications: true"), "should default notifications on");
    assert.ok(content.includes("sidebar: true"), "should default sidebar on");
    assert.ok(content.includes("splits: false"), "should default splits off");
  });

  test("returns false when preferences file does not exist", () => {
    const result = autoEnableCmuxPreferences();
    assert.equal(result, false);
  });

  test("preserves existing cmux sub-preferences when auto-enabling", () => {
    const prefsPath = path.join(tmp, ".gsd", "preferences.md");
    fs.writeFileSync(prefsPath, [
      "---",
      "version: 1",
      "cmux:",
      "  splits: true",
      "  browser: true",
      "---",
      "",
      "# GSD Skill Preferences",
    ].join("\n"));

    const result = autoEnableCmuxPreferences();
    assert.equal(result, true);

    const content = fs.readFileSync(prefsPath, "utf-8");
    assert.ok(content.includes("enabled: true"), "should set enabled: true");
    assert.ok(content.includes("splits: true"), "should preserve existing splits: true");
    assert.ok(content.includes("browser: true"), "should preserve existing browser: true");
  });

  test("writes only the requested project when host cwd differs", (t) => {
    const activeProject = fs.mkdtempSync(path.join(tmpdir(), "cmux-active-project-"));
    const hostPath = path.join(tmp, ".gsd", "preferences.md");
    const activePath = path.join(activeProject, ".gsd", "preferences.md");
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.writeFileSync(hostPath, "---\nversion: 1\n---\n");
    fs.writeFileSync(activePath, "---\nversion: 1\n---\n");
    t.after(() => {
      fs.rmSync(activeProject, { recursive: true, force: true });
    });

    const result = autoEnableCmuxPreferences(activeProject);

    assert.equal(result, true);
    assert.doesNotMatch(fs.readFileSync(hostPath, "utf-8"), /cmux:/);
    assert.match(fs.readFileSync(activePath, "utf-8"), /cmux:/);
    assert.match(fs.readFileSync(activePath, "utf-8"), /enabled: true/);
  });
});

test("buildCmuxStatusLabel and progress prefer deepest active unit", () => {
  const state: CmuxStateInput = {
    activeMilestone: { id: "M001" },
    activeSlice: { id: "S02" },
    activeTask: { id: "T03" },
    phase: "executing",
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 1, total: 3 },
      tasks: { done: 2, total: 5 },
    },
  };

  assert.equal(buildCmuxStatusLabel(state), "M001 S02/T03 · executing");
  assert.deepEqual(buildCmuxProgress(state), { value: 0.4, label: "2/5 tasks" });
});

describe("createGridLayout", () => {
  // Create a mock CmuxClient that tracks createSplitFrom calls
  function makeMockClient() {
    let nextId = 1;
    const calls: Array<{ source: string | undefined; direction: string }> = [];

    const client = {
      calls,
      async createGridLayout(count: number) {
        // Simulate the grid layout logic with a fake client
        if (count <= 0) return [];
        const surfaces: string[] = [];

        const createSplitFrom = async (source: string | undefined, direction: string) => {
          calls.push({ source, direction });
          return `surface-${nextId++}`;
        };

        const rightCol = await createSplitFrom("gsd-surface", "right");
        surfaces.push(rightCol);
        if (count === 1) return surfaces;

        const bottomRight = await createSplitFrom(rightCol, "down");
        surfaces.push(bottomRight);
        if (count === 2) return surfaces;

        const bottomLeft = await createSplitFrom("gsd-surface", "down");
        surfaces.push(bottomLeft);
        if (count === 3) return surfaces;

        let lastSurface = bottomRight;
        for (let i = 3; i < count; i++) {
          const next = await createSplitFrom(lastSurface, "down");
          surfaces.push(next);
          lastSurface = next;
        }

        return surfaces;
      },
    };
    return client;
  }

  test("1 agent creates single right split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(1);
    assert.equal(surfaces.length, 1);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
    ]);
  });

  test("2 agents creates right column then splits it down", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(2);
    assert.equal(surfaces.length, 2);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
    ]);
  });

  test("3 agents creates 2x2 grid (gsd + 3 agent surfaces)", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(3);
    assert.equal(surfaces.length, 3);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" },
    ]);
  });

  test("4 agents creates 2x2 grid with extra split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(4);
    assert.equal(surfaces.length, 4);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" },
      { source: "surface-2", direction: "down" },
    ]);
  });

  test("0 agents returns empty", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(0);
    assert.equal(surfaces.length, 0);
    assert.equal(mock.calls.length, 0);
  });
});

describe("CmuxClient stdio isolation", () => {
  test("runSync and runAsync execute the cmux CLI without inheriting test stdin", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const cmuxPath = path.join(binDir, "cmux");
    const originalPath = process.env.PATH;
    fs.writeFileSync(
      cmuxPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({surfaces:[{id:'surface-1'}]}));",
        "else process.stdout.write('ok');",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(cmuxPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = new CmuxClient({
        enabled: true,
        available: true,
        cliAvailable: true,
        notifications: true,
        sidebar: true,
        splits: true,
        browser: false,
        workspaceId: "workspace-1",
        surfaceId: "surface-0",
        socketPath: "/tmp/cmux.sock",
      });

      client.setStatus("M001", "executing");
      await client.listSurfaceIds();

      const calls = fs.readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      const commandPrefixes = calls.map((call) => call.slice(0, 2));
      assert.ok(
        commandPrefixes.some((prefix) => JSON.stringify(prefix) === JSON.stringify(["set-status", "gsd"])),
        "set-status command should be invoked",
      );
      assert.ok(
        commandPrefixes.some((prefix) => JSON.stringify(prefix) === JSON.stringify(["list-pane-surfaces", "--json"])),
        "list-pane-surfaces command should be invoked",
      );
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("CmuxClient surface id parsing (current cmux CLI output shapes, #2050 regression)", () => {
  function writeFakeCli(binDir: string, logPath: string, opts: { splitOutput: string; listSurfacesJson: string }): string {
    const cmuxPath = path.join(binDir, "cmux");
    fs.writeFileSync(
      cmuxPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "const args = process.argv.slice(2);",
        "if (args[0] === 'new-split') {",
        `  process.stdout.write(${JSON.stringify(opts.splitOutput)});`,
        "} else if (args[0] === 'list-pane-surfaces') {",
        `  process.stdout.write(${JSON.stringify(opts.listSurfacesJson)});`,
        "} else {",
        "  process.stdout.write('ok');",
        "}",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(cmuxPath, 0o755);
    return cmuxPath;
  }

  function makeClient(): CmuxClient {
    return new CmuxClient({
      enabled: true,
      available: true,
      cliAvailable: true,
      notifications: true,
      sidebar: true,
      splits: true,
      browser: false,
      workspaceId: "workspace:1000040001",
      surfaceId: "surface:1000040003",
      socketPath: "/tmp/cmux.sock",
    });
  }

  test("createSplit extracts the surface id from the current 'OK surface:<id> workspace:<id>' output", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const originalPath = process.env.PATH;
    writeFakeCli(binDir, logPath, {
      splitOutput: "OK surface:1000040021 workspace:1000040001",
      listSurfacesJson: JSON.stringify({ surfaces: [] }),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = makeClient();
      const created = await client.createSplit("right");
      assert.equal(created, "surface:1000040021");
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("createSplit returns null (not a false empty-room garbage id) for a bare 'OK' or empty response", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const originalPath = process.env.PATH;
    writeFakeCli(binDir, logPath, {
      splitOutput: "ok",
      listSurfacesJson: JSON.stringify({ surfaces: [] }),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = makeClient();
      const created = await client.createSplit("right");
      assert.equal(created, null);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("listSurfaceIds extracts ids from the current nested 'surfaces[].ref' JSON shape, not a flat 'surface_id'/'surface' key", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const originalPath = process.env.PATH;
    // Matches real `cmux list-pane-surfaces --json --id-format both` output.
    writeFakeCli(binDir, logPath, {
      splitOutput: "ok",
      listSurfacesJson: JSON.stringify({
        pane_id: "20E57FDE-5D08-4E7C-83CC-6C4A91F42645",
        pane_ref: "pane:1000040003",
        surfaces: [
          { id: "6465E063-9860-445C-94FC-D83A429BE1F9", ref: "surface:1000040003", selected: true, title: "a", type: "terminal" },
          { id: "ABC", ref: "surface:1000040021", selected: false, title: "b", type: "terminal" },
        ],
        window_id: "D2739624-967E-45A4-B7BB-29DF8CC610E0",
        window_ref: "window:1000040000",
        workspace_id: "26C7823A-940B-43D1-8698-A3CAEFF95F8A",
        workspace_ref: "workspace:1000040001",
      }),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = makeClient();
      const ids = await client.listSurfaceIds();
      assert.deepEqual([...ids].sort(), ["surface:1000040003", "surface:1000040021"]);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("createSplitFrom falls back to the list-pane-surfaces diff when new-split prints no parseable id, so a split created without id output is not silently left unattached", async () => {
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "cmux-bin-"));
    const logPath = path.join(binDir, "calls.jsonl");
    const originalPath = process.env.PATH;
    const cmuxPath = path.join(binDir, "cmux");
    const counterPath = path.join(binDir, "count");
    fs.writeFileSync(
      cmuxPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "const args = process.argv.slice(2);",
        "if (args[0] === 'new-split') { process.stdout.write('ok'); }",
        "else if (args[0] === 'list-pane-surfaces') {",
        `  const counterPath = ${JSON.stringify(counterPath)};`,
        "  let n = 0; try { n = parseInt(fs.readFileSync(counterPath, 'utf-8'), 10); } catch {}",
        "  fs.writeFileSync(counterPath, String(n + 1));",
        "  if (n === 0) process.stdout.write(JSON.stringify({ surfaces: [{ ref: 'surface:1000040003' }] }));",
        "  else process.stdout.write(JSON.stringify({ surfaces: [{ ref: 'surface:1000040003' }, { ref: 'surface:1000040099' }] }));",
        "} else { process.stdout.write('ok'); }",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(cmuxPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = makeClient();
      const created = await client.createSplitFrom("surface:1000040003", "down");
      assert.equal(created, "surface:1000040099");
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("cmux extension discovery opt-out", () => {
  test("cmux directory has package.json with pi manifest to prevent auto-discovery as extension", () => {
    const cmuxDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../cmux",
    );
    const pkgPath = path.join(cmuxDir, "package.json");
    assert.ok(fs.existsSync(pkgPath), `${pkgPath} must exist`);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.pi !== undefined && typeof pkg.pi === "object",
      'package.json must have a "pi" field to opt out of extension auto-discovery',
    );
    assert.ok(
      !pkg.pi.extensions?.length,
      "pi.extensions must be empty or absent — cmux is a library, not an extension",
    );
  });
});
