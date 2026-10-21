// gsd-pi UOK Audit Sink Tests
//
// Dedicated coverage for `uok/audit.ts` — the structured audit-event sink that
// every workflow-logger / journal / metrics path funnels through when the
// unified-audit toggle is on. The contract test (`uok-contracts.test.ts`)
// exercises the happy DB+jsonl path and timeline precedence, but none of the
// four error/control branches below:
//   1. stale-turn write drop          (isStaleWrite early return)
//   2. validation failure throw        (malformed envelope)
//   3. DB authoritative write failure  (re-throw to caller)
//   4. jsonl projection swallow        (best-effort, never throws)
// These tests pin each branch so regressions surface as clear failures.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEventEnvelope } from "../uok/contracts.ts";
import { CURRENT_UOK_CONTRACT_VERSION } from "../uok/contracts.ts";
import {
  buildAuditEnvelope,
  emitLifecycleShadowObservation,
  emitUokAuditEvent,
} from "../uok/audit.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";
import {
  bumpTurnGeneration,
  runWithTurnGeneration,
  _resetTurnEpoch,
} from "../auto/turn-epoch.ts";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function auditEventsPath(basePath: string): string {
  return join(basePath, ".gsd", "audit", "events.jsonl");
}

function readAuditEvents(basePath: string): AuditEventEnvelope[] {
  const path = auditEventsPath(basePath);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as AuditEventEnvelope);
}

function makeBasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-uok-audit-sink-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function validEnvelope(overrides: Partial<AuditEventEnvelope> = {}): AuditEventEnvelope {
  return buildAuditEnvelope({
    traceId: "trace-sink",
    turnId: "turn-sink",
    category: "orchestration",
    type: "audit-sink-test",
    payload: {},
    ...overrides,
  });
}

test("buildAuditEnvelope stamps version, eventId, and ts", () => {
  const event = buildAuditEnvelope({
    traceId: "trace-1",
    category: "orchestration",
    type: "turn-start",
    payload: { unitType: "execute-task" },
  });

  assert.equal(event.version, CURRENT_UOK_CONTRACT_VERSION);
  assert.equal(typeof event.eventId, "string");
  assert.ok(event.eventId.length > 0, "eventId must be populated");
  assert.equal(event.traceId, "trace-1");
  assert.equal(event.turnId, undefined, "turnId is optional and omitted");
  assert.equal(event.causedBy, undefined, "causedBy is optional and omitted");
  assert.equal(event.category, "orchestration");
  assert.equal(event.type, "turn-start");
  assert.deepEqual(event.payload, { unitType: "execute-task" });
  assert.match(event.ts, ISO_RE);
});

test("buildAuditEnvelope defaults payload to empty object when omitted", () => {
  const event = buildAuditEnvelope({
    traceId: "trace-2",
    category: "orchestration",
    type: "minimal",
  });
  assert.deepEqual(event.payload, {});
});

test("buildAuditEnvelope mints a unique eventId per call", () => {
  const a = buildAuditEnvelope({ traceId: "t", category: "orchestration", type: "x" });
  const b = buildAuditEnvelope({ traceId: "t", category: "orchestration", type: "x" });
  assert.notEqual(a.eventId, b.eventId, "each call must mint a fresh eventId");
});

