// gsd-pi - Write-gate state tests: database rows shared by two processes.
/**
 * Write-gate state is rows of the project database (write_gate_state). The
 * extension host and the workflow MCP child read them through one reader.
 * These tests run the second writer as a real child process where the
 * behavior depends on two processes or on a restart:
 *
 *   (a) a gate verified in one process survives that process and the next
 *       session start, and allows the CONTEXT save;
 *   (b) a pending gate armed in one process blocks the other; no file can
 *       verify or clear it;
 *   (c) the host does not re-arm a gate the child verified, on the adapter and
 *       on both hook windows (tool_call defer, tool_execution_start re-arm);
 *   (d) two basePaths defer approval gates in the same process;
 *   (e) the rows are the one store: the host opens the project database for a
 *       gate call, and a database that does not open blocks the gated writes
 *       only;
 *   (f) the native requirement tools report the gate block.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  applyAskUserQuestionsGateResult,
  applyWriteGateSessionBoundary,
  childWriteGateAdapter,
  clearDiscussionFlowState,
  getPendingGate,
  hostWriteGateAdapter,
  loadWriteGateSnapshot,
  isQueuePhaseActive,
  setQueuePhaseActive,
  shouldBlockContextArtifactSave,
  shouldBlockContextWrite,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  shouldBlockRootArtifactSaveInSnapshot,
} from "../bootstrap/write-gate.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";

const GATE = "depth_verification_M007_confirm";
const CONFIRM = "Yes, you got it (Recommended)";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-write-gate-seam-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A project whose workflow database this process (the extension host) has open. */
function makeProject(prefix: string): string {
  const dir = makeTempDir(prefix);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  return dir;
}

function cleanup(dir: string): void {
  clearDiscussionFlowState(dir);
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}

function gateRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(
    "SELECT gate_kind, gate_id, writer FROM write_gate_state ORDER BY gate_kind, gate_id",
  ).all().map((row) => ({ ...row }));
}

/**
 * Run `body` in another process, as the workflow MCP child runs: its own
 * database handle and GSD_WORKFLOW_PROJECT_ROOT in the environment. The
 * process exits without closing the database, like a killed process.
 */
