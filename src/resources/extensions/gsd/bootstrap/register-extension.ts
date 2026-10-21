// gsd-pi — Extension registration: wires all GSD tools, commands, and hooks into pi

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { registerExitCommand } from "../exit-command.js";
import { registerLazyWorktreeCommands } from "../worktree-command-bootstrap.js";
import type { GSDEcosystemBeforeAgentStartHandler } from "../ecosystem/gsd-extension-api.js";
import { registerDbTools } from "./db-tools.js";
import { registerDynamicTools } from "./dynamic-tools.js";
import { registerExecTools } from "./exec-tools.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerToolSearchShim } from "./tool-search-shim.js";
import { registerQueryTools } from "./query-tools.js";
import { registerScheduleWakeupTool } from "./schedule-wakeup-tool.js";
import { registerHooks } from "./register-hooks.js";
import { registerShortcuts } from "./register-shortcuts.js";
import { writeCrashLog } from "./crash-log.js";
import { logWarning, isGsdExtensionStderrEnabled } from "../workflow-logger.js";
import { UNIT_TOOL_CONTRACTS } from "../unit-tool-contracts.js";
import { installManifestFlushOnProcessTeardown } from "../workflow-manifest.js";
// Static import so cmux event listeners are registered synchronously during
// extension bootstrap. Prior implementation used `void import().then()` which
// queued listener registration as a microtask — any CMUX_CHANNELS emit fired
// in the same event loop turn as registration (e.g. from a provider-error
// session hook calling startAuto) would be silently dropped because Node's
// EventEmitter does not buffer events for late subscribers.
import { initCmuxEventListeners } from "../../cmux/index.js";

export { writeCrashLog } from "./crash-log.js";

// Pipe-closed storm guard. #99/#101 stopped EPIPE from flooding ~/.gsd/crash,
// but a persistently-broken output pipe whose `destroyed`/`writableEnded` flags
// never flip is still swallowed on every write — a tight, progress-free CPU
// spin. If the pipe-closed error fires in a tight loop the pipe is gone for
// good; exit cleanly instead.
const EPIPE_STORM_THRESHOLD = 100;
const EPIPE_STORM_WINDOW_MS = 10_000;
let epipeCount = 0;
let epipeWindowStart = 0;

export const CRITICAL_GSD_WORKFLOW_TOOL_NAMES = [...new Set(
  Object.values(UNIT_TOOL_CONTRACTS)
    .flatMap((contract) => contract.requiredWorkflowTools)
    .filter((toolName) => toolName.startsWith("gsd_")),
)].sort();

/** Write to stderr without ever re-throwing — stderr can EPIPE too, which would
 *  re-enter this handler and re-loop. */
function safeStderr(msg: string): void {
  if (!isGsdExtensionStderrEnabled()) return;
  try {
    process.stderr.write(msg);
  } catch { /* stderr is also broken; nothing we can do */ }
}

/** A peer closing the read end of a pipe mid-write surfaces differently per
 *  platform: POSIX throws `EPIPE`; Windows throws `Error: write EOF` (or
 *  `read EOF`) with no `code` set, from node:internal/stream_base_commons.
 *  Both are the same logical condition and must be treated as recoverable —
 *  otherwise the Windows EOF variant escapes to the uncaught-exception path
 *  and crashes auto-mode workers mid-iteration (#181). ECONNRESET is NOT
 *  included here: it commonly comes from network sockets (#182 follow-up) and
 *  is a real error that should surface rather than be silently swallowed. */
function isPipeClosedError(err: Error): boolean {
  const errno = (err as NodeJS.ErrnoException).code;
  if (errno === "EPIPE") return true;
  const message = err.message;
  return message === "write EOF" || message === "read EOF";
}

export function handleRecoverableExtensionProcessError(err: Error): boolean {
  if (err.message.includes("ProcessTransport is not ready for writing")) {
    safeStderr(`[gsd] swallowed dead transport control write: ${err.message}\n`);
    return true;
  }
  if (isPipeClosedError(err)) {
    const code = (err as NodeJS.ErrnoException).code;
    const tag = code ?? err.message;
    const stdoutGone = process.stdout.destroyed || process.stdout.writableEnded;
    if (stdoutGone) {
      process.exit(0);
    }
    const now = Date.now();
    if (now - epipeWindowStart > EPIPE_STORM_WINDOW_MS) {
      epipeWindowStart = now;
      epipeCount = 0;
    }
    if (++epipeCount > EPIPE_STORM_THRESHOLD) {
      safeStderr(
        `[gsd] ${tag} storm (${epipeCount} within ${EPIPE_STORM_WINDOW_MS}ms) — output pipe is gone; exiting.\n`,
      );
      process.exit(0);
    }
    safeStderr(
      `[gsd] swallowed ${tag} (syscall=${(err as NodeJS.ErrnoException).syscall ?? "?"})\n`,
    );
    return true;
  }
  if ((err as NodeJS.ErrnoException).code === "EIO") {
    const syscall = (err as NodeJS.ErrnoException).syscall;
    if (syscall === "read") {
      safeStderr(`[gsd] EIO: ${err.message}\n`);
      return true;
    }
  }
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    const syscall = (err as NodeJS.ErrnoException).syscall;
    if (syscall?.startsWith("spawn")) {
      safeStderr(`[gsd] spawn ENOENT: ${(err as any).path ?? "unknown"} — command not found\n`);
      return true;
    }
    if (syscall === "uv_cwd") {
      safeStderr(`[gsd] ENOENT (${syscall}): ${err.message}\n`);
      return true;
    }
  }
  return false;
}

