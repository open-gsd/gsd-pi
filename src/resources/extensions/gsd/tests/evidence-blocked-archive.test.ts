// Project/App: gsd-pi
// File Purpose: Tests for blocked-path evidence archiving (#2425). The safety
// block must preserve the recorded evidence under .gsd/safety/blocked/
// instead of deleting it, so the mismatch that caused the block stays
// inspectable.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveEvidenceToBlocked,
  recordToolCall,
  recordToolResult,
  resetEvidence,
  saveEvidenceToDisk,
} from "../safety/evidence-collector.js";

describe("blocked-path evidence archiving (#2425)", () => {
  let basePath: string;

  beforeEach(() => {
    resetEvidence();
    basePath = mkdtempSync(join(tmpdir(), "gsd-evidence-blocked-"));
  });

  it("moves the evidence file into .gsd/safety/blocked/ instead of deleting it", (t) => {
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    recordToolCall("tc-arch", "bash", { command: "npm test" });
    recordToolResult("tc-arch", "bash", "Command exited with code 1\nfailed", true);
    saveEvidenceToDisk(basePath, "M032", "S19", "T04");

    const livePath = join(basePath, ".gsd", "safety", "evidence-M032-S19-T04.json");
    assert.ok(existsSync(livePath), "evidence file must exist before archiving");

    archiveEvidenceToBlocked(basePath, "M032", "S19", "T04");

    assert.equal(existsSync(livePath), false, "evidence file must move out of the live slot");
    const blockedDir = join(basePath, ".gsd", "safety", "blocked");
    assert.equal(readdirSync(blockedDir).length, 1, "archived evidence must be preserved");
  });

  it("keeps every blocked snapshot when the same unit blocks repeatedly", (t) => {
    t.after(() => rmSync(basePath, { recursive: true, force: true }));

    archiveEvidenceToBlocked(basePath, "M001", "S01", "T01"); // no live file: no-op

    recordToolCall("tc-1", "bash", { command: "npm test" });
    saveEvidenceToDisk(basePath, "M001", "S01", "T01");
    archiveEvidenceToBlocked(basePath, "M001", "S01", "T01");

    recordToolCall("tc-2", "bash", { command: "npm run build" });
    saveEvidenceToDisk(basePath, "M001", "S01", "T01");
    archiveEvidenceToBlocked(basePath, "M001", "S01", "T01");

    assert.equal(readdirSync(join(basePath, ".gsd", "safety", "blocked")).length, 2);
  });
});
