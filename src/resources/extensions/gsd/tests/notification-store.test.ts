// GSD Extension — Notification Store Tests

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initNotificationStore,
  appendNotification,
  readNotifications,
  markAllRead,
  clearNotifications,
  getUnreadCount,
  getLineCount,
  suppressPersistence,
  unsuppressPersistence,
  onNotificationStoreChange,
  _resetNotificationStore,
} from "../notification-store.js";
import { resolveNotificationStoreBasePath } from "../bootstrap/register-hooks.js";

describe("notification-store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-notif-test-"));
    mkdirSync(join(tmp, ".gsd"), { recursive: true });
    _resetNotificationStore();
  });

  afterEach(() => {
    _resetNotificationStore();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appendNotification creates file and writes entry", () => {
    initNotificationStore(tmp);
    appendNotification("test message", "info");

    const filePath = join(tmp, ".gsd", "notifications.jsonl");
    assert.ok(existsSync(filePath));

    const content = readFileSync(filePath, "utf-8").trim();
    const entry = JSON.parse(content);
    assert.equal(entry.message, "test message");
    assert.equal(entry.severity, "info");
    assert.equal(entry.source, "notify");
    assert.equal(entry.read, false);
    assert.ok(entry.id);
    assert.ok(entry.ts);
  });

  test("readNotifications returns newest-first", () => {
    initNotificationStore(tmp);
    appendNotification("first", "info");
    appendNotification("second", "warning");
    appendNotification("third", "error");

    const entries = readNotifications();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].message, "third");
    assert.equal(entries[1].message, "second");
    assert.equal(entries[2].message, "first");
  });

  test("getUnreadCount tracks appends", () => {
    initNotificationStore(tmp);
    assert.equal(getUnreadCount(), 0);

    appendNotification("msg1", "info");
    assert.equal(getUnreadCount(), 1);

    appendNotification("msg2", "warning");
    assert.equal(getUnreadCount(), 2);
  });

  test("markAllRead sets all entries to read", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");
    appendNotification("msg2", "warning");

    assert.equal(getUnreadCount(), 2);

    markAllRead();

    assert.equal(getUnreadCount(), 0);

    const entries = readNotifications();
    assert.ok(entries.every((e) => e.read === true));
  });

  test("clearNotifications empties the file", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");
    appendNotification("msg2", "error");

    assert.equal(getLineCount(), 2);

    clearNotifications();

    assert.equal(getLineCount(), 0);
    assert.equal(getUnreadCount(), 0);
    assert.equal(readNotifications().length, 0);
  });

  test("rotation keeps only 500 entries", () => {
    initNotificationStore(tmp);

    for (let i = 0; i < 510; i++) {
      appendNotification(`msg-${i}`, "info");
    }

    const entries = readNotifications();
    assert.ok(entries.length <= 500, `Expected <= 500 entries, got ${entries.length}`);
    // Most recent should be msg-509
    assert.equal(entries[0].message, "msg-509");
  });

  test("source field is preserved", () => {
    initNotificationStore(tmp);
    appendNotification("from notify", "info", "notify");
    appendNotification("from logger", "warning", "workflow-logger");

    const entries = readNotifications();
    assert.equal(entries[0].source, "workflow-logger");
    assert.equal(entries[1].source, "notify");
  });

  test("messages are truncated at 500 chars", () => {
    initNotificationStore(tmp);
    const longMsg = "x".repeat(600);
    appendNotification(longMsg, "info");

    const entries = readNotifications();
    assert.ok(entries[0].message.length <= 501); // 500 + "…"
    assert.ok(entries[0].message.endsWith("…"));
  });

  test("readNotifications with explicit basePath works", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");

    // Read with explicit basePath
    _resetNotificationStore();
    const entries = readNotifications(tmp);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "msg1");
  });

  test("init seeds counters from existing file", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");
    appendNotification("msg2", "warning");

    // Reset and re-init — should seed from disk
    _resetNotificationStore();
    initNotificationStore(tmp);

    assert.equal(getLineCount(), 2);
    assert.equal(getUnreadCount(), 2);
  });

  test("no-op when store not initialized", () => {
    // Should not throw
    appendNotification("msg", "info");
    assert.equal(readNotifications().length, 0);
    assert.equal(getUnreadCount(), 0);
  });

  test("suppressPersistence prevents writes", () => {
    initNotificationStore(tmp);
    appendNotification("before", "info");
    assert.equal(getLineCount(), 1);

    suppressPersistence();
    appendNotification("suppressed", "info");
    assert.equal(getLineCount(), 1); // still 1

    unsuppressPersistence();
    appendNotification("after", "info");
    assert.equal(getLineCount(), 2); // now 2

    const entries = readNotifications();
    assert.equal(entries[0].message, "after");
    assert.equal(entries[1].message, "before");
    // "suppressed" should not appear
    assert.ok(!entries.some((e) => e.message === "suppressed"));
  });

  test("appendNotification suppresses identical messages within the dedup window", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);

    appendNotification("same", "warning");
    now += 1_000;
    appendNotification("same", "warning");
    now += 31_000;
    appendNotification("same", "warning");

    const entries = readNotifications();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message, "same");
    assert.equal(entries[1].message, "same");
  });

  test("occurrence identity: same occurrence dedups, a new occurrence is never suppressed (#2935)", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const meta = (attempt: number) => ({
      kind: "uat-needs-human",
      scope: "M1/S1",
      occurrence: { milestone: "M1", slice: "S1", uatAttempt: attempt },
    });

    // Same occurrence, rephrased text, inside the window: one row.
    appendNotification("UAT needs human (first wording)", "warning", "notify", meta(1));
    now += 1_000;
    appendNotification("UAT needs human (rephrased)", "warning", "notify", meta(1));
    // A new UAT attempt on the same slice, same kind and scope, inside the
    // window: it is a different occurrence and must NOT be suppressed.
    now += 1_000;
    appendNotification("UAT needs human (attempt 2)", "warning", "notify", meta(2));

    const entries = readNotifications();
    assert.equal(entries.length, 2, "same occurrence dedups; new attempt is kept");
  });

  test("without occurrence identity, prose and time window dedup stays as before (#2935 compat)", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    appendNotification("same", "warning");
    now += 1_000;
    appendNotification("same", "warning");
    assert.equal(readNotifications().length, 1);
  });

  test("occurrence dedup survives the 30 s window (not time-pruned) (#2935 review)", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const occ = { milestone: "M1", slice: "S1", uatAttempt: 1 };
    appendNotification("A", "warning", "notify", { kind: "uat-needs-human", scope: "M1/S1", occurrence: occ });
    // Advance beyond the legacy window and churn the legacy map past its prune threshold.
    now += 60_000;
    for (let i = 0; i < 250; i++) {
      appendNotification(`noise ${i}`, "info", "notify", { kind: "x", scope: `s${i}`, occurrence: { n: i } });
    }
    // Same occurrence again: must still collapse, because occurrence is not time-based.
    appendNotification("A again", "warning", "notify", { kind: "uat-needs-human", scope: "M1/S1", occurrence: occ });
    const aRows = readNotifications().filter((e) => e.message.startsWith("A"));
    assert.equal(aRows.length, 1, "occurrence A must not be re-admitted after the window");
  });

  test("clearNotifications resets occurrence dedup so a cleared store can receive the same occurrence (#2935 review)", () => {
    initNotificationStore(tmp);
    const occ = { milestone: "M1", slice: "S1", uatAttempt: 1 };
    appendNotification("first", "warning", "notify", { kind: "uat-needs-human", scope: "M1/S1", occurrence: occ });
    clearNotifications();
    appendNotification("after clear", "warning", "notify", { kind: "uat-needs-human", scope: "M1/S1", occurrence: occ });
    assert.equal(readNotifications().length, 1, "store must not stay empty after clear");
  });

  test("suppressPersistence is ref-counted", () => {
    initNotificationStore(tmp);
    suppressPersistence();
    suppressPersistence();
    unsuppressPersistence();
    // Still suppressed (one suppress remaining)
    appendNotification("still suppressed", "info");
    assert.equal(getLineCount(), 0);

    unsuppressPersistence();
    appendNotification("now works", "info");
    assert.equal(getLineCount(), 1);
  });

  test("reinit switches to new project path", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "gsd-notif-test2-"));
    mkdirSync(join(tmp2, ".gsd"), { recursive: true });

    initNotificationStore(tmp);
    appendNotification("project1", "info");

    // Switch to new project
    initNotificationStore(tmp2);
    appendNotification("project2", "info");

    // project2 should only have its own entry
    const entries = readNotifications();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "project2");

    // project1 should still have its entry
    const p1Entries = readNotifications(tmp);
    assert.equal(p1Entries.length, 1);
    assert.equal(p1Entries[0].message, "project1");

    rmSync(tmp2, { recursive: true, force: true });
  });

  test("session notification base resolves auto-worktree paths to project root", () => {
    const worktreePath = join(tmp, ".gsd", "worktrees", "M001");
    mkdirSync(worktreePath, { recursive: true });

    assert.equal(resolveNotificationStoreBasePath(worktreePath), tmp);
  });

  test("counters resync from disk after markAllRead", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");
    appendNotification("msg2", "info");
    assert.equal(getUnreadCount(), 2);
    assert.equal(getLineCount(), 2);

    markAllRead();
    assert.equal(getUnreadCount(), 0);
    assert.equal(getLineCount(), 2); // entries still exist, just marked read
  });

  test("counters resync from disk after clearNotifications", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");
    appendNotification("msg2", "info");

    clearNotifications();
    assert.equal(getUnreadCount(), 0);
    assert.equal(getLineCount(), 0);
  });

  test("markAllRead does not delete a foreign lock file", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");

    // Simulate another process holding the lock
    const lockPath = join(tmp, ".gsd", "notifications.lock");
    writeFileSync(lockPath, String(Date.now()), "utf-8");

    // markAllRead should still work (best-effort) but not delete the foreign lock
    markAllRead();

    assert.ok(existsSync(lockPath), "foreign lock file should not be deleted");

    // Clean up the lock so afterEach doesn't leave artifacts
    rmSync(lockPath, { force: true });
  });

  test("clearNotifications does not delete a foreign lock file", () => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");

    // Simulate another process holding the lock
    const lockPath = join(tmp, ".gsd", "notifications.lock");
    writeFileSync(lockPath, String(Date.now()), "utf-8");

    // clearNotifications should still work but not delete the foreign lock
    clearNotifications();

    assert.ok(existsSync(lockPath), "foreign lock file should not be deleted");

    rmSync(lockPath, { force: true });
  });

  test("markAllRead does not busy-spin when a foreign lock is held", (t) => {
    initNotificationStore(tmp);
    appendNotification("msg1", "info");

    const lockPath = join(tmp, ".gsd", "notifications.lock");
    writeFileSync(lockPath, "1000", "utf-8");

    let now = 1001;
    let calls = 0;
    t.mock.method(Date, "now", () => {
      calls++;
      return now++;
    });

    markAllRead();

    assert.ok(calls <= 2, `expected no retry spin, got ${calls} Date.now calls`);
    assert.ok(existsSync(lockPath), "foreign lock file should not be deleted");
    assert.equal(getUnreadCount(), 0, "best-effort mutation should still run");

    rmSync(lockPath, { force: true });
  });

  test("structured meta persists kind and scope on the entry", () => {
    initNotificationStore(tmp);
    appendNotification("Auto-mode blocked — validation gate", "warning", "notify", { kind: "auto-stop", scope: "M005" });

    const entries = readNotifications();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "auto-stop");
    assert.equal(entries[0].scope, "M005");
  });

  test("dedup keys on kind+scope when present, not on prose", () => {
    initNotificationStore(tmp);
    appendNotification("Auto-mode blocked — validation gate", "warning", "notify", { kind: "auto-stop", scope: "M005" });
    // Rephrased message, same structured identity → deduped within the window
    appendNotification("Auto-mode blocked — gate rejected", "warning", "notify", { kind: "auto-stop", scope: "M005" });
    // Same kind, different scope → distinct
    appendNotification("Auto-mode blocked — validation gate", "warning", "notify", { kind: "auto-stop", scope: "M006" });

    assert.equal(readNotifications().length, 2);
  });

  test("readNotifications filters by kind and scope", () => {
    initNotificationStore(tmp);
    appendNotification("a", "info", "notify", { kind: "auto-stop", scope: "M005" });
    appendNotification("b", "info", "notify", { kind: "provider-error-pause", scope: "M005" });
    appendNotification("c", "info");

    assert.equal(readNotifications(tmp, { kind: "auto-stop" }).length, 1);
    assert.equal(readNotifications(tmp, { scope: "M005" }).length, 2);
    assert.equal(readNotifications(tmp, { kind: "provider-error-pause", scope: "M005" })[0].message, "b");
  });

  test("listeners are notified on append, markAllRead, and clear", () => {
    initNotificationStore(tmp);
    let calls = 0;
    const unsubscribe = onNotificationStoreChange(() => { calls++; });

    appendNotification("msg1", "info");
    assert.equal(calls, 1, "append should emit one change");

    markAllRead();
    assert.equal(calls, 2, "markAllRead should emit one change when state changes");

    clearNotifications();
    assert.equal(calls, 3, "clear should emit one change");

    unsubscribe();
  });
});