function runWorkflowChild(dir: string, body: string): string {
  // Strip-types runs have no compiled .js sibling on disk, so hand the worker
  // the .ts entrypoint; compiled runs keep the .js URL. spawn() takes the
  // loader flags in the args array.
  const jsPath = fileURLToPath(new URL("../bootstrap/write-gate.js", import.meta.url));
  const writeGateUrl = pathToFileURL(existsSync(jsPath) ? jsPath : jsPath.replace(/\.js$/, ".ts")).href;
  const workerExecArgs: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (arg === "--experimental-strip-types" || arg.startsWith("--import")) {
      workerExecArgs.push(arg);
      if (arg === "--import") workerExecArgs.push(process.execArgv[++i]!);
    }
  }
  const worker = [
    `const gate = await import(${JSON.stringify(writeGateUrl)});`,
    `const dir = ${JSON.stringify(dir)};`,
    body,
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(process.execPath, [...workerExecArgs, "--input-type=module", "-e", worker], {
    encoding: "utf-8",
    env: { ...process.env, GSD_WORKFLOW_PROJECT_ROOT: dir },
  });
  assert.equal(result.status, 0, `workflow child failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeHookHarness(): {
  handlers: Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>;
  pi: any;
} {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  return { handlers, pi };
}

function contextPath(dir: string, milestoneId: string): string {
  return join(dir, ".gsd", "milestones", milestoneId, `${milestoneId}-CONTEXT.md`);
}

// ── (a) a verified gate is a database row ────────────────────────────────────

test("seam: a depth gate answered in another process survives its exit and the next session start", (t) => {
  const dir = makeProject("restart");
  t.after(() => cleanup(dir));

  const status = runWorkflowChild(dir, `
    gate.setPendingGate(${JSON.stringify(GATE)}, dir);
    const result = gate.applyAskUserQuestionsGateResult({
      basePath: dir,
      questions: [{ id: ${JSON.stringify(GATE)}, options: [{ label: ${JSON.stringify(CONFIRM)} }, { label: "Not quite" }] }],
      details: { response: { answers: { ${JSON.stringify(GATE)}: { selected: ${JSON.stringify(CONFIRM)} } } } },
    });
    console.log(result.status);
  `);
  assert.equal(status, "verified", "the child must record the confirmed depth answer");

  // The process that recorded the answer is gone. A new host process has no
  // database open when its session starts (the session_start hook applies
  // this boundary).
  closeDatabase();
  applyWriteGateSessionBoundary("start", dir);

  assert.equal(
    shouldBlockContextWrite("write", contextPath(dir, "M007"), null, false, dir).block,
    false,
    "the verified milestone CONTEXT write is allowed after the restart",
  );
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, false);
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M008", null, dir).block,
    true,
    "a milestone the user did not confirm stays blocked",
  );
  assert.deepEqual(gateRows(), [
    { gate_kind: "approval_verified", gate_id: GATE, writer: "child" },
    { gate_kind: "depth_verified", gate_id: "M007", writer: "child" },
  ]);
  assert.equal(
    existsSync(join(dir, ".gsd", "runtime", "write-gate-state.json")),
    false,
    "no snapshot file is written",
  );
});

test("seam: verifications written by two processes are all kept", (t) => {
  const dir = makeProject("two-writers");
  t.after(() => cleanup(dir));

  hostWriteGateAdapter.markDepthVerified("M001", dir);
  runWorkflowChild(dir, `gate.markDepthVerified("M002", dir);`);
  // The host holds no copy of the rows, so its next write cannot drop M002.
  hostWriteGateAdapter.markDepthVerified("M003", dir);

  assert.deepEqual(loadWriteGateSnapshot(dir).verifiedDepthMilestones, ["M001", "M002", "M003"]);
  assert.deepEqual(gateRows().map((row) => row.writer), ["host", "child", "host"]);
});

// ── (b) a pending gate is a database row ─────────────────────────────────────

test("seam: a pending gate armed in another process blocks this one, and no file changes it", (t) => {
  const dir = makeProject("pending");
  t.after(() => cleanup(dir));

  runWorkflowChild(dir, `gate.setPendingGate(${JSON.stringify(GATE)}, dir);`);

  assert.equal(getPendingGate(dir), GATE, "the host reads the gate the child armed");
  assert.equal(shouldBlockPendingGate("write", "M007", false, dir).block, true);

  // A snapshot file of an older build claims the gate is verified and not pending.
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "runtime", "write-gate-state.json"),
    JSON.stringify({ verifiedDepthMilestones: ["M007"], verifiedApprovalGates: [GATE], pendingGateId: null }),
    "utf-8",
  );
  assert.equal(getPendingGate(dir), GATE, "the file is not read");
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, true);

  // Deleting the runtime directory was the old way to clear the gate.
  rmSync(join(dir, ".gsd", "runtime"), { recursive: true, force: true });
  assert.equal(getPendingGate(dir), GATE);

  // The session that asked the question is gone: the question is no longer
  // pending, but nothing was confirmed, so the CONTEXT save stays blocked.
  closeDatabase();
  applyWriteGateSessionBoundary("start", dir);
  assert.equal(getPendingGate(dir), null);
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, true);
});

test("seam: a restart and a resume keep verified gates and end the queue phase; a new session ends the discussion", (t) => {
  const dir = makeProject("session-boundary");
  t.after(() => cleanup(dir));
  const arm = () => {
    hostWriteGateAdapter.markDepthVerified("M007", dir);
    hostWriteGateAdapter.setPending("depth_verification_M008_confirm", dir);
    setQueuePhaseActive(true, dir);
  };

  arm();
  applyWriteGateSessionBoundary("start", dir);
  assert.deepEqual(loadWriteGateSnapshot(dir), {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: null,
  });

  arm();
  applyWriteGateSessionBoundary("resume", dir);
  assert.deepEqual(loadWriteGateSnapshot(dir).verifiedDepthMilestones, ["M007"]);
  assert.equal(getPendingGate(dir), null);
  assert.equal(isQueuePhaseActive(dir), false);

  arm();
  applyWriteGateSessionBoundary("new", dir);
  assert.deepEqual(gateRows(), [], "a new session removes every gate row of the discussion");
});

test("seam: a queue phase set by a process that exited does not block a source write after the next session start", async (t) => {
  const dir = makeProject("queue-restart");
  t.after(() => cleanup(dir));

  runWorkflowChild(dir, `gate.setQueuePhaseActive(true, dir);`);

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  const writeSource = async (toolCallId: string): Promise<any> => {
    let blocked: any;
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({
        toolCallId,
        toolName: "write",
        input: { path: join(dir, "src", "app.ts"), content: "export {};\n" },
      }, ctx);
      if (result?.block) blocked = result;
    }
    return blocked;
  };

  assert.match(
    (await writeSource("t-queue"))?.reason ?? "",
    /\/gsd queue is a planning tool/,
    "the queue phase row blocks a source write while the queue conversation is live",
  );

  // The process that ran /gsd queue is gone. A new host process starts a session.
  closeDatabase();
  applyWriteGateSessionBoundary("start", dir);

  assert.equal(isQueuePhaseActive(dir), false);
  assert.equal(await writeSource("t-restart"), undefined, "a restart ends the queue phase");
});

// ── (c) verified wins over a host re-arm ─────────────────────────────────────

test("seam: host setPending does not re-arm a gate the child verified", (t) => {
  const dir = makeProject("no-clobber-adapter");
  t.after(() => cleanup(dir));

  assert.equal(hostWriteGateAdapter.setPending(GATE, dir), true, "fresh gate must arm");
  assert.equal(getPendingGate(dir), GATE);

  // The child records the user's answer.
  childWriteGateAdapter.markApprovalGateVerified(GATE, dir);
  childWriteGateAdapter.markDepthVerified("M007", dir);
  assert.equal(getPendingGate(dir), null, "a verified gate is not pending");

  assert.equal(hostWriteGateAdapter.setPending(GATE, dir), false, "re-arm must be suppressed");
  const snapshot = loadWriteGateSnapshot(dir);
  assert.deepEqual(snapshot.verifiedDepthMilestones, ["M007"], "verification must survive");
  assert.deepEqual(snapshot.verifiedApprovalGates, [GATE]);
  assert.equal(snapshot.pendingGateId, null, "no pending gate after suppressed re-arm");
});

test("seam: child setPending revokes the verification of the gate it asks again", (t) => {
  const dir = makeProject("child-rearm");
  t.after(() => cleanup(dir));

  childWriteGateAdapter.markApprovalGateVerified(GATE, dir);
  childWriteGateAdapter.markDepthVerified("M007", dir);
  childWriteGateAdapter.markDepthVerified("M001", dir);

  assert.equal(childWriteGateAdapter.setPending(GATE, dir), true);
  assert.deepEqual(loadWriteGateSnapshot(dir), {
    verifiedDepthMilestones: ["M001"],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: GATE,
  });
});

test("seam: tool_call defer path does not block tools for a gate the child verified", async (t) => {
  const dir = makeProject("no-clobber-defer");
  t.after(() => cleanup(dir));

  // Child verified the gate before the host ever saw the tool block.
  childWriteGateAdapter.markApprovalGateVerified(GATE, dir);
  childWriteGateAdapter.markDepthVerified("M007", dir);

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  // tool_call defer window: ask_user_questions arrives post-hoc with the gate id.
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "ask_user_questions",
      input: { questions: [{ id: GATE }] },
    }, ctx);
  }

  // A subsequent tool in the same turn must NOT hit the deferred-gate block.
  let blocked: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolCallId: "t-next",
      toolName: "glob",
      input: { pattern: "*.md" },
    }, ctx);
    if (result?.block) blocked = result;
  }
  assert.equal(blocked, undefined, "verified gate must not be deferred/blocking");
  assert.equal(getPendingGate(dir), null);
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(snapshot.verifiedDepthMilestones.includes("M007"), "verification must survive the defer window");
});

test("seam: tool_execution_start re-arm window keeps the child verification", async (t) => {
  const dir = makeProject("no-clobber-exec-start");
  t.after(() => cleanup(dir));

  childWriteGateAdapter.markApprovalGateVerified(GATE, dir);
  childWriteGateAdapter.markDepthVerified("M007", dir);

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "mcp__gsd-workflow__ask_user_questions",
      args: { questions: [{ id: GATE }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "post-hoc replay must not re-arm a verified gate");
  assert.ok(loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M007"));
});

test("seam: a decline after a restart revokes the earlier confirmation of the same gate", async (t) => {
  const dir = makeProject("decline-after-restart");
  t.after(() => cleanup(dir));

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  const questions = [{ id: GATE, options: [{ label: CONFIRM }, { label: "Not quite" }] }];
  // One native ask_user_questions round: the host hooks see the call and the answer.
  const ask = async (toolCallId: string, selected: string): Promise<void> => {
    for (const handler of handlers.get("tool_call") ?? []) {
      await handler({ toolCallId, toolName: "ask_user_questions", input: { questions } }, ctx);
    }
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolCallId, toolName: "ask_user_questions", args: { questions } }, ctx);
    }
    for (const handler of handlers.get("tool_result") ?? []) {
      await handler({
        toolCallId,
        toolName: "ask_user_questions",
        input: { questions },
        details: { response: { answers: { [GATE]: { selected } } } },
      }, ctx);
    }
  };

  await ask("t-confirm", CONFIRM);
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, false);

  applyWriteGateSessionBoundary("start", dir);
  await ask("t-decline", "Not quite");

  assert.equal(getPendingGate(dir), GATE, "the declined gate is pending");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block,
    true,
    "the latest answer is a decline, so the CONTEXT save is blocked",
  );
  assert.equal(shouldBlockContextWrite("write", contextPath(dir, "M007"), null, false, dir).block, true);
  assert.deepEqual(gateRows(), [{ gate_kind: "pending", gate_id: GATE, writer: "host" }]);
});

test("seam: a decline of a gate id without a milestone revokes the milestone its confirmation verified", (t) => {
  const dir = makeProject("decline-fallback");
  t.after(() => cleanup(dir));

  const gateId = "depth_verification_confirm";
  const answer = (selected: string) => applyAskUserQuestionsGateResult({
    basePath: dir,
    questions: [{ id: gateId, options: [{ label: CONFIRM }, { label: "Not quite" }] }],
    details: { response: { answers: { [gateId]: { selected } } } },
    fallbackMilestoneId: "M007",
  });

  assert.equal(answer(CONFIRM).status, "verified");
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, false);

  assert.deepEqual(answer("Not quite"), { status: "declined", gateId });
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, true);
});

// ── (d) per-basePath deferred gates ──────────────────────────────────────────

test("seam: a gate call reads and writes the rows of its project when another database is open", (t) => {
  const dir = makeProject("other-project");
  const other = makeTempDir("other-open");
  t.after(() => {
    cleanup(dir);
    rmSync(other, { recursive: true, force: true });
  });
  hostWriteGateAdapter.setPending(GATE, dir);

  openDatabase(join(other, "other.db"));
  assert.equal(getPendingGate(dir), GATE, "the gate is read from the rows of its own project");
  hostWriteGateAdapter.markDepthVerified("M009", dir);
  assert.deepEqual(gateRows(), [
    { gate_kind: "depth_verified", gate_id: "M009", writer: "host" },
    { gate_kind: "pending", gate_id: GATE, writer: "host" },
  ]);

  openDatabase(join(other, "other.db"));
  assert.equal(
    _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM write_gate_state").get()?.["count"],
    0,
    "a gate write for another project does not land in the database that was open",
  );
});

// ── (e) one store: the rows, also after the host closed its database ─────────

test("seam: a plain-text approval typed after auto-mode stopped is recorded on the rows", async (t) => {
  const dir = makeProject("approval-after-stop");
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(dir);
  });
  hostWriteGateAdapter.setPending(GATE, dir);
  // stopAuto closes the host's database; the pending gate stays a row.
  closeDatabase();

  process.chdir(dir);
  const { handlers, pi } = makeHookHarness();
  Object.assign(pi, { getActiveTools: () => [], getAllTools: () => [], setActiveTools() {} });
  registerHooks(pi, []);
  const ctx = {
    cwd: dir,
    model: { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
    modelRegistry: { getProviderAuthMode: () => "apiKey", isProviderRequestReady: () => true },
    getSystemPrompt: () => "base",
    ui: { notify: () => undefined, setWidget: () => undefined },
  } as any;
  for (const handler of handlers.get("before_agent_start") ?? []) {
    await handler({ prompt: "yes, looks good", systemPrompt: "base" }, ctx);
  }

  openDatabase(join(dir, ".gsd", "gsd.db"));
  assert.deepEqual(gateRows(), [
    { gate_kind: "approval_verified", gate_id: GATE, writer: "host" },
    { gate_kind: "depth_verified", gate_id: "M007", writer: "host" },
  ]);
  assert.equal(shouldBlockPendingGate("glob", null, false, dir).block, false, "the tool is not blocked again");
  assert.equal(shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir).block, false);
});

test("seam: gate state armed before the project had a database moves into its rows", (t) => {
  const dir = makeTempDir("adopt-memory");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  hostWriteGateAdapter.setPending(GATE, dir);
  assert.equal(getPendingGate(dir), GATE, "the gate blocks before a database exists");

  openDatabase(join(dir, ".gsd", "gsd.db"));
  assert.equal(getPendingGate(dir), GATE, "the gate still blocks after the database is created");
  assert.deepEqual(gateRows(), [{ gate_kind: "pending", gate_id: GATE, writer: "host" }]);
});

test("seam: a project database that does not open blocks the gated writes only and records no approval", (t) => {
  const dir = makeTempDir("unopenable");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "gsd.db"), "this file is not a SQLite database\n".repeat(200));
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = loadWriteGateSnapshot(dir);
  assert.match(snapshot.storeError ?? "", /could not be opened/);
  for (const toolName of ["read", "glob", "bash", "ask_user_questions"]) {
    assert.equal(
      shouldBlockPendingGate(toolName, null, false, dir).block,
      false,
      `${toolName} is not a gated write, so it runs`,
    );
  }
  assert.equal(shouldBlockPendingGateBash("ls", null, false, dir).block, false);
  assert.equal(hostWriteGateAdapter.setPending(GATE, dir), false, "a gate write reports that nothing was recorded");
  hostWriteGateAdapter.markDepthVerified("M007", dir);
  const contextSave = shouldBlockContextArtifactSave("CONTEXT", "M007", null, dir);
  assert.equal(contextSave.block, true, "an approval that was not recorded does not unlock the CONTEXT save");
  assert.match(contextSave.reason ?? "", /Write-gate state is unavailable/);
  for (const artifactType of ["PROJECT", "REQUIREMENTS"]) {
    const rootSave = shouldBlockRootArtifactSaveInSnapshot(snapshot, artifactType);
    assert.equal(rootSave.block, true, `${artifactType} save is refused`);
    assert.equal(rootSave.displayReason, "The project database could not be opened.");
  }
  assert.equal(shouldBlockRootArtifactSaveInSnapshot(snapshot, "REQUIREMENTS-DRAFT").block, false);
});

test("seam: an unbound checkout lets a read tool run and refuses a gated write with the database message", async (t) => {
  const origin = makeTempDir("unbound-origin");
  const moved = `${origin}-moved`;
  mkdirSync(join(origin, ".gsd"), { recursive: true });
  assert.equal(openWorkflowDatabase(origin).ok, true, "the first open binds the database to its checkout");
  closeDatabase();
  renameSync(origin, moved);
  t.after(() => {
    closeDatabase();
    rmSync(moved, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: moved, ui: { notify: () => undefined } } as any;
  const callTool = async (toolName: string, input: Record<string, unknown>): Promise<any> => {
    let blocked: any;
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({ toolCallId: `call-${toolName}`, toolName, input }, ctx);
      if (result?.block) blocked ??= result;
    }
    return blocked;
  };

  assert.equal(await callTool("read", { path: join(moved, "README.md") }), undefined, "a read tool runs");
  assert.equal(await callTool("bash", { command: "ls" }), undefined, "bash runs");

  const write = await callTool("write", { path: contextPath(moved, "M007"), content: "# Context\n" });
  assert.equal(write?.block, true, "the milestone CONTEXT write is refused");
  assert.match(write.reason, /checkout-unbound/);
  assert.match(write.reason, /\/gsd db bind/);
  assert.doesNotMatch(write.reason, /depth_verification|Depth confirmation/);
  assert.equal(write.displayReason, "The project database could not be opened.");

  const save = shouldBlockRootArtifactSaveInSnapshot(loadWriteGateSnapshot(moved), "REQUIREMENTS");
  assert.equal(save.block, true, "a requirement write is refused");
  assert.match(save.reason ?? "", /\/gsd db bind/);
});

// ── (f) the native requirement tools report the gate block ───────────────────

test("seam: the native requirement tools return root_artifact_write_blocked while a gate is pending", async (t) => {
  const dir = makeProject("native-requirement-gate");
  t.after(() => cleanup(dir));
  const tools = new Map<string, any>();
  registerDbTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  hostWriteGateAdapter.setPending("depth_verification_requirements_confirm", dir);

  const saved = await tools.get("gsd_requirement_save").execute(
    "call-save",
    { class: "functional", description: "Blocked requirement", why: "gate test", source: "user" },
    undefined,
    undefined,
    { cwd: dir },
  );
  assert.equal(saved.isError, true);
  assert.equal(saved.details.error, "root_artifact_write_blocked");
  assert.match(saved.content[0].text, /has not been confirmed/);

  const updated = await tools.get("gsd_requirement_update").execute(
    "call-update",
    { id: "R001", notes: "blocked" },
    undefined,
    undefined,
    { cwd: dir },
  );
  assert.equal(updated.isError, true);
  assert.equal(updated.details.error, "root_artifact_write_blocked");
  assert.equal(
    _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM requirements").get()?.["count"],
    0,
    "a blocked call writes no requirement",
  );
});

test("seam: two basePaths defer gates in one process and both activate", async (t) => {
  // Neither directory has a workflow database: the gates stay in this process.
  const dirA = makeTempDir("defer-a");
  const dirB = makeTempDir("defer-b");
  t.after(() => {
    cleanup(dirA);
    cleanup(dirB);
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const gateA = "depth_verification_M010_confirm";
  const gateB = "depth_verification_M020_confirm";
  const ctxA = { cwd: dirA, ui: { notify: () => undefined } } as any;
  const ctxB = { cwd: dirB, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "a-1", toolName: "ask_user_questions", input: { questions: [{ id: gateA }] } }, ctxA);
  }
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "b-1", toolName: "ask_user_questions", input: { questions: [{ id: gateB }] } }, ctxB);
  }

  // With the old single global slot, project A's deferral was lost the moment
  // project B deferred. Both must still block follow-up tools.
  for (const [ctx, label] of [[ctxA, "A"], [ctxB, "B"]] as const) {
    let blocked: any;
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({ toolCallId: `chk-${label}`, toolName: "glob", input: { pattern: "*" } }, ctx);
      if (result?.block) blocked = result;
    }
    assert.equal(blocked?.block, true, `project ${label} deferred gate must still block`);
    assert.match(blocked?.reason ?? "", /Approval question/);
  }

  // Activation happens via tool_execution_start in each project independently.
  for (const [ctx, gate, dir] of [[ctxA, gateA, dirA], [ctxB, gateB, dirB]] as const) {
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolCallId: "act", toolName: "ask_user_questions", args: { questions: [{ id: gate }] } }, ctx);
    }
    assert.equal(getPendingGate(dir), gate, `gate must arm for ${dir}`);
  }
});