test("emitUokAuditEvent writes the jsonl projection when DB is unavailable", () => {
  const basePath = makeBasePath();
  try {
    // No openDatabase() call → isDbAvailable() is false → DB branch skipped,
    // envelope lands only in the jsonl projection.
    emitUokAuditEvent(basePath, validEnvelope({ traceId: "trace-jsonl-only" }));

    const events = readAuditEvents(basePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].traceId, "trace-jsonl-only");
    assert.equal(events[0].category, "orchestration");
    assert.equal(events[0].type, "audit-sink-test");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("emitUokAuditEvent drops the write when the turn is stale", () => {
  _resetTurnEpoch();
  const basePath = makeBasePath();
  try {
    // Capture generation 0, then bump to 1 so the captured turn is superseded.
    bumpTurnGeneration("test: simulate timeout recovery");
    const emitted = runWithTurnGeneration(0, () => {
      emitUokAuditEvent(basePath, validEnvelope({ traceId: "trace-stale" }));
      return true;
    });

    assert.equal(emitted, true, "emit must return without throwing on a stale turn");
    assert.equal(existsSync(auditEventsPath(basePath)), false, "stale write must not create the projection");
    assert.equal(readAuditEvents(basePath).length, 0, "stale write must not persist anything");
  } finally {
    _resetTurnEpoch();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("emitUokAuditEvent throws on an invalid envelope", () => {
  const basePath = makeBasePath();
  try {
    // Missing required string fields (traceId/category/type) → validator reports issues.
    const invalid = {
      version: CURRENT_UOK_CONTRACT_VERSION,
      eventId: "evt-bad",
      ts: new Date().toISOString(),
      payload: {},
    } as unknown as AuditEventEnvelope;

    assert.throws(
      () => emitUokAuditEvent(basePath, invalid),
      /Invalid UOK audit event:.*traceId/u,
      "validation failure must throw with the offending field path",
    );
    assert.equal(readAuditEvents(basePath).length, 0, "invalid event must not be persisted");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("emitUokAuditEvent re-throws when the authoritative DB write fails", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true, "DB must open for this scenario");
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  // Break the authoritative sink: drop the audit_events table so the prepared
  // INSERT inside insertAuditEvent throws. This proves the DB failure surfaces
  // to the caller as a wrapped error rather than being silently swallowed.
  _getAdapter()!.exec("DROP TABLE audit_events");

  assert.throws(
    () => emitUokAuditEvent(basePath, validEnvelope({ traceId: "trace-db-fail" })),
    /DB authoritative audit write failed/u,
    "a failed authoritative DB write must re-throw to the caller",
  );
});

test("emitUokAuditEvent swallows jsonl projection failures (best-effort)", (t) => {
  const basePath = makeBasePath();
  t.after(() => rmSync(basePath, { recursive: true, force: true }));

  // Point the envelope at a path whose parent directory cannot be created:
  // gsdRoot() resolves under basePath, so a basePath whose .gsd is a regular
  // file makes mkdirSync(audit/) throw — exercising the silent catch.
  // We pre-create .gsd as a file so ensureAuditDir()'s recursive mkdir fails.
  rmSync(join(basePath, ".gsd"), { recursive: true, force: true });
  writeFileSync(join(basePath, ".gsd"), "not-a-directory");

  // With no DB open and an unwritable projection path, emit must NOT throw —
  // audit writes are explicitly best-effort and must never break orchestration.
  assert.doesNotThrow(() => {
    emitUokAuditEvent(basePath, validEnvelope({ traceId: "trace-swallow" }));
  }, "jsonl projection failure must be swallowed, not propagated");
});

test("mandatory lifecycle-shadow observation falls back to explicit JSONL loss accounting", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  _getAdapter()!.exec("DROP TABLE audit_events");
  const attemptedObservation = {
    milestoneId: "M001",
    items: [],
    mode: "legacy" as const,
    transport: "native_pi" as const,
    sourceRevision: "unavailable",
    projectRevision: 7,
    authorityEpoch: 3,
    traceId: null,
    turnId: null,
    repairDisposition: "not_attempted" as const,
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
  };

  assert.doesNotThrow(() => emitLifecycleShadowObservation(basePath, attemptedObservation));

  const events = readAuditEvents(basePath);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "lifecycle-shadow-observation-loss");
  assert.equal(events[0].category, "execution");
  assert.deepEqual(events[0].payload, {
    ...attemptedObservation,
    observationLossAccounting: {
      lossCount: 1,
      persistedCount: 0,
      reason: "primary_sink_failed",
      errorHash: (events[0].payload as any).observationLossAccounting.errorHash,
    },
  });
  assert.match(
    (events[0].payload as any).observationLossAccounting.errorHash,
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("mandatory observation retains query and primary-sink loss causes", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  _getAdapter()!.exec("DROP TABLE audit_events");
  emitLifecycleShadowObservation(basePath, {
    milestoneId: "M001",
    items: [],
    mode: "legacy",
    transport: "native_pi",
    sourceRevision: "unavailable",
    projectRevision: 0,
    authorityEpoch: 0,
    traceId: null,
    turnId: null,
    repairDisposition: "not_attempted",
    reason: "shadow_query_failed",
    observationLossAccounting: {
      lossCount: 1,
      persistedCount: 1,
      reason: "shadow_query_failed",
      errorHash: "sha256:query",
    },
  });

  const accounting = (readAuditEvents(basePath)[0].payload as any).observationLossAccounting;
  assert.equal(accounting.lossCount, 2);
  assert.equal(accounting.persistedCount, 0);
  assert.deepEqual(accounting.causes, [
    { reason: "shadow_query_failed", errorHash: "sha256:query" },
    { reason: "primary_sink_failed", errorHash: accounting.errorHash },
  ]);
});

test("mandatory observation spools a retry record when DB and audit JSONL both fail", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  _getAdapter()!.exec("DROP TABLE audit_events");
  writeFileSync(join(basePath, ".gsd", "audit"), "obstructed", "utf-8");
  emitLifecycleShadowObservation(basePath, {
    milestoneId: "M001",
    items: [],
    mode: "legacy",
    transport: "native_pi",
    sourceRevision: "unavailable",
    projectRevision: 1,
    authorityEpoch: 1,
    traceId: null,
    turnId: null,
    repairDisposition: "not_attempted",
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
  });

  const spoolPath = join(basePath, ".gsd", "runtime", "lifecycle-shadow-observation-loss.jsonl");
  const spooled = JSON.parse(readFileSync(spoolPath, "utf-8").trim());
  assert.equal(spooled.type, "lifecycle-shadow-observation-loss");
  assert.equal(spooled.payload.observationLossAccounting.lossCount, 1);
  assert.equal(spooled.payload.observationLossAccounting.persistedCount, 0);
});

test("mandatory observation records projection sink failure in the authoritative DB", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  writeFileSync(join(basePath, ".gsd", "audit"), "obstructed", "utf-8");
  emitLifecycleShadowObservation(basePath, {
    milestoneId: "M001",
    items: [],
    mode: "legacy",
    transport: "native_pi",
    sourceRevision: "unavailable",
    projectRevision: 1,
    authorityEpoch: 1,
    traceId: null,
    turnId: null,
    repairDisposition: "not_attempted",
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
  });

  const loss = _getAdapter()!.prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observation-loss'
  `).get();
  assert.ok(loss);
  const accounting = JSON.parse(String(loss["payload_json"])).observationLossAccounting;
  assert.equal(accounting.lossCount, 1);
  assert.equal(accounting.persistedCount, 1);
  assert.equal(accounting.reason, "projection_sink_failed");
  assert.equal(accounting.causes[0].reason, "projection_sink_failed");
});

test("mandatory observation uses the emergency journal when DB, audit, and spool fail", (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });

  _getAdapter()!.exec("DROP TABLE audit_events");
  writeFileSync(join(basePath, ".gsd", "audit"), "obstructed", "utf-8");
  writeFileSync(join(basePath, ".gsd", "runtime"), "obstructed", "utf-8");
  emitLifecycleShadowObservation(basePath, {
    milestoneId: "M001",
    items: [],
    mode: "legacy",
    transport: "native_pi",
    sourceRevision: "unavailable",
    projectRevision: 1,
    authorityEpoch: 1,
    traceId: null,
    turnId: null,
    repairDisposition: "not_attempted",
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
  });

  const emergencyPath = join(basePath, ".gsd", "lifecycle-shadow-observation-loss.jsonl");
  const emergency = JSON.parse(readFileSync(emergencyPath, "utf-8").trim());
  assert.equal(emergency.type, "lifecycle-shadow-observation-loss");
  assert.equal(emergency.payload.observationLossAccounting.lossCount, 1);
  assert.equal(emergency.payload.observationLossAccounting.persistedCount, 0);
});
