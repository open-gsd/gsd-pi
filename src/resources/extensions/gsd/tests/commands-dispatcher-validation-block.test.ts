// Project/App: gsd-pi
// File Purpose: Dispatcher regression tests for validation-blocked milestones.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { handleGSDCommand } from "../commands/dispatcher.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

interface NotifyCall {
  message: string;
  kind: string;
}

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
}

function makeBase(): string {
  const base = makeTempRepo(`gsd-dispatch-block-${randomUUID()}-`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function makeMockCtx(base: string): {
  ctx: any;
  calls: NotifyCall[];
  widgets: Array<[string, unknown]>;
  statuses: Array<[string, string | undefined]>;
  newSessions: Array<{ workspaceRoot?: string }>;
} {
  const calls: NotifyCall[] = [];
  const widgets: Array<[string, unknown]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const newSessions: Array<{ workspaceRoot?: string }> = [];
  return {
    ctx: {
      cwd: base,
      ui: {
        notify: (message: string, kind: string) => {
          calls.push({ message, kind });
        },
        setWidget: (key: string, value: unknown) => {
          widgets.push([key, value]);
        },
        setStatus: (key: string, value: string | undefined) => {
          statuses.push([key, value]);
        },
      },
      newSession: async (options?: { workspaceRoot?: string }) => {
        newSessions.push(options ?? {});
        return { cancelled: false };
      },
    },
    calls,
    widgets,
    statuses,
    newSessions,
  };
}

function makeMockPi(): { pi: any; messages: SentMessage[] } {
  const messages: SentMessage[] = [];
  return {
    pi: {
      sendMessage: (message: SentMessage) => {
        messages.push(message);
      },
    },
    messages,
  };
}

function seedValidationBlockedMilestone(
  base: string,
  status: "needs-attention" | "needs-remediation" = "needs-attention",
): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M006", title: "Mark All Complete", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M006",
    title: "Done Slice",
    status: "complete",
    risk: "low",
    depends: [],
  });
  insertAssessment({
    path: "milestones/M006/M006-VALIDATION.md",
    milestoneId: "M006",
    status,
    scope: "milestone-validation",
    fullContent: `verdict: ${status}`,
  });
  invalidateStateCache();
}

test("dispatcher blocks bare /gsd while milestone validation needs attention", async () => {
  const base = makeBase();
  try {
    seedValidationBlockedMilestone(base);
    const { ctx, calls, widgets, statuses } = makeMockCtx(base);
    const { pi, messages } = makeMockPi();

    await handleGSDCommand("", ctx, pi);

    assert.equal(calls.length, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "gsd-command-block");
    assert.equal(messages[0].display, true);
    assert.match(messages[0].content, /\/gsd cannot run/);
    assert.match(messages[0].content, /\/gsd validate-milestone/);
    assert.match(messages[0].content, /\/gsd verdict pass --rationale/);
    assert.ok(widgets.some(([key, value]) => key === "gsd-outcome" && value === undefined));
    assert.ok(widgets.some(([key, value]) => key === "gsd-progress" && value === undefined));
    assert.ok(statuses.some(([key, value]) => key === "gsd-step" && value === undefined));
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});

test("dispatcher blocks workflow-advancing aliases while validation is blocked", async () => {
  const blockedCommands = [
    "next",
    "auto",
    "do mark all complete",
    "dispatch complete",
    "plan-phase",
    "execute-phase --milestone M009",
    "autonomous --from 1",
    "workstreams resume",
    "workstreams complete",
    "workflow resume",
    "workflow release-checklist",
  ];

  for (const command of blockedCommands) {
    const base = makeBase();
    try {
      seedValidationBlockedMilestone(base);
      const { ctx, calls } = makeMockCtx(base);
      const { pi, messages } = makeMockPi();

      await handleGSDCommand(command, ctx, pi);

      assert.equal(calls.length, 0, command);
      assert.equal(messages.length, 1, command);
      assert.equal(messages[0].display, true, command);
      let blockedLabel = command;
      if (command === "workstreams resume") {
        blockedLabel = "parallel resume";
      } else if (command === "workstreams complete") {
        blockedLabel = "parallel merge";
      }
      assert.match(messages[0].content, new RegExp(`/gsd ${blockedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cannot run`), command);
    } finally {
      closeDatabase();
      invalidateStateCache();
      cleanup(base);
    }
  }
});

test("dispatcher keeps manager read-only while validation is blocked", async () => {
  const base = makeBase();
  try {
    seedValidationBlockedMilestone(base);
    const { ctx, calls } = makeMockCtx(base);
    const { pi, messages } = makeMockPi();

    await handleGSDCommand("manager", ctx, pi);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "info");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "gsd-manager");
    assert.match(messages[0].content, /read-only/i);
    assert.match(messages[0].content, /active milestone is blocked by validation/);
    assert.doesNotMatch(messages[0].content, /Start\/stop auto-mode/);
    assert.doesNotMatch(messages[0].content, /Run parallel milestones/);
    assert.doesNotMatch(messages[0].content, /Act on the selection/);
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});

test("dispatcher allows reassess dispatch while validation needs remediation", async () => {
  const base = makeBase();
  try {
    seedValidationBlockedMilestone(base, "needs-remediation");
    const { ctx, calls, newSessions } = makeMockCtx(base);
    const { pi, messages } = makeMockPi();

    await handleGSDCommand("dispatch reassess", ctx, pi);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "gsd-dispatch");
    assert.equal(messages[0].display, false);
    assert.match(messages[0].content, /UNIT: Reassess Roadmap/);
    assert.ok(
      calls.some((call) => call.kind === "info" && /Dispatching reassess-roadmap for M006\/S01/.test(call.message)),
      `expected reassess dispatch notification, got: ${JSON.stringify(calls)}`,
    );
    assert.deepEqual(newSessions, [{ workspaceRoot: base }]);
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});

test("dispatcher still allows recovery commands while validation is blocked", async () => {
  const base = makeBase();
  try {
    seedValidationBlockedMilestone(base);
    const { ctx, calls } = makeMockCtx(base);

    await handleGSDCommand("help", ctx, {} as any);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "info");
    assert.match(calls[0].message, /GSD/);
    assert.doesNotMatch(calls[0].message, /cannot run/);
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});

test("dispatcher allows diagnostic and knowledge commands while validation is blocked", async () => {
  const base = makeBase();
  try {
    seedValidationBlockedMilestone(base);
    const { ctx, calls } = makeMockCtx(base);
    const { pi, messages } = makeMockPi();

    await handleGSDCommand("capture investigating validation false positive", ctx, pi);

    assert.equal(messages.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "info");
    assert.match(calls[0].message, /Captured:/);
    assert.doesNotMatch(calls[0].message, /cannot run/);
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});
