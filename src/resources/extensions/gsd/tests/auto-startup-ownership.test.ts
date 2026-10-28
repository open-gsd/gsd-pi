// Invocation-local ownership reaches asynchronous guided dispatch without leaking to manual commands.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAutoStartupOwnership, captureAutoStartupOwnership, noteAutoStartupDispatch } from "../auto/startup-ownership.ts";
import { _dispatchWorkflowForTest } from "../guided-flow.ts";
import { _getPendingAutoStart, deletePendingAutoStart, setPendingAutoStart } from "../pending-auto-start.ts";

function harness(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "gsd-startup-owner-"));
  const beforePath = process.env.GSD_WORKFLOW_PATH;
  const beforeBlocking = process.env.GSD_GUIDED_MCP_BLOCKING;
  process.env.GSD_WORKFLOW_PATH = join(base, "WORKFLOW.md");
  process.env.GSD_GUIDED_MCP_BLOCKING = "0";
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Workflow\n");
  let sent = 0;
  let onTools = () => {};
  const tools = ["read", "gsd_plan_slice"];
  const ctx = { model: { provider: "local-provider" },
    modelRegistry: { getProviderAuthMode: () => "apiKey" },
    sessionManager: { getSessionId: () => "startup-ownership-fixture" },
    ui: { notify() {} },
  };
  const pi = { getActiveTools: () => { onTools(); return [...tools]; },
    getAllTools: () => tools.map((name) => ({ name })),
    setActiveTools() {}, sendMessage() { sent++; } };
  const deps = { loadPreferences: () => ({ preferences: {} }) as any,
    selectModel: async (..._args: any[]) => ({ routing: null, appliedModel: null }),
    getDispatchReadinessError: () => null };
  const dispatch = () => _dispatchWorkflowForTest(pi as any, "Plan", "gsd-run", ctx as any,
    "plan-slice", { basePath: base, deps });
  t.after(() => {
    deletePendingAutoStart(base);
    if (beforePath === undefined) delete process.env.GSD_WORKFLOW_PATH; else process.env.GSD_WORKFLOW_PATH = beforePath;
    if (beforeBlocking === undefined) delete process.env.GSD_GUIDED_MCP_BLOCKING; else process.env.GSD_GUIDED_MCP_BLOCKING = beforeBlocking;
    rmSync(base, { recursive: true, force: true });
  });
  return { base, ctx, pi, deps, dispatch, get sent() { return sent; },
    onTools(callback: () => void) { onTools = callback; } };
}

test("cancelled startup cannot send after awaited guided model preparation; independent commands still dispatch", { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  let current = true;
  const scope = createAutoStartupOwnership(() => current);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  h.deps.selectModel = async () => { entered(); await held; return { routing: null, appliedModel: null }; };
  const running = scope.run(h.dispatch);
  await ready;
  current = false; scope.cancel(); release();
  assert.equal(await running, false, "cancelled guided dispatch reports that no turn started");
  assert.equal(h.sent, 0);
  assert.equal(captureAutoStartupOwnership()(), true, "cancelled ownership must not leak outside its async invocation");
  await h.dispatch();
  assert.equal(h.sent, 1, "a new independent command remains allowed");
});

test("last guided send checks ownership even after model readiness has passed", { timeout: 30_000 }, async (t) => {
  const h = harness(t);
  let current = true;
  const scope = createAutoStartupOwnership(() => current);
  h.onTools(() => { current = false; scope.cancel(); });
  const dispatched = await scope.run(h.dispatch);
  assert.equal(dispatched, false, "cancelled final send reports that no turn started");
  assert.equal(current, false, "fixture must reach the pre-send tool setup boundary");
  assert.equal(h.sent, 0, "late cancellation cannot publish a guided turn");
});

test("cancellation removes only its own pending handoff and cannot remove a replacement", async (t) => {
  const h = harness(t);
  let current = true;
  const scope = createAutoStartupOwnership(() => current);
  const entry = { ctx: h.ctx as any, pi: h.pi as any, basePath: h.base, milestoneId: "M001" };
  await scope.run(async () => {
    setPendingAutoStart(h.base, entry);
    assert.ok(_getPendingAutoStart(h.base));
    current = false; scope.cancel();
    assert.equal(_getPendingAutoStart(h.base), null);
  });
  current = true;
  await scope.run(async () => {
    setPendingAutoStart(h.base, entry);
    const own = _getPendingAutoStart(h.base);
    // A separate manual invocation does not inherit this startup's cleanup registration.
    await createAutoStartupOwnership(() => true).run(async () => {
      setPendingAutoStart(h.base, entry);
      noteAutoStartupDispatch();
    });
    const replacement = _getPendingAutoStart(h.base);
    assert.notEqual(replacement, own);
    current = false; scope.cancel();
    assert.equal(_getPendingAutoStart(h.base), replacement);
  });
});

test("refused or throwing startup cannot leave an unsent handoff armed", async (t) => {
  const h = harness(t);
  const entry = { ctx: h.ctx as any, pi: h.pi as any, basePath: h.base, milestoneId: "M001" };
  await createAutoStartupOwnership(() => true).run(async () => setPendingAutoStart(h.base, entry));
  assert.equal(_getPendingAutoStart(h.base), null, "no dispatched turn means no live handoff");
  const failure = new Error("Synthetic guided preparation failure");
  await assert.rejects(createAutoStartupOwnership(() => true).run(async () => {
    setPendingAutoStart(h.base, entry);
    throw failure;
  }), (error) => error === failure);
  assert.equal(_getPendingAutoStart(h.base), null, "cleanup must preserve the original failure and remove its handoff");
});
