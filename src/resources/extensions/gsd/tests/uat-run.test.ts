import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  prepareUatRun,
  type UatEvidenceRef,
  type UatResultSaveParams,
} from "../uat-run.ts";
import { buildRunUatPresentationForType } from "../tool-presentation-plan.ts";

type EvidenceInput = UatEvidenceRef | { kind: string; ref: string };

function makeTmpBase(): string {
  return mkdtempSync(join(tmpdir(), "gsd-uat-run-"));
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function writeFreshUatEvidence(base: string, id = "fresh-uat-evidence"): string {
  const execDir = join(base, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  writeFileSync(
    join(execDir, `${id}.meta.json`),
    JSON.stringify({ id, metadata: { kind: "uat_exec" } }),
    "utf-8",
  );
  return id;
}

function buildParams(
  evidence: EvidenceInput[],
  options: {
    uatType?: UatResultSaveParams["uatType"];
    mode?: UatResultSaveParams["checks"][number]["mode"];
  } = {},
): UatResultSaveParams {
  const uatType = options.uatType ?? "runtime-executable";
  return {
    milestoneId: "M001",
    sliceId: "S01",
    uatType,
    verdict: "PASS",
    checks: [{
      id: "UAT-01",
      description: "Evidence contract check",
      mode: options.mode ?? "runtime",
      result: "PASS",
      evidence: evidence as UatEvidenceRef[],
      notes: "Evidence validation should be explicit.",
    }],
    presentation: buildRunUatPresentationForType(uatType),
    notes: "UAT passed.",
  };
}

test("prepareUatRun accepts browser evidence backed by an http URL", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "browser", ref: "https://example.test/uat/session" },
    ], { uatType: "browser-executable", mode: "browser" }));

    if (!result.ok) assert.fail(result.error.message);
    assert.equal(result.run.params.checks[0]?.evidence?.[1]?.kind, "browser");
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun accepts screenshot and log evidence under approved roots", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    mkdirSync(join(base, ".artifacts", "browser", "session"), { recursive: true });
    mkdirSync(join(base, ".gsd", "uat", "M001", "S01"), { recursive: true });
    writeFileSync(join(base, ".artifacts", "browser", "session", "home.png"), "png", "utf-8");
    writeFileSync(join(base, ".gsd", "uat", "M001", "S01", "console.log"), "ok", "utf-8");

    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "screenshot", ref: ".artifacts/browser/session/home.png" },
      { kind: "log", ref: ".gsd/uat/M001/S01/console.log" },
    ], { uatType: "artifact-driven", mode: "artifact" }));

    if (!result.ok) assert.fail(result.error.message);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects unknown evidence kinds with the accepted kind list", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "artifact", ref: ".gsd/uat/M001/S01/readme.md" },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /evidence\.kind must be one of: "gsd_uat_exec", "gsd_exec", "screenshot", "log", "url", "browser"/);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects log refs outside approved roots with recovery details", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "log", ref: "AGENTS.md#Security.External-access" },
    ]));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /log evidence ref must be a path under approved evidence locations/);
    assert.match(result.error.message, /\.gsd\/exec\//);
    assert.match(result.error.message, /\.gsd\/uat\//);
    assert.match(result.error.message, /\.artifacts\/browser\//);
  } finally {
    cleanup(base);
  }
});

test("prepareUatRun rejects browser filesystem refs outside browser artifacts", () => {
  const base = makeTmpBase();
  try {
    const evidenceId = writeFreshUatEvidence(base);
    const result = prepareUatRun(base, buildParams([
      { kind: "gsd_uat_exec", ref: evidenceId },
      { kind: "browser", ref: ".gsd/uat/M001/S01/browser.json" },
    ], { uatType: "browser-executable", mode: "browser" }));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected invalid evidence");
    assert.match(result.error.message, /browser evidence ref must be an http:\/\/ or https:\/\/ URL/);
    assert.match(result.error.message, /\.artifacts\/browser\//);
  } finally {
    cleanup(base);
  }
});
