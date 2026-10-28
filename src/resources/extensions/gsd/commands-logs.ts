/**
 * /gsd logs — Browse activity logs, debug logs, exec output logs, and metrics.
 *
 * Subcommands:
 *   /gsd logs                        — List recent activity + debug logs (plus exec run count)
 *   /gsd logs <N>                    — Show summary of activity log #N
 *   /gsd logs debug                  — List debug log files
 *   /gsd logs debug <N>              — Show debug log summary #N
 *   /gsd logs exec                   — List recent gsd_exec / gsd_uat_exec output logs
 *   /gsd logs exec <N|run-id>        — Show run metadata with complete original output paths
 *   /gsd logs exec <N|run-id> copy stdout   — Copy the run's complete original stdout path to the clipboard
 *   /gsd logs exec <N|run-id> copy stderr   — Copy the run's complete original stderr path to the clipboard
 *   /gsd logs tail [N]               — Show last N activity log entries (default 5)
 *   /gsd logs clear                  — Remove old activity and debug logs
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { copyToClipboard } from "@gsd/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull } from "./json-persistence.js";
import { currentDirectoryRoot } from "./commands/context.js";
import { listExecHistory, type ExecHistoryEntry } from "./exec-history.js";
import { sanitizeExecDisplayText } from "./tools/exec-tool-renderer.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LogEntry {
  seq: number;
  filename: string;
  unitType: string;
  unitId: string;
  size: number;
  mtime: Date;
}

interface DebugLogEntry {
  filename: string;
  size: number;
  mtime: Date;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function activityDir(basePath: string): string {
  return join(gsdRoot(basePath), "activity");
}

function debugDir(basePath: string): string {
  return join(gsdRoot(basePath), "debug");
}

function listActivityLogs(basePath: string): LogEntry[] {
  const dir = activityDir(basePath);
  if (!existsSync(dir)) return [];

  const entries: LogEntry[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      // Filename format: {seq}-{unitType}-{unitId}.jsonl
      // unitType is lowercase-with-hyphens (e.g., "execute-task", "complete-slice")
      // unitId starts with M followed by digits (e.g., "M001-S01-T01")
      const match = f.match(/^(\d+)-([\w-]+?)-(M\d[\w-]*)\.jsonl$/);
      if (!match) continue;

      const filePath = join(dir, f);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }

      entries.push({
        seq: parseInt(match[1], 10),
        filename: f,
        unitType: match[2],
        unitId: match[3].replace(/-/g, "/"),
        size: stat.size,
        mtime: stat.mtime,
      });
    }
  } catch { /* dir not readable */ }

  return entries.sort((a, b) => a.seq - b.seq);
}

function listDebugLogs(basePath: string): DebugLogEntry[] {
  const dir = debugDir(basePath);
  if (!existsSync(dir)) return [];

  const entries: DebugLogEntry[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".log")) continue;
      const filePath = join(dir, f);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      entries.push({ filename: f, size: stat.size, mtime: stat.mtime });
    }
  } catch { /* dir not readable */ }

  return entries.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Extract a summary from an activity log JSONL file.
 * Parses the entries to count tool calls, errors, and extract key events.
 */
function summarizeActivityLog(filePath: string): {
  toolCalls: number;
  errors: number;
  filesWritten: string[];
  commandsRun: Array<{ command: string; failed: boolean }>;
  lastReasoning: string;
  entryCount: number;
} {
  const result = {
    toolCalls: 0,
    errors: 0,
    filesWritten: new Set<string>(),
    commandsRun: [] as Array<{ command: string; failed: boolean }>,
    lastReasoning: "",
    entryCount: 0,
  };

  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return { ...result, filesWritten: [] }; }

  const lines = raw.split("\n").filter(l => l.trim());
  result.entryCount = lines.length;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    // Count tool calls
    if (entry.type === "toolCall" || (entry.role === "assistant" && entry.content && Array.isArray(entry.content))) {
      if (entry.type === "toolCall") {
        result.toolCalls++;
        const name = entry.name as string | undefined;
        const args = entry.arguments as Record<string, unknown> | undefined;

        if (name === "write" || name === "edit") {
          const path = args?.file_path as string | undefined;
          if (path) result.filesWritten.add(path);
        }
        if (name === "bash") {
          const cmd = args?.command as string | undefined;
          if (cmd) result.commandsRun.push({ command: cmd.slice(0, 80), failed: false });
        }
      }
    }

    // Count errors
    if (entry.role === "toolResult" && entry.isError) {
      result.errors++;
      // Mark last command as failed
      if (result.commandsRun.length > 0) {
        result.commandsRun[result.commandsRun.length - 1].failed = true;
      }
    }

    // Track assistant reasoning
    if (entry.role === "assistant" && typeof entry.content === "string") {
      result.lastReasoning = entry.content.slice(0, 200);
    }
  }

  return {
    ...result,
    filesWritten: [...result.filesWritten],
  };
}

