// Lightweight registration: SQLite and the observer load only when explicitly invoked.
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "@gsd/pi-ai";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { CoordinationObservations, PidObservation } from "./cutover-coordination-inspection.js";

/** Signal zero reports this probe only, never the original owner's identity or death. */
export function observeLocalPid(pid: number, signalZero: (pid: number, signal: 0) => unknown = process.kill): PidObservation {
  try { signalZero(pid, 0); return "present"; } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ESRCH" ? "absent-at-probe" : code === "EPERM" ? "permission-denied" : "unknown";
  }
}

export async function readCutoverCoordination(input: unknown, observations?: CoordinationObservations) {
  const failure = (error: string) => ({ operation: "authority_cutover_coordination" as const, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_request");
  const request = input as { cwd?: unknown; limit?: unknown };
  if (typeof request.cwd !== "string" || request.cwd.length > 8192 || !isAbsolute(request.cwd)
    || (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 25))) {
    return failure("invalid_request");
  }
  try {
    const root = realpathSync(request.cwd);
    const rootIdentity = lstatSync(root, { bigint: true });
    if (!rootIdentity.isDirectory()) return failure("invalid_request");
    const gsd = join(root, ".gsd");
    // Do not follow a .gsd symlink to another checkout's database.
    const gsdIdentity = lstatSync(gsd, { bigint: true });
    if (!gsdIdentity.isDirectory() || realpathSync(gsd) !== gsd) return failure("database_unavailable_or_incompatible");
    const path = join(gsd, "gsd.db");
    let file;
    try { file = lstatSync(path, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return failure("database_missing");
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n) return failure("database_unavailable_or_incompatible");
    const { inspectSqliteReadOnlySnapshot } = await import("./sqlite-readonly.js");
    const { inspectCutoverCoordination } = await import("./cutover-coordination-inspection.js");
    const result = inspectSqliteReadOnlySnapshot(path, (db) => inspectCutoverCoordination(db, root,
      request.limit === undefined ? 10 : Number(request.limit), observations ?? {
        now: new Date().toISOString(), localHost: hostname(), selfPid: process.pid,
        aliasScope: randomUUID(), observePid: observeLocalPid, pidObservationTime: () => new Date().toISOString(),
      }));
    const after = lstatSync(path, { bigint: true });
    const rootAfter = lstatSync(root, { bigint: true });
    const gsdAfter = lstatSync(gsd, { bigint: true });
    if (realpathSync(request.cwd) !== root || realpathSync(gsd) !== gsd
      || rootAfter.dev !== rootIdentity.dev || rootAfter.ino !== rootIdentity.ino
      || gsdAfter.dev !== gsdIdentity.dev || gsdAfter.ino !== gsdIdentity.ino
      || after.dev !== file.dev || after.ino !== file.ino || !after.isFile() || after.nlink !== 1n) throw new Error("identity_changed");
    return result;
  } catch {
    // No raw SQL, paths, provider errors or partial counts cross this boundary.
    return failure("database_unavailable_or_incompatible");
  }
}

export function registerCutoverCoordinationRead(pi: ExtensionAPI): void {
  if (typeof pi.registerRuntimeRead === "function") {
    pi.registerRuntimeRead("authority_cutover_coordination", (input) => readCutoverCoordination(input));
  }
  pi.registerTool({
    name: "gsd_cutover_coordination_inspect",
    label: "Inspect cutover coordination",
    description: "Read-only bounded cutover guard snapshot. No initialization, admission, maintenance or recovery. PID probes do not establish original-owner identity or death.",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await readCutoverCoordination({ cwd: ctx.cwd, limit: params.limit });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
