// Complete-set observations and escaped presentation. No authority is exported here.
import { createHash } from "node:crypto";
import type { DbAdapter } from "./db-adapter.js";
import { sameNativeMachineFacts, validatePreBootRecordTimes, type NativeSameMachineFacts } from "./coordination-same-machine-facts.js";

/** Detached immutable data, never a grant. Native boot/PID records contain only scalars. */
export function captureNativeMaintenanceFacts(facts: NativeSameMachineFacts): NativeSameMachineFacts {
  const captured = {
    boot: Object.freeze({ ...facts.boot }),
    pids: facts.pids.map(pid => Object.freeze({ ...pid })),
  };
  Object.freeze(captured.pids);
  return Object.freeze(captured);
}

export const ATTENDED_POLICY = "attested-preboot-original-owner-death-v1";
export const ATTENDED_REVIEW_MS = 600_000;
export const ATTENDED_CAPABILITY_MS = 30_000;
export const ATTENDED_WRITE_MS = 60_000;
const MAX_WORKERS = 1024;
const MAX_BYTES = 2_097_152;
type Row = Record<string, unknown>;
export interface MaintenanceReviewSnapshot {
  schemaVersion: number;
  applicationId: number;
  binding: string;
  root: string;
  projectId: string;
  revision: number;
  epoch: number;
  leases: Row[];
  workers: Row[];
  dispatches: Row[];
  attempts: Row[];
}
export function maintenanceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function refuse(): never { throw new Error("attended maintenance refused"); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function time(value: unknown): number {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return refuse();
  return Date.parse(value);
}
function canonicalRows(rows: Row[]): Row[] {
  return rows.map(row => {
    const result: Row = Object.create(null);
    for (const key of Object.keys(row).sort()) {
      const value = row[key];
      if (!(value === null || typeof value === "string" || typeof value === "number") ||
          (typeof value === "string" && value.length > 4096) || (typeof value === "number" && !Number.isSafeInteger(value))) return refuse();
      result[key] = value;
    }
    return result;
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}
/** Called only on an engine-owned correlated connection and consistent snapshot. */
export function collectMaintenanceReview(db: DbAdapter, identity: Pick<MaintenanceReviewSnapshot, "binding" | "root" | "projectId" | "schemaVersion" | "applicationId">): MaintenanceReviewSnapshot {
  const authority = db.prepare("SELECT project_id, project_root_realpath, revision, authority_epoch FROM project_authority WHERE singleton = 1").get();
  if (!authority || authority.project_id !== identity.projectId || authority.project_root_realpath !== identity.root || !integer(authority.revision) || !integer(authority.authority_epoch)) return refuse();
  // Reject oversized text in SQL before materializing any permission-bearing row.
  const boundedText = (table: "workers" | "milestone_leases", predicate: string, columns: readonly string[]) => {
    const invalid = columns.map(column => `(typeof(${column}) != 'text' OR length(CAST(${column} AS BLOB)) > 4096)`).join(" OR ");
    if (db.prepare(`SELECT 1 FROM ${table} WHERE (${predicate}) AND (${invalid}) LIMIT 1`).get()) return refuse();
  };
  boundedText("workers", "status IS NULL OR status != 'stopped'", ["worker_id", "host", "started_at", "version", "last_heartbeat_at", "status", "project_root_realpath"]);
  boundedText("milestone_leases", "status = 'held'", ["milestone_id", "worker_id", "acquired_at", "expires_at", "status"]);
  // Nonempty work sets always refuse: do not materialize attacker-sized payloads.
  if (db.prepare("SELECT 1 FROM unit_dispatches WHERE status IN ('pending', 'claimed', 'running') LIMIT 1").get()
    || db.prepare("SELECT 1 FROM workflow_execution_attempts WHERE attempt_state IN ('claimed', 'running') LIMIT 1").get()) return refuse();
  const snapshot = {
    ...identity, revision: authority.revision, epoch: authority.authority_epoch,
    leases: canonicalRows(db.prepare("SELECT milestone_id, worker_id, fencing_token, acquired_at, expires_at, status FROM milestone_leases WHERE status = 'held' LIMIT 2").all()),
    workers: canonicalRows(db.prepare("SELECT worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath FROM workers WHERE status IS NULL OR status != 'stopped' LIMIT 1025").all()),
    dispatches: [] as Row[],
    attempts: [] as Row[],
  };
  if (snapshot.leases.length !== 1 || snapshot.workers.length === 0 || snapshot.workers.length > MAX_WORKERS || snapshot.dispatches.length || snapshot.attempts.length || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) return refuse();
  const lease = snapshot.leases[0];
  if (typeof lease.milestone_id !== "string" || !integer(lease.fencing_token) || lease.fencing_token < 1 || time(lease.acquired_at) > time(lease.expires_at) || time(lease.expires_at) > Date.now()) return refuse();
  const selected = snapshot.workers.find(row => row.worker_id === lease.worker_id);
  if (!selected || selected.status !== "stopping") return refuse();
  for (const row of snapshot.workers) {
    if (typeof row.worker_id !== "string" || !row.worker_id || typeof row.host !== "string" || !row.host || row.project_root_realpath !== identity.root ||
        (row.status !== "stopping" && row.status !== "crashed") || !integer(row.pid) || row.pid < 1 || row.pid > 2_147_483_647 ||
        time(row.started_at) > time(row.last_heartbeat_at) || time(row.last_heartbeat_at) > Date.now()) return refuse();
  }
  return snapshot;
}
/** Observations may advance, but wall-clock regression or drift cannot renew consent. */
export function stableMaintenanceFacts(original: NativeSameMachineFacts, current: NativeSameMachineFacts, initialMonotonicMs: number, currentMonotonicMs: number): boolean {
  const wallElapsed = current.boot.observedAtMs - original.boot.observedAtMs;
  const monotonicElapsed = currentMonotonicMs - initialMonotonicMs;
  return wallElapsed >= 0 && monotonicElapsed >= 0 && Math.abs(wallElapsed - monotonicElapsed) <= 1000 && sameNativeMachineFacts(original, current);
}
export function maintenanceReviewProof(snapshot: MaintenanceReviewSnapshot, facts: NativeSameMachineFacts, initialObservationAtMs: number) {
  if (!Number.isSafeInteger(initialObservationAtMs) || initialObservationAtMs > facts.boot.observedAtMs || !sameNativeMachineFacts(facts, facts)) return refuse();
  const lease = snapshot.leases[0];
  const counts = { legacyAbsent: 0, attestedAbsent: 0, attestedReused: 0 };
  const members = snapshot.workers.map(row => {
    const fact = facts.pids.find(entry => entry.pid === row.pid);
    if (!fact) return refuse();
    // This distinct policy conservatively requires preboot chronology for the full set.
    const record = { startedAt: String(row.started_at), lastHeartbeatAt: String(row.last_heartbeat_at),
      ...(row.worker_id === lease.worker_id ? { acquiredAt: String(lease.acquired_at), expiresAt: String(lease.expires_at) } : {}) };
    if (!validatePreBootRecordTimes(record, facts.boot) || (fact.state === "present" &&
        (fact.startedLowerBoundMs! <= facts.boot.bootUpperBoundMs || fact.startedUpperBoundMs! >= initialObservationAtMs))) return refuse();
    let category: keyof typeof counts;
    if (row.host === facts.boot.currentHost && fact.state === "absent") category = "legacyAbsent";
    else {
      category = fact.state === "absent" ? "attestedAbsent" : "attestedReused";
    }
    counts[category]++;
    return { worker: row, process: fact, category };
  });
  const expectedPids = new Set(snapshot.workers.map(row => row.pid));
  if (facts.pids.length !== expectedPids.size || facts.pids.some(row => !expectedPids.has(row.pid))) return refuse();
  const hosts = [...new Set(snapshot.workers.map(row => String(row.host)))].sort();
  if (hosts.length > MAX_WORKERS) return refuse();
  return { counts, hosts, members };
}
/** Printable ASCII only: stored ESC/C1/bidi/control characters cannot instruct the terminal. */
export function maintenanceReviewLine(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function maintenanceReviewPresentation(snapshot: MaintenanceReviewSnapshot, facts: NativeSameMachineFacts, sealId: string, initialObservationAtMs: number): string[] {
  const proof = maintenanceReviewProof(snapshot, facts, initialObservationAtMs);
  const lines = ["NATIVE ATTENDED COORDINATION RECOVERY - OPERATOR ATTESTATION, NOT HARDWARE VERIFICATION",
    maintenanceReviewLine({ policy: ATTENDED_POLICY, root: snapshot.root, projectId: snapshot.projectId, binding: snapshot.binding,
      schemaVersion: snapshot.schemaVersion, applicationId: snapshot.applicationId, revision: snapshot.revision, epoch: snapshot.epoch, snapshot: maintenanceDigest(snapshot), sealId,
      workers: snapshot.workers.length, heldLeases: snapshot.leases.length, dispatches: snapshot.dispatches.length, attempts: snapshot.attempts.length,
      originalHosts: proof.hosts, currentBoot: facts.boot, initialObservationAtMs, proofCounts: proof.counts }),
    maintenanceReviewLine({ selectedLease: snapshot.leases[0] }),
    ...proof.members.map((member, index) => maintenanceReviewLine({ member: index + 1, total: proof.members.length, ...member })),
    "Attest EVERY enumerated original owner belonged to THIS physical Mac's relevant OS installation/instance, NOT a clone, VM, another volume or other host still able to operate.",
    "Unknown members: CANCEL. Chronology assumes original clocks were correct. PTYs can be automated; this is NOT cryptographic human-presence assurance.",
    "Only the selected lease is released; worker history is unchanged. Ambiguous outcome: reconcile the sealId receipt, NOT blind retry."];
  if (Buffer.byteLength(lines.join("\n")) > MAX_BYTES) return refuse();
  return lines;
}
