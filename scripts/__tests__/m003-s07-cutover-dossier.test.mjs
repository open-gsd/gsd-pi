// Project/App: gsd-pi
// File Purpose: Executable contract for the deterministic M003/S07 cutover dossier.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  COMMAND_INVENTORY,
  DEFAULT_OUTPUT,
  buildDossier,
  hashCanonical,
  parseArgs,
  renderDossier,
  runDossierCli,
  validateDossier,
} from "../m003-s07-cutover-dossier.mjs";

const MODES = ["auto", "interactive", "guided", "uok", "custom", "legacy"];
const TRANSPORTS = ["native_pi", "workflow_mcp"];
const CLASSIFICATIONS = [
  "match",
  "semantic_match_exact_delta",
  "missing_shadow",
  "extra_shadow",
  "status_mismatch",
];
const PROOF_OUTCOMES = ["advanced", "repaired", "unresolved", "rejected", "observation_loss"];
const COMPATIBILITY_IDS = [
  "runtime-disagreement",
  "same-status-repair",
  "park-unpark",
  "discard",
  "skipped-dispatch",
  "db-unavailable-dispatch",
  "db-unavailable-resolver",
  "db-unavailable-resolver-no-active",
  "resolve-dispatch-authority",
  "db-unavailable-status",
  "state-derivation-authority",
];
const COMPATIBILITY_DETAILS = Object.freeze({
  "runtime-disagreement": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "legacy milestone status remains public when canonical lifecycle disagrees",
  },
  "same-status-repair": {
    file: "src/resources/extensions/gsd/tests/adopted-lifecycle-bypass-closure.test.ts",
    title: "same-status completion timestamp repair remains available when adopted state is aligned",
  },
  "park-unpark": {
    file: "src/resources/extensions/gsd/tests/park-db-sync.test.ts",
    title: "unparkMilestone updates DB status to 'active' (#2694)",
  },
  discard: {
    file: "src/resources/extensions/gsd/tests/park-milestone.test.ts",
    title: "discardMilestone removes DB rows, worktree, and milestone branch",
  },
  "skipped-dispatch": {
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "skipped prior DB slices do not block later slice dispatch",
  },
  "db-unavailable-dispatch": {
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "DB-unavailable dispatch fails closed without trusting milestone SUMMARY",
  },
  "db-unavailable-resolver": {
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "resolveDispatch fails closed for a concrete milestone when the DB is unavailable",
  },
  "db-unavailable-resolver-no-active": {
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "resolveDispatch fails closed for a concrete milestone without active state",
  },
  "resolve-dispatch-authority": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "resolveDispatch keeps legacy milestone status authoritative when canonical lifecycle disagrees",
  },
  "db-unavailable-status": {
    file: "src/resources/extensions/gsd/tests/milestone-status-tool.test.ts",
    title: "gsd_milestone_status handles missing DB gracefully",
  },
  "state-derivation-authority": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "legacy validation assessment steers state when canonical lifecycle disagrees",
  },
});
const COMMANDS = Object.freeze([
  {
    id: "semantic-shadow-capstone",
    command: "pnpm exec tsx --test --test-concurrency=1 src/resources/extensions/gsd/tests/semantic-shadow-capstone.test.ts src/resources/extensions/gsd/tests/semantic-shadow-soak.test.ts packages/mcp-server/src/workflow-tools-parity.test.ts",
    stage: "post_generation",
    verdict: "required",
  },
  {
    id: "semantic-shadow-no-cutover",
    command: "pnpm run gate:semantic-shadow-no-cutover",
    stage: "observed",
    verdict: "pass",
    exitCode: 0,
  },
  {
    id: "authority-baseline",
    command: "pnpm run baseline:workflow-authority",
    stage: "observed",
    verdict: "pass",
    exitCode: 0,
  },
  {
    id: "dossier-check",
    command: "node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types scripts/m003-s07-dossier-input.ts --source-root \"$PWD\" --database <canonical-gsd-db> --capstone <fresh-capstone-json> --check-dossier docs/dev/m003-s07-cutover-dossier.json",
    stage: "post_generation",
    verdict: "required",
  },
  {
    id: "verify-merge",
    command: "pnpm run verify:merge",
    stage: "post_generation",
    verdict: "required",
  },
]);
const DEFERRED_BLOCKERS = [
  "production-read-authority",
  "canonical-dependency-eligibility",
  "integrated-slice-source-uat-identity",
  "closeout-effects",
  "merge-publication-settlement",
  "park-unpark-discard-adoption",
  "projection-work-redesign",
  "legacy-cascade-deletion",
  "compatibility-retirement",
];

