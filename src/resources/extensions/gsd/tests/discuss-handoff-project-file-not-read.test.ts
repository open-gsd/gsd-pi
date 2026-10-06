// Project/App: gsd-pi
// File Purpose: The discuss handoff decides from database rows and does not read PROJECT.md from disk.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkAutoStartAfterDiscuss,
  clearPendingAutoStart,
  setPendingAutoStart,
} from "../guided-flow.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { saveContextArtifact } from "./helpers/saved-context.ts";

test("a PROJECT.md file that lists a milestone with no directory does not warn at the discuss handoff", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-handoff-project-file-"));
  t.after(() => {
    closeDatabase();
    clearPendingAutoStart();
    rmSync(base, { recursive: true, force: true });
  });
  const gsdDir = join(base, ".gsd");
  mkdirSync(join(gsdDir, "milestones", "M001"), { recursive: true });
  // The file names M002, which has no directory, no CONTEXT and no database row.
  writeFileSync(
    join(gsdDir, "PROJECT.md"),
    ["# Project", "", "| M001 | First milestone | active |", "| M002 | Second milestone | queued |", ""].join("\n"),
  );
  openDatabase(":memory:");
  saveContextArtifact("M001");

  const notifications: string[] = [];
  clearPendingAutoStart();
  setPendingAutoStart(base, {
    basePath: base,
    milestoneId: "M001",
    startAuto: false,
    ctx: { ui: { notify: (message: string) => { notifications.push(message); } } } as any,
    pi: { setActiveTools: () => undefined, getActiveTools: () => [] } as any,
  });

  assert.equal(checkAutoStartAfterDiscuss(base), true);
  assert.deepEqual(notifications, [
    "Milestone M001 context captured. Continuing the planning pipeline.",
  ]);
});
