// Regression: complete-slice reopen/replan handoff must not artifact-retry (#183)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  decideVerificationRetry,
  hashVerificationFailureContext,
} from "../auto/verification-retry-policy.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function makePostUnitContext(base: string, s: AutoSession, notifications: string[]) {
  return {
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: {} as any,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };
}

test("complete-slice with gsd_task_reopen handoff continues instead of artifact-retrying", async () => {
  const base = makeTempRepo("gsd-complete-slice-reopen-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const retryKey = "complete-slice:M001/S01";
    s.verificationRetryCount.set(retryKey, 2);
    s.pendingVerificationRetry = {
      unitId: "M001/S01",
      failureContext: "Missing expected artifact (attempt 2/3).",
      attempt: 2,
    };

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      makePostUnitContext(base, s, notifications),
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "gsd_task_reopen", arguments: { taskId: "T01" } }],
          },
        ],
      },
    );

    assert.equal(result, "continue");
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.has(retryKey), false);
    assert.ok(
      notifications.some((message) => message.includes("handed off via reopen/replan")),
      `expected handoff notification, got: ${notifications.join("\n")}`,
    );
  } finally {
    cleanup(base);
  }
});

test("complete-slice text mentioning gsd_task_reopen does not count as a handoff", async () => {
  const base = makeTempRepo("gsd-complete-slice-reopen-text-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      makePostUnitContext(base, s, notifications),
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: "I should call gsd_task_reopen for T01, then stop.",
          },
        ],
      },
    );

    assert.equal(result, "continue");
    assert.equal(s.pendingVerificationRetry, null);
    assert.ok(
      notifications.every((message) => !message.includes("handed off via reopen/replan")),
      `plain text must not be treated as handoff, got: ${notifications.join("\n")}`,
    );
    assert.ok(
      notifications.some((message) => message.includes("DB unavailable")),
      `expected DB-unavailable fallback, got: ${notifications.join("\n")}`,
    );
  } finally {
    cleanup(base);
  }
});

test("complete-slice with gsd_replan_slice tool result continues instead of artifact-retrying", async () => {
  const base = makeTempRepo("gsd-complete-slice-replan-");
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-REPLAN.md"), "# Replan\n");

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const retryKey = "complete-slice:M001/S01";
    s.verificationRetryCount.set(retryKey, 1);

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      makePostUnitContext(base, s, notifications),
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "toolResult",
            toolName: "gsd_replan_slice",
            isError: false,
            content: "Slice replanned with reopened task T02.",
          },
        ],
      },
    );

    assert.equal(result, "continue");
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.has(retryKey), false);
    assert.ok(
      notifications.some((message) => message.includes("valid replan outcome")),
      `expected handoff notification, got: ${notifications.join("\n")}`,
    );
  } finally {
    cleanup(base);
  }
});

test("complete-slice text mentioning gsd_replan_slice does not count as a valid replan outcome", async () => {
  const base = makeTempRepo("gsd-complete-slice-replan-text-");
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-REPLAN.md"), "# Replan\n");

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      makePostUnitContext(base, s, notifications),
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: "I will use gsd_replan_slice and let execution follow up.",
          },
        ],
      },
    );

    assert.equal(result, "continue");
    assert.equal(s.pendingVerificationRetry, null);
    assert.ok(
      notifications.every((message) => !message.includes("valid replan outcome")),
      `plain text must not be treated as replan outcome, got: ${notifications.join("\n")}`,
    );
    assert.ok(
      notifications.some((message) => message.includes("DB unavailable")),
      `expected DB-unavailable fallback, got: ${notifications.join("\n")}`,
    );
  } finally {
    cleanup(base);
  }
});

test("complete-slice with gsd_replan_slice but no REPLAN artifact retries", async () => {
  const base = makeTempRepo("gsd-complete-slice-replan-missing-artifact-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const notifications: string[] = [];
    const result = await postUnitPreVerification(
      makePostUnitContext(base, s, notifications),
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "toolResult",
            toolName: "gsd_replan_slice",
            isError: false,
            content: "Slice replanned with reopened task T02.",
          },
        ],
      },
    );

    assert.equal(result, "retry");
    assert.ok(s.pendingVerificationRetry);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01");
  } finally {
    cleanup(base);
  }
});

test("artifact retry context stays stable across attempts while notifications show attempt count", async () => {
  const base = makeTempRepo("gsd-artifact-retry-stable-context-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

    const notifications: string[] = [];
    const pctx = makePostUnitContext(base, s, notifications);
    const opts = {
      skipSettleDelay: true,
      skipWorktreeSync: true,
      agentEndMessages: [
        {
          role: "toolResult",
          toolName: "gsd_replan_slice",
          isError: false,
          content: "Slice replanned with reopened task T02.",
        },
      ],
    };

    assert.equal(await postUnitPreVerification(pctx, opts), "retry");
    const firstRetry = s.pendingVerificationRetry;
    assert.ok(firstRetry);
    assert.equal(firstRetry.attempt, 1);
    assert.doesNotMatch(firstRetry.failureContext, /\(attempt \d\/3\)\.$/);
    const firstFailureHash = hashVerificationFailureContext(firstRetry.failureContext);

    assert.equal(await postUnitPreVerification(pctx, opts), "retry");
    const secondRetry = s.pendingVerificationRetry;
    assert.ok(secondRetry);
    assert.equal(secondRetry.attempt, 2);
    assert.equal(secondRetry.failureContext, firstRetry.failureContext);
    assert.equal(hashVerificationFailureContext(secondRetry.failureContext), firstFailureHash);
    assert.deepEqual(
      decideVerificationRetry({
        unitType: s.currentUnit.type,
        retryInfo: secondRetry,
        previousFailureHash: firstFailureHash,
        random: () => 0.5,
      }),
      {
        action: "pause",
        reason: "duplicate-failure-context",
        key: "complete-slice:M001/S01",
        failureHash: firstFailureHash,
      },
    );
    assert.ok(
      notifications.some((message) => message.includes("Retrying (attempt 1/3).")),
      `expected first attempt notification, got: ${notifications.join("\n")}`,
    );
    assert.ok(
      notifications.some((message) => message.includes("Retrying (attempt 2/3).")),
      `expected second attempt notification, got: ${notifications.join("\n")}`,
    );
  } finally {
    cleanup(base);
  }
});

