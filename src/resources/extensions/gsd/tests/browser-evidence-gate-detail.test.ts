// Project/App: gsd-pi
// File Purpose: Canonical browser-evidence gate errors name the missing slices.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { structuredBrowserEvidenceRejection } from "../milestone-validation-evidence.ts";

let basePath: string | undefined;

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("canonical browser gate names missing slices and why evidence did not qualify (#2115)", async () => {
  basePath = mkdtempSync(join(tmpdir(), "gsd-browser-gate-"));
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({
    id: "M001",
    title: "UI",
    status: "active",
    planning: { verificationUat: "browser UAT in the browser" },
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    status: "complete",
    demo: "open the page in the browser and confirm the heading",
    planning: { successCriteria: "screenshot of the loaded page" },
  });
  mkdirSync(join(basePath, ".artifacts", "browser"), { recursive: true });
  writeFileSync(join(basePath, ".artifacts", "browser", "run.json"), "{}\n");

  const message = await structuredBrowserEvidenceRejection({
    milestoneId: "M001",
    verdict: "pass",
    successCriteriaChecklist: "",
    verdictRationale: "claimed pass",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      observation: "failed",
      sliceId: "S01",
    }],
  }, basePath);

  assert.ok(message);
  assert.match(message!, /Missing: S01/);
  assert.match(message!, /\.artifacts\/browser JSON files: 1/);
  assert.match(message!, /Supplied browser\/runtime verificationEvidence: 1/);
  assert.match(message!, /1 disqualified/);
});
