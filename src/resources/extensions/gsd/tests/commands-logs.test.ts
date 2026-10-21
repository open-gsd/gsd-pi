import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleLogs } from "../commands-logs.ts";

// ─── Test helpers ───────────────────────────────────────────────────────────

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-logs-test-"));
  mkdirSync(join(dir, ".gsd", "activity"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "debug"), { recursive: true });
  return dir;
}

function createMockCtx(): { notifications: Array<{ msg: string; level: string }>; ui: any } {
  const notifications: Array<{ msg: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(msg: string, level: string) { notifications.push({ msg, level }); },
      setStatus() {},
      setWidget() {},
      setFooter() {},
    },
  };
}

function writeActivityLog(dir: string, seq: number, unitType: string, unitId: string, entries: Record<string, unknown>[]): void {
  const safeId = unitId.replace(/\//g, "-");
  const filename = `${String(seq).padStart(3, "0")}-${unitType}-${safeId}.jsonl`;
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, ".gsd", "activity", filename), content);
}

function writeDebugLog(dir: string, name: string, entries: Record<string, unknown>[]): void {
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, ".gsd", "debug", name), content);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("logs shows empty state message when no logs exist", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].msg.includes("No logs found"));
});

test("logs lists activity logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: false },
  ]);
  writeActivityLog(dir, 2, "complete-slice", "M001/S01", [
    { role: "assistant", content: "Completing slice S01" },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Activity Logs"), "should show activity logs header");
  assert.ok(msg.includes("execute-task"), "should show unit type");
  assert.ok(msg.includes("complete-slice"), "should show second log");
  assert.ok(msg.includes("/gsd logs <#>"), "should show usage hint");
});

test("logs <N> shows activity log details", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    { type: "toolCall", name: "write", arguments: { file_path: "/tmp/test.ts" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: false },
    { role: "toolResult", toolCallId: "2", toolName: "write", isError: true },
    { role: "assistant", content: "I ran the tests and wrote a file" },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("1", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Activity Log #1"), "should show log number");
  assert.ok(msg.includes("execute-task"), "should show unit type");
  assert.ok(msg.includes("Tool calls: 2"), "should count tool calls");
  assert.ok(msg.includes("Errors: 1"), "should count errors");
  assert.ok(msg.includes("/tmp/test.ts"), "should show files written");
  assert.ok(msg.includes("npm test"), "should show commands run");
});

test("logs <N> shows not found for invalid seq", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("999", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].msg.includes("not found"));
  assert.equal(ctx.notifications[0].level, "warning");
});

test("logs debug lists debug logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeDebugLog(dir, "debug-2026-03-18T10-30-00.log", [
    { ts: "2026-03-18T10:30:00Z", event: "debug-start", platform: "darwin" },
    { ts: "2026-03-18T10:35:00Z", event: "debug-summary", dispatches: 5 },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("debug", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Debug Logs"), "should show debug logs header");
  assert.ok(msg.includes("debug-2026-03-18T10-30-00.log"), "should show filename");
});

