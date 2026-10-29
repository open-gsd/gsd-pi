// Public native frontend: no engine, database, managed resources or normal loader.
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";
export { MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";

const COMMAND = "coordination-maintenance";
const HELP = "Usage: gsd coordination-maintenance --project ABS --json\n";
export function parseCoordinationMaintenanceArgs(args: readonly string[]): { projectDir: string } | "help" | null {
  if (args.length === 2 && args[0] === COMMAND && args[1] === "--help") return "help";
  if (args.length !== 4 || args[0] !== COMMAND || args[1] !== "--project" || args[3] !== "--json") return null;
  const projectDir = args[2];
  return projectDir && isAbsolute(projectDir) && !projectDir.includes("\0") ? { projectDir } : null;
}

/** Only the fixed package backend is executable; no public program/loader/SQL option. */
export async function runCoordinationMaintenanceCli(args: readonly string[]): Promise<number> {
  const parsed = parseCoordinationMaintenanceArgs(args);
  if (parsed === "help") { process.stdout.write(HELP); return 0; }
  if (!parsed) { process.stdout.write('{"requestId":null,"result":{"status":"refused","code":"invalid-arguments"}}\n'); return 2; }
  return await new Promise<number>(resolve => {
    let child: ChildProcess | undefined;
    let ready = false;
    let inputEnded = false;
    let handshakeSent = false;
    let pending = Buffer.alloc(0);
    let frames = 0;
    const queued: Buffer[] = [];
    let stopping = false;
    let finished = false;
    let inputRefused = false;
    let outputBytes = 0;
    let inputBytes = 0;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(cleanup); clearTimeout(hardStop);
      process.stdin.off("data", input); process.stdin.pause();
      resolve(code);
    };
    const status = (termination: string) => {
      // Fixed, redacted diagnostic only. Never wait for an obstructed output sink.
      if (!inputRefused && !process.stdout.destroyed) process.stdout.write(`${JSON.stringify({ status: "refused", code: "maintenance-unavailable", termination })}\n`);
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      process.stdin.pause();
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        status("confirmed"); finish(1); return;
      }
      child.stdin?.destroy();
      child.kill("SIGTERM");
      cleanup = setTimeout(() => child?.kill("SIGKILL"), MAINTENANCE_LIMITS.cleanupMs / 2);
      hardStop = setTimeout(() => {
        status("unconfirmed");
        child?.stdout?.destroy(); child?.stderr?.destroy();
        if (child?.connected) child.disconnect();
        child?.unref();
        finish(1);
      }, MAINTENANCE_LIMITS.cleanupMs);
    };
    // Installed before backend creation/load/factory: its event loop cannot block this timer.
    const deadline = setTimeout(stop, MAINTENANCE_LIMITS.lifetimeMs);
    const input = (chunk: Buffer) => {
      inputBytes += chunk.length;
      if (stopping || inputBytes > MAINTENANCE_LIMITS.totalBytes) { stop(); return; }
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (!frame || Array.isArray(frame) || typeof frame !== "object" ||
              Object.keys(frame).length !== 3 || !Object.keys(frame).every(key => ["requestId", "command", "input"].includes(key)) ||
              typeof frame.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frame.requestId) ||
              !["prepare", "apply", "receipt"].includes(frame.command as string)) throw new Error("frame");
        } catch { refuseInput(); return; }
        if (line.length > MAINTENANCE_LIMITS.frameBytes || ++frames > MAINTENANCE_LIMITS.frames) { refuseInput(); return; }
      }
      if (pending.length > MAINTENANCE_LIMITS.frameBytes) { refuseInput(); return; }
      if (!ready) queued.push(chunk);
      else if (!child?.stdin?.write(chunk)) process.stdin.pause();
    };
    const refuseInput = () => {
      if (inputRefused || stopping || finished) return;
      inputRefused = true;
      process.stdout.write('{"requestId":null,"result":{"status":"refused","code":"maintenance-refused"}}\n');
      stop();
    };
    process.stdin.on("data", input);
    process.stdin.once("end", () => {
      inputEnded = true;
      if (pending.length || frames === 0) { refuseInput(); return; }
      if (ready) child?.stdin?.end();
      // EOF after valid frames is normal pipe usage. The independent deadline
      // still cancels work even when the owned backend blocks synchronously.
    });
    process.stdin.resume();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
    process.stdin.once("error", stop);
    process.stdout.once("error", stop);
    process.stderr.once("error", stop);
    try {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const token = randomBytes(32).toString("hex");
      child = fork(new URL(`./coordination-maintenance-worker.${extension}`, import.meta.url), [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      child.on("error", stop);
      child.on("disconnect", () => { if (!finished && !stopping) cleanup = setTimeout(stop, MAINTENANCE_LIMITS.cleanupMs); });
      child.once("close", code => {
        if (stopping) status("confirmed");
        finish(stopping ? 1 : code === 0 ? 0 : 1);
      });
      const relay = (stream: NodeJS.ReadableStream, destination: NodeJS.WriteStream) => {
        stream.on("error", stop);
        stream.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > MAINTENANCE_LIMITS.totalBytes) { stop(); return; }
          if (!destination.write(chunk)) stream.pause();
        });
        destination.on("drain", () => { if (!stopping) stream.resume(); });
      };
      relay(child.stdout!, process.stdout); relay(child.stderr!, process.stderr);
      child.stdin!.on("error", stop);
      child.stdin!.on("drain", () => { if (ready && !stopping) process.stdin.resume(); });
      child.on("message", message => {
        const reply = message as { type?: string; token?: string };
        if (reply?.type === "maintenance-awaiting-start" && !handshakeSent && !stopping) {
          handshakeSent = true;
          child?.send({ type: "maintenance-start", token, parentPid: process.pid, projectDir: parsed.projectDir }, error => { if (error) stop(); });
          return;
        }
        if (ready || stopping || reply?.type !== "maintenance-ready" || reply.token !== token) { stop(); return; }
        ready = true;
        for (const chunk of queued) child?.stdin?.write(chunk);
        queued.length = 0;
        if (inputEnded) child?.stdin?.end();
        process.send?.({ type: "maintenance-ready" });
      });
    } catch { stop(); }
  });
}