// ─── Activity-JSONL detector regression (#2223) ─────────────────────────────
// unitActivityMentionsTool greps .gsd/activity/<unit>.jsonl as a fallback. The
// unit's own prompt is persisted in that same file as a plain custom_message
// entry listing every tool name, so only structural toolCall/toolResult
// entries may count as a reopen/replan handoff.

function makeActivityRepo(): string {
  const base = join(tmpdir(), `gsd-handoff-activity-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  return base;
}

function writeActivityFile(base: string, lines: string[]): void {
  mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
  writeFileSync(join(base, ".gsd", "activity", "001-complete-slice-M001-S01.jsonl"), lines.join("\n"));
}

function cleanupActivityRepo(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function unitPromptEntry(): string {
  return JSON.stringify({
    type: "custom_message",
    customType: "gsd-unit-prompt",
    message:
      "Complete slice M001/S01. Call gsd_task_complete to finish a task, " +
      "gsd_task_reopen to reopen a task, or gsd_replan_slice to replan this slice.",
  });
}

function activityToolCallEntry(toolName: string): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: toolName, id: "call_1", arguments: { taskId: "T01" } },
        { type: "text", text: "Reopening T01 before handing off." },
      ],
    },
  });
}

test("activity file whose only gsd_task_reopen mention is the unit prompt is not a handoff", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeActivityFile(base, [unitPromptEntry()]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.equal(s.pendingVerificationRetry, null);
  assert.ok(
    notifications.every((message) => !message.includes("handed off via reopen/replan")),
    `unit prompt alone must not read as handoff, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.some((message) => message.includes("DB unavailable")),
    `expected DB-unavailable fallback, got: ${notifications.join("\n")}`,
  );
});

test("activity file with a real gsd_task_reopen toolCall entry counts as a handoff", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeActivityFile(base, [activityToolCallEntry("gsd_task_reopen")]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.ok(
    notifications.some((message) => message.includes("handed off via reopen/replan")),
    `expected handoff notification, got: ${notifications.join("\n")}`,
  );
});

test("activity file with a gsd_replan_slice toolResult entry counts as a replan signal", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN.md"), "# Replan\n");
  writeActivityFile(base, [
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "gsd_replan_slice",
        isError: false,
        content: "Slice replanned with reopened task T02.",
      },
    }),
  ]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.ok(
    notifications.some((message) => message.includes("valid replan outcome")),
    `expected handoff notification, got: ${notifications.join("\n")}`,
  );
});

test("ordinary message text mentioning the tools is not a handoff or replan", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeActivityFile(base, [
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I considered gsd_task_reopen and gsd_replan_slice but the slice is complete." },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "do not call gsd_task_reopen" }] },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_9",
        toolName: "gsd_exec",
        isError: false,
        content: "ran: gsd_task_reopen --dry-run (not invoked)",
      },
    }),
  ]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.ok(
    notifications.every((message) => !message.includes("handed off via reopen/replan")),
    `assistant/user text must not read as handoff, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.every((message) => !message.includes("valid replan outcome")),
    `assistant/user text must not read as replan outcome, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.some((message) => message.includes("DB unavailable")),
    `expected DB-unavailable fallback, got: ${notifications.join("\n")}`,
  );
});

test("malformed activity lines are skipped without breaking tool detection", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeActivityFile(base, [
    '{"type": "message", "message": { "role": "assistant", "content": [ truncated',
    activityToolCallEntry("gsd_task_reopen"),
  ]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.ok(
    notifications.some((message) => message.includes("handed off via reopen/replan")),
    `expected handoff notification after skipping corrupt line, got: ${notifications.join("\n")}`,
  );
});

test("activity file whose only gsd_replan_slice mention is the unit prompt is not a replan outcome", async (t) => {
  const base = makeActivityRepo();
  t.after(() => cleanupActivityRepo(base));
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN.md"), "# Replan\n");
  writeActivityFile(base, [unitPromptEntry()]);

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "complete-slice", id: "M001/S01", startedAt: Date.now() };

  const notifications: string[] = [];
  const result = await postUnitPreVerification(
    makePostUnitContext(base, s, notifications),
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "continue");
  assert.ok(
    notifications.every((message) => !message.includes("valid replan outcome")),
    `unit prompt alone must not read as replan outcome, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.every((message) => !message.includes("handed off via reopen/replan")),
    `unit prompt alone must not read as handoff, got: ${notifications.join("\n")}`,
  );
  assert.ok(
    notifications.some((message) => message.includes("DB unavailable")),
    `expected DB-unavailable fallback, got: ${notifications.join("\n")}`,
  );
});
