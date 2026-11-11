// Fixed attended backend process. IPC supervision is NOT human consent.
import { ATTENDED_MAINTENANCE_LIMITS } from "./coordination-maintenance-limits.js";
if (!process.send || !process.connected || process.argv.length !== 2) {
  process.stderr.write('{"status":"refused","code":"maintenance-supervision-required"}\n');
  process.exitCode = 1;
} else {
  const parentPid = process.ppid;
  let running = false;
  const startup = setTimeout(() => process.exit(1), 5000);
  process.once("disconnect", () => {
    if (!running) process.exit(1);
    process.emit("SIGTERM");
    setTimeout(() => process.exit(1), ATTENDED_MAINTENANCE_LIMITS.cleanupMs);
  });
  process.once("message", async message => {
    process.channel?.ref();
    clearTimeout(startup);
    const start = message as Record<string, unknown>;
    if (!start || typeof start !== "object" || Object.keys(start).length !== 4 || start.type !== "maintenance-attended-start" ||
        start.parentPid !== parentPid || process.ppid !== parentPid || typeof start.projectDir !== "string" ||
        typeof start.token !== "string" || !/^[a-f0-9]{64}$/.test(start.token)) process.exit(1);
    try {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const backend = await import(new URL(`./coordination-maintenance-backend.${extension}`, import.meta.url).href) as typeof import("./coordination-maintenance-backend.js");
      if (!process.connected || process.ppid !== parentPid) process.exit(1);
      running = true;
      process.send?.({ type: "maintenance-attended-ready", token: start.token });
      process.exit(await backend.runAttendedCoordinationMaintenanceBackend(start.projectDir as string));
    } catch { process.exit(1); }
  });
  process.send({ type: "maintenance-attended-awaiting-start" });
}