export function installEpipeGuard(): void {
  if (!process.listeners("uncaughtException").some((listener) => listener.name === "_gsdEpipeGuard")) {
    const _gsdEpipeGuard = (err: Error): void => {
      if (handleRecoverableExtensionProcessError(err)) return;
      // Write crash log and exit cleanly for unrecoverable errors.
      // Logging and continuing was the original double-fault fix (#3163), but
      // continuing in an indeterminate state is worse than a clean exit (#3348).
      writeCrashLog(err, "uncaughtException");
      process.exit(1);
    };
    process.on("uncaughtException", _gsdEpipeGuard);
  }

  if (!process.listeners("unhandledRejection").some((listener) => listener.name === "_gsdRejectionGuard")) {
    const _gsdRejectionGuard = (reason: unknown, _promise: Promise<unknown>): void => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      if (handleRecoverableExtensionProcessError(err)) return;
      writeCrashLog(err, "unhandledRejection");
      process.exit(1);
    };
    process.on("unhandledRejection", _gsdRejectionGuard);
  }
}

/**
 * Assert that critical GSD workflow tools were registered.
 *
 * During extension loading, getAllTools() is a throwing stub
 * ("Extension runtime not initialized") that only becomes real after
 * runner.bindCore(). Calling it here used to throw, propagating to index.ts's
 * catch and firing "Extension setup partially failed" — which, under Claude
 * Code CLI, left the model's tool surface incomplete and trapped units in a
 * finalize-retry loop. Tolerate the pre-bind throw and defer the real check to
 * the first before_agent_start (where applyMinimalGsdToolSurface already
 * re-reads the registered surface post-bind).
 */
function assertCriticalGsdWorkflowToolsRegistered(pi: ExtensionAPI): void {
  if (typeof pi.getAllTools !== "function") return;

  let registered: Set<string>;
  try {
    registered = new Set(pi.getAllTools().map((tool) => tool.name));
  } catch {
    // Pre-bind runtime: getAllTools() is not yet wired. The critical-tools
    // invariant is re-checked post-bind during the first before_agent_start.
    return;
  }

  const missing = CRITICAL_GSD_WORKFLOW_TOOL_NAMES.filter((toolName) => !registered.has(toolName));
  if (missing.length === 0) return;

  const message = [
    `Critical GSD workflow tool registration failed; missing required tool(s): ${missing.join(", ")}.`,
    "Check earlier bootstrap warnings for the registration slot that failed.",
  ].join(" ");
  logWarning("bootstrap", message);
  throw new Error(message);
}

export function registerGsdExtension(pi: ExtensionAPI): void {
  // Note: registerGSDCommand is called by index.ts before this function,
  // so we intentionally skip it here to avoid double-registration.
  registerLazyWorktreeCommands(pi);
  registerExitCommand(pi);

  // Wire the Layer 2 event emitter bridge so deeply-nested GSD code can emit
  // extension events (git lifecycle, verify, budget, milestone, unit) without
  // threading `pi` through every call site.
  import("../hook-emitter.js")
    .then(({ setHookEmitter }) => setHookEmitter(pi))
    .catch((err) => {
      // Non-fatal — emitters simply become no-ops if this import fails, but
      // surface the failure so silent bootstrap breakage is debuggable.
      process.stderr.write(
        `[gsd] Failed to bootstrap hook-emitter bridge: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    });

  installEpipeGuard();
  installManifestFlushOnProcessTeardown();

  // Ecosystem handlers captured by the GSDExtensionAPI wrapper for the
  // GSD-owned `before_agent_start` dispatch step (#3338).
  const ecosystemHandlers: GSDEcosystemBeforeAgentStartHandler[] = [];

  pi.registerCommand("kill", {
    description: "Exit GSD immediately (no cleanup)",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      process.exit(0);
    },
  });

  // ToolSearch is a compatibility stub — register early so it stays in the
  // active tool set even when later bootstrap steps fail partially.
  try {
    registerToolSearchShim(pi);
  } catch (err) {
    logWarning(
      "bootstrap",
      `Failed to register tool-search-shim: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wrap non-critical registrations individually so one failure
  // doesn't prevent the others from loading.
  const nonCriticalRegistrations: Array<[string, () => void]> = [
    ["dynamic-tools", () => registerDynamicTools(pi)],
    ["db-tools", () => registerDbTools(pi)],
    ["journal-tools", () => registerJournalTools(pi)],
    ["query-tools", () => registerQueryTools(pi)],
    ["memory-tools", () => registerMemoryTools(pi)],
    ["exec-tools", () => registerExecTools(pi)],
    ["schedule-wakeup-tool", () => registerScheduleWakeupTool(pi)],
    ["shortcuts", () => registerShortcuts(pi)],
    // cmux is a library (no pi), so gsd sets up the event listeners on its
    // behalf using the shared event channel contract. Registration is
    // synchronous — see the import comment above for the rationale.
    ["cmux-events", () => initCmuxEventListeners(pi.events)],
    ["hooks", () => registerHooks(pi, ecosystemHandlers)],
    ["ecosystem", () => {
      void import("../ecosystem/loader.js")
        .then(({ loadEcosystemExtensions }) => loadEcosystemExtensions(pi, ecosystemHandlers))
        .catch((err) => {
          logWarning(
            "ecosystem",
            `loader failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }],
  ];

  for (const [name, register] of nonCriticalRegistrations) {
    try {
      register();
    } catch (err) {
      logWarning(
        "bootstrap",
        `Failed to register ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  assertCriticalGsdWorkflowToolsRegistered(pi);
}
