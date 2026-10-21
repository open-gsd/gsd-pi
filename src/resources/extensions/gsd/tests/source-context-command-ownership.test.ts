// Project/App: gsd-pi
// File Purpose: Keep manual debug/quick work outside an executing auto Unit.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { autoSession } from "../auto-runtime-state.js";
import { handleDebug } from "../commands-debug.js";
import { handleWorkflowCommand } from "../commands/handlers/workflow.js";
import { applyProviderPayloadPolicy } from "../provider-payload-policy.js";

function fixture(t: TestContext) {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-source-context-command-"));
  const cwd = process.cwd();
  const notifications: Array<{ message: string; level: string }> = [];
  const dispatched: unknown[] = [];
  const ctx = {
    cwd: basePath,
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    sendMessage(message: unknown) { dispatched.push(message); },
  } as unknown as ExtensionAPI;
  process.chdir(basePath);
  autoSession.basePath = basePath;
  autoSession.active = true;
  autoSession.paused = false;
  const unit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: 123,
    workspaceRoot: basePath,
  };
  autoSession.setCurrentUnit(unit);
  writeFileSync(join(basePath, "app.ts"), "export const value = 1;\n");
  autoSession.sourceObservations.observeRead({ path: "app.ts" });
  t.after(() => {
    autoSession.active = false;
    autoSession.paused = false;
    autoSession.clearCurrentUnit();
    autoSession.basePath = "";
    process.chdir(cwd);
    rmSync(basePath, { recursive: true, force: true });
  });
  return { basePath, ctx, pi, notifications, dispatched, unit };
}

for (const args of [
  "investigate source context",
  "continue existing-session",
  "--diagnose investigate source context",
]) {
  test(`debug ${args} cannot take ownership of an active auto Unit`, async (t) => {
    const { basePath, ctx, pi, notifications, dispatched, unit } = fixture(t);
    const block = autoSession.sourceObservations.renderActiveBlock();

    await handleDebug(args, ctx, pi);

    assert.equal(dispatched.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");
    assert.match(notifications[0].message, /Pause auto-mode first with \/gsd pause/);
    assert.equal(existsSync(join(basePath, ".gsd", "debug")), false);
    assert.equal(autoSession.active, true);
    assert.equal(autoSession.currentUnit, unit);
    assert.equal(autoSession.sourceObservations.renderActiveBlock(), block);
  });
}

test("read-only debug remains available without changing the active Unit", async (t) => {
  const { ctx, pi, notifications, dispatched, unit } = fixture(t);
  const block = autoSession.sourceObservations.renderActiveBlock();

  await handleDebug("list", ctx, pi);

  assert.equal(dispatched.length, 0);
  assert.ok(notifications.length > 0);
  assert.ok(notifications.every(entry => entry.level !== "error"));
  assert.equal(autoSession.currentUnit, unit);
  assert.equal(autoSession.sourceObservations.renderActiveBlock(), block);
});

test("quick retains its existing active-auto guard and source owner", async (t) => {
  const { basePath, ctx, pi, notifications, dispatched, unit } = fixture(t);
  const block = autoSession.sourceObservations.renderActiveBlock();

  assert.equal(await handleWorkflowCommand("quick inspect context", ctx, pi), true);

  assert.equal(dispatched.length, 0);
  assert.match(notifications[0].message, /cannot run while auto-mode is active/);
  assert.equal(existsSync(join(basePath, ".gsd", "quick")), false);
  assert.equal(autoSession.currentUnit, unit);
  assert.equal(autoSession.sourceObservations.renderActiveBlock(), block);
});

test("pause handoff excludes manual context and legitimate redispatch observes fresh bytes", (t) => {
  const { basePath, unit } = fixture(t);
  const store = autoSession.sourceObservations;
  const renderPayload = (prompt: string) => JSON.stringify(applyProviderPayloadPolicy({
    payload: { messages: [{ role: "user", content: prompt }] },
    deps: {
      isAutoActive: () => autoSession.active,
      renderSourceContextBlock: () => store.renderActiveBlock(),
      loadContextManagementConfig: () => undefined,
    },
  }));

  assert.match(renderPayload("execute"), /export const value = 1/);
  // These are the in-memory effects of normal pauseAuto(ctx). This is not a
  // canonical Attempt/closeout test and deliberately does not write lifecycle rows.
  autoSession.active = false;
  autoSession.paused = true;
  autoSession.clearCurrentUnit();
  writeFileSync(join(basePath, "debug.ts"), "manual-only bytes\n");
  store.observeRead({ path: "debug.ts" });
  store.observeMutation({ path: "debug.ts" });
  assert.equal(store.renderActiveBlock(), null);
  for (const prompt of ["/gsd debug inspect context", "/gsd quick inspect context"]) {
    assert.doesNotMatch(renderPayload(prompt), /Source Context Block|Active Unit:|manual-only bytes/);
  }

  writeFileSync(join(basePath, "app.ts"), "export const value = 2;\n");
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.setCurrentUnit({ ...unit, startedAt: 456 });
  store.observeRead({ path: "app.ts" });
  const resumed = renderPayload("legitimate redispatch");
  assert.match(resumed, /Active Unit: execute-task M001\/S01\/T01/);
  assert.match(resumed, /export const value = 2/);
  assert.doesNotMatch(resumed, /export const value = 1|manual-only bytes|debug\.ts/);
});