function sha(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function item(classification, index) {
  const common = {
    classification,
    itemIdentity: {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S07",
      taskId: `T${String(index + 1).padStart(2, "0")}`,
      lifecycleId: classification === "missing_shadow" ? null : `lifecycle-${index + 1}`,
    },
  };
  switch (classification) {
    case "match":
      return {
        ...common,
        rawLegacyStatus: "pending",
        rawCanonicalStatus: "pending",
        normalizedLegacyStatus: "pending",
        normalizedCanonicalStatus: "pending",
      };
    case "semantic_match_exact_delta":
      return {
        ...common,
        rawLegacyStatus: "queued",
        rawCanonicalStatus: "ready",
        normalizedLegacyStatus: "pending",
        normalizedCanonicalStatus: "ready",
      };
    case "missing_shadow":
      return {
        ...common,
        rawLegacyStatus: "complete",
        rawCanonicalStatus: null,
        normalizedLegacyStatus: "completed",
        normalizedCanonicalStatus: null,
      };
    case "extra_shadow":
      return {
        ...common,
        rawLegacyStatus: null,
        rawCanonicalStatus: "ready",
        normalizedLegacyStatus: null,
        normalizedCanonicalStatus: "ready",
      };
    case "status_mismatch":
      return {
        ...common,
        rawLegacyStatus: "active",
        rawCanonicalStatus: "completed",
        normalizedLegacyStatus: "in_progress",
        normalizedCanonicalStatus: "completed",
      };
    default:
      throw new Error(`Unsupported fixture classification: ${classification}`);
  }
}

function observation(mode, transport, sourceRevision, responseHash) {
  return {
    mode,
    transport,
    sourceRevision,
    responseHash,
    projectRevision: 7,
    authorityEpoch: 0,
    traceId: `trace-${mode}-${transport}`,
    turnId: `turn-${mode}-${transport}`,
    repairDisposition: "not_attempted",
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
    items: CLASSIFICATIONS.map(item),
  };
}

function repairHistory() {
  return Array.from({ length: 33 }, (_, index) => {
    const advanced = index < 10;
    const repairedMissing = index >= 10 && index < 21;
    return {
      resultingRevision: 138 + index,
      eventIndex: 0,
      eventId: `event-${String(index + 1).padStart(2, "0")}`,
      eventType: advanced ? "lifecycle.shadow.advanced" : "lifecycle.shadow.repaired",
      disposition: advanced ? "advanced" : "repaired",
      comparisonKind: repairedMissing ? "missing_shadow" : "status_mismatch",
      evidenceDigest: sha(`repair-evidence-${index % 23}`),
      eventCount: 1,
      outboxCount: 1,
      projectionCount: 1,
    };
  });
}

function taskReceiptHistory() {
  return Array.from({ length: 6 }, (_, index) => {
    const taskId = `T${String(index + 1).padStart(2, "0")}`;
    const attempts = taskId === "T05" ? [1, 2] : [1];
    return attempts.map((attemptNumber) => {
      const current = attemptNumber === attempts.at(-1);
      const label = `${taskId.toLowerCase()}-${attemptNumber}`;
      return {
        taskId,
        lifecycleStatus: "completed",
        attemptNumber,
        attemptId: `attempt-${label}`,
        attemptState: "settled",
        resultId: `result-${label}`,
        resultOutcome: "succeeded",
        verdictId: `verdict-${label}`,
        verdict: current ? "pass" : "inconclusive",
        evidenceId: `evidence-${label}`,
        evidenceSourceRevision: sha(`${label}-source`),
        observation: current ? "passed" : "inconclusive",
        testedSourceRevision: sha(`${label}-source`),
        evidenceHash: sha(`${label}-evidence`),
        durableOutputRef: `db://fixture/${label}`,
        environment: { attemptNumber, taskId, verificationPolicy: "fixture" },
        verdictRevision: 100 + index + attemptNumber,
        current,
      };
    });
  }).flat();
}

function validInput() {
  const sourceRevision = sha("candidate-source");
  const publicResponseHash = sha("frozen-public-response");
  const receipts = taskReceiptHistory();
  return {
    recommendation: "NO_GO",
    observationEvidencePlane: "capstone_fixture",
    canonicalHistoryEvidencePlane: "live_project",
    evidenceSourceRevision: sourceRevision,
    publicResponseHash,
    sourceCapstoneEvidenceHash: sha("source-capstone-evidence"),
    authority: { projectId: "fixture-project", projectRevision: 195, authorityEpoch: 0 },
    observations: MODES.flatMap((mode) => (
      TRANSPORTS.map((transport) => observation(mode, transport, sourceRevision, publicResponseHash))
    )),
    dispositionProof: PROOF_OUTCOMES.map((outcome) => ({
      outcome,
      evidenceHash: sha(`proof-${outcome}`),
      residueFree: outcome === "rejected",
      accounted: outcome === "observation_loss",
      ...(outcome === "observation_loss" ? { lossRef: "isolated-loss" } : {}),
    })),
    observationLosses: [{
      id: "isolated-loss",
      lossCount: 1,
      persistedCount: 1,
      terminalRecords: 1,
      accounted: true,
      causes: [{ reason: "primary_sink_failed", errorHash: sha("isolated-loss") }],
    }],
    repairHistory: repairHistory(),
    liveDrift: [
      {
        lifecycleId: "lifecycle-m003",
        itemKind: "milestone",
        milestoneId: "M003",
        sliceId: null,
        taskId: null,
        legacyStatus: "active",
        canonicalStatus: "ready",
        classification: "semantic_match_exact_delta",
      },
      {
        lifecycleId: "lifecycle-t07",
        itemKind: "task",
        milestoneId: "M003",
        sliceId: "S07",
        taskId: "T07",
        legacyStatus: "pending",
        canonicalStatus: "ready",
        classification: "semantic_match_exact_delta",
      },
    ],
    taskReceiptHistory: receipts,
    taskReceiptHeads: receipts.filter((receipt) => receipt.current).map((receipt) => ({
      taskId: receipt.taskId,
      attemptNumber: receipt.attemptNumber,
      attemptState: receipt.attemptState,
      resultOutcome: receipt.resultOutcome,
      verdict: receipt.verdict,
      current: true,
      testedSourceRevision: receipt.testedSourceRevision,
      evidenceHash: receipt.evidenceHash,
    })),
    compatibilityInventory: COMPATIBILITY_IDS.map((id) => ({
      id,
      ...COMPATIBILITY_DETAILS[id],
      verdict: "pass",
    })),
    commands: COMMANDS.map((command) => ({ ...command })),
    noCutover: {
      structural: { passed: 8, total: 8 },
      behavioral: { passed: 11, total: 11 },
    },
    authorityBaseline: { passed: 4, total: 4 },
    deferredCutoverBlockers: [...DEFERRED_BLOCKERS],
  };
}

function reversedInput() {
  const input = validInput();
  input.observations.reverse();
  for (const envelope of input.observations) envelope.items.reverse();
  input.dispositionProof.reverse();
  input.repairHistory.reverse();
  input.liveDrift.reverse();
  input.taskReceiptHistory.reverse();
  input.taskReceiptHeads.reverse();
  input.compatibilityInventory.reverse();
  input.commands.reverse();
  input.deferredCutoverBlockers.reverse();
  return input;
}

function inputWithRuntimeCommandContract() {
  const input = validInput();
  input.commands = COMMAND_INVENTORY.map((command) => ({ ...command }));
  return input;
}

test("buildDossier produces stable ordered JSON and self-verifying hashes", () => {
  const first = buildDossier(validInput());
  const second = buildDossier(reversedInput());

  assert.deepEqual(second, first);
  const rendered = renderDossier(first);
  assert.ok(rendered.indexOf('"authority"') < rendered.indexOf('"schemaVersion"'));
  assert.deepEqual(JSON.parse(rendered), first);
  assert.match(first.hashes.capstoneEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.hashes.canonicalHistoryHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.hashes.dossierHash, /^sha256:[0-9a-f]{64}$/);

  const withoutSelfHash = structuredClone(first);
  delete withoutSelfHash.hashes.dossierHash;
  assert.equal(first.hashes.dossierHash, hashCanonical(withoutSelfHash));
  assert.equal(first.observationCoverage.length, 60);
  assert.equal(first.observationEvidencePlane, "capstone_fixture");
  assert.equal(first.canonicalHistoryEvidencePlane, "live_project");
  assert.equal(first.publicResponseHash, sha("frozen-public-response"));
  assert.equal(first.sourceCapstoneEvidenceHash, sha("source-capstone-evidence"));
  assert.deepEqual(first.canonicalClosure, {
    status: "blocked",
    candidateStage: "pre_closure",
    blockedEntities: ["M003/S07", "M003/S07/T07"],
    requiredEvidence: {
      sourceBinding: "exact_merged_revision",
      automatedUatVerdict: "pass",
      durableVerdictReceipt: "required",
    },
  });
  assert.equal(first.observationCoverage[0].itemIdentity.milestoneId, "M001");
  assert.deepEqual(first.observationCoverage.slice(0, 5).map((row) => row.classification), CLASSIFICATIONS);
  assert.equal(first.observationCoverage[0].itemIdentity.lifecyclePresent, true);
  assert.equal("lifecycleId" in first.observationCoverage[0].itemIdentity, false);
  assert.deepEqual(first.commands, COMMANDS);
  assert.deepEqual(first.compatibilityInventory[0], {
    id: "runtime-disagreement",
    ...COMPATIBILITY_DETAILS["runtime-disagreement"],
    verdict: "pass",
  });
  assert.deepEqual(first.repairHistory.counts, {
    total: 33,
    advanced: 10,
    repaired: 23,
    missingShadow: 11,
    statusMismatch: 22,
    distinctEvidenceDigests: 23,
  });
  assert.equal(first.authority.projectId, "fixture-project");
  assert.equal(first.taskReceiptHistory.length, 7);
  assert.deepEqual(
    first.taskReceiptHistory.filter((receipt) => receipt.taskId === "T05")
      .map(({ attemptNumber, current }) => ({ attemptNumber, current })),
    [{ attemptNumber: 1, current: false }, { attemptNumber: 2, current: true }],
  );
  assert.equal(first.taskReceiptHeads.find((receipt) => receipt.taskId === "T05").attemptNumber, 2);
});

test("capstone suite remains required until DB-backed post-generation UAT", () => {
  const dossier = buildDossier(validInput());
  const capstone = dossier.commands.find((command) => command.id === "semantic-shadow-capstone");

  assert.deepEqual(capstone, COMMANDS[0]);
  assert.equal(Object.hasOwn(capstone, "exitCode"), false);
});

test("canonical history retains exact live lifecycle identities", () => {
  const dossier = buildDossier(inputWithRuntimeCommandContract());

  assert.deepEqual(
    dossier.liveDrift.map((row) => row.lifecycleId),
    ["lifecycle-m003", "lifecycle-t07"],
  );
});

test("canonical history hash binds exact live lifecycle identities", () => {
  const first = buildDossier(inputWithRuntimeCommandContract());
  const changedInput = inputWithRuntimeCommandContract();
  changedInput.liveDrift[0].lifecycleId = "replacement-lifecycle-m003";
  const changed = buildDossier(changedInput);

  assert.notEqual(changed.hashes.canonicalHistoryHash, first.hashes.canonicalHistoryHash);
});

const failureCases = [
  ["missing mode/transport cell", (input) => input.observations.pop(), /missing observation cell/i],
  ["duplicate mode/transport cell", (input) => input.observations.push(structuredClone(input.observations[0])), /duplicate observation cell/i],
  ["missing classification tuple", (input) => input.observations[0].items.pop(), /classification tuple/i],
  ["classification alias", (input) => { input.observations[0].items[0].classification = "exact_match"; }, /unknown classification/i],
  ["missing lifecycle identity", (input) => { delete input.observations[0].items[0].itemIdentity.lifecycleId; }, /lifecycle.*identity/i],
  ["live milestone relabeled as fixture", (input) => { input.liveDrift[0].milestoneId = "M001"; }, /live drift milestone.*M003/i],
  ["fixture milestone relabeled as live", (input) => { input.observations[0].items[0].itemIdentity.milestoneId = "M003"; }, /fixture observation milestone.*M001/i],
  ["missing fixture evidence plane", (input) => { delete input.observationEvidencePlane; }, /observation evidence plane.*capstone_fixture/i],
  ["wrong history evidence plane", (input) => { input.canonicalHistoryEvidencePlane = "capstone_fixture"; }, /canonical history evidence plane.*live_project/i],
  ["incomplete tuple identity", (input) => { input.observations[0].items[0].itemIdentity.taskId = null; }, /task identity/i],
  ["forged normalized status", (input) => { input.observations[0].items[1].normalizedLegacyStatus = "ready"; }, /frozen semantic relation/i],
  ["missing public response hash", (input) => { delete input.publicResponseHash; }, /public response hash/i],
  ["corrupt public response hash", (input) => { input.publicResponseHash = "sha256:bad"; }, /public response hash/i],
  ["missing source capstone hash", (input) => { delete input.sourceCapstoneEvidenceHash; }, /source capstone evidence hash/i],
  ["corrupt source capstone hash", (input) => { input.sourceCapstoneEvidenceHash = "SHA256:BAD"; }, /source capstone evidence hash/i],
  ["missing observation response hash", (input) => { delete input.observations[0].responseHash; }, /observation response hash/i],
  ["mixed exact response hash", (input) => { input.observations[0].responseHash = sha("other-response"); }, /observation response hash.*public/i],
  ["corrupt observation response hash", (input) => { input.observations[0].responseHash = "sha256:bad"; }, /observation response hash/i],
  ["unavailable source", (input) => { input.observations[0].sourceRevision = "unavailable"; }, /source revision/i],
  ["mixed exact source", (input) => { input.observations[0].sourceRevision = sha("other-source"); }, /source revision/i],
  ["clean matrix loss", (input) => { input.observations[0].observationLossAccounting.lossCount = 1; }, /clean observation.*loss/i],
  ["unaccounted isolated loss", (input) => { input.observationLosses[0].accounted = false; }, /unaccounted observation loss/i],
  ["competing loss terminal", (input) => { input.observationLosses[0].terminalRecords = 2; }, /terminal record/i],
  ["corrupt repair digest", (input) => { input.repairHistory[0].evidenceDigest = "sha256:bad"; }, /repair.*digest/i],
  ["missing repair receipt", (input) => input.repairHistory.pop(), /33 repair/i],
  ["missing repair outbox", (input) => { input.repairHistory[0].outboxCount = 0; }, /repair.*1\/1\/1/i],
  ["historical disposition drift", (input) => { input.repairHistory[0].disposition = "repaired"; }, /repair.*disposition/i],
  ["missing live lifecycle identity", (input) => { delete input.liveDrift[0].lifecycleId; }, /live drift.*lifecycle identity/i],
  ["live missing shadow", (input) => { input.liveDrift[0].classification = "missing_shadow"; }, /live drift/i],
  ["forged allowed live classification", (input) => { input.liveDrift[0].classification = "match"; }, /frozen semantic relation/i],
  ["unknown live status", (input) => { input.liveDrift[0].legacyStatus = "mystery"; }, /live drift/i],
  ["missing receipt history", (input) => input.taskReceiptHistory.pop(), /receipt history.*seven Attempts/i],
  ["reopened receipt task", (input) => { input.taskReceiptHistory[0].lifecycleStatus = "ready"; }, /lifecycle must be completed/i],
  ["duplicate receipt result", (input) => { input.taskReceiptHistory[1].resultId = input.taskReceiptHistory[0].resultId; }, /duplicate receipt history Result/i],
  ["duplicate receipt evidence", (input) => { input.taskReceiptHistory[1].evidenceId = input.taskReceiptHistory[0].evidenceId; }, /duplicate receipt history Evidence/i],
  ["receipt source mismatch", (input) => { input.taskReceiptHistory[0].evidenceSourceRevision = sha("other-source"); }, /source revisions disagree/i],
  ["missing durable receipt output", (input) => { input.taskReceiptHistory[0].durableOutputRef = ""; }, /durable output reference/i],
  ["nonpassing receipt head", (input) => { input.taskReceiptHeads[0].verdict = "fail"; }, /receipt head/i],
  ["declared receipt head drift", (input) => { input.taskReceiptHeads[4].attemptNumber = 1; }, /receipt heads.*complete receipt history/i],
  ["missing compatibility witness", (input) => input.compatibilityInventory.pop(), /compatibility inventory/i],
  ["missing compatibility file", (input) => { delete input.compatibilityInventory[0].file; }, /compatibility.*file/i],
  ["changed compatibility title", (input) => { input.compatibilityInventory[0].title = "renamed"; }, /compatibility.*title/i],
  ["missing command", (input) => input.commands.pop(), /command inventory/i],
  ["changed command", (input) => { input.commands[0].command = "pnpm test"; }, /command inventory/i],
  ["failed observed command", (input) => { input.commands[1].exitCode = 1; }, /observed command.*pass/i],
  ["wrong observed stage", (input) => { input.commands[1].stage = "post_generation"; }, /command inventory.*stage/i],
  ["pre-certified capstone command", (input) => {
    input.commands[0].stage = "observed";
    input.commands[0].verdict = "pass";
    input.commands[0].exitCode = 0;
  }, /command inventory.*stage|post-generation command/i],
  ["pre-certified post-generation command", (input) => { input.commands[3].verdict = "pass"; }, /post-generation command.*required/i],
  ["post-generation exit claim", (input) => { input.commands[3].exitCode = 0; }, /post-generation command.*exit/i],
  ["no-cutover regression", (input) => { input.noCutover.behavioral.passed = 10; }, /no-cutover.*11\/11/i],
  ["authority baseline regression", (input) => { input.authorityBaseline.passed = 3; }, /baseline.*4\/4/i],
  ["GO recommendation", (input) => { input.recommendation = "GO"; }, /recommendation.*NO_GO/i],
  ["missing deferred blocker", (input) => input.deferredCutoverBlockers.pop(), /deferred cutover blocker/i],
  ["GitHub label input", (input) => { input.githubLabels = ["ready"]; }, /forbidden.*github/i],
  ["Git tag input", (input) => { input.releaseTags = ["v1.0.0"]; }, /forbidden.*tags/i],
  ["network input", (input) => { input.networkSource = "https://example.test/evidence"; }, /forbidden.*network/i],
];

for (const [name, mutate, expected] of failureCases) {
  test(`buildDossier rejects ${name}`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildDossier(input), expected);
  });
}

