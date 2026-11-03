// Project/App: gsd-pi
// File Purpose: Regression test for #3084 — resuming a paused auto-mode
// session must re-activate the shared GSD phase state the same way a fresh
// start does, so setCurrentPhase() is not refused for every unit that runs
// after the first pause.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { pauseAuto, startAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { activateGSD, isGSDActive } from "../../shared/gsd-phase-state.ts";

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-resume-phase-")));
  // Keep the fake home distinct from the project for startAuto's directory guard.
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const previousCwd = process.cwd();
  // #3084: without this sandbox, a successful resume runs
  // refreshResumeResourcesAndDb() -> initResources(), which re-syncs the
  // real agent directory of whoever runs the test (GSD_CODING_AGENT_DIR, or
  // GSD_HOME/agent, or ~/.gsd/agent).
  const previousAgentDir = process.env.GSD_CODING_AGENT_DIR;
  const previousGsdHome = process.env.GSD_HOME;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.GSD_CODING_AGENT_DIR = join(base, ".gsd", "agent");
  process.env.GSD_HOME = join(base, ".gsd-home");
  // initResources() also cleans bundled skills via os.homedir(), which uses
  // HOME on POSIX and USERPROFILE on Windows rather than either GSD override.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Milestone\n", "utf-8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  autoSession.reset();
  t.after(() => {
    autoSession.reset();
    try { closeDatabase(); } catch { /* already closed */ }
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = previousAgentDir;
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test("resuming a paused session re-activates the GSD phase state before the loop runs", async (t) => {
  const base = makeProject(t);
  assert.equal(homedir(), join(base, "home"), "resume side effects must stay in the temporary user home");
  activateGSD();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  process.chdir(base);

  await pauseAuto(undefined, undefined, "user_request");
  assert.equal(isGSDActive(), false, "pauseAuto deactivates the phase state");

  const activeAtResume: boolean[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => {
        if (message === "Auto-mode resumed." || message === "Step-mode resumed.") activeAtResume.push(isGSDActive());
      },
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => "resume-phase-state-test" },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false },
    model: undefined,
  } as unknown as Parameters<typeof startAuto>[0];
  const pi = {
    getThinkingLevel: () => "off",
    events: { emit: () => {} },
  } as unknown as Parameters<typeof startAuto>[1];

  try {
    await startAuto(ctx, pi, base, false);
  } catch {
    // No real host to dispatch to past the resume notification — the
    // assertion below only needs the state observed at that notification.
  }

  assert.deepEqual(
    activeAtResume,
    [true],
    "the phase state must be active once resume marks the session active, before the loop runs",
  );
});
