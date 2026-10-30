// Fixed private backend entry. Bare execution refuses BEFORE importing the engine host.
const refuse = () => {
  process.stderr.write('{"status":"refused","code":"maintenance-supervision-required"}\n');
  process.exitCode = 1;
};

if (!process.send || !process.connected || process.argv.length !== 2) {
  refuse();
} else {
  const parentPid = process.ppid;
  const startup = setTimeout(() => process.exit(1), 5_000);
  let disconnected = false;
  let backendRunning = false;
  let cleanupMs = 0;
  let disconnectDeadline: ReturnType<typeof setTimeout> | undefined;
  const onDisconnect = () => {
    disconnected = true;
    if (!backendRunning) { process.exit(1); return; }
    process.emit("SIGTERM");
    disconnectDeadline = setTimeout(() => process.exit(1), cleanupMs);
  };
  process.once("disconnect", onDisconnect);
  process.once("message", async message => {
    // once() removes the last IPC listener before this async callback runs.
    // Keep ownership live across cold imports, which need not hold a JS handle.
    process.channel?.ref();
    clearTimeout(startup);
    if (!message || typeof message !== "object") { process.exit(1); }
    const start = message as { type?: unknown; token?: unknown; parentPid?: unknown; projectDir?: unknown };
    if (start.type !== "maintenance-start" || start.parentPid !== parentPid || process.ppid !== parentPid ||
        typeof start.token !== "string" || !/^[a-f0-9]{64}$/.test(start.token) || typeof start.projectDir !== "string") {
      process.exit(1);
    }
    try {
      // Source and packaged builds resolve their OWN fixed sibling. No caller path.
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const backendUrl = new URL(`./coordination-maintenance-backend.${extension}`, import.meta.url);
      // Source execution already inherits its Node TS loader from the frontend.
      // Do not nest a second compiler around the transport and its IPC lifecycle.
      const backend = await import(backendUrl.href);
      const { MAINTENANCE_LIMITS } = await import("./coordination-maintenance-limits.js");
      cleanupMs = MAINTENANCE_LIMITS.cleanupMs;
      const { runCoordinationMaintenanceProtocol } = backend as typeof import("./coordination-maintenance-backend.js");
      const running = runCoordinationMaintenanceProtocol(start.projectDir, { input: process.stdin, output: process.stdout, signals: process });
      backendRunning = true;
      if (disconnected) process.emit("SIGTERM");
      process.send?.({ type: "maintenance-ready", token: start.token });
      const code = await running;
      if (disconnectDeadline) clearTimeout(disconnectDeadline);
      process.off("disconnect", onDisconnect);
      process.exit(code);
    } catch {
      if (disconnectDeadline) clearTimeout(disconnectDeadline);
      process.off("disconnect", onDisconnect);
      process.exit(1);
    }
  });
  // Announce listener installation before the parent sends its one-shot challenge.
  process.send({ type: "maintenance-awaiting-start" });
}

export {};
