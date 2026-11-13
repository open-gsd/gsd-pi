// Project/App: gsd-pi
// File Purpose: Regression coverage for the codebase.inject preference (lazy CODEBASE map injection).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { buildBeforeAgentStartResult, _flushDeferredContextMaintenanceForTest } from "../bootstrap/system-context.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";

async function startResult(base: string, preferencesMarkdown: string): Promise<{ systemPrompt: string }> {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "src-file.ts"), "export const x = 1;\n");
  // The codebase map enumerates tracked files, so the fixture must be committed.
  execFileSync("git", ["add", "src-file.ts"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-q", "--no-verify", "-m", "fixture"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(gsdDir, "PREFERENCES.md"), preferencesMarkdown);
  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");

  try {
    const ctx = { projectRoot: base, ui: { notify: () => undefined } } as unknown as ExtensionContext;
    const result = await buildBeforeAgentStartResult({ prompt: "ping", systemPrompt: "BASE" }, ctx);
    await _flushDeferredContextMaintenanceForTest(base);
    return result;
  } finally {
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
  }
}

test("codebase.inject: lazy replaces the map block with a stable pointer line", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-codebase-lazy-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await startResult(base, "---\ncodebase:\n  inject: lazy\n---\n");

  assert.match(result.systemPrompt, /map omitted \(codebase\.inject: lazy\)/);
  assert.ok(!result.systemPrompt.includes("### src-file"), "lazy mode must not inject the file map");
  assert.ok(!result.systemPrompt.includes("src-file.ts"), "lazy mode must not list files in the prefix");
});

test("codebase.inject inline keeps the map block", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-codebase-inline-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await startResult(base, "---\ncodebase:\n  inject: inline\n---\n");

  assert.match(result.systemPrompt, /\[PROJECT CODEBASE — File structure/);
  assert.ok(result.systemPrompt.includes("src-file.ts"));
});

test("codebase.map without inject preference stays inline (default unchanged)", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-codebase-default-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await startResult(base, "---\ncodebase:\n  max_files: 10\n---\n");

  assert.match(result.systemPrompt, /\[PROJECT CODEBASE — File structure/);
  assert.ok(result.systemPrompt.includes("src-file.ts"));
});
