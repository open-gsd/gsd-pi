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

function writeUatExecEvidence(
  base: string,
  outcome: { exit_code?: number; signal?: string | null; timed_out?: boolean; aborted?: boolean },
  id = "fresh-uat-evidence",
): string {
  const execDir = join(base, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  writeFileSync(
    join(execDir, `${id}.meta.json`),
    JSON.stringify({
      id,
      ...outcome,
      metadata: { kind: "uat_exec" },
    }),
    "utf-8",
  );
  return id;
}

function writeFreshUatEvidence(base: string, id = "fresh-uat-evidence"): string {
  return writeUatExecEvidence(base, { exit_code: 0, signal: null, timed_out: false, aborted: false }, id);
}

function buildParams(
  evidence: EvidenceInput[],
  options: {
    uatType?: UatResultSaveParams["uatType"];
    mode?: UatResultSaveParams["checks"][number]["mode"];
    verdict?: UatResultSaveParams["verdict"];
    checkResult?: UatResultSaveParams["checks"][number]["result"];
  } = {},
): UatResultSaveParams {
  const uatType = options.uatType ?? "runtime-executable";
  const verdict = options.verdict ?? "PASS";
  return {
    milestoneId: "M001",
    sliceId: "S01",
    uatType,
    verdict,
    checks: [{
      id: "UAT-01",
      description: "Evidence contract check",
      mode: options.mode ?? "runtime",
      result: options.checkResult ?? "PASS",
      evidence: evidence as UatEvidenceRef[],
      notes: "Evidence validation should be explicit.",
    }],
    presentation: buildRunUatPresentationForType(uatType),
    notes: `UAT ${verdict}.`,
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

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence recorded a failed execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected failed-execution evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /failed-uat-evidence/);
  assert.match(result.error.message, /exit_code=1/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence recorded a non-null signal", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: "SIGTERM", timed_out: false, aborted: false },
    "signalled-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected signalled evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /signalled-uat-evidence/);
  assert.match(result.error.message, /signal=SIGTERM/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence timed out", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: null, timed_out: true, aborted: false },
    "timed-out-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected timed-out evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /timed-out-uat-evidence/);
  assert.match(result.error.message, /timed_out=true/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence was aborted", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0, signal: null, timed_out: false, aborted: true },
    "aborted-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected aborted evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /aborted-uat-evidence/);
  assert.match(result.error.message, /aborted=true/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence is missing exit_code", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { signal: null, timed_out: false, aborted: false },
    "exit-code-less-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected outcome-less evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /exit_code=undefined/);
});

test("prepareUatRun rejects a PASS check whose gsd_uat_exec evidence is missing signal and timed_out", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 0 },
    "partial-outcome-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected outcome-less evidence to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /signal=undefined/);
  assert.match(result.error.message, /timed_out=undefined/);
});

test("prepareUatRun accepts a PASS check whose gsd_uat_exec evidence recorded a successful execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeFreshUatEvidence(base);
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ]));

  if (!result.ok) assert.fail(result.error.message);
  assert.equal(result.run.params.verdict, "PASS");
});

test("prepareUatRun still accepts a FAIL check whose gsd_uat_exec evidence recorded a failed execution", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const result = prepareUatRun(base, buildParams([
    { kind: "gsd_uat_exec", ref: evidenceId },
  ], { verdict: "FAIL", checkResult: "FAIL" }));

  if (!result.ok) assert.fail(result.error.message);
  assert.equal(result.run.params.verdict, "FAIL");
  assert.equal(result.run.gateOutcome, "fail");
});

test("prepareUatRun rejects on the PASS check alone when a FAIL check cites the same failing evidence", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const evidenceId = writeUatExecEvidence(
    base,
    { exit_code: 1, signal: null, timed_out: false, aborted: false },
    "failed-uat-evidence",
  );
  const params = buildParams(
    [{ kind: "gsd_uat_exec", ref: evidenceId }],
    { verdict: "FAIL", checkResult: "FAIL" },
  );
  params.checks.push({
    id: "UAT-02",
    description: "Second check wrongly claims success",
    mode: "runtime",
    result: "PASS",
    evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
    notes: "Claims the failing run passed.",
  });

  const result = prepareUatRun(base, params);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the PASS check to be rejected");
  assert.equal(result.error.code, "invalid_evidence");
  assert.match(result.error.message, /check UAT-02/);
  assert.doesNotMatch(result.error.message, /check UAT-01/);
  assert.match(result.error.message, /failed-uat-evidence/);
  assert.match(result.error.message, /exit_code=1/);
});