test("validateDossier reconstructs normalized evidence and rejects changed hashes", () => {
  const dossier = buildDossier(validInput());
  assert.deepEqual(validateDossier(dossier), dossier);

  const corrupt = structuredClone(dossier);
  corrupt.hashes.capstoneEvidenceHash = sha("corrupt");
  assert.throws(() => validateDossier(corrupt), /hash|normalized dossier/i);
});

test("parseArgs exposes check and explicit local generation modes", () => {
  assert.deepEqual(parseArgs(["--input", "evidence.json", "--json"]), {
    mode: "generate",
    inputPath: "evidence.json",
    outputPath: DEFAULT_OUTPUT,
    json: true,
  });
  assert.deepEqual(parseArgs(["--check"]), {
    mode: "check",
    inputPath: null,
    outputPath: DEFAULT_OUTPUT,
    json: false,
  });
  assert.deepEqual(parseArgs(["--input", "evidence.json", "--output", "result.json"]), {
    mode: "generate",
    inputPath: "evidence.json",
    outputPath: "result.json",
    json: false,
  });
  assert.throws(() => parseArgs(["--check", "--input", "evidence.json"]), /check.*input/i);
  assert.throws(() => parseArgs(["--check", "--output", "result.json"]), /output.*generate/i);
  assert.throws(() => parseArgs(["--input", "https://example.test/evidence.json"]), /local path/i);
  assert.throws(() => parseArgs(["--github-label", "ready"]), /unknown argument/i);
});

