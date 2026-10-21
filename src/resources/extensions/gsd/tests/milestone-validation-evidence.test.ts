// Project/App: gsd-pi
// File Purpose: Tests for forwarded milestone validation evidence helpers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBrowserEvidenceGate,
  hasRuntimeExecutableUatEvidenceText,
} from "../milestone-validation-evidence.js";

test("hasRuntimeExecutableUatEvidenceText requires runtime-executable PASS evidence", () => {
  const evidence = [
    "---",
    "uatType: runtime-executable",
    "verdict: PASS",
    "---",
    "| Check | Mode | Result | Evidence |",
    "| DOM | runtime | PASS | gsd_uat_exec:.gsd/evidence/uat/M001/S01/dom.json |",
  ].join("\n");

  assert.equal(hasRuntimeExecutableUatEvidenceText(evidence), true);
  assert.equal(hasRuntimeExecutableUatEvidenceText(evidence.replace("runtime | PASS", "manual | PASS")), false);
});

test("applyBrowserEvidenceGate records downgrade rationale", () => {
  const params = applyBrowserEvidenceGate({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "",
    sliceDeliveryAudit: "",
    crossSliceIntegration: "",
    requirementCoverage: "",
    verdictRationale: "Initial rationale.",
  });

  assert.equal(params.verdict, "needs-attention");
  assert.match(params.verdictRationale, /Initial rationale/);
  assert.match(params.verdictRationale, /Browser evidence gate/);
});
