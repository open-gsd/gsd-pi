// #2987 — the text-based approval pause must not arm in headless runs.
//
// `gsd headless new-milestone` (step mode) reported Status: complete / exit 0
// while the run had actually stopped on the prose approval pause: the model
// ended a sentence with a question mark, message_update armed the deferred
// gate, agent_end activated it into the project database, and nothing in the
// headless wrapper classified the park. No human can ever answer a prose
// pause in a headless session, so arming it there only poisons later runs.
//
// These tests drive the real registered hooks end-to-end against a real
// project database (the gate rows are durable state that outlives the run),
// mirroring the elicitation-pause-guard harness in
// register-hooks-depth-verification.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  clearPendingAutoStart,
  setPendingAutoStart,
} from "../guided-flow.ts";
import { getPendingGate, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { openDatabase, closeDatabase } from "../gsd-db.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-headless-approval-pause-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function makeHarness(dir: string) {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd: dir,
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  } as any;

  registerHooks(pi, []);

  // A discuss-milestone is the active unit, so approval prose names its gate.
  setPendingAutoStart(dir, {
    basePath: dir,
    milestoneId: "M001",
    ctx,
    pi: { sendMessage: () => undefined } as any,
  });

  const approvalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Here is the milestone plan.\n\nDid I capture the project correctly?" },
    ],
  };

  return {
    notices,
    fireMessageUpdate: async () => {
      for (const handler of handlers.get("message_update") ?? []) {
        await handler({ message: approvalMessage }, ctx);
      }
    },
    fireAgentEnd: async () => {
      for (const handler of handlers.get("agent_end") ?? []) {
        await handler({ messages: [] }, ctx);
      }
    },
  };
}

/** Close and reopen the project database so assertions see durable rows. */
function reopenDatabase(dir: string): void {
  closeDatabase();
  openDatabase(join(dir, ".gsd", "gsd.db"));
}

test("headless run does not arm the text-based approval pause or its durable gate (#2987)", async (t) => {
  const dir = makeTempDir("headless");
  const originalCwd = process.cwd();
  const originalHeadless = process.env.GSD_HEADLESS;
  // Register cleanup before any mutation so a setup failure cannot leak
  // the chdir/env/database into other tests.
  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
      clearPendingAutoStart(dir);
    } finally {
      closeDatabase();
      if (originalHeadless === undefined) delete process.env.GSD_HEADLESS;
      else process.env.GSD_HEADLESS = originalHeadless;
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  process.env.GSD_HEADLESS = "1";
  process.chdir(dir);
  clearDiscussionFlowState(dir);
  clearPendingAutoStart(dir);
  openDatabase(join(dir, ".gsd", "gsd.db"));

  const harness = makeHarness(dir);
  await harness.fireMessageUpdate();
  await harness.fireAgentEnd();

  assert.equal(
    harness.notices.some((n) => /waiting for your approval - pausing/.test(n.text)),
    false,
    "headless runs must not emit the prose approval-pause notice",
  );

  reopenDatabase(dir);
  assert.equal(
    getPendingGate(dir),
    null,
    "headless runs must not leave a durable pending gate in the project database",
  );
});

test("interactive run still arms the pause and activates the durable gate (control)", async (t) => {
  const dir = makeTempDir("interactive");
  const originalCwd = process.cwd();
  const originalHeadless = process.env.GSD_HEADLESS;
  // Register cleanup before any mutation so a setup failure cannot leak
  // the chdir/env/database into other tests.
  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
      clearPendingAutoStart(dir);
    } finally {
      closeDatabase();
      if (originalHeadless === undefined) delete process.env.GSD_HEADLESS;
      else process.env.GSD_HEADLESS = originalHeadless;
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  delete process.env.GSD_HEADLESS;
  process.chdir(dir);
  clearDiscussionFlowState(dir);
  clearPendingAutoStart(dir);
  openDatabase(join(dir, ".gsd", "gsd.db"));

  const harness = makeHarness(dir);
  await harness.fireMessageUpdate();

  assert.equal(
    harness.notices.some((n) => /discuss-milestone M001 is waiting for your approval - pausing/.test(n.text)),
    true,
    "interactive prose approval must still arm the pause notice",
  );

  await harness.fireAgentEnd();
  reopenDatabase(dir);
  assert.equal(
    getPendingGate(dir),
    "depth_verification_M001_confirm",
    "interactive prose approval must still activate the durable gate at agent_end",
  );
});