/**
 * Extract summary events from a debug log file.
 */
function summarizeDebugLog(filePath: string): {
  events: number;
  duration: string;
  dispatches: number;
  errors: Array<{ event: string; message: string }>;
} {
  const result = {
    events: 0,
    duration: "unknown",
    dispatches: 0,
    errors: [] as Array<{ event: string; message: string }>,
  };

  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return result; }

  const lines = raw.split("\n").filter(l => l.trim());
  result.events = lines.length;

  let firstTs = 0;
  let lastTs = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.ts as string | undefined;
    if (ts) {
      const t = new Date(ts).getTime();
      if (!firstTs) firstTs = t;
      lastTs = t;
    }

    const event = entry.event as string | undefined;
    if (!event) continue;

    if (event === "debug-summary") {
      result.dispatches = (entry.dispatches as number) ?? 0;
    }

    if (event.includes("error") || event.includes("failed")) {
      const msg = (entry.error as string) ?? (entry.message as string) ?? JSON.stringify(entry).slice(0, 100);
      result.errors.push({ event, message: msg });
    }
  }

  if (firstTs && lastTs) {
    const elapsed = lastTs - firstTs;
    const mins = Math.floor(elapsed / 60_000);
    if (mins < 1) result.duration = `${Math.floor(elapsed / 1000)}s`;
    else if (mins < 60) result.duration = `${mins}m`;
    else result.duration = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  return result;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export async function handleLogs(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const basePath = currentDirectoryRoot();
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "";

  // /gsd logs clear
  if (subCmd === "clear") {
    await handleLogsClear(basePath, ctx);
    return;
  }

  // /gsd logs debug [N]
  if (subCmd === "debug") {
    const idx = parts[1] ? parseInt(parts[1], 10) : undefined;
    await handleLogsDebug(basePath, ctx, idx);
    return;
  }

  // /gsd logs exec [N] [copy stdout|stderr]
  if (subCmd === "exec") {
    await handleLogsExec(basePath, ctx, parts.slice(1));
    return;
  }

  // /gsd logs tail [N]
  if (subCmd === "tail") {
    const count = parts[1] ? parseInt(parts[1], 10) : 5;
    await handleLogsTail(basePath, ctx, count);
    return;
  }

  // /gsd logs <N> — show specific activity log
  if (subCmd && /^\d+$/.test(subCmd)) {
    const seq = parseInt(subCmd, 10);
    await handleLogsShow(basePath, ctx, seq);
    return;
  }

  // /gsd logs — list overview
  await handleLogsList(basePath, ctx);
}

// ─── Subcommand Handlers ────────────────────────────────────────────────────

async function handleLogsList(basePath: string, ctx: ExtensionCommandContext): Promise<void> {
  const activities = listActivityLogs(basePath);
  const debugLogs = listDebugLogs(basePath);
  // Exec output logs (gsd_exec / gsd_uat_exec) — counted even when no
  // activity/debug logs exist, so an exec-only workspace still gets a pointer
  // instead of a bare "No logs found".
  const execRuns = listExecHistory(basePath);

  if (activities.length === 0 && debugLogs.length === 0) {
    ctx.ui.notify(
      execRuns.length > 0
        ? "No activity or debug logs found.\n\nExec output logs exist — run /gsd logs exec to browse them."
        : "No logs found.\n\nActivity logs are created during auto-mode.\nDebug logs require GSD_DEBUG=1.\nExec output logs persist under .gsd/exec/ when gsd_exec or gsd_uat_exec runs.",
      "info",
    );
    return;
  }

  const lines: string[] = [];

  if (activities.length > 0) {
    lines.push("Activity Logs (.gsd/activity/):");
    lines.push("  #   Unit Type         Unit ID              Size    Age");
    lines.push("  " + "─".repeat(70));

    // Show last 15 entries
    const recent = activities.slice(-15);
    for (const e of recent) {
      const seq = String(e.seq).padStart(3, " ");
      const type = e.unitType.padEnd(18, " ");
      const id = e.unitId.padEnd(20, " ");
      const size = formatSize(e.size).padStart(7, " ");
      const age = formatAge(e.mtime);
      lines.push(`  ${seq} ${type} ${id} ${size}  ${age}`);
    }

    if (activities.length > 15) {
      lines.push(`  ... and ${activities.length - 15} older entries`);
    }
    lines.push("");
    lines.push("  View details: /gsd logs <#>");
  }

  if (debugLogs.length > 0) {
    lines.push("");
    lines.push("Debug Logs (.gsd/debug/):");
    for (let i = 0; i < debugLogs.length; i++) {
      const d = debugLogs[i];
      const size = formatSize(d.size).padStart(7, " ");
      const age = formatAge(d.mtime);
      lines.push(`  ${i + 1}. ${d.filename}  ${size}  ${age}`);
    }
    lines.push("");
    lines.push("  View details: /gsd logs debug <#>");
  }

  // Dedicated listing carries the per-run rows and complete original paths.
  if (execRuns.length > 0) {
    lines.push("");
    lines.push(`Exec Output Logs (.gsd/exec/): ${execRuns.length} run(s)`);
    lines.push("  Browse + copy paths: /gsd logs exec");
  }

  // Metrics summary
  const metricsPath = join(gsdRoot(basePath), "metrics.json");
  const isMetrics = (d: unknown): d is { units: Array<Record<string, unknown>> } =>
    d !== null && typeof d === "object" && "units" in d! && Array.isArray((d as Record<string, unknown>).units);
  const metrics = loadJsonFileOrNull(metricsPath, isMetrics);
  if (metrics && metrics.units.length > 0) {
    const units = metrics.units;
    const totalCost = units.reduce((sum: number, u) => sum + ((u.cost as number) ?? 0), 0);
    const totalTokens = units.reduce((sum: number, u) => {
      const t = u.tokens as Record<string, number> | undefined;
      return sum + (t?.total ?? 0);
    }, 0);
    lines.push("");
    lines.push(`Metrics: ${units.length} units tracked · $${totalCost.toFixed(2)} · ${(totalTokens / 1000).toFixed(0)}K tokens`);
  }

  lines.push("");
  lines.push("Tip: Enable debug logging with GSD_DEBUG=1 before /gsd auto");

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleLogsShow(basePath: string, ctx: ExtensionCommandContext, seq: number): Promise<void> {
  const activities = listActivityLogs(basePath);
  const entry = activities.find(e => e.seq === seq);

  if (!entry) {
    ctx.ui.notify(`Activity log #${seq} not found. Run /gsd logs to see available logs.`, "warning");
    return;
  }

  const filePath = join(activityDir(basePath), entry.filename);
  const summary = summarizeActivityLog(filePath);

  const lines: string[] = [];
  lines.push(`Activity Log #${entry.seq}: ${entry.unitType} — ${entry.unitId}`);
  lines.push("─".repeat(60));
  lines.push(`File: ${entry.filename}`);
  lines.push(`Size: ${formatSize(entry.size)}  |  Age: ${formatAge(entry.mtime)}`);
  lines.push(`Entries: ${summary.entryCount}  |  Tool calls: ${summary.toolCalls}  |  Errors: ${summary.errors}`);

  if (summary.filesWritten.length > 0) {
    lines.push("");
    lines.push("Files written/edited:");
    for (const f of summary.filesWritten.slice(0, 10)) {
      lines.push(`  ${f}`);
    }
    if (summary.filesWritten.length > 10) {
      lines.push(`  ... and ${summary.filesWritten.length - 10} more`);
    }
  }

  if (summary.commandsRun.length > 0) {
    lines.push("");
    lines.push("Commands run:");
    for (const c of summary.commandsRun.slice(0, 10)) {
      const status = c.failed ? " FAILED" : "";
      lines.push(`  ${c.command}${status}`);
    }
    if (summary.commandsRun.length > 10) {
      lines.push(`  ... and ${summary.commandsRun.length - 10} more`);
    }
  }

  if (summary.errors > 0) {
    lines.push("");
    lines.push(`${summary.errors} error(s) encountered during this unit.`);
  }

  if (summary.lastReasoning) {
    lines.push("");
    lines.push("Last reasoning:");
    lines.push(`  "${summary.lastReasoning}${summary.lastReasoning.length >= 200 ? "..." : ""}"`);
  }

  lines.push("");
  lines.push(`Full log: ${filePath}`);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleLogsDebug(basePath: string, ctx: ExtensionCommandContext, idx?: number): Promise<void> {
  const debugLogs = listDebugLogs(basePath);

  if (debugLogs.length === 0) {
    ctx.ui.notify(
      "No debug logs found.\n\nEnable debug logging: GSD_DEBUG=1 gsd auto",
      "info",
    );
    return;
  }

  if (idx === undefined) {
    // List debug logs
    const lines: string[] = ["Debug Logs (.gsd/debug/):", ""];
    for (let i = 0; i < debugLogs.length; i++) {
      const d = debugLogs[i];
      lines.push(`  ${i + 1}. ${d.filename}  ${formatSize(d.size)}  ${formatAge(d.mtime)}`);
    }
    lines.push("");
    lines.push("View details: /gsd logs debug <#>");
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  // Show specific debug log
  if (idx < 1 || idx > debugLogs.length) {
    ctx.ui.notify(`Debug log #${idx} not found. Available: 1-${debugLogs.length}`, "warning");
    return;
  }

  const entry = debugLogs[idx - 1];
  const filePath = join(debugDir(basePath), entry.filename);
  const summary = summarizeDebugLog(filePath);

  const lines: string[] = [];
  lines.push(`Debug Log: ${entry.filename}`);
  lines.push("─".repeat(60));
  lines.push(`Size: ${formatSize(entry.size)}  |  Age: ${formatAge(entry.mtime)}`);
  lines.push(`Events: ${summary.events}  |  Duration: ${summary.duration}  |  Dispatches: ${summary.dispatches}`);

  if (summary.errors.length > 0) {
    lines.push("");
    lines.push("Errors/failures:");
    for (const e of summary.errors.slice(0, 10)) {
      lines.push(`  [${e.event}] ${e.message}`);
    }
    if (summary.errors.length > 10) {
      lines.push(`  ... and ${summary.errors.length - 10} more`);
    }
  }

  lines.push("");
  lines.push(`Full log: ${filePath}`);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleLogsTail(basePath: string, ctx: ExtensionCommandContext, count: number): Promise<void> {
  const activities = listActivityLogs(basePath);

  if (activities.length === 0) {
    ctx.ui.notify("No activity logs found. Logs are created during auto-mode.", "info");
    return;
  }

  const recent = activities.slice(-Math.max(1, Math.min(count, 20)));
  const lines: string[] = [`Last ${recent.length} activity log(s):`, ""];

  for (const e of recent) {
    const filePath = join(activityDir(basePath), e.filename);
    const summary = summarizeActivityLog(filePath);
    const status = summary.errors > 0 ? `${summary.errors} err` : "ok";
    lines.push(`  #${e.seq} ${e.unitType} ${e.unitId} — ${summary.toolCalls} tools, ${status}, ${formatAge(e.mtime)}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Exec Output Logs (/gsd logs exec) ──────────────────────────────────────
// #2934 slice: keyboard-reachable complete-path actions over the executor's
// trusted persisted metadata (.gsd/exec/<id>.meta.json, written by
// exec-sandbox). Copy-only by construction: the exact stored path string goes
// to the clipboard on an explicit user action in an interactive terminal — no
// file launch, no output-supplied command, no path rewriting, and no
// truncation of the original path, ever. Paths are re-resolved from the
// current workspace on every invocation, and runs can be addressed by their
// stable id so a newer run can never hijack a printed hint.

/** Rows shown by `/gsd logs exec` before the "... and N older runs" elision. */
const EXEC_LIST_LIMIT = 15;
/** Longest rendered exec purpose before elision (display only — never applied to paths). */
const EXEC_PURPOSE_MAX_CHARS = 120;

/**
 * Swappable clipboard dispatcher — exported so tests can stub it (clipboard
 * writes shell out to platform tools and are environment-dependent).
 */
export const logsClipboard = { copy: copyToClipboard };

/**
 * Original output paths as recorded inside the meta file by the executor.
 *
 * Read here — separately from exec-history's entry — because the shared read
 * side deliberately derives filesystem paths from the meta filename and
 * discards JSON path fields for its model-facing consumers (a tested security
 * boundary in exec-history.test.ts). This command is human-facing: the stored
 * original wins for display/copy so the complete original path survives
 * host/workspace moves, and it is never used for filesystem access. Absent,
 * blank, or non-string values fall back to the derived sibling path.
 */
function readStoredOutputPaths(metaPath: string): { stdout?: string; stderr?: string } {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    const pick = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    return { stdout: pick(parsed.stdout_path), stderr: pick(parsed.stderr_path) };
  } catch {
    return {};
  }
}

/**
 * Display form of a path: control characters (C0/C1/DEL) and any escape
 * sequence they could start are rendered as reversible \xNN/\uNNNN escapes;
 * ordinary Unicode (long CJK/emoji paths included) stays verbatim. Never
 * deletes characters — a path containing \u0001 must not display as a
 * different location. Clipboard payloads stay raw.
 */
function displayPath(path: string): string {
  return path.replace(/[\u0000-\u001F\u007F-\u009F]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function execExitText(entry: ExecHistoryEntry): string {
  if (entry.timed_out) return "timeout";
  if (entry.signal) return `signal:${sanitizeExecDisplayText(entry.signal)}`;
  return entry.exit_code === null ? "exit unknown" : `exit ${entry.exit_code}`;
}

/** Display-normalized purpose: sanitized and bounded; paths are never elided. */
function execPurposeText(entry: ExecHistoryEntry): string | undefined {
  const purpose = entry.purpose === null ? undefined : sanitizeExecDisplayText(entry.purpose).replace(/\s+/g, " ").trim();
  if (!purpose) return undefined;
  return purpose.length <= EXEC_PURPOSE_MAX_CHARS
    ? purpose
    : `${purpose.slice(0, EXEC_PURPOSE_MAX_CHARS - 1)}…`;
}

/** True when the persisted output file no longer exists on disk (best-effort). */
function execOutputFileMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch {
    return true;
  }
}

/** Resolve a list position (1-based) or a stable run id against the fresh listing. */
function resolveExecRun(runs: ExecHistoryEntry[], key: string): { entry: ExecHistoryEntry; position: number } | undefined {
  const byId = runs.find((e) => e.id === key);
  if (byId) return { entry: byId, position: runs.indexOf(byId) + 1 };
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10);
    if (idx >= 1 && idx <= runs.length) return { entry: runs[idx - 1], position: idx };
  }
  return undefined;
}

async function handleLogsExec(basePath: string, ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  // Re-listed on every invocation — listings never hold stale references
  // across invocations; identity-sensitive actions (copy) address runs by id.
  const runs = listExecHistory(basePath);

  // /gsd logs exec — list recent runs
  if (rest.length === 0) {
    if (runs.length === 0) {
      ctx.ui.notify(
        "No exec output logs found.\n\nExec output logs persist under .gsd/exec/ when gsd_exec or gsd_uat_exec runs.",
        "info",
      );
      return;
    }

    const lines: string[] = ["Exec Output Logs (.gsd/exec/, newest first):", ""];
    const recent = runs.slice(0, EXEC_LIST_LIMIT);
    for (let i = 0; i < recent.length; i++) {
      const e = recent[i];
      const purpose = execPurposeText(e);
      const label = purpose ? ` — ${purpose}` : "";
      lines.push(`  ${i + 1}. ${sanitizeExecDisplayText(e.id)} · ${sanitizeExecDisplayText(e.runtime)} · ${execExitText(e)} · stdout ${e.stdout_bytes}B / stderr ${e.stderr_bytes}B${label}`);
    }
    if (runs.length > recent.length) {
      lines.push(`  ... and ${runs.length - recent.length} older runs`);
    }
    lines.push("");
    lines.push("  Complete original paths: /gsd logs exec <#|run-id>");
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  const key = rest[0];
  const resolved = key ? resolveExecRun(runs, key) : undefined;
  if (!resolved) {
    ctx.ui.notify(`Exec run "${key ?? ""}" not found. Run /gsd logs exec to list runs.`, "warning");
    return;
  }
  const { entry } = resolved;

  // /gsd logs exec <N|id> — metadata with complete original paths
  if (rest.length === 1) {
    const stored = readStoredOutputPaths(entry.meta_path);
    const lines: string[] = [];
    lines.push(`Exec Run ${sanitizeExecDisplayText(entry.id)}`);
    lines.push("─".repeat(60));
    lines.push(`Runtime: ${sanitizeExecDisplayText(entry.runtime)}  |  Exit: ${execExitText(entry)}  |  ${entry.duration_ms}ms`);
    lines.push(`Started: ${entry.started_at}${entry.finished_at ? `  |  Finished: ${entry.finished_at}` : ""}`);
    const purpose = execPurposeText(entry);
    if (purpose) lines.push(`Purpose: ${purpose}`);
    lines.push("");
    for (const kind of ["stdout", "stderr"] as const) {
      const bytes = kind === "stdout" ? entry.stdout_bytes : entry.stderr_bytes;
      const truncated = kind === "stdout" ? entry.stdout_truncated : entry.stderr_truncated;
      const original = stored[kind] ?? (kind === "stdout" ? entry.stdout_path : entry.stderr_path);
      const derived = kind === "stdout" ? entry.stdout_path : entry.stderr_path;
      const flags = [`${bytes}B`];
      if (truncated) flags.push("truncated on disk");
      if (execOutputFileMissing(derived)) flags.push("local copy missing — original path still valid for its host");
      lines.push(`${kind} (${flags.join(", ")}):`);
      // Complete original path — reversible escape display, never shortened.
      lines.push(`  ${displayPath(original)}`);
      if (stored[kind] && stored[kind] !== derived) {
        lines.push(`  local sibling: ${displayPath(derived)}`);
      }
    }
    lines.push("");
    lines.push(`  Copy full path: /gsd logs exec ${sanitizeExecDisplayText(entry.id)} copy stdout`);
    lines.push(`                  /gsd logs exec ${sanitizeExecDisplayText(entry.id)} copy stderr`);
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  // /gsd logs exec <N|id> copy stdout|stderr
  if (rest.length === 3 && rest[1] === "copy" && (rest[2] === "stdout" || rest[2] === "stderr")) {
    const stream = rest[2];
    const stored = readStoredOutputPaths(entry.meta_path);
    const path = (stream === "stdout" ? stored.stdout : stored.stderr)
      ?? (stream === "stdout" ? entry.stdout_path : entry.stderr_path);
    // Clipboard writes emit terminal escapes / platform tool output on the
    // TTY streams; in RPC/print modes stdout is a protocol stream, so fall
    // back to displaying the complete path instead of writing to it.
    if (!process.stdout.isTTY) {
      ctx.ui.notify(
        `Clipboard is only available in an interactive terminal. Complete original ${stream} path:\n${displayPath(path)}`,
        "info",
      );
      return;
    }
    try {
      await logsClipboard.copy(path);
      ctx.ui.notify(
        `Copied complete original ${stream} path (${sanitizeExecDisplayText(entry.id)}) to clipboard:\n${displayPath(path)}`,
        "success",
      );
    } catch (error) {
      ctx.ui.notify(
        `Failed to copy ${stream} path: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return;
  }

  ctx.ui.notify("Usage: /gsd logs exec [<N>|<run-id>] [copy stdout|stderr]", "warning");
}

async function handleLogsClear(basePath: string, ctx: ExtensionCommandContext): Promise<void> {
  let removedActivity = 0;
  let removedDebug = 0;

  // Clear activity logs older than 7 days, keep the 5 most recent
  const activities = listActivityLogs(basePath);
  const keepRecent = activities.slice(-5);
  const keepSeqs = new Set(keepRecent.map(e => e.seq));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const e of activities) {
    if (keepSeqs.has(e.seq)) continue;
    if (e.mtime.getTime() < cutoff) {
      try {
        unlinkSync(join(activityDir(basePath), e.filename));
        removedActivity++;
      } catch { /* ignore */ }
    }
  }

  // Clear debug logs older than 3 days, keep latest 2
  const debugLogs = listDebugLogs(basePath);
  const keepDebug = debugLogs.slice(-2);
  const keepDebugNames = new Set(keepDebug.map(d => d.filename));
  const debugCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;

  for (const d of debugLogs) {
    if (keepDebugNames.has(d.filename)) continue;
    if (d.mtime.getTime() < debugCutoff) {
      try {
        unlinkSync(join(debugDir(basePath), d.filename));
        removedDebug++;
      } catch { /* ignore */ }
    }
  }

  if (removedActivity === 0 && removedDebug === 0) {
    ctx.ui.notify("No old logs to clear.", "info");
  } else {
    ctx.ui.notify(
      `Cleared ${removedActivity} activity log(s) and ${removedDebug} debug log(s).`,
      "info",
    );
  }
}
