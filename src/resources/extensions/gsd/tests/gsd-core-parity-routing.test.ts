// gsd-pi — Comprehensive routing test for all additional commands
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Asserts that EVERY gsd-core command name is handled by the gsd-pi dispatcher —
// either as an implemented native workflow (dispatches a prompt) or as an alias
// (redirect / unavailable notice). None may fall through to "Unknown".

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleGSDCommand } from "../commands/dispatcher.ts";
import { closeDatabase } from "../gsd-db.ts";

function createMockPi() {
  const sent: any[] = [];
  return {
    sent,
    sendMessage: (message: any) => sent.push(message),
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on() {},
  };
}

function createMockCtx(cwd?: string) {
  const notifications: { message: string; level: string }[] = [];
  return {
    cwd,
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  };
}

function createTempGsdProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-core-parity-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

// The complete list of gsd-core command names (from ~/github/open-gsd/gsd-core/commands/gsd/*.md).
// extract-learnings and complete-milestone are natively handled by ops.ts (pre-existing).
const GSD_CORE_COMMANDS = [
  "add-tests",
  "ai-integration-phase",
  "audit-fix",
  "audit-milestone",
  "audit-uat",
  "autonomous",
  "capture",
  "cleanup",
  "code-review",
  "complete-milestone",
  "debug",
  "discuss-phase",
  "docs-update",
  "execute-phase",
  "explore",
  "extract-learnings",
  "graphify",
  "health",
  "help",
  "import",
  "inbox",
  "ingest-docs",
  "manager",
  "map-codebase",
  "milestone-summary",
  "mvp-phase",
  "new-milestone",
  "new-project",
  "ns-context",
  "ns-ideate",
  "ns-manage",
  "ns-project",
  "ns-review",
  "ns-workflow",
  "pause-work",
  "phase",
  "plan-phase",
  "plan-review-convergence",
  "progress",
  "resume-work",
  "review",
  "review-backlog",
  "secure-phase",
  "settings",
  "sketch",
  "spec-phase",
  "spike",
  "stats",
  "surface",
  "thread",
  "ui-phase",
  "ui-review",
  "ultraplan-phase",
  "validate-phase",
  "verify-work",
  "workspace",
  "workstreams",
] as const;

describe("gsd-core command parity routing", () => {
  // Commands that legitimately don't dispatch a prompt on a bare invocation in a
  // mock environment (they need a real .gsd/ project / TUI / gh CLI). We only
  // assert they don't fall through to "Unknown".
  test("every gsd-core command is handled (no 'Unknown' fallthrough)", async () => {
    const unhandled: string[] = [];
    const base = createTempGsdProject();
    try {
      for (const cmd of GSD_CORE_COMMANDS) {
        const pi = createMockPi();
        const ctx = createMockCtx(base);
        try {
          await handleGSDCommand(cmd, ctx as any, pi as any);
        } catch {
          // Some commands throw GSDNoProjectError etc. in a mock env — that still
          // means they were recognized and routed, not "Unknown".
        }
        const fellThrough = ctx.notifications.some(
          (n) => n.message.startsWith("Unknown:") && n.message.includes(`/gsd ${cmd}`),
        );
        if (fellThrough) unhandled.push(cmd);
      }
    } finally {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
    assert.deepStrictEqual(
      unhandled,
      [],
      `These gsd-core commands fell through to "Unknown" (not routed):\n  ${unhandled.join(", ")}`,
    );
  });

  test("implemented commands dispatch a prompt via pi.sendMessage", async () => {
    const implemented = [
      "explore", "spike", "sketch",
      "map-codebase", "docs-update", "graphify", "stats", "progress", "health", "surface",
      "code-review", "review", "audit-milestone", "audit-uat", "audit-fix", "ui-review",
      "secure-phase", "validate-phase", "verify-work", "plan-review-convergence",
      "discuss-phase", "plan-phase", "execute-phase", "spec-phase", "mvp-phase",
      "ui-phase", "ai-integration-phase", "ultraplan-phase", "autonomous",
      "pause-work", "resume-work",
      "manager", "thread", "workstreams", "milestone-summary",
      "review-backlog", "inbox", "import", "ingest-docs", "profile-user", "settings",
    ];
    const noPrompt: string[] = [];
    const base = createTempGsdProject();
    const processCwd = createTempGsdProject();
    const originalCwd = process.cwd();
    try {
      process.chdir(processCwd);
      for (const cmd of implemented) {
        const pi = createMockPi();
        const ctx = createMockCtx(base);
        await handleGSDCommand(cmd, ctx as any, pi as any);
        if (pi.sent.length !== 1) noPrompt.push(`${cmd} (sent ${pi.sent.length})`);
      }
      assert.equal(existsSync(join(processCwd, ".gsd", "spikes")), false);
      assert.equal(existsSync(join(processCwd, ".gsd", "sketches")), false);
      assert.equal(existsSync(join(processCwd, ".gsd", "codebase")), false);
      assert.equal(existsSync(join(processCwd, ".gsd", "knowledge")), false);
      assert.equal(existsSync(join(processCwd, ".gsd", "reviews")), false);
    } finally {
      process.chdir(originalCwd);
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
      rmSync(processCwd, { recursive: true, force: true });
    }
    assert.deepStrictEqual(
      noPrompt,
      [],
      `These implemented commands did not dispatch exactly one prompt:\n  ${noPrompt.join(", ")}`,
    );
  });
});
