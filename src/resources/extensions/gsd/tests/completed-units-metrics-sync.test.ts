/**
 * completed-units-metrics-sync.test.ts — Regression tests for #2313.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncStateToProjectRoot } from "../auto-worktree-sync.ts";

test("#2313: syncStateToProjectRoot copies metrics but not the vestigial completed-units file", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-sync-metrics-"));
  const projectRoot = join(root, "project");
  const worktree = join(root, "worktree");
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".gsd", "metrics.json"), JSON.stringify({ tokens: 42 }));
  writeFileSync(join(worktree, ".gsd", "completed-units.json"), JSON.stringify([{ id: "T01" }]));

  try {
    syncStateToProjectRoot(worktree, projectRoot, "M001");

    assert.deepEqual(
      JSON.parse(readFileSync(join(projectRoot, ".gsd", "metrics.json"), "utf-8")),
      { tokens: 42 },
    );
    assert.equal(existsSync(join(projectRoot, ".gsd", "completed-units.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