test("logs debug <N> shows debug log summary", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeDebugLog(dir, "debug-2026-03-18T10-30-00.log", [
    { ts: "2026-03-18T10:30:00Z", event: "debug-start", platform: "darwin" },
    { ts: "2026-03-18T10:30:05Z", event: "dispatch-error", error: "missing plan" },
    { ts: "2026-03-18T10:35:00Z", event: "debug-summary", dispatches: 5 },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("debug 1", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Debug Log:"), "should show debug log header");
  assert.ok(msg.includes("Events: 3"), "should count events");
  assert.ok(msg.includes("Dispatches: 5"), "should show dispatch count");
  assert.ok(msg.includes("dispatch-error"), "should show errors");
});

test("logs tail shows recent activity summaries", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
  ]);
  writeActivityLog(dir, 2, "execute-task", "M001/S01/T02", [
    { type: "toolCall", name: "bash", arguments: { command: "npm build" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: true },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("tail 2", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Last 2 activity log(s)"), "should show count");
  assert.ok(msg.includes("#1"), "should show first log");
  assert.ok(msg.includes("#2"), "should show second log");
});

test("logs clear removes old logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  // Create an old activity log (modify mtime to 10 days ago)
  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [{ type: "toolCall" }]);
  const oldFile = join(dir, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl");
  const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, oldTime, oldTime);

  // Create 6 recent activity logs so the old one is outside the "keep 5" window
  for (let i = 2; i <= 7; i++) {
    writeActivityLog(dir, i, "execute-task", `M001/S01/T0${i}`, [{ type: "toolCall" }]);
  }

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("clear", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  // Old log should be removed, recent ones kept
  assert.ok(!existsSync(oldFile), "old log should be removed");
  assert.ok(
    existsSync(join(dir, ".gsd", "activity", "007-execute-task-M001-S01-T07.jsonl")),
    "most recent log should be kept",
  );
});

// ─── Exec output logs (/gsd logs exec, #2934 slice) ─────────────────────────

import { logsClipboard } from "../commands-logs.ts";

interface ExecMetaOverrides {
  id?: string;
  runtime?: string;
  purpose?: string | null;
  exit_code?: number | null;
  signal?: string | null;
  timed_out?: boolean;
  duration_ms?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  started_at?: string;
  finished_at?: string;
  writeStdout?: boolean;
  writeStderr?: boolean;
}

function writeExecRun(dir: string, id: string, overrides: ExecMetaOverrides = {}): void {
  const { writeStdout, writeStderr, ...metaOverrides } = overrides;
  const execDir = join(dir, ".gsd", "exec");
  mkdirSync(execDir, { recursive: true });
  const meta = {
    id,
    runtime: "bash",
    purpose: null,
    started_at: "2026-10-20T12:00:00.000Z",
    finished_at: "2026-10-20T12:00:01.000Z",
    duration_ms: 1000,
    exit_code: 0,
    signal: null,
    timed_out: false,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    ...metaOverrides,
  };
  writeFileSync(join(execDir, `${id}.meta.json`), JSON.stringify(meta));
  if (writeStdout) writeFileSync(join(execDir, `${id}.stdout`), "out\n");
  if (writeStderr) writeFileSync(join(execDir, `${id}.stderr`), "err\n");
}

/** Force process.stdout.isTTY for the duration of a test; restore via t.after (FIFO-safe). */
function withTty(t: import("node:test").TestContext, value: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });
}

/** Stub the clipboard dispatcher (in an interactive TTY); returns captured payloads. Restores via t.after (FIFO-safe). */
function stubClipboard(t: import("node:test").TestContext): { captured: string[]; fail: (err: Error) => void } {
  withTty(t, true);
  const captured: string[] = [];
  let forcedError: Error | null = null;
  const original = logsClipboard.copy;
  logsClipboard.copy = async (text: string) => {
    if (forcedError) throw forcedError;
    captured.push(text);
  };
  t.after(() => {
    logsClipboard.copy = original;
  });
  return { captured, fail: (err: Error) => { forcedError = err; } };
}

test("logs exec lists recent runs with exit and byte counts", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-a", { purpose: "run the unit tests", exit_code: 0, stdout_bytes: 120, stderr_bytes: 0 });
  writeExecRun(dir, "run-b", { runtime: "python", exit_code: 2, stdout_bytes: 10, stderr_bytes: 64, stderr_truncated: true });

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Exec Output Logs"), "should show exec header");
  assert.ok(msg.includes("run-a"), "should list run-a");
  assert.ok(msg.includes("run-b"), "should list run-b");
  assert.ok(msg.includes("exit 2"), "should show exit code");
  assert.ok(msg.includes("exit 0"), "should show successful exit");
  assert.ok(msg.includes("/gsd logs exec <#|run-id>"), "should show detail hint");
});

test("logs exec shows empty state when no runs exist", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].msg.includes("No exec output logs found"));
});

