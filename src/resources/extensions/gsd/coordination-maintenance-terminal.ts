// Fixed native terminal boundary. Not a generic confirmation callback or grant factory.
// A controlling foreground PTY is NOT cryptographic proof that a human supplied input.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { isatty, ReadStream } from "node:tty";
import { performance } from "node:perf_hooks";
import { maintenanceDigest } from "./coordination-maintenance-review.js";

export function openMaintenanceTerminal() {
  if (process.platform !== "darwin") throw new Error("native Mac terminal required");
  const fd = openSync("/dev/tty", constants.O_RDWR | constants.O_NOCTTY | constants.O_NOFOLLOW);
  let output: number;
  try { output = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY | constants.O_NOFOLLOW); }
  catch (error) { closeSync(fd); throw error; }
  let stream: ReadStream;
  try { stream = new ReadStream(fd); }
  catch (error) { closeSync(fd); closeSync(output); throw error; }
  // ReadStream may set O_NONBLOCK. A separate open description keeps output
  // blocking, and every short write is completed before a page can be affirmed.
  const writeAll = (text: string, deadline: number) => {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      if (performance.now() >= deadline) throw new Error("terminal output expired");
      const written = writeSync(output, bytes, offset, bytes.length - offset);
      if (written < 1) throw new Error("incomplete terminal output");
      offset += written;
    }
  };
  let closed = false;
  let failed = false;
  let identity: string;
  const check = () => {
    if (closed || failed || !isatty(fd) || !fstatSync(fd).isCharacterDevice()) throw new Error("native terminal required");
    const result = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid=", "-o", "tpgid=", "-o", "tty="], {
      encoding: "utf8", env: { LC_ALL: "C", LANG: "C" }, timeout: 1000, maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(result.stdout ?? "");
    if (result.error || result.status !== 0 || result.stderr !== "" || !match || Number(match[1]) < 1 || match[1] !== match[2] || match[3] === "??") throw new Error("foreground controlling terminal required");
    const stat = fstatSync(fd);
    const destination = fstatSync(output);
    if (!destination.isCharacterDevice() || destination.dev !== stat.dev || destination.ino !== stat.ino || destination.rdev !== stat.rdev) throw new Error("terminal output changed");
    const current = maintenanceDigest([process.pid, process.ppid, String(stat.dev), String(stat.ino), String(stat.rdev), match[1], match[3]]);
    if (identity !== undefined && current !== identity) throw new Error("terminal changed");
    identity = current;
  };
  try { check(); } catch (error) { stream.destroy(); closeSync(output); throw error; }
  stream.on("error", () => { failed = true; });
  stream.pause();
  return Object.freeze({
    async review(lines: readonly string[], sealId: string, snapshotDigest: string, deadline: number, signal: AbortSignal): Promise<string> {
      const readDecision = (prompt: string, expected: string) => new Promise<void>((resolve, reject) => {
        let pending = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.pause();
          stream.off("data", data); stream.off("end", ended); stream.off("error", ended); stream.off("close", ended);
          signal.removeEventListener("abort", aborted);
          if (error) reject(error); else resolve();
        };
        const ended = () => finish(new Error("terminal disconnected"));
        const aborted = () => finish(new Error("native review cancelled"));
        const data = (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          if (Buffer.byteLength(pending) > 256 || /[^\x20-\x7e\r\n]/.test(pending)) { ended(); return; }
          if (!pending.includes("\n")) return;
          // No prefed extra decisions or generic yes; each prompt binds exact reviewed content.
          if (pending !== `${expected}\n` && pending !== `${expected}\r\n`) { ended(); return; }
          try { check(); signal.throwIfAborted(); finish(); } catch { ended(); }
        };
        const timer = setTimeout(aborted, Math.max(1, deadline - performance.now()));
        try {
          check(); signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error("review expired");
          writeAll(`${prompt}\n`, deadline);
          stream.on("data", data); stream.once("end", ended); stream.once("error", ended); stream.once("close", ended);
          signal.addEventListener("abort", aborted, { once: true });
          stream.resume();
        } catch { ended(); }
      });
      for (let offset = 0; offset < lines.length; offset += 20) {
        check(); signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error("review expired");
        writeAll(`${lines.slice(offset, offset + 20).join("\n")}\n`, deadline);
        if (offset + 20 < lines.length) {
          const next = `NEXT ${Math.floor(offset / 20) + 1}`;
          await readDecision(`Inspect this page. Type ${next} to continue, anything else cancels.`, next);
        }
      }
      const decision = `ATTEST ${sealId} ${snapshotDigest}`;
      await readDecision(`Fresh complete-set attestation and selected release: type exactly ${decision}`, decision);
      check(); signal.throwIfAborted();
      return maintenanceDigest(["native-terminal-attestation-v1", identity!, sealId, snapshotDigest]);
    },
    close() { if (!closed) { closed = true; stream.destroy(); closeSync(output); } },
  });
}