test("bare --check validates and byte-compares the default checked dossier", () => {
  const dossier = buildDossier(validInput());
  const rendered = renderDossier(dossier);
  const output = [];
  const io = {
    readText(path) {
      assert.equal(path, DEFAULT_OUTPUT);
      return rendered;
    },
    writeText() {
      assert.fail("--check must not write");
    },
    writeStdout(text) {
      output.push(text);
    },
  };

  runDossierCli(["--check"], io);
  assert.match(output.join(""), /valid/i);

  assert.throws(() => runDossierCli(["--check"], {
    ...io,
    readText: () => `${rendered}\n`,
  }), /byte|canonical|stale/i);
});

test("explicit --output writes a validated generated dossier", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "m003-s07-dossier-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "dossier.json");
  writeFileSync(inputPath, `${JSON.stringify(validInput())}\n`);

  const result = spawnSync(process.execPath, [
    "scripts/m003-s07-cutover-dossier.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(outputPath, "utf8")).hashes.dossierHash,
    buildDossier(validInput()).hashes.dossierHash,
  );
});

test("CLI renders a validated local fixture without writing production JSON", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "m003-s07-dossier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(validInput())}\n`);

  const result = spawnSync(process.execPath, [
    "scripts/m003-s07-cutover-dossier.mjs",
    "--input",
    inputPath,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), buildDossier(validInput()));
});