test("logs exec <N|id> shows complete original paths verbatim — long Unicode paths, no truncation", async (t) => {
  // Keep every directory component under the 255-byte Linux limit; build the
  // length with nested Unicode components instead.
  const nested = join(tmpdir(), "结果-ログ-ディレクトリ-".repeat(6) + "a", "ᚱᚢᚾᛖᛋ-".repeat(10) + "b");
  mkdirSync(nested, { recursive: true });
  const dir = mkdtempSync(join(nested, "gsd-logs-exec-"));
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-long", { writeStdout: true, writeStderr: true, stdout_bytes: 4, stderr_bytes: 4 });

  // process.cwd() returns the realpath (macOS /var -> /private/var); the
  // command resolves paths from cwd, so expectations must use the same form.
  const realDir = process.cwd();
  const stdoutPath = join(realDir, ".gsd", "exec", "run-long.stdout");
  const stderrPath = join(realDir, ".gsd", "exec", "run-long.stderr");
  // Byte length (not UTF-16 units) so the threshold holds on every platform
  // regardless of how short the platform tmpdir base is.
  assert.ok(Buffer.byteLength(stdoutPath) > 200, "test setup should produce a long path");
  for (const component of stdoutPath.split("/")) {
    assert.ok(Buffer.byteLength(component) <= 255, "fixture must stay within Linux per-component limits");
  }

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("run-long"), "should show run id");
  assert.ok(msg.includes(stdoutPath), "full stdout path must appear verbatim");
  assert.ok(msg.includes(stderrPath), "full stderr path must appear verbatim");
  assert.ok(!msg.includes("…"), "no ellipsis may truncate any displayed value");
  assert.ok(msg.includes("copy stdout") && msg.includes("copy stderr"), "should show copy hints");
});

test("logs exec <N> copy stdout copies the exact stored path and nothing else", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-copy", { writeStdout: true });
  const clipboard = stubClipboard(t);
  const expectedPath = join(process.cwd(), ".gsd", "exec", "run-copy.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1 copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [expectedPath], "clipboard must receive the exact original path string");
  assert.equal(ctx.notifications[0].level, "success");
  assert.ok(ctx.notifications[0].msg.includes(expectedPath), "confirmation echoes the copied path");
});

test("logs exec <N> copy stderr targets the stderr path", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-err", { writeStderr: true, exit_code: 1 });
  const clipboard = stubClipboard(t);
  const expectedPath = join(process.cwd(), ".gsd", "exec", "run-err.stderr");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1 copy stderr", ctx as any);
  assert.deepEqual(clipboard.captured, [expectedPath]);
  assert.equal(ctx.notifications[0].level, "success");
});

test("copy fallback works when the output file is missing — path is still copied in full", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-gone", { stdout_bytes: 4096 }); // meta only, no .stdout file
  const clipboard = stubClipboard(t);
  const expectedPath = join(process.cwd(), ".gsd", "exec", "run-gone.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1", ctx as any);
  assert.ok(ctx.notifications[0].msg.includes("local copy missing"), "detail should flag the missing local copy");
  assert.ok(ctx.notifications[0].msg.includes(expectedPath), "path still shown in full");

  await handleLogs("exec 1 copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [expectedPath], "missing file must not block the copy fallback");
  assert.equal(ctx.notifications[1].level, "success");
});

test("clipboard failure surfaces as an error notification", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-fail");
  const clipboard = stubClipboard(t);
  clipboard.fail(new Error("no clipboard available"));

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1 copy stdout", ctx as any);
  assert.equal(ctx.notifications[0].level, "error");
  assert.ok(ctx.notifications[0].msg.includes("no clipboard available"));
});

test("untrusted purpose text is sanitized for display but paths and clipboard stay exact", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-osc", {
    purpose: "audit \u001B]0;pwned\u0007 write\u0007\u001B[2J done",
    stdout_bytes: 5,
  });
  const clipboard = stubClipboard(t);
  const expectedPath = join(process.cwd(), ".gsd", "exec", "run-osc.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1", ctx as any);
  const msg = ctx.notifications[0].msg;
  assert.ok(!msg.includes("\u001B"), "no escape sequences may reach the display");
  assert.ok(!msg.includes("pwned"), "OSC payload text must be stripped");
  assert.ok(msg.includes("audit") && msg.includes("done"), "safe words survive sanitization");

  await handleLogs("exec 1 copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [expectedPath], "clipboard gets the raw stored path, not sanitized text");
});

test("logs exec rejects invalid index and invalid copy grammar", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-one");
  const clipboard = stubClipboard(t);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 5", ctx as any);
  assert.equal(ctx.notifications[0].level, "warning");
  assert.ok(ctx.notifications[0].msg.includes("not found"));

  await handleLogs("exec 1 copy both", ctx as any);
  assert.equal(ctx.notifications[1].level, "warning");
  assert.ok(ctx.notifications[1].msg.includes("Usage"));

  await handleLogs("exec 1 copy", ctx as any);
  assert.equal(ctx.notifications[2].level, "warning");

  assert.deepEqual(clipboard.captured, [], "no clipboard write may happen for invalid grammar");
});

