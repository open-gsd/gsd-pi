// Project/App: gsd-pi
// File Purpose: Compiled MCP protocol tests with mocked native bridges only.
// Native persistence parity lives in mcp-blocker-boundary-pr2865.integration.test.ts.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createMcpServer } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { resolvePersistedAutoPauseBlockerViaBridge } from "./workflow-tools.js";

// Intercept the dynamic runtime boundary, not native TypeScript. This compiled
// suite must neither compile native sources nor open a real project database.
const state = {
  calls: [] as unknown[][],
  backendCalls: 0,
  gate: "",
  cachedSuccess: { resolved: true, scope: "M001/S01/T01", replayed: true },
};
const stateKey = "__pr2865McpBoundaryMock";
(globalThis as any)[stateKey] = state;
const bridge = `
const state = globalThis.${stateKey};
export function openExistingWorkflowDatabase() { return { ok: true }; }
export function closeDatabase() {}
export async function resolvePendingEscalation(...args) {
  state.calls.push(args);
  return { status: 'resolved', questionId: args[3] ?? 'legacy-question', message: 'Escalation resolved' };
}
export function resolveAutoPauseBlockerById() {
  state.backendCalls++;
  return state.cachedSuccess;
}
`;
const gate = `
const state = globalThis.${stateKey};
export function loadWriteGateSnapshot() { return { activeQueuePhase: false }; }
export function shouldBlockPendingGateInSnapshot() {
  return { block: !!state.gate, reason: state.gate };
}
export function shouldBlockQueueExecutionInSnapshot() { return { block: false }; }
`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = /(?:^|\/)mcp-bridge\.[jt]s$/.test(specifier) ? bridge + gate.replace(`const state = globalThis.${stateKey};`, "")
      : /(?:^|\/)write-gate\.[jt]s$/.test(specifier) ? gate : undefined;
    if (source !== undefined) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
after(() => {
  hooks.deregister();
  delete (globalThis as any)[stateKey];
});

async function captureResolveBlockerTool(manager = new SessionManager()) {
  const { server } = await createMcpServer(manager, { includeWorkflowTools: false });
  const tool = (server as any)._registeredTools?.gsd_resolve_blocker;
  assert.ok(tool);
  return tool;
}

const pauseInput = {
  pauseBlockerId: "B-cache",
  outcome: "resolved" as const,
  rationale: "The guard is clear",
  expectedRevision: 7,
  expectedAuthorityEpoch: 3,
};

function extra(requestId = "resolve-test") {
  return { sessionId: "mcp-client", requestId, _meta: { "claudecode/toolUseId": requestId } };
}

test("resolve-blocker schema rejects conflicting, empty, and malformed selectors", async () => {
  const tool = await captureResolveBlockerTool();
  for (const args of [
    { sessionId: "live", response: "continue" },
    { projectDir: "/tmp/project", response: "A" },
    { projectDir: "/tmp/project", questionId: "Q-explicit", response: "A" },
    { projectDir: "/tmp/project", ...pauseInput },
  ]) {
    assert.equal(tool.inputSchema.safeParse(args).success, true, JSON.stringify(args));
  }
  for (const args of [
    {},
    { sessionId: "", response: "A" },
    { sessionId: "  ", response: "A" },
    { questionId: "", response: "A" },
    { questionId: "  ", response: "A" },
    { response: "" },
    { response: "  " },
    { projectDir: "  ", response: "A" },
    { sessionId: "live", questionId: "Q", response: "A" },
    { ...pauseInput, sessionId: "live" },
    { ...pauseInput, questionId: "Q" },
    { ...pauseInput, response: "A" },
    { ...pauseInput, pauseBlockerId: "" },
    { ...pauseInput, pauseBlockerId: "  " },
    { ...pauseInput, rationale: "  " },
    { ...pauseInput, outcome: "waived" },
    { ...pauseInput, expectedRevision: -1 },
    { ...pauseInput, expectedRevision: 0.5 },
    { ...pauseInput, expectedAuthorityEpoch: -1 },
    { ...pauseInput, expectedAuthorityEpoch: 0.5 },
    { ...pauseInput, expectedRevision: undefined },
    { ...pauseInput, expectedAuthorityEpoch: undefined },
  ]) {
    assert.equal(tool.inputSchema.safeParse(args).success, false, JSON.stringify(args));
  }
});

test("invalid selectors are refused before calling the bridge", async () => {
  state.calls.length = 0;
  const tool = await captureResolveBlockerTool();
  for (const args of [{}, { ...pauseInput, questionId: "Q" }, { response: "  " }]) {
    const result = await tool.handler(args, extra());
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.length > 0);
  }
  assert.equal(state.calls.length, 0);
});

test("explicit questionId and legacy escalation paths preserve agent invocation", async () => {
  state.calls.length = 0;
  const tool = await captureResolveBlockerTool();
  for (const args of [
    { projectDir: "/tmp/protocol", questionId: "Q-explicit", response: "A" },
    { projectDir: "/tmp/protocol", response: "B" },
  ]) {
    const result = await tool.handler(args, extra());
    assert.notEqual(result.isError, true, result.content[0].text);
  }
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]![3], "Q-explicit");
  assert.equal(state.calls[1]![3], undefined);
  for (const call of state.calls) {
    assert.equal((call[2] as any).actorType, "agent");
    assert.equal((call[2] as any).sourceTransport, "workflow-mcp");
  }
});

test("live session UI responses retain the session path", async () => {
  const manager = new SessionManager();
  const calls: unknown[][] = [];
  manager.getSession = (() => ({ id: "live" })) as any;
  manager.resolveBlocker = async (...args) => { calls.push(args); };
  const tool = await captureResolveBlockerTool(manager);
  const result = await tool.handler({ sessionId: "live", response: "continue" }, extra());
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [["live", "continue"]]);
});

test("persisted escalation write gate runs before resolving", async () => {
  state.calls.length = 0;
  state.gate = "Discussion gate is active";
  try {
    const tool = await captureResolveBlockerTool();
    const result = await tool.handler({ projectDir: "/tmp/protocol", response: "A" }, extra());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Discussion gate/);
    assert.equal(state.calls.length, 0);
  } finally {
    state.gate = "";
  }
});

test("unsafe cached pause success cannot replay through packaged or shared MCP entrypoints", async () => {
  state.backendCalls = 0;
  const tool = await captureResolveBlockerTool();
  for (let retry = 0; retry < 2; retry++) {
    // An old request identity is deliberately reused. The mock native backend
    // would replay unsafe historical success if either frontend consulted it.
    const packaged = await tool.handler({ projectDir: "/tmp/protocol", ...pauseInput }, extra("old-unsafe-receipt"));
    assert.equal(packaged.isError, true);
    assert.match(packaged.content[0].text, /native operator/);
    const shared = await resolvePersistedAutoPauseBlockerViaBridge(
      "/tmp/protocol", pauseInput.pauseBlockerId, pauseInput.rationale,
      pauseInput.expectedRevision, pauseInput.expectedAuthorityEpoch,
      extra("old-unsafe-receipt"),
    );
    assert.equal(shared.resolved, false);
    assert.match(shared.failure!, /user-owned.*native operator/);
  }
  assert.equal(state.backendCalls, 0);
});
