// Project/App: gsd-pi
// File Purpose: Regression coverage for deliberate closeout refusal markers (#2033).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveVerificationFailureMarker } from "../paths.ts";

test("resolveVerificationFailureMarker accepts CLOSEOUT-VERIFICATION-FAILED alias (#2033)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-fail-2033-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const closeout = join(base, "03-CLOSEOUT-VERIFICATION-FAILED.md");
  writeFileSync(closeout, "# deliberate closeout refusal\n");

  const resolved = resolveVerificationFailureMarker(
    (suffix) => (suffix === "CLOSEOUT-VERIFICATION-FAILED" ? closeout : null),
    (suffix) => join(base, `default-${suffix}.md`),
  );

  assert.equal(resolved, closeout);
});

test("resolveVerificationFailureMarker prefers canonical VERIFICATION-FAILED over alias", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-fail-canonical-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const canonical = join(base, "03-VERIFICATION-FAILED.md");
  const closeout = join(base, "03-CLOSEOUT-VERIFICATION-FAILED.md");
  writeFileSync(canonical, "# canonical\n");
  writeFileSync(closeout, "# alias\n");

  const resolved = resolveVerificationFailureMarker(
    (suffix) => {
      if (suffix === "VERIFICATION-FAILED") return canonical;
      if (suffix === "CLOSEOUT-VERIFICATION-FAILED") return closeout;
      return null;
    },
    (suffix) => join(base, `default-${suffix}.md`),
  );

  assert.equal(resolved, canonical);
});