test("logs overview mentions exec runs when they exist", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-overview");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Exec output logs exist"), "overview should surface exec-only workspaces");
  assert.ok(msg.includes("/gsd logs exec"), "overview should point at the exec listing");
});

test("stored original path wins for display and copy; derived sibling shown alongside", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  // Meta written by an executor on the original host: stored paths point at
  // the original location; locally the sibling is this workspace.
  const originalStdout = "/original-host/project/.gsd/exec/run-moved.stdout";
  const originalStderr = "/original-host/project/.gsd/exec/run-moved.stderr";
  writeExecRun(dir, "run-moved", {
    stdout_bytes: 4096,
    stderr_bytes: 0,
  });
  const metaPath = join(dir, ".gsd", "exec", "run-moved.meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  meta.stdout_path = originalStdout;
  meta.stderr_path = originalStderr;
  writeFileSync(metaPath, JSON.stringify(meta));
  const clipboard = stubClipboard(t);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec run-moved", ctx as any);
  const detail = ctx.notifications[0].msg;
  assert.ok(detail.includes(originalStdout), "detail must show the stored complete original path");
  assert.ok(detail.includes("local sibling:"), "detail should also show the local derived sibling");

  await handleLogs("exec run-moved copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [originalStdout], "copy must hand over the stored original, not the derived local path");

  await handleLogs("exec run-moved copy stderr", ctx as any);
  assert.deepEqual(clipboard.captured, [originalStdout, originalStderr], "stderr copy uses the stored original too");
});

test("legacy meta without stored paths falls back to the derived sibling path", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-legacy"); // helper writes no stdout_path/stderr_path fields
  const clipboard = stubClipboard(t);
  const derivedPath = join(process.cwd(), ".gsd", "exec", "run-legacy.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec run-legacy copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [derivedPath]);
  assert.ok(!ctx.notifications[0].msg.includes("local sibling:"), "no sibling line when stored equals derived (or absent)");
});

test("control-character stored path displays reversibly escaped but copies raw", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  const controlPath = `/original-host/p${"\u0001"}q/.gsd/exec/run-ctl.stdout`;
  writeExecRun(dir, "run-ctl", {});
  const metaPath = join(dir, ".gsd", "exec", "run-ctl.meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  meta.stdout_path = controlPath;
  writeFileSync(metaPath, JSON.stringify(meta));
  const clipboard = stubClipboard(t);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec run-ctl", ctx as any);
  const detail = ctx.notifications[0].msg;
  assert.ok(detail.includes("\\x01"), "control byte must render as a reversible escape");
  assert.ok(!detail.includes(controlPath), "raw control byte must not reach the display");

  await handleLogs("exec run-ctl copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [controlPath], "clipboard payload stays the exact stored string");
});

test("copy by run id survives a newer run landing; numeric index tracks the current listing", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-old", { stdout_bytes: 1 });
  const clipboard = stubClipboard(t);
  const oldPath = join(process.cwd(), ".gsd", "exec", "run-old.stdout");
  const newPath = join(process.cwd(), ".gsd", "exec", "run-new.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec 1", ctx as any); // detail rendered while run-old is newest

  // A newer run lands before the user follows the printed hint.
  writeExecRun(dir, "run-new", { stdout_bytes: 2 });

  await handleLogs("exec run-old copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [oldPath], "id-addressed copy must not be hijacked by the newer run");

  await handleLogs("exec 1 copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [oldPath, newPath], "numeric index intentionally resolves against the current listing");
});

test("non-TTY (RPC/print) mode never touches the clipboard and shows the complete path", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  writeExecRun(dir, "run-rpc", { stdout_bytes: 7 });
  const clipboard = stubClipboard(t);
  withTty(t, false); // applies immediately; FIFO t.after restores are unaffected
  const expectedPath = join(process.cwd(), ".gsd", "exec", "run-rpc.stdout");

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("exec run-rpc copy stdout", ctx as any);
  assert.deepEqual(clipboard.captured, [], "no clipboard write may happen outside an interactive terminal");
  assert.equal(ctx.notifications[0].level, "info");
  assert.ok(ctx.notifications[0].msg.includes(expectedPath), "fallback displays the complete path");
});
