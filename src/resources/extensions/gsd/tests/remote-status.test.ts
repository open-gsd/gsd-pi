import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { createPromptRecord, writePromptRecord } from "../../remote-questions/mod.js";
import { getLatestPromptSummary } from "../../remote-questions/mod.js";

// Prompt records are rows of the project database.
beforeEach(() => {
  assert.equal(openDatabase(":memory:"), true);
});

afterEach(() => {
  closeDatabase();
});

test("getLatestPromptSummary returns latest stored prompt", () => {
  const recordA = createPromptRecord({
    id: "a-prompt",
    channel: "slack",
    createdAt: 1,
    timeoutAt: 10,
    pollIntervalMs: 5000,
    questions: [],
  });
  recordA.updatedAt = 1;
  writePromptRecord(recordA);

  const recordB = createPromptRecord({
    id: "z-prompt",
    channel: "discord",
    createdAt: 2,
    timeoutAt: 10,
    pollIntervalMs: 5000,
    questions: [],
  });
  recordB.updatedAt = 2;
  recordB.status = "answered";
  writePromptRecord(recordB);

  const latest = getLatestPromptSummary();
  assert.equal(latest?.id, "z-prompt");
  assert.equal(latest?.status, "answered");
});

test("getLatestPromptSummary sorts by updatedAt, not by id", () => {
  // Record with alphabetically-LAST id but OLDEST timestamp
  const old = createPromptRecord({
    id: "zzz-oldest",
    channel: "slack",
    createdAt: 1000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  old.updatedAt = 1000;
  writePromptRecord(old);

  // Record with alphabetically-FIRST id but NEWEST timestamp
  const newest = createPromptRecord({
    id: "aaa-newest",
    channel: "discord",
    createdAt: 3000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  newest.updatedAt = 3000;
  newest.status = "answered";
  writePromptRecord(newest);

  // Record in between
  const middle = createPromptRecord({
    id: "mmm-middle",
    channel: "slack",
    createdAt: 2000,
    timeoutAt: 9999,
    pollIntervalMs: 5000,
    questions: [],
  });
  middle.updatedAt = 2000;
  writePromptRecord(middle);

  const latest = getLatestPromptSummary();
  // Should return "aaa-newest" (updatedAt=3000), NOT "zzz-oldest" (alphabetically last)
  assert.equal(latest?.id, "aaa-newest", "should pick the most recently updated prompt, not the alphabetically last id");
  assert.equal(latest?.status, "answered");
  assert.equal(latest?.updatedAt, 3000);
});

test("getLatestPromptSummary returns null when no project database is open", () => {
  closeDatabase();
  assert.equal(getLatestPromptSummary(), null);
  assert.equal(openDatabase(":memory:"), true);
});
