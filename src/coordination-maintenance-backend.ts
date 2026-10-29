// Native transport boundary. The engine owns authorization and all inner inputs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveBundledGsdExtensionModule, resolvePackageRoot } from "./bundled-resource-path.js";
import type { CoordinationMaintenanceFrame, CoordinationMaintenanceHost, CoordinationMaintenanceModule, CoordinationMaintenanceReply } from "./resources/shared/coordination-maintenance-contract.js";

const COMMAND = "coordination-maintenance";
import { MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";
export { MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";
const HELP = "Usage: gsd coordination-maintenance --project ABS --json\nBounded newline JSON: {requestId,command:prepare|apply|receipt,input}\nNo ordinary session is started. Apply authorization is enforced separately by the engine.\n";

function parseFrame(line: Buffer): CoordinationMaintenanceFrame | null {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    value = JSON.parse(text);
  } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // JSON.parse yields only own data properties, never accessors or caller prototypes.
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame);
  if (keys.length !== 3 || !keys.every(key => key === "requestId" || key === "command" || key === "input")) return null;
  if (typeof frame.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frame.requestId)) return null;
  if (frame.command !== "prepare" && frame.command !== "apply" && frame.command !== "receipt") return null;
  return frame as unknown as CoordinationMaintenanceFrame;
}

// Read-only equivalent of the ordinary newer-managed-resource fence. Do not import
// resource-loader: this path must never discover, initialize, copy or sync resources.
export function assertMaintenancePackageCompatibility(): void {
  const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(import.meta.url), "package.json"), "utf8"));
  const agentDir = process.env.GSD_AGENT_DIR || join(process.env.GSD_HOME || join(homedir(), ".gsd"), "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.packageName !== pkg.name) return;
  const release = (value: unknown): number[] => {
    if (typeof value !== "string" || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(value)) throw new Error("incompatible");
    return value.replace(/^v/, "").split(/[-+]/, 1)[0].split(".").map(Number);
  };
  const current = release(pkg.version);
  const managed = release(manifest.gsdVersion);
  for (let i = 0; i < 3; i++) {
    if (managed[i] > current[i]) throw new Error("incompatible");
    if (managed[i] < current[i]) return;
  }
}

async function openPackagedHost(projectDir: string, signal: AbortSignal): Promise<CoordinationMaintenanceHost> {
  assertMaintenancePackageCompatibility();
  const { createJiti } = await import("@mariozechner/jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: false, debug: false, fsCache: false });
  const engine = await jiti.import(resolveBundledGsdExtensionModule(import.meta.url, "coordination-maintenance.ts")) as CoordinationMaintenanceModule;
  // Cancellation during module loading must never open a late database handle.
  signal.throwIfAborted();
  // Actual provenance is derived by the engine, not accepted from argv or JSON.
  return engine.openCoordinationMaintenanceHost({ projectDir });
}

export interface MaintenanceTransport {
  input: Readable;
  output: Writable;
  signals?: NodeJS.Process;
}

/** Unit seam mocks only the fixed host interface; it is not writer proof. */
export async function runCoordinationMaintenanceProtocol(
  projectDir: string,
  transport: MaintenanceTransport,
  openHost: (projectDir: string, signal: AbortSignal) => Promise<CoordinationMaintenanceHost> = openPackagedHost,
): Promise<number> {
  const { input, output, signals } = transport;
  let host: CoordinationMaintenanceHost | undefined;
  let requestId: string | null = null;
  let pending = Buffer.alloc(0);
  let totalBytes = 0;
  let frames = 0;
  let prepared = false;
  let stopped = false;
  let exitCode = 0;
  const cancellation = new AbortController();
  let deadlineReject: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; });
  // Attach immediately: timeout/signal may occur while waiting for stdin or import.
  void deadline.catch(() => {});
  const stop = () => {
    stopped = true;
    cancellation.abort();
    deadlineReject(new Error("stopped"));
    input.destroy();
  };
  const timer = setTimeout(stop, MAINTENANCE_LIMITS.lifetimeMs);
  signals?.on("SIGINT", stop);
  signals?.on("SIGTERM", stop);
  output.on("error", stop);
  const emit = async (result: CoordinationMaintenanceReply) => {
    const line = JSON.stringify({ requestId, result }) + "\n";
    if (Buffer.byteLength(line) > MAINTENANCE_LIMITS.frameBytes) throw new Error("reply-limit");
    await Promise.race([new Promise<void>((resolve, reject) => {
      output.write(line, error => error ? reject(error) : resolve());
    }), deadline]);
  };
  try {
    const iterator = input[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > MAINTENANCE_LIMITS.totalBytes) throw new Error("input-limit");
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        requestId = null;
        if (newline > MAINTENANCE_LIMITS.frameBytes || ++frames > MAINTENANCE_LIMITS.frames) throw new Error("frame-limit");
        const frame = parseFrame(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        if (!frame) throw new Error("invalid-frame");
        requestId = frame.requestId;
        if (frame.command === "prepare" && prepared) throw new Error("retarget");
        if (!host) {
          const opening = openHost(projectDir, cancellation.signal).then(opened => {
            if (stopped) { opened.close(); throw new Error("stopped"); }
            return opened;
          });
          host = await Promise.race([opening, deadline]);
        }
        let result: CoordinationMaintenanceReply;
        switch (frame.command) {
          case "prepare": prepared = true; result = host.prepare(frame.input); break;
          case "apply": result = host.apply(frame.input); break;
          case "receipt": result = host.receipt(frame.input); break;
        }
        if (!["prepared", "committed", "replayed", "refused"].includes(result.status)) throw new Error("invalid-reply");
        await emit(result);
        if (result.status === "refused") { exitCode = 1; return exitCode; }
        requestId = null;
      }
      if (pending.length > MAINTENANCE_LIMITS.frameBytes) throw new Error("frame-limit");
    }
    if (pending.length !== 0 || frames === 0) throw new Error("incomplete-frame");
  } catch {
    exitCode = 1;
    // Exceptions may contain paths, argv, tokens or raw input. Never serialize them.
    if (!stopped) {
      try { await emit({ status: "refused", code: "maintenance-refused" }); } catch { /* Broken output is terminal. */ }
    }
  } finally {
    clearTimeout(timer);
    signals?.off("SIGINT", stop);
    signals?.off("SIGTERM", stop);
    output.off("error", stop);
    input.destroy();
    try { host?.close(); } catch { exitCode = 1; }
  }
  return exitCode;
}
