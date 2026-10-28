// Hermetic controller UNIT tests. All host/DB boundaries are mocked: these do
// not prove real human provenance or claim a terminal user's approval.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const commandSource = readFileSync(new URL("../commands-blocker.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(commandSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
// Use the host's actual unsupported RPC custom implementation, not a fictitious
// mode marker. RPC dialog responses remain programmable even under a PTY.
const rpcOutput = ts.transpileModule(
  // allow-source-grep: Produce an executable AST/VM fixture of the private RPC adapter; assertions exercise its runtime behavior, not source text.
  readFileSync(new URL("../../../../../packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const rpcAst = ts.createSourceFile("rpc-mode.js", rpcOutput, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
function findRpcCustomMethod(node: ts.Node): ts.MethodDeclaration | undefined {
  if (ts.isMethodDeclaration(node) && node.name.getText(rpcAst) === "custom") return node;
  return ts.forEachChild(node, findRpcCustomMethod);
}
const rpcCustomMethod = findRpcCustomMethod(rpcAst);
assert.ok(rpcCustomMethod, "RPC UI adapter exposes its custom capability method");
// Execute the real method behavior instead of matching implementation text.
const rpcCustom = runInNewContext(`({ ${rpcCustomMethod.getText(rpcAst)} }).custom`);

type Component = { handleInput(data: string): void; render(width: number): string[]; invalidate(): void };
function harness() {
  const state = {
    snapshot: {
      eligible: true, projectId: "project-original", revision: 7, authorityEpoch: 2,
      failure: undefined as string | undefined,
      blocker: {
        id: "b1", kind: "consent", owner: "user", scope: "M001/S01", origin: "auto-pause",
        lifecycleState: "in_progress",
        description: "Live acceptance is blocked pending explicit user approval." as string | null,
        requestedAction: "Grant or deny the pending approval, then resolve this blocker." as string | null,
        // Sibling field that must stay excluded by the presentation allowlist.
        evidence: "do-not-display-evidence",
      },
      pause: { id: "p1", scope: "M001/S01" },
      secretPayload: "do-not-display",
    },
    cwd: "/project", activePath: "/project/.gsd/gsd.db", expectedPath: "/project/.gsd/gsd.db",
    input: "verified access", key: "y", customBehavior: "native-unit",
    afterInput: () => {}, afterCustom: () => {},
    fileReads: 0, boundReads: 0, factoryRuns: 0, keyEvents: 0, confirms: 0,
    mutations: [] as any[], notices: [] as string[], review: [] as string[],
  };
  const nativeCustom = async (factory: (...args: any[]) => Component) => {
    state.factoryRuns++;
    const component = factory({}, {}, {}, () => {});
    state.review = component.render(1000);
    component.invalidate();
    if (state.customBehavior === "native-unit") {
      state.keyEvents++;
      component.handleInput(state.key);
    }
    state.afterCustom();
    return true; // Always true: the controller must not trust this result.
  };
  const ctx = {
    hasUI: true,
    get cwd() { return state.cwd; },
    ui: {
      notify(message: string) { state.notices.push(message); },
      input: async () => { state.afterInput(); return state.input; },
      confirm: async () => { state.confirms++; return true; },
      custom: async (factory: (...args: any[]) => Component) => {
        if (state.customBehavior === "rpc") return rpcCustom(factory);
        if (state.customBehavior === "return-true") return true;
        return nativeCustom(factory);
      },
    },
  };
  const boundDb = { prepare: (sql: string) => {
    assert.equal(sql, "PRAGMA query_only", "mock engine boundary permits read-only statements only");
    return { get: () => ({ query_only: 0 }) };
  } };
  const exports: Record<string, any> = {};
  runInNewContext(outputText, {
    exports,
    process: { stdin: { isTTY: true }, stdout: { isTTY: true } },
    require(specifier: string) {
      switch (specifier) {
        case "node:crypto": return require(specifier);
        case "node:fs": return { realpathSync: (path: string) => path };
        case "@gsd/pi-tui": return { truncateToWidth: (line: string, width: number) => line.slice(0, width) };
        case "./db-workspace.js": return { resolveProjectRootDbPath: () => state.expectedPath };
        case "./db/engine.js": return {
          getDbPath: () => { state.boundReads++; return state.activePath; },
          getDb: () => boundDb,
        };
        case "./pause-blocker-inspection.js": return {
          inspectAutoPauseBlockerFile: () => { state.fileReads++; return structuredClone(state.snapshot); },
          classifyAutoPauseBlockerResolution: () => structuredClone(state.snapshot),
          requirePauseBlockerCheckout: () => {},
        };
        case "./pause-blocker-domain-operation.js": return {
          resolveAutoPauseBlockerById: (input: any) => { state.mutations.push(input); return { resolved: true }; },
        };
        default: throw new Error(`Unexpected dependency (bootstrap is forbidden): ${specifier}`);
      }
    },
  });
  return { state, run: (args = "resolve b1 resolved approval verified") => exports.handleBlocker(args, ctx, "/project") };
}

test("UNIT: realistic RPC under PTY, hasUI true and no mode marker, cannot approve via dialogs", async () => {
  const h = harness();
  h.state.customBehavior = "rpc";
  await h.run();
  assert.equal(h.state.factoryRuns, 0);
  assert.equal(h.state.confirms, 0);
  assert.ok(h.state.boundReads >= 1, "only reads an already-bound connection; no opener is available");
  assert.equal(h.state.mutations.length, 0);
  assert.match(h.state.notices.join("\n"), /No native human terminal approval/);
});

for (const behavior of ["return-true", "factory-without-key"]) {
  test(`UNIT: malicious custom ${behavior} cannot mint a user approval`, async () => {
    const h = harness();
    h.state.customBehavior = behavior;
    await h.run();
    assert.equal(h.state.keyEvents, 0);
    assert.ok(h.state.boundReads >= 1, "only reads an already-bound connection; no opener is available");
    assert.equal(h.state.mutations.length, 0);
  });
}

for (const input of [undefined, "", "   "]) {
  test(`UNIT: cancelled/blank evidence ${JSON.stringify(input)} never opens/writes a connection`, async () => {
    const h = harness();
    h.state.input = input as any;
    await h.run();
    assert.equal(h.state.factoryRuns, 0);
    assert.ok(h.state.boundReads >= 1, "only reads an already-bound connection; no opener is available");
    assert.equal(h.state.mutations.length, 0);
  });
}

for (const key of ["n", "\x1b", "\x03", "pasted y"]) {
  test(`UNIT: non-acceptance key ${JSON.stringify(key)} never mutates`, async () => {
    const h = harness(); h.state.key = key;
    await h.run();
    assert.ok(h.state.boundReads >= 1, "only reads an already-bound connection; no opener is available");
    assert.equal(h.state.mutations.length, 0);
  });
}

test("UNIT: inspect exposes safe fields and Project ID without writable binding or dialogs", async () => {
  const h = harness();
  await h.run("inspect b1");
  assert.equal(h.state.fileReads, 1);
  assert.equal(h.state.boundReads, 0);
  assert.equal(h.state.factoryRuns, 0);
  const shown = h.state.notices.join("\n");
  assert.match(shown, /project-original/);
  const details = JSON.parse(shown);
  assert.equal(details.blocker.description, "Live acceptance is blocked pending explicit user approval.");
  assert.equal(details.blocker.requestedAction, "Grant or deny the pending approval, then resolve this blocker.");
  assert.match(details.guidance, /clear-only/i);
  assert.match(details.guidance, /not repair/);
  assert.match(details.guidance, /not Task success/);
  assert.match(details.guidance, /not verification success/);
  assert.match(details.guidance, /no retry authority/);
  assert.match(details.guidance, /not completion/);
  assert.match(details.guidance, /never resumes or retries/);
  assert.doesNotMatch(shown, /do-not-display|secretPayload/);
});

for (const eligible of [true, false]) {
  test(`UNIT: inspect allowlist excludes private diagnostic fields when eligible=${eligible}`, async () => {
    const h = harness();
    h.state.snapshot.eligible = eligible;
    h.state.snapshot.failure = eligible ? undefined : "blocker-not-open";
    for (const record of [h.state.snapshot, h.state.snapshot.blocker, h.state.snapshot.pause]) {
      Object.assign(record, { evidenceJson: "private-evidence", requestPayload: "private-request", runtimeMetadata: "private-runtime" });
    }
    await h.run("inspect b1");
    const shown = h.state.notices.join("\n");
    const details = JSON.parse(shown);
    assert.deepEqual(Object.keys(details).sort(), ["authorityEpoch", "blocker", "eligible", "guidance", "pause", "projectId", "revision", ...(eligible ? [] : ["failure"])].sort());
    assert.deepEqual(Object.keys(details.blocker).sort(), ["description", "id", "kind", "lifecycleState", "origin", "owner", "requestedAction", "scope"].sort());
    assert.deepEqual(Object.keys(details.pause).sort(), ["id", "scope"]);
    assert.equal(details.blocker.description, h.state.snapshot.blocker.description);
    assert.equal(details.blocker.requestedAction, h.state.snapshot.blocker.requestedAction);
    assert.equal(details.eligible, eligible);
    assert.doesNotMatch(shown, /private-|do-not-display|secretPayload/);
    assert.equal(h.state.fileReads, 1);
    assert.equal(h.state.boundReads, 0);
    assert.equal(h.state.factoryRuns, 0);
    assert.equal(h.state.confirms, 0);
    assert.equal(h.state.mutations.length, 0);
  });
}

test("UNIT: eligible epoch-zero inspect distinguishes association from resolution readiness", async () => {
  const h = harness();
  h.state.snapshot.authorityEpoch = 0;
  await h.run("inspect b1");
  const details = JSON.parse(h.state.notices.join("\n"));
  assert.equal(details.eligible, true);
  assert.equal(details.authorityEpoch, 0);
  assert.match(details.guidance, /association-only/);
  assert.match(details.guidance, /existing positive-epoch writable binding prerequisite is unmet/);
  assert.match(details.guidance, /cannot resolve at the current authority epoch/i);
  assert.match(details.guidance, /no automatic adoption or cutover/i);
  assert.doesNotMatch(details.guidance, /resolution is available|inspect again/i);
  assert.equal(h.state.boundReads, 0);
  assert.equal(h.state.factoryRuns, 0);
  assert.equal(h.state.mutations.length, 0);
});

test("UNIT: native epoch-zero refusal never prompts for evidence or mutates", async () => {
  const h = harness();
  h.state.snapshot.authorityEpoch = 0;
  let evidencePrompts = 0;
  h.state.afterInput = () => { evidencePrompts++; };
  await h.run();
  assert.ok(h.state.boundReads >= 1);
  assert.equal(evidencePrompts, 0);
  assert.equal(h.state.factoryRuns, 0);
  assert.equal(h.state.keyEvents, 0);
  assert.equal(h.state.confirms, 0);
  assert.equal(h.state.mutations.length, 0);
  const shown = h.state.notices.join("\n");
  assert.match(shown, /cannot resolve at the current authority epoch \(0\)/i);
  assert.match(shown, /No adoption or cutover was attempted/);
  assert.doesNotMatch(shown, /inspect again/i);
});

test("UNIT: inspect renders missing legacy context fail-soft as null without changing guidance", async () => {
  const h = harness();
  h.state.snapshot.blocker.description = null;
  h.state.snapshot.blocker.requestedAction = null;
  await h.run("inspect b1");
  const shown = h.state.notices.join("\n");
  const details = JSON.parse(shown);
  assert.equal(details.blocker.description, null);
  assert.equal(details.blocker.requestedAction, null);
  assert.match(details.guidance, /clear-only/i);
  assert.doesNotMatch(shown, /do-not-display|secretPayload/);
});

test("UNIT: ineligible inspect explains clear-only unavailability without claiming success", async () => {
  const h = harness();
  h.state.snapshot.eligible = false;
  h.state.snapshot.failure = "blocker-not-open";
  await h.run("inspect b1");
  const details = JSON.parse(h.state.notices.join("\n"));
  assert.equal(details.eligible, false);
  assert.equal(details.failure, "blocker-not-open");
  assert.match(details.guidance, /unavailable/);
  assert.match(details.guidance, /nothing was changed/i);
});

for (const boundary of ["afterInput", "afterCustom"] as const) {
  for (const change of ["project-id", "revision", "epoch", "cwd", "binding", "database-path", "owner", "pause", "scope", "lifecycle", "description", "requested-action"]) {
    test(`UNIT: rechecks ${change} at ${boundary} before mutation`, async () => {
      const h = harness();
      h.state[boundary] = () => {
        if (change === "project-id") h.state.snapshot.projectId = "replacement-same-fences";
        if (change === "revision") h.state.snapshot.revision++;
        if (change === "epoch") h.state.snapshot.authorityEpoch++;
        if (change === "cwd") h.state.cwd = "/other-project";
        if (change === "binding") h.state.activePath = "/other-project/.gsd/gsd.db";
        if (change === "database-path") h.state.expectedPath = "/replacement/.gsd/gsd.db";
        if (change === "owner") h.state.snapshot.blocker.owner = "agent";
        if (change === "pause") h.state.snapshot.pause.id = "p2";
        if (change === "scope") h.state.snapshot.blocker.scope = "M001/S02";
        if (change === "lifecycle") h.state.snapshot.blocker.lifecycleState = "complete";
        if (change === "description") h.state.snapshot.blocker.description = "changed-context";
        if (change === "requested-action") h.state.snapshot.blocker.requestedAction = "changed-action";
      };
      await h.run();
      assert.equal(h.state.mutations.length, 0);
    });
  }
}

test("UNIT: mocked native factory AND key handler approval pins Project ID and exact fences", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.state.factoryRuns, 1);
  assert.equal(h.state.keyEvents, 1);
  assert.equal(h.state.mutations.length, 1);
  const [input] = h.state.mutations;
  assert.equal(input.expectedProjectId, "project-original");
  assert.equal(input.expectedRevision, 7);
  assert.equal(input.expectedAuthorityEpoch, 2);
  assert.equal(input.invocation.actorType, "user");
  assert.equal(input.invocation.sourceTransport, "internal");
  assert.match(input.rationale, /Evidence: verified access/);
  assert.match(h.state.review.join("\n"), /project-original/);
  assert.doesNotMatch(h.state.review.join("\n"), /do-not-display/);
});
