// Fixed frontend supervisor. Never reads or produces a native attestation.
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ATTENDED_MAINTENANCE_LIMITS, MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";

export function runAttendedMaintenanceFrontend(projectDir: string): Promise<number> {
  return new Promise(resolve => {
    let child: ChildProcess | undefined;
    let stopping = false;
    let finished = false;
    let started = false;
    let ready = false;
    let writing = false;
    let bytes = 0;
    let pending = 0;
    let exitCode = 1;
    let disconnect: ReturnType<typeof setTimeout> | undefined;
    let writer: ReturnType<typeof setTimeout> | undefined;
    let kill: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const done = () => { if (finished && pending === 0) { clearTimeout(flush); resolve(exitCode); } };
    const finish = (code: number) => {
      if (finished) return;
      finished = true; exitCode = code;
      clearTimeout(total); clearTimeout(writer); clearTimeout(kill); clearTimeout(hard); clearTimeout(disconnect);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
      process.stdout.off("error", stop); process.stderr.off("error", stop);
      if (pending) flush = setTimeout(() => process.exit(code), ATTENDED_MAINTENANCE_LIMITS.cleanupMs);
      done();
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      child?.kill("SIGTERM");
      kill = setTimeout(() => child?.kill("SIGKILL"), ATTENDED_MAINTENANCE_LIMITS.cleanupMs / 2);
      hard = setTimeout(() => {
        child?.stdout?.destroy(); child?.stderr?.destroy();
        if (child?.connected) child.disconnect();
        child?.unref(); finish(1);
      }, ATTENDED_MAINTENANCE_LIMITS.cleanupMs);
    };
    // Independent of all synchronous OS/database work in the child.
    const total = setTimeout(stop, ATTENDED_MAINTENANCE_LIMITS.reviewMs);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
    process.stdout.on("error", stop); process.stderr.on("error", stop);
    try {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const token = randomBytes(32).toString("hex");
      child = fork(new URL(`./coordination-maintenance-attended-worker.${extension}`, import.meta.url), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.on("error", stop);
      child.on("disconnect", () => { if (!finished && !stopping) disconnect = setTimeout(stop, ATTENDED_MAINTENANCE_LIMITS.cleanupMs); });
      child.once("close", code => finish(!stopping && code === 0 ? 0 : 1));
      const relay = (source: NodeJS.ReadableStream, destination: NodeJS.WriteStream) => {
        source.on("error", stop);
        source.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAINTENANCE_LIMITS.totalBytes || stopping) { stop(); return; }
          pending++;
          try {
            if (!destination.write(chunk, error => { pending--; if (error) stop(); done(); })) source.pause();
          } catch { pending--; stop(); done(); }
        });
        destination.on("drain", () => { if (!stopping) source.resume(); });
      };
      relay(child.stdout!, process.stdout); relay(child.stderr!, process.stderr);
      child.on("message", message => {
        const reply = message as { type?: string; token?: string };
        if (reply?.type === "maintenance-attended-awaiting-start" && !started && !stopping) {
          started = true;
          child?.send({ type: "maintenance-attended-start", parentPid: process.pid, token, projectDir }, error => { if (error) stop(); });
        } else if (reply?.type === "maintenance-attended-ready" && started && reply.token === token) ready = true;
        else if (reply?.type === "maintenance-attended-writing" && ready && !writing && !stopping) {
          writing = true;
          // Review budget ends here. Keep only the write deadline supervising the writer,
          // so the review timer cannot kill the worker mid-commit or drop its reply.
          clearTimeout(total);
          writer = setTimeout(stop, ATTENDED_MAINTENANCE_LIMITS.writeMs);
        } else stop();
      });
    } catch { stop(); }
  });
}
