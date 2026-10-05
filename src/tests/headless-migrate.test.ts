// gsd-pi - headless migrate tests.
// File Purpose: Prove that `gsd headless migrate` previews and applies a v1 migration on a project with no .gsd.

import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openWorkflowDatabase } from "../resources/extensions/gsd/db-workspace.ts";
import { detectProjectState } from "../resources/extensions/gsd/detection.ts";
import { _getAdapter, closeDatabase } from "../resources/extensions/gsd/gsd-db.ts";

const previousAgentDir = process.env.GSD_AGENT_DIR;
process.env.GSD_AGENT_DIR = join(tmpdir(), `gsd-headless-migrate-missing-agent-${process.pid}`);
const { handleMigrate: handleHeadlessMigrate } = await import("../headless-migrate.ts");
after(() => {
  if (previousAgentDir === undefined) delete process.env.GSD_AGENT_DIR;
  else process.env.GSD_AGENT_DIR = previousAgentDir;
});

function makePlanningProject(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-migrate-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const planning = join(base, ".planning");
  const phase = join(planning, "phases", "29-auth-system");
  mkdirSync(phase, { recursive: true });
  writeFileSync(join(planning, "PROJECT.md"), "# Legacy Project\n\nA project to migrate.\n");
  writeFileSync(join(planning, "ROADMAP.md"), [
    "# Project Roadmap",
    "",
    "## Phases",
    "",
    "- [ ] 29 — Auth System",
    "",
  ].join("\n"));
  writeFileSync(join(phase, "29-01-PLAN.md"), [
    "---",
    'phase: "29-auth-system"',
    'plan: "01"',
    "---",
    "",
    "# 29-01: Implement Auth",
    "",
    "<objective>",
    "Build the authentication system.",
    "</objective>",
    "",
    "<tasks>",
    "<task>Create auth middleware</task>",
    "</tasks>",
    "",
  ].join("\n"));
  return base;
}

/** Run the headless command and collect what it prints. */
async function runHeadlessMigrate(t: TestContext, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  let stderr = "";
  const previousWrite = process.stderr.write;
  t.after(() => {
    process.stderr.write = previousWrite;
  });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  const result = await handleHeadlessMigrate(args);
  process.stderr.write = previousWrite;
  return { exitCode: result.exitCode, stderr };
}

test("gsd headless migrate previews a project with no .gsd and applies the approved Preview", (t) => {
  const base = makePlanningProject(t);
  const home = mkdtempSync(join(tmpdir(), "gsd-headless-migrate-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GSD_AGENT_DIR: join(home, "agent"),
    GSD_HOME: home,
    GSD_SUPPRESS_LOGO: "1",
  };
  delete env.NODE_TEST_CONTEXT;
  // The real CLI, so the headless dispatcher itself is under test.
  const runMigrate = (args: readonly string[] = []) => spawnSync(process.execPath, [
    "--import",
    join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs"),
    "--experimental-strip-types",
    join(process.cwd(), "src/loader.ts"),
    "headless",
    "migrate",
    ...args,
  ], {
    cwd: base,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });

  const preview = runMigrate();

  assert.equal(preview.status, 0, preview.stderr);
  const approval = /gsd headless migrate (--preview=sha256:[0-9a-f]{64}) /u.exec(preview.stderr)?.[1];
  assert.ok(approval, preview.stderr);
  assert.doesNotMatch(preview.stderr, /\/gsd migrate/u, "the printed command is the headless command");
  assert.equal(detectProjectState(base).state, "v1-planning", "the Preview leaves the project a v1 project");

  const applied = runMigrate([approval]);

  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stderr, /Migration complete/u);
  assert.equal(detectProjectState(base).state, "v2-gsd");
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.deepEqual(
    _getAdapter()!.prepare(
      "SELECT operation.trace_id FROM workflow_import_applications JOIN workflow_operations operation USING (operation_id)",
    ).all(),
    [{ trace_id: approval.slice("--preview=".length) }],
    "the one Import Application records the approved Preview hash",
  );
  assert.deepEqual(_getAdapter()!.prepare("SELECT id FROM milestones").all(), [{ id: "M001" }]);
});

test("gsd headless migrate exits 1 and applies nothing for a Preview hash that is not current", async (t) => {
  const base = makePlanningProject(t);

  const refused = await runHeadlessMigrate(t, [`--preview=sha256:${"0".repeat(64)}`, base]);

  assert.equal(refused.exitCode, 1, refused.stderr);
  assert.match(refused.stderr, /is not the current Preview; nothing was written/u);
  assert.equal(existsSync(join(base, ".gsd")), false);
  assert.equal(detectProjectState(base).state, "v1-planning");
});
