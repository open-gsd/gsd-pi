#!/usr/bin/env node

// Project/App: gsd-pi
// File Purpose: Deterministic validation and normalization core for the M003/S07 cutover dossier.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODES = Object.freeze(["auto", "interactive", "guided", "uok", "custom", "legacy"]);
export const TRANSPORTS = Object.freeze(["native_pi", "workflow_mcp"]);
export const CLASSIFICATIONS = Object.freeze([
  "match",
  "semantic_match_exact_delta",
  "missing_shadow",
  "extra_shadow",
  "status_mismatch",
]);
export const PROOF_OUTCOMES = Object.freeze([
  "advanced",
  "repaired",
  "unresolved",
  "rejected",
  "observation_loss",
]);
export const COMPATIBILITY_IDS = Object.freeze([
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
]);
export const COMPATIBILITY_WITNESSES = Object.freeze([
  {
    id: "runtime-disagreement",
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "legacy milestone status remains public when canonical lifecycle disagrees",
  },
  {
    id: "same-status-repair",
    file: "src/resources/extensions/gsd/tests/adopted-lifecycle-bypass-closure.test.ts",
    title: "same-status completion timestamp repair remains available when adopted state is aligned",
  },
  {
    id: "park-unpark",
    file: "src/resources/extensions/gsd/tests/park-db-sync.test.ts",
    title: "unparkMilestone updates DB status to 'active' (#2694)",
  },
  {
    id: "discard",
    file: "src/resources/extensions/gsd/tests/park-milestone.test.ts",
    title: "discardMilestone removes DB rows, worktree, and milestone branch",
  },
  {
    id: "skipped-dispatch",
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "skipped prior DB slices do not block later slice dispatch",
  },
  {
    id: "db-unavailable-dispatch",
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "DB-unavailable dispatch fails closed without trusting milestone SUMMARY",
  },
  {
    id: "db-unavailable-resolver",
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "resolveDispatch fails closed for a concrete milestone when the DB is unavailable",
  },
  {
    id: "db-unavailable-resolver-no-active",
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "resolveDispatch fails closed for a concrete milestone without active state",
  },
  {
    id: "resolve-dispatch-authority",
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "resolveDispatch keeps legacy milestone status authoritative when canonical lifecycle disagrees",
  },
  {
    id: "db-unavailable-status",
    file: "src/resources/extensions/gsd/tests/milestone-status-tool.test.ts",
    title: "gsd_milestone_status handles missing DB gracefully",
  },
  {
    id: "state-derivation-authority",
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "legacy validation assessment steers state when canonical lifecycle disagrees",
  },
]);
export const COMMAND_INVENTORY = Object.freeze([
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
export const DEFERRED_BLOCKERS = Object.freeze([
  "production-read-authority",
  "canonical-dependency-eligibility",
  "integrated-slice-source-uat-identity",
  "closeout-effects",
  "merge-publication-settlement",
  "park-unpark-discard-adoption",
  "projection-work-redesign",
  "legacy-cascade-deletion",
  "compatibility-retirement",
]);
const CANONICAL_CLOSURE = Object.freeze({
  status: "blocked",
  candidateStage: "pre_closure",
  blockedEntities: Object.freeze(["M003/S07", "M003/S07/T07"]),
  requiredEvidence: Object.freeze({
    sourceBinding: "exact_merged_revision",
    automatedUatVerdict: "pass",
    durableVerdictReceipt: "required",
  }),
});
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, "../docs/dev/m003-s07-cutover-dossier.json");

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LEGACY_STATUS_MAP = Object.freeze({
  pending: "pending",
  queued: "pending",
  planned: "pending",
  active: "in_progress",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  blocked: "paused",
  parked: "paused",
  complete: "completed",
  done: "completed",
  closed: "completed",
  skipped: "cancelled",
  deferred: "cancelled",
});
const CANONICAL_STATUSES = new Set(["pending", "ready", "in_progress", "paused", "completed", "cancelled"]);
const LOSS_REASONS = new Set([
  "context_resolution_failed",
  "shadow_query_failed",
  "primary_sink_failed",
  "projection_sink_failed",
]);
const TOP_LEVEL_KEYS = new Set([
  "recommendation",
  "observationEvidencePlane",
  "canonicalHistoryEvidencePlane",
  "evidenceSourceRevision",
  "publicResponseHash",
  "sourceCapstoneEvidenceHash",
  "authority",
  "observations",
  "dispositionProof",
  "observationLosses",
  "repairHistory",
  "liveDrift",
  "taskReceiptHistory",
  "taskReceiptHeads",
  "compatibilityInventory",
  "noCutover",
  "authorityBaseline",
  "commands",
  "deferredCutoverBlockers",
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a nonblank string`);
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  return requireString(value, label);
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase sha256 digest`);
  return value;
}

function orderBy(inventory, value, label) {
  const index = inventory.indexOf(value);
  if (index === -1) fail(`Unknown ${label}: ${String(value)}`);
  return index;
}

function forbiddenInputToken(key) {
  const tokens = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
  return tokens.find((token) => [
    "github",
    "label",
    "labels",
    "tag",
    "tags",
    "network",
    "octokit",
    "hosted",
    "url",
    "urls",
  ].includes(token));
}

function rejectForbiddenInputs(value, path = "input") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenInputs(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const token = forbiddenInputToken(key);
      if (token) fail(`Forbidden ${token} input at ${path}.${key}`);
      rejectForbiddenInputs(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && /(?:https?:\/\/|git@github|github\.com)/i.test(value)) {
    fail(`Forbidden network input value at ${path}`);
  }
}

function rejectUnknownTopLevelKeys(input) {
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`Unknown dossier input field: ${key}`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function frozenComparison(rawLegacyStatus, rawCanonicalStatus) {
  const normalizedLegacyStatus = rawLegacyStatus === null
    ? null
    : LEGACY_STATUS_MAP[rawLegacyStatus] ?? null;
  const normalizedCanonicalStatus = rawCanonicalStatus !== null && CANONICAL_STATUSES.has(rawCanonicalStatus)
    ? rawCanonicalStatus
    : null;

  let classification = "status_mismatch";
  if (rawLegacyStatus !== null && rawCanonicalStatus === null) classification = "missing_shadow";
  else if (rawLegacyStatus === null && rawCanonicalStatus !== null) classification = "extra_shadow";
  else if (rawLegacyStatus === rawCanonicalStatus && normalizedLegacyStatus !== null && normalizedCanonicalStatus !== null) {
    classification = "match";
  } else if (normalizedLegacyStatus !== null && normalizedCanonicalStatus !== null
    && (normalizedLegacyStatus === normalizedCanonicalStatus
      || (normalizedCanonicalStatus === "ready" && ["pending", "in_progress"].includes(normalizedLegacyStatus)))) {
    classification = "semantic_match_exact_delta";
  }
  return { classification, normalizedLegacyStatus, normalizedCanonicalStatus };
}

function requireOwn(record, key, label) {
  if (!Object.hasOwn(record, key)) fail(`${label} is required`);
}

function requireFrozenRelation(item, label) {
  const comparison = frozenComparison(item.rawLegacyStatus, item.rawCanonicalStatus);
  if (item.classification !== comparison.classification
    || item.normalizedLegacyStatus !== comparison.normalizedLegacyStatus
    || item.normalizedCanonicalStatus !== comparison.normalizedCanonicalStatus) {
    fail(`${label} does not match the frozen semantic relation`);
  }
}

function validateItemIdentity(identity) {
  if (identity.itemKind === "milestone" && (identity.sliceId !== null || identity.taskId !== null)) {
    fail("Milestone identity must not contain Slice or Task IDs");
  }
  if (identity.itemKind === "slice" && (identity.sliceId === null || identity.taskId !== null)) {
    fail("Slice identity requires a Slice ID and no Task ID");
  }
  if (identity.itemKind === "task" && (identity.sliceId === null || identity.taskId === null)) {
    fail("Task identity requires both Slice and Task IDs");
  }
}

function normalizeItem(rawItem) {
  const item = requireRecord(rawItem, "Observation item");
  const classification = requireString(item.classification, "Observation classification");
  orderBy(CLASSIFICATIONS, classification, "classification");
  const identity = requireRecord(item.itemIdentity, "Observation item identity");
  requireOwn(identity, "lifecycleId", "Observation lifecycle identity");
  const lifecycleId = requireNullableString(identity.lifecycleId, "Observation lifecycle identity");
  const normalized = {
    classification,
    itemIdentity: {
      itemKind: requireString(identity.itemKind, "Observation item kind"),
      milestoneId: requireString(identity.milestoneId, "Observation milestone ID"),
      sliceId: requireNullableString(identity.sliceId, "Observation slice ID"),
      taskId: requireNullableString(identity.taskId, "Observation task ID"),
      lifecyclePresent: lifecycleId !== null,
    },
    rawLegacyStatus: requireNullableString(item.rawLegacyStatus, "Raw legacy status"),
    rawCanonicalStatus: requireNullableString(item.rawCanonicalStatus, "Raw canonical status"),
    normalizedLegacyStatus: requireNullableString(item.normalizedLegacyStatus, "Normalized legacy status"),
    normalizedCanonicalStatus: requireNullableString(item.normalizedCanonicalStatus, "Normalized canonical status"),
  };
  if (!["milestone", "slice", "task"].includes(normalized.itemIdentity.itemKind)) {
    fail(`Unknown observation item kind: ${normalized.itemIdentity.itemKind}`);
  }
  if (normalized.itemIdentity.milestoneId !== "M001") fail("Fixture observation milestone ID must be M001");
  validateItemIdentity(normalized.itemIdentity);
  requireFrozenRelation(normalized, "Observation tuple");
  if ((normalized.rawCanonicalStatus === null) !== (lifecycleId === null)) {
    fail("Observation lifecycle identity must be present exactly when canonical status is present");
  }
  return normalized;
}

function normalizeObservations(rawObservations, sourceRevision, publicResponseHash) {
  const observations = requireArray(rawObservations, "Observations");
  const cells = new Map();
  for (const rawObservation of observations) {
    const observation = requireRecord(rawObservation, "Observation envelope");
    const mode = requireString(observation.mode, "Observation mode");
    const transport = requireString(observation.transport, "Observation transport");
    orderBy(MODES, mode, "mode");
    orderBy(TRANSPORTS, transport, "transport");
    const cell = `${mode}/${transport}`;
    if (cells.has(cell)) fail(`Duplicate observation cell: ${cell}`);

    const observedSource = requireSha(observation.sourceRevision, "Observation source revision");
    if (observedSource !== sourceRevision) fail(`Observation source revision does not match dossier source: ${cell}`);
    const responseHash = requireSha(observation.responseHash, "Observation response hash");
    if (responseHash !== publicResponseHash) fail(`Observation response hash does not match public response: ${cell}`);
    if (observation.repairDisposition !== "not_attempted") {
      fail(`Clean observation repair disposition must be not_attempted: ${cell}`);
    }
    const loss = requireRecord(observation.observationLossAccounting, "Observation loss accounting");
    if (loss.lossCount !== 0 || loss.persistedCount !== 1) {
      fail(`Clean observation coverage must have zero loss and one persisted record: ${cell}`);
    }

    const items = requireArray(observation.items, "Observation items").map(normalizeItem);
    const byClassification = new Map();
    const identities = new Set();
    for (const item of items) {
      if (byClassification.has(item.classification)) {
        fail(`Duplicate classification tuple for ${cell}/${item.classification}`);
      }
      const identityKey = JSON.stringify(item.itemIdentity);
      if (identities.has(identityKey)) fail(`Duplicate observation identity in ${cell}`);
      identities.add(identityKey);
      byClassification.set(item.classification, item);
    }
    for (const classification of CLASSIFICATIONS) {
      if (!byClassification.has(classification)) {
        fail(`Missing classification tuple for ${cell}/${classification}`);
      }
    }
    if (items.length !== CLASSIFICATIONS.length) fail(`Observation cell ${cell} must have five classification tuples`);

    cells.set(cell, {
      mode,
      transport,
      sourceRevision: observedSource,
      projectRevision: requireInteger(observation.projectRevision, "Observation project revision"),
      authorityEpoch: requireInteger(observation.authorityEpoch, "Observation authority epoch"),
      traceId: requireString(observation.traceId, "Observation trace ID"),
      turnId: requireString(observation.turnId, "Observation turn ID"),
      repairDisposition: "not_attempted",
      observationLossAccounting: { lossCount: 0, persistedCount: 1 },
      items: [...items].sort((left, right) => (
        orderBy(CLASSIFICATIONS, left.classification, "classification")
        - orderBy(CLASSIFICATIONS, right.classification, "classification")
      )),
    });
  }

  for (const mode of MODES) {
    for (const transport of TRANSPORTS) {
      const cell = `${mode}/${transport}`;
      if (!cells.has(cell)) fail(`Missing observation cell: ${cell}`);
    }
  }
  if (cells.size !== MODES.length * TRANSPORTS.length) fail("Observation coverage must contain exactly 12 cells");

  const ordered = [...cells.values()].sort((left, right) => (
    orderBy(MODES, left.mode, "mode") - orderBy(MODES, right.mode, "mode")
    || orderBy(TRANSPORTS, left.transport, "transport")
      - orderBy(TRANSPORTS, right.transport, "transport")
  ));
  return ordered.flatMap((observation) => observation.items.map((item) => ({
    mode: observation.mode,
    transport: observation.transport,
    sourceRevision: observation.sourceRevision,
    projectRevision: observation.projectRevision,
    authorityEpoch: observation.authorityEpoch,
    traceId: observation.traceId,
    turnId: observation.turnId,
    repairDisposition: observation.repairDisposition,
    observationLossAccounting: observation.observationLossAccounting,
    ...item,
  })));
}

function normalizeLosses(rawLosses) {
  const losses = requireArray(rawLosses, "Observation losses");
  const ids = new Set();
  const normalized = losses.map((rawLoss) => {
    const loss = requireRecord(rawLoss, "Observation loss");
    const id = requireString(loss.id, "Observation loss ID");
    if (ids.has(id)) fail(`Duplicate observation loss: ${id}`);
    ids.add(id);
    const lossCount = requireInteger(loss.lossCount, "Observation loss count");
    const persistedCount = requireInteger(loss.persistedCount, "Observation persisted count");
    if (!loss.accounted || lossCount === 0) fail(`Unaccounted observation loss: ${id}`);
    if (loss.terminalRecords !== 1) fail(`Observation loss must have exactly one terminal record: ${id}`);
    if (![0, 1].includes(persistedCount)) fail(`Observation persisted count must be zero or one: ${id}`);
    const causes = requireArray(loss.causes, "Observation loss causes").map((rawCause) => {
      const cause = requireRecord(rawCause, "Observation loss cause");
      const reason = requireString(cause.reason, "Observation loss reason");
      if (!LOSS_REASONS.has(reason)) fail(`Unknown observation loss reason: ${reason}`);
      return { reason, errorHash: requireSha(cause.errorHash, "Observation loss error hash") };
    }).sort((left, right) => left.reason.localeCompare(right.reason) || left.errorHash.localeCompare(right.errorHash));
    if (causes.length !== lossCount) fail(`Observation loss cause count does not match lossCount: ${id}`);
    return { id, lossCount, persistedCount, terminalRecords: 1, accounted: true, causes };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeDispositionProof(rawProof, losses) {
  const proof = requireArray(rawProof, "Disposition proof");
  const byOutcome = new Map();
  for (const rawEntry of proof) {
    const entry = requireRecord(rawEntry, "Disposition proof entry");
    const outcome = requireString(entry.outcome, "Disposition proof outcome");
    orderBy(PROOF_OUTCOMES, outcome, "proof outcome");
    if (byOutcome.has(outcome)) fail(`Duplicate disposition proof: ${outcome}`);
    if (outcome === "rejected" && entry.residueFree !== true) {
      fail("Rejected disposition proof must be residue-free");
    }
    if (outcome === "observation_loss") {
      if (entry.accounted !== true) fail("Observation-loss disposition proof must be accounted");
      const lossRef = requireString(entry.lossRef, "Observation-loss reference");
      if (!losses.some((loss) => loss.id === lossRef)) fail(`Observation-loss proof has unknown loss reference: ${lossRef}`);
    }
    byOutcome.set(outcome, {
      outcome,
      evidenceHash: requireSha(entry.evidenceHash, "Disposition proof evidence hash"),
      residueFree: entry.residueFree === true,
      accounted: entry.accounted === true,
      ...(outcome === "observation_loss" ? { lossRef: entry.lossRef } : {}),
    });
  }
  for (const outcome of PROOF_OUTCOMES) {
    if (!byOutcome.has(outcome)) fail(`Missing disposition proof: ${outcome}`);
  }
  if (byOutcome.size !== PROOF_OUTCOMES.length) fail("Disposition proof must contain exactly five outcomes");
  return PROOF_OUTCOMES.map((outcome) => byOutcome.get(outcome));
}

function normalizeRepairHistory(rawHistory) {
  const history = requireArray(rawHistory, "Repair history");
  if (history.length !== 33) fail("Canonical history must contain exactly 33 repair receipts");
  const rows = history.map((rawRow) => {
    const row = requireRecord(rawRow, "Repair receipt");
    const normalized = {
      resultingRevision: requireInteger(row.resultingRevision, "Repair revision"),
      eventIndex: requireInteger(row.eventIndex, "Repair event index"),
      eventId: requireString(row.eventId, "Repair event ID"),
      eventType: requireString(row.eventType, "Repair event type"),
      disposition: requireString(row.disposition, "Repair disposition"),
      comparisonKind: requireString(row.comparisonKind, "Repair comparison kind"),
      evidenceDigest: requireSha(row.evidenceDigest, "Repair evidence digest"),
      eventCount: requireInteger(row.eventCount, "Repair event count"),
      outboxCount: requireInteger(row.outboxCount, "Repair outbox count"),
      projectionCount: requireInteger(row.projectionCount, "Repair projection count"),
    };
    if (normalized.eventCount !== 1 || normalized.outboxCount !== 1 || normalized.projectionCount !== 1) {
      fail(`Repair receipt must have event/outbox/projection counts 1/1/1: ${normalized.eventId}`);
    }
    const expectedEvent = normalized.disposition === "advanced"
      ? "lifecycle.shadow.advanced"
      : "lifecycle.shadow.repaired";
    if (!["advanced", "repaired"].includes(normalized.disposition) || normalized.eventType !== expectedEvent) {
      fail(`Repair event/disposition mismatch: ${normalized.eventId}`);
    }
    if (normalized.disposition === "advanced" && normalized.comparisonKind !== "status_mismatch") {
      fail(`Advanced repair must originate from status_mismatch: ${normalized.eventId}`);
    }
    if (normalized.disposition === "repaired" && !["missing_shadow", "status_mismatch"].includes(normalized.comparisonKind)) {
      fail(`Repaired receipt has invalid comparison: ${normalized.eventId}`);
    }
    return normalized;
  }).sort((left, right) => (
    left.resultingRevision - right.resultingRevision
    || left.eventIndex - right.eventIndex
    || left.eventId.localeCompare(right.eventId)
  ));

  rows.forEach((row, index) => {
    if (row.resultingRevision !== 138 + index || row.eventIndex !== 0) {
      fail("Repair lineage must cover revisions 138-170 with event index zero");
    }
  });
  const counts = {
    total: rows.length,
    advanced: rows.filter((row) => row.disposition === "advanced").length,
    repaired: rows.filter((row) => row.disposition === "repaired").length,
    missingShadow: rows.filter((row) => row.comparisonKind === "missing_shadow").length,
    statusMismatch: rows.filter((row) => row.comparisonKind === "status_mismatch").length,
    distinctEvidenceDigests: new Set(rows.map((row) => row.evidenceDigest)).size,
  };
  if (counts.advanced !== 10 || counts.repaired !== 23
    || counts.missingShadow !== 11 || counts.statusMismatch !== 22
    || counts.distinctEvidenceDigests !== 23) {
    fail("Repair historical cardinality must be 10 advanced, 23 repaired, 11 missing, 22 mismatch, and 23 distinct evidence digests");
  }
  return { counts, rows };
}

function normalizeLiveDrift(rawRows) {
  const rows = requireArray(rawRows, "Live drift rows");
  if (rows.length === 0) fail("Live drift snapshot must not be empty");
  const kindOrder = ["milestone", "slice", "task"];
  return rows.map((rawRow) => {
    const row = requireRecord(rawRow, "Live drift row");
    requireOwn(row, "lifecycleId", "Live drift lifecycle identity");
    const lifecycleId = requireNullableString(row.lifecycleId, "Live drift lifecycle identity");
    const classification = requireString(row.classification, "Live drift classification");
    const itemKind = requireString(row.itemKind, "Live drift item kind");
    orderBy(kindOrder, itemKind, "live item kind");
    const normalized = {
      lifecycleId,
      itemKind,
      milestoneId: requireString(row.milestoneId, "Live drift milestone ID"),
      sliceId: requireNullableString(row.sliceId, "Live drift slice ID"),
      taskId: requireNullableString(row.taskId, "Live drift task ID"),
      rawLegacyStatus: requireNullableString(row.legacyStatus, "Live legacy status"),
      rawCanonicalStatus: requireNullableString(row.canonicalStatus, "Live canonical status"),
      classification,
    };
    const comparison = frozenComparison(normalized.rawLegacyStatus, normalized.rawCanonicalStatus);
    if (classification !== comparison.classification) {
      fail("Live drift classification does not match the frozen semantic relation");
    }
    if (!["match", "semantic_match_exact_delta"].includes(comparison.classification)) {
      fail(`Live drift contains unexplained ${comparison.classification}`);
    }
    if (comparison.normalizedLegacyStatus === null || comparison.normalizedCanonicalStatus === null) {
      fail("Live drift contains an unknown status");
    }
    if (normalized.milestoneId !== "M003") fail("Live drift milestone ID must be M003");
    validateItemIdentity(normalized);
    if ((normalized.rawCanonicalStatus === null) !== (lifecycleId === null)) {
      fail("Live drift lifecycle identity must be present exactly when canonical status is present");
    }
    return { ...normalized, ...comparison };
  }).sort((left, right) => (
    orderBy(kindOrder, left.itemKind, "live item kind") - orderBy(kindOrder, right.itemKind, "live item kind")
    || left.milestoneId.localeCompare(right.milestoneId)
    || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
    || (left.taskId ?? "").localeCompare(right.taskId ?? "")
  ));
}

function normalizeTaskReceiptHeads(rawHeads) {
  const heads = requireArray(rawHeads, "Task receipt heads");
  const expected = Array.from({ length: 6 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
  const byTask = new Map();
  for (const rawHead of heads) {
    const head = requireRecord(rawHead, "Task receipt head");
    const taskId = requireString(head.taskId, "Receipt head task ID");
    if (byTask.has(taskId)) fail(`Duplicate receipt head: ${taskId}`);
    if (head.attemptState !== "settled" || head.resultOutcome !== "succeeded"
      || head.verdict !== "pass" || head.current !== true) {
      fail(`Receipt head must be current, settled, succeeded, and passing: ${taskId}`);
    }
    byTask.set(taskId, {
      taskId,
      attemptNumber: requireInteger(head.attemptNumber, "Receipt attempt number"),
      attemptState: "settled",
      resultOutcome: "succeeded",
      verdict: "pass",
      current: true,
      testedSourceRevision: requireSha(head.testedSourceRevision, "Receipt tested source revision"),
      evidenceHash: requireSha(head.evidenceHash, "Receipt evidence hash"),
    });
  }
  for (const taskId of expected) {
    if (!byTask.has(taskId)) fail(`Missing current receipt head: ${taskId}`);
  }
  if (byTask.size !== expected.length) fail("Receipt heads must contain exactly T01-T06");
  return expected.map((taskId) => byTask.get(taskId));
}

function normalizeTaskReceiptHistory(rawHistory) {
  const history = requireArray(rawHistory, "Task receipt history");
  const seenAttempts = new Set();
  const seenResults = new Set();
  const seenVerdicts = new Set();
  const seenEvidence = new Set();
  const normalized = history.map((rawReceipt) => {
    const receipt = requireRecord(rawReceipt, "Task receipt history row");
    const taskId = requireString(receipt.taskId, "Receipt history task ID");
    const attemptId = requireString(receipt.attemptId, "Receipt history Attempt ID");
    const resultId = requireString(receipt.resultId, "Receipt history Result ID");
    const verdictId = requireString(receipt.verdictId, "Receipt history Verdict ID");
    const evidenceId = requireString(receipt.evidenceId, "Receipt history Evidence ID");
    if (seenAttempts.has(attemptId)) fail(`Duplicate receipt history Attempt: ${attemptId}`);
    if (seenResults.has(resultId)) fail(`Duplicate receipt history Result: ${resultId}`);
    if (seenVerdicts.has(verdictId)) fail(`Duplicate receipt history Verdict: ${verdictId}`);
    if (seenEvidence.has(evidenceId)) fail(`Duplicate receipt history Evidence: ${evidenceId}`);
    seenAttempts.add(attemptId);
    seenResults.add(resultId);
    seenVerdicts.add(verdictId);
    seenEvidence.add(evidenceId);
    const testedSourceRevision = requireSha(
      receipt.testedSourceRevision,
      "Receipt history tested source revision",
    );
    const evidenceSourceRevision = requireSha(
      receipt.evidenceSourceRevision,
      "Receipt history evidence source revision",
    );
    if (testedSourceRevision !== evidenceSourceRevision) {
      fail(`Receipt history source revisions disagree: ${taskId}/${attemptId}`);
    }
    if (receipt.lifecycleStatus !== "completed") {
      fail(`Receipt history Task lifecycle must be completed: ${taskId}`);
    }
    if (receipt.attemptState !== "settled" || receipt.resultOutcome !== "succeeded") {
      fail(`Receipt history Attempt must be settled and succeeded: ${taskId}/${attemptId}`);
    }
    if (typeof receipt.current !== "boolean") fail("Receipt history current marker must be boolean");
    const environment = canonicalValue(requireRecord(receipt.environment, "Receipt history environment"));
    return {
      taskId,
      lifecycleStatus: "completed",
      attemptNumber: requireInteger(receipt.attemptNumber, "Receipt history attempt number"),
      attemptId,
      attemptState: "settled",
      resultId,
      resultOutcome: "succeeded",
      verdictId,
      verdict: requireString(receipt.verdict, "Receipt history verdict"),
      evidenceId,
      evidenceSourceRevision,
      observation: requireString(receipt.observation, "Receipt history observation"),
      testedSourceRevision,
      evidenceHash: requireSha(receipt.evidenceHash, "Receipt history evidence hash"),
      durableOutputRef: requireString(receipt.durableOutputRef, "Receipt history durable output reference"),
      environment,
      verdictRevision: requireInteger(receipt.verdictRevision, "Receipt history verdict revision"),
      current: receipt.current,
    };
  }).sort((left, right) => (
    left.taskId.localeCompare(right.taskId)
    || left.attemptNumber - right.attemptNumber
    || left.verdictRevision - right.verdictRevision
    || left.evidenceId.localeCompare(right.evidenceId)
  ));

  const expectedTasks = Array.from({ length: 6 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
  // The candidate freezes six initial Attempts plus T05's source-drift retry.
  // Later retries would be unexpected prerequisite drift, not ignorable history.
  if (normalized.length !== 7) fail("Task receipt history must contain exactly seven Attempts");
  for (const taskId of expectedTasks) {
    const taskHistory = normalized.filter((receipt) => receipt.taskId === taskId);
    const expectedAttempts = taskId === "T05" ? [1, 2] : [1];
    if (taskHistory.length !== expectedAttempts.length
      || taskHistory.some((receipt, index) => receipt.attemptNumber !== expectedAttempts[index])) {
      fail(`Task receipt history has incomplete Attempt lineage: ${taskId}`);
    }
    const current = taskHistory.filter((receipt) => receipt.current);
    if (current.length !== 1 || current[0].attemptNumber !== expectedAttempts.at(-1)
      || current[0].verdict !== "pass" || current[0].observation !== "passed") {
      fail(`Task receipt history has invalid current head: ${taskId}`);
    }
  }
  if (normalized.some((receipt) => !expectedTasks.includes(receipt.taskId))) {
    fail("Task receipt history must contain only T01-T06");
  }
  return normalized;
}

function deriveTaskReceiptHeads(history) {
  return history.filter((receipt) => receipt.current).map((receipt) => ({
    taskId: receipt.taskId,
    attemptNumber: receipt.attemptNumber,
    attemptState: receipt.attemptState,
    resultOutcome: receipt.resultOutcome,
    verdict: receipt.verdict,
    current: true,
    testedSourceRevision: receipt.testedSourceRevision,
    evidenceHash: receipt.evidenceHash,
  }));
}

function normalizeCompatibility(rawInventory) {
  const inventory = requireArray(rawInventory, "Compatibility inventory");
  const byId = new Map();
  for (const rawEntry of inventory) {
    const entry = requireRecord(rawEntry, "Compatibility entry");
    const id = requireString(entry.id, "Compatibility ID");
    if (byId.has(id)) fail(`Duplicate compatibility inventory entry: ${id}`);
    const expected = COMPATIBILITY_WITNESSES.find((witness) => witness.id === id);
    if (!expected) fail(`Compatibility inventory contains an unknown entry: ${id}`);
    if (entry.file !== expected.file) fail(`Compatibility file does not match frozen witness: ${id}`);
    if (entry.title !== expected.title) fail(`Compatibility title does not match frozen witness: ${id}`);
    if (entry.verdict !== "pass") fail(`Compatibility inventory entry must pass: ${id}`);
    byId.set(id, { ...expected, verdict: "pass" });
  }
  for (const id of COMPATIBILITY_IDS) {
    if (!byId.has(id)) fail(`Compatibility inventory is missing ${id}`);
  }
  if (byId.size !== COMPATIBILITY_IDS.length) fail("Compatibility inventory contains an unknown entry");
  return COMPATIBILITY_IDS.map((id) => byId.get(id));
}

function normalizeCommands(rawCommands) {
  const commands = requireArray(rawCommands, "Command inventory");
  const byId = new Map();
  for (const rawCommand of commands) {
    const command = requireRecord(rawCommand, "Command inventory entry");
    const id = requireString(command.id, "Command inventory ID");
    if (byId.has(id)) fail(`Duplicate command inventory entry: ${id}`);
    const expected = COMMAND_INVENTORY.find((candidate) => candidate.id === id);
    if (!expected || command.command !== expected.command) fail(`Command inventory does not match frozen command: ${id}`);
    if (command.stage !== expected.stage) fail(`Command inventory stage does not match frozen command: ${id}`);
    if (expected.stage === "observed") {
      if (command.exitCode !== 0 || command.verdict !== "pass") {
        fail(`Observed command must pass with exit code zero: ${id}`);
      }
    } else {
      if (command.verdict !== "required") fail(`Post-generation command must remain required: ${id}`);
      if (Object.hasOwn(command, "exitCode")) fail(`Post-generation command must not claim an exit code: ${id}`);
    }
    byId.set(id, { ...expected });
  }
  for (const expected of COMMAND_INVENTORY) {
    if (!byId.has(expected.id)) fail(`Command inventory is missing ${expected.id}`);
  }
  if (byId.size !== COMMAND_INVENTORY.length) fail("Command inventory contains an unknown entry");
  return COMMAND_INVENTORY.map(({ id }) => byId.get(id));
}

function requireExactGate(rawGate, expected, label) {
  const gate = requireRecord(rawGate, label);
  if (gate.passed !== expected || gate.total !== expected) fail(`${label} must be ${expected}/${expected}`);
  return { passed: expected, total: expected };
}

function normalizeNoCutover(rawNoCutover) {
  const noCutover = requireRecord(rawNoCutover, "No-cutover gate");
  return {
    structural: requireExactGate(noCutover.structural, 8, "No-cutover structural gate"),
    behavioral: requireExactGate(
      noCutover.behavioral,
      COMPATIBILITY_IDS.length,
      "No-cutover behavioral gate",
    ),
  };
}

function normalizeBlockers(rawBlockers) {
  const blockers = requireArray(rawBlockers, "Deferred cutover blockers");
  const actual = new Set(blockers.map((blocker) => requireString(blocker, "Deferred cutover blocker")));
  for (const blocker of DEFERRED_BLOCKERS) {
    if (!actual.has(blocker)) fail(`Missing deferred cutover blocker: ${blocker}`);
  }
  if (actual.size !== DEFERRED_BLOCKERS.length || actual.size !== blockers.length) {
    fail("Deferred cutover blocker inventory must match the frozen NO_GO contract");
  }
  return [...DEFERRED_BLOCKERS];
}

function observedCounts(rows) {
  return {
    envelopes: new Set(rows.map((row) => `${row.mode}/${row.transport}`)).size,
    items: rows.length,
    byMode: Object.fromEntries(MODES.map((mode) => [mode, rows.filter((row) => row.mode === mode).length])),
    byTransport: Object.fromEntries(TRANSPORTS.map((transport) => [
      transport,
      rows.filter((row) => row.transport === transport).length,
    ])),
    byClassification: Object.fromEntries(CLASSIFICATIONS.map((classification) => [
      classification,
      rows.filter((row) => row.classification === classification).length,
    ])),
  };
}

export function buildDossier(rawInput) {
  const input = requireRecord(rawInput, "Dossier input");
  rejectForbiddenInputs(input);
  rejectUnknownTopLevelKeys(input);
  if (input.recommendation !== "NO_GO") fail("Dossier recommendation must remain NO_GO");
  if (input.observationEvidencePlane !== "capstone_fixture") {
    fail("Observation evidence plane must be capstone_fixture");
  }
  if (input.canonicalHistoryEvidencePlane !== "live_project") {
    fail("Canonical history evidence plane must be live_project");
  }
  const evidenceSourceRevision = requireSha(input.evidenceSourceRevision, "Evidence source revision");
  const publicResponseHash = requireSha(input.publicResponseHash, "Public response hash");
  const sourceCapstoneEvidenceHash = requireSha(
    input.sourceCapstoneEvidenceHash,
    "Source capstone evidence hash",
  );
  const authority = requireRecord(input.authority, "Authority snapshot");
  const normalizedAuthority = {
    projectId: requireString(authority.projectId, "Authority project ID"),
    projectRevision: requireInteger(authority.projectRevision, "Authority project revision"),
    authorityEpoch: requireInteger(authority.authorityEpoch, "Authority epoch"),
  };
  const observationCoverage = normalizeObservations(input.observations, evidenceSourceRevision, publicResponseHash);
  const observationLosses = normalizeLosses(input.observationLosses);
  const dispositionProof = normalizeDispositionProof(input.dispositionProof, observationLosses);
  const repairHistory = normalizeRepairHistory(input.repairHistory);
  const liveDrift = normalizeLiveDrift(input.liveDrift);
  const taskReceiptHistory = normalizeTaskReceiptHistory(input.taskReceiptHistory);
  const taskReceiptHeads = normalizeTaskReceiptHeads(deriveTaskReceiptHeads(taskReceiptHistory));
  const declaredTaskReceiptHeads = normalizeTaskReceiptHeads(input.taskReceiptHeads);
  if (JSON.stringify(declaredTaskReceiptHeads) !== JSON.stringify(taskReceiptHeads)) {
    fail("Declared task receipt heads do not match complete receipt history");
  }
  const compatibilityInventory = normalizeCompatibility(input.compatibilityInventory);
  const commands = normalizeCommands(input.commands);
  const noCutover = normalizeNoCutover(input.noCutover);
  const authorityBaseline = requireExactGate(input.authorityBaseline, 4, "Authority baseline");
  const deferredCutoverBlockers = normalizeBlockers(input.deferredCutoverBlockers);
  const expectedCoverage = { envelopes: 12, items: 60, tuples: 60 };
  const counts = observedCounts(observationCoverage);

  const capstoneEvidence = {
    observationEvidencePlane: "capstone_fixture",
    evidenceSourceRevision,
    publicResponseHash,
    sourceCapstoneEvidenceHash,
    expectedCoverage,
    observedCounts: counts,
    observationCoverage,
    dispositionProof,
    observationLosses,
    compatibilityInventory,
    commands,
    noCutover,
    authorityBaseline,
  };
  const canonicalHistory = {
    canonicalHistoryEvidencePlane: "live_project",
    authority: normalizedAuthority,
    repairHistory,
    liveDrift,
    taskReceiptHistory,
    taskReceiptHeads,
  };
  const report = {
    schemaVersion: 1,
    milestoneId: "M003",
    sliceId: "S07",
    recommendation: "NO_GO",
    canonicalClosure: CANONICAL_CLOSURE,
    observationEvidencePlane: "capstone_fixture",
    canonicalHistoryEvidencePlane: "live_project",
    evidenceSourceRevision,
    publicResponseHash,
    sourceCapstoneEvidenceHash,
    authority: normalizedAuthority,
    expectedCoverage,
    observedCounts: counts,
    observationCoverage,
    dispositionProof,
    observationLosses,
    repairHistory,
    liveDrift,
    taskReceiptHistory,
    taskReceiptHeads,
    compatibilityInventory,
    commands,
    noCutover,
    authorityBaseline,
    deferredCutoverBlockers,
    hashes: {
      capstoneEvidenceHash: hashCanonical(capstoneEvidence),
      canonicalHistoryHash: hashCanonical(canonicalHistory),
    },
  };
  return {
    ...report,
    hashes: { ...report.hashes, dossierHash: hashCanonical(report) },
  };
}

export function renderDossier(dossier) {
  return `${JSON.stringify(canonicalValue(dossier), null, 2)}\n`;
}

function lifecyclePlaceholder(present, label) {
  if (typeof present !== "boolean") fail(`${label} lifecyclePresent must be boolean`);
  return present ? "checked-lifecycle-present" : null;
}

function inputFromDossier(rawDossier) {
  const dossier = requireRecord(rawDossier, "Checked dossier");
  if (dossier.schemaVersion !== 1 || dossier.milestoneId !== "M003" || dossier.sliceId !== "S07") {
    fail("Checked dossier identity or schema version is invalid");
  }
  const groupedObservations = new Map();
  for (const rawRow of requireArray(dossier.observationCoverage, "Checked observation coverage")) {
    const row = requireRecord(rawRow, "Checked observation row");
    const key = `${row.mode}/${row.transport}`;
    let envelope = groupedObservations.get(key);
    if (!envelope) {
      envelope = {
        mode: row.mode,
        transport: row.transport,
        sourceRevision: row.sourceRevision,
        responseHash: dossier.publicResponseHash,
        projectRevision: row.projectRevision,
        authorityEpoch: row.authorityEpoch,
        traceId: row.traceId,
        turnId: row.turnId,
        repairDisposition: row.repairDisposition,
        observationLossAccounting: row.observationLossAccounting,
        items: [],
      };
      groupedObservations.set(key, envelope);
    }
    const identity = requireRecord(row.itemIdentity, "Checked observation identity");
    envelope.items.push({
      classification: row.classification,
      itemIdentity: {
        itemKind: identity.itemKind,
        milestoneId: identity.milestoneId,
        sliceId: identity.sliceId,
        taskId: identity.taskId,
        lifecycleId: lifecyclePlaceholder(identity.lifecyclePresent, "Checked observation"),
      },
      rawLegacyStatus: row.rawLegacyStatus,
      rawCanonicalStatus: row.rawCanonicalStatus,
      normalizedLegacyStatus: row.normalizedLegacyStatus,
      normalizedCanonicalStatus: row.normalizedCanonicalStatus,
    });
  }

  return {
    recommendation: dossier.recommendation,
    observationEvidencePlane: dossier.observationEvidencePlane,
    canonicalHistoryEvidencePlane: dossier.canonicalHistoryEvidencePlane,
    evidenceSourceRevision: dossier.evidenceSourceRevision,
    publicResponseHash: dossier.publicResponseHash,
    sourceCapstoneEvidenceHash: dossier.sourceCapstoneEvidenceHash,
    authority: dossier.authority,
    observations: [...groupedObservations.values()],
    dispositionProof: dossier.dispositionProof,
    observationLosses: dossier.observationLosses,
    repairHistory: requireRecord(dossier.repairHistory, "Checked repair history").rows,
    liveDrift: requireArray(dossier.liveDrift, "Checked live drift").map((rawRow) => {
      const row = requireRecord(rawRow, "Checked live drift row");
      return {
        lifecycleId: row.lifecycleId,
        itemKind: row.itemKind,
        milestoneId: row.milestoneId,
        sliceId: row.sliceId,
        taskId: row.taskId,
        legacyStatus: row.rawLegacyStatus,
        canonicalStatus: row.rawCanonicalStatus,
        classification: row.classification,
      };
    }),
    taskReceiptHistory: dossier.taskReceiptHistory,
    taskReceiptHeads: dossier.taskReceiptHeads,
    compatibilityInventory: dossier.compatibilityInventory,
    commands: dossier.commands,
    noCutover: dossier.noCutover,
    authorityBaseline: dossier.authorityBaseline,
    deferredCutoverBlockers: dossier.deferredCutoverBlockers,
  };
}

export function validateDossier(rawDossier) {
  rejectForbiddenInputs(rawDossier, "checked dossier");
  const rebuilt = buildDossier(inputFromDossier(rawDossier));
  if (renderDossier(rawDossier) !== renderDossier(rebuilt)) {
    fail("Checked normalized dossier or hash does not match reconstructed evidence");
  }
  return rebuilt;
}

export function parseArgs(argv = process.argv.slice(2)) {
  let inputPath = null;
  let outputPath = DEFAULT_OUTPUT;
  let outputSpecified = false;
  let check = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--input requires a local path");
      if (/:\/\//.test(value) || /^git@/i.test(value)) fail("--input must be a local path");
      if (inputPath !== null) fail("--input may only be provided once");
      inputPath = value;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--output requires a local path");
      if (/:\/\//.test(value) || /^git@/i.test(value)) fail("--output must be a local path");
      if (outputSpecified) fail("--output may only be provided once");
      outputPath = value;
      outputSpecified = true;
      index += 1;
      continue;
    }
    if (argument === "--check") {
      if (check) fail("--check may only be provided once");
      check = true;
      continue;
    }
    if (argument === "--json") {
      if (json) fail("--json may only be provided once");
      json = true;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (check && inputPath !== null) fail("--check cannot be combined with --input");
  if (check && outputSpecified) fail("--output is only valid for generate mode");
  if (check) return { mode: "check", inputPath: null, outputPath: DEFAULT_OUTPUT, json };
  if (!inputPath) fail("--input requires a local path");
  return { mode: "generate", inputPath, outputPath, json };
}

const defaultIo = {
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text),
  writeStdout: (text) => process.stdout.write(text),
};

export function runDossierCli(argv = process.argv.slice(2), io = defaultIo) {
  const args = parseArgs(argv);
  if (args.mode === "check") {
    const checkedBytes = io.readText(args.outputPath);
    const dossier = validateDossier(JSON.parse(checkedBytes));
    if (checkedBytes !== renderDossier(dossier)) {
      fail("Checked dossier bytes are stale or non-canonical");
    }
    io.writeStdout(args.json
      ? renderDossier(dossier)
      : `M003/S07 dossier valid: ${dossier.hashes.dossierHash}\n`);
    return dossier;
  }

  const input = JSON.parse(io.readText(resolve(args.inputPath)));
  const dossier = validateDossier(buildDossier(input));
  const rendered = renderDossier(dossier);
  const explicitOutput = argv.includes("--output");
  if (explicitOutput || !args.json) io.writeText(resolve(args.outputPath), rendered);
  if (args.json) io.writeStdout(rendered);
  else io.writeStdout(`M003/S07 dossier written: ${args.outputPath}\n`);
  return dossier;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runDossierCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
