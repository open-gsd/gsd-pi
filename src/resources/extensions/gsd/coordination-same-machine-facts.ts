/**
 * Read-only OS observations, NEVER consent, worker ownership or maintenance authority.
 * Boot-session UUID is ephemeral, not hardware identity. Matching facts do not prove
 * the same physical machine. An attended operator attestation is a separate future
 * native step. Preboot reasoning assumes the original record clock was correct.
 * Preserve original stored timestamp strings outside this module for outer fencing.
 * ps birth identity has one-second resolution: even matching PID/birth bounds do
 * not exclude reuse within that second and cannot identify the original worker.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

export interface NativeSameMachineBootFacts {
  currentHost: string;
  bootSessionHash: string;
  bootLowerBoundMs: number;
  bootUpperBoundMs: number;
  observedAtMs: number;
}

export interface NativeSameMachinePidFact {
  pid: number;
  state: "absent" | "present";
  processIdentity: string | null;
  startedLowerBoundMs?: number;
  startedUpperBoundMs?: number;
}

export interface NativeSameMachineFacts {
  boot: NativeSameMachineBootFacts;
  pids: NativeSameMachinePidFact[];
}

type RefusalCode = "unsupported-platform" | "invalid-pids" | "invalid-boot" |
  "native-command-failed" | "collection-budget" | "unknown-pid" | "ambiguous-pid" | "inconsistent-facts";

export class NativeSameMachineFactsError extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode) {
    super(code); // Never expose native stderr, UUID, host or process details in errors.
    this.code = code;
    this.name = "NativeSameMachineFactsError";
  }
}

const COLLECTION_BUDGET_MS = 5000;
const COMMAND_TIMEOUT_MS = 750;
const MAX_OUTPUT_BYTES = 65536;
const MAX_PIDS = 1024;
const MAX_PID = 2147483647;
const HASH = /^[a-f0-9]{64}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fail = (code: RefusalCode): never => { throw new NativeSameMachineFactsError(code); };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0 && ms < 8640000000000000;

/** Returns a copy; rejects duplicates rather than silently changing the selected set. */
export function validateNativePidList(pids: readonly number[]): number[] {
  if (!Array.isArray(pids) || pids.length > MAX_PIDS) return fail("invalid-pids");
  const result = Array.from(pids);
  if (!result.every(validPid) || new Set(result).size !== result.length) return fail("invalid-pids");
  return result;
}

function calendarMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

/** Numeric timeval and optional UTC/C printable suffix must agree. */
export function parseNativeBootTime(text: string): Pick<NativeSameMachineBootFacts, "bootLowerBoundMs" | "bootUpperBoundMs"> {
  if (typeof text !== "string" || text.length > 256) return fail("invalid-boot");
  const match = /^\{ sec = ([0-9]{1,12}), usec = ([0-9]{1,6}) \}(?: (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})?\n?$/.exec(text);
  if (!match || match[0] !== text) return fail("invalid-boot");
  const sec = Number(match[1]);
  const usec = Number(match[2]);
  const lower = sec * 1000 + Math.floor(usec / 1000);
  if (sec <= 0 || usec > 999999 || !validMs(lower)) return fail("invalid-boot");
  const suffix = text.replace(/\n$/, "").split("} ")[1];
  if (suffix !== undefined) {
    try {
      if (parseUtcPsStart(suffix).startedLowerBoundMs !== sec * 1000) return fail("invalid-boot");
    } catch { return fail("invalid-boot"); }
  }
  // Outward integer rounding includes the native microsecond precision interval.
  return { bootLowerBoundMs: lower, bootUpperBoundMs: lower + 1 };
}

export function parseNativeBootSessionUuid(text: string): string {
  if (typeof text !== "string" || text.length > 37) return fail("invalid-boot");
  const uuid = text.replace(/\n$/, "").toLowerCase();
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(uuid);
  if (!match || match[0] !== uuid) return fail("invalid-boot");
  if (uuid === "00000000-0000-0000-0000-000000000000") return fail("invalid-boot");
  return hash(uuid);
}

/** ps runs under fixed UTC/C. lstart only resolves seconds, hence a full second bound. */
export function parseUtcPsStart(text: string): { startedLowerBoundMs: number; startedUpperBoundMs: number } {
  if (typeof text !== "string" || text.length > 64) return fail("ambiguous-pid");
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(text);
  if (!match || match[0] !== text) return fail("ambiguous-pid");
  const ms = calendarMs(Number(match[7]), MONTHS.indexOf(match[2]) + 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (ms === null || !validMs(ms) || DAYS[new Date(ms).getUTCDay()] !== match[1]) return fail("ambiguous-pid");
  return { startedLowerBoundMs: ms, startedUpperBoundMs: ms + 1000 };
}

interface RecordTimeBounds { lowerNs: bigint; upperMs: number }

function recordTime(text: unknown): RecordTimeBounds | null {
  if (typeof text !== "string" || text.length > 40) return null;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(text);
  // Require complete explicit-zone input; never normalize stored strings.
  if (!match || match[0] !== text || match[8] === "-00:00") return null;
  let ms = calendarMs(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (ms === null) return null;
  const zone = match[8];
  if (zone !== "Z") {
    const hour = Number(zone.slice(1, 3));
    const minute = Number(zone.slice(4, 6));
    if (hour > 23 || minute > 59) return null;
    ms -= (zone[0] === "+" ? 1 : -1) * (hour * 60 + minute) * 60000;
  }
  const fraction = match[7] ?? "";
  const lowerNs = BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, "0"));
  const upperNs = lowerNs + 10n ** BigInt(9 - fraction.length);
  // Ceiling rounds toward the conservative side even for submillisecond precision.
  const upperMs = Number(upperNs / 1000000n) + (upperNs % 1000000n > 0n ? 1 : 0);
  return { lowerNs, upperMs };
}

function validBoot(boot: NativeSameMachineBootFacts): boolean {
  return !!boot && typeof boot.currentHost === "string" && boot.currentHost.length > 0 && boot.currentHost.length <= 255 &&
    !/[\s\x00-\x1f\x7f]/.test(boot.currentHost) && typeof boot.bootSessionHash === "string" && HASH.test(boot.bootSessionHash) &&
    validMs(boot.bootLowerBoundMs) && validMs(boot.bootUpperBoundMs) && validMs(boot.observedAtMs) &&
    boot.bootUpperBoundMs === boot.bootLowerBoundMs + 1 && boot.bootUpperBoundMs < boot.observedAtMs;
}

/** Pure bounded comparisons only. No normalized strings are returned or persisted. */
export function validatePreBootRecordTimes(record: {
  startedAt: string; lastHeartbeatAt: string; acquiredAt?: string; expiresAt?: string;
}, boot: NativeSameMachineBootFacts): boolean {
  if (!record || !validBoot(boot)) return false;
  const start = recordTime(record.startedAt);
  const heartbeat = recordTime(record.lastHeartbeatAt);
  if (!start || !heartbeat || start.lowerNs > heartbeat.lowerNs) return false;
  const selected = [start, heartbeat];
  if (record.acquiredAt !== undefined || record.expiresAt !== undefined) {
    const acquired = recordTime(record.acquiredAt);
    const expires = recordTime(record.expiresAt);
    if (!acquired || !expires || acquired.lowerNs > expires.lowerNs) return false;
    selected.push(acquired, expires);
  } else if (Object.hasOwn(record, "acquiredAt") || Object.hasOwn(record, "expiresAt")) {
    // Explicit undefined is not evidence that a selected lease had no fields.
    return false;
  }
  return selected.every(time => time.upperMs < boot.bootLowerBoundMs);
}

function validFacts(facts: NativeSameMachineFacts): boolean {
  if (!facts || !validBoot(facts.boot) || !Array.isArray(facts.pids) || facts.pids.length > MAX_PIDS) return false;
  const seen = new Set<number>();
  return facts.pids.every(fact => {
    if (!fact || !validPid(fact.pid) || seen.has(fact.pid)) return false;
    seen.add(fact.pid);
    if (fact.state === "absent") return fact.processIdentity === null && fact.startedLowerBoundMs === undefined && fact.startedUpperBoundMs === undefined;
    return fact.state === "present" && typeof fact.processIdentity === "string" && HASH.test(fact.processIdentity) &&
      validMs(fact.startedLowerBoundMs) && validMs(fact.startedUpperBoundMs) &&
      fact.startedLowerBoundMs > facts.boot.bootUpperBoundMs && fact.startedUpperBoundMs === fact.startedLowerBoundMs + 1000 &&
      fact.startedLowerBoundMs <= facts.boot.observedAtMs;
  });
}

/** Set comparison only; PID equality NEVER identifies the original recorded worker. */
export function sameNativeMachineFacts(a: NativeSameMachineFacts, b: NativeSameMachineFacts): boolean {
  if (!validFacts(a) || !validFacts(b)) return false;
  if (a.boot.currentHost !== b.boot.currentHost || a.boot.bootSessionHash !== b.boot.bootSessionHash ||
    a.boot.bootLowerBoundMs !== b.boot.bootLowerBoundMs || a.boot.bootUpperBoundMs !== b.boot.bootUpperBoundMs || a.pids.length !== b.pids.length) return false;
  const byPid = new Map(b.pids.map(fact => [fact.pid, fact]));
  return a.pids.every(fact => {
    const other = byPid.get(fact.pid);
    return !!other && fact.state === other.state && fact.processIdentity === other.processIdentity &&
      fact.startedLowerBoundMs === other.startedLowerBoundMs && fact.startedUpperBoundMs === other.startedUpperBoundMs;
  });
}

/** No production overrides: only a bounded numeric selection; all observations are native. */
export function collectNativeSameMachineFacts(pids: readonly number[]): NativeSameMachineFacts {
  if (process.platform !== "darwin") return fail("unsupported-platform");
  const selected = validateNativePidList(pids);
  const monotonicStart = performance.now();
  const wallStart = Date.now();
  const budget = (): number => {
    const remaining = Math.floor(COLLECTION_BUDGET_MS - (performance.now() - monotonicStart));
    if (remaining <= 0) return fail("collection-budget");
    return remaining;
  };
  const command = (path: "/usr/sbin/sysctl" | "/bin/ps", args: string[]): string => {
    const remaining = budget();
    let result;
    try {
      result = spawnSync(path, args, {
        encoding: "utf8", env: { TZ: "UTC", LC_ALL: "C", LANG: "C" },
        timeout: Math.min(COMMAND_TIMEOUT_MS, remaining), maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { return fail("native-command-failed"); }
    budget();
    if (result.error || result.signal || result.status !== 0 || result.stderr !== "" || typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return fail("native-command-failed");
    return result.stdout;
  };
  const readBoot = () => ({
    ...parseNativeBootTime(command("/usr/sbin/sysctl", ["-n", "kern.boottime"])),
    bootSessionHash: parseNativeBootSessionUuid(command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])),
  });
  const probe = (pid: number): "present" | "absent" => {
    budget();
    try { process.kill(pid, 0); return "present"; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return "absent";
      return fail("unknown-pid"); // EPERM is not absence, nor is any unknown error.
    }
  };
  let currentHost: string;
  try { currentHost = hostname(); } catch { return fail("inconsistent-facts"); }
  const initialBoot = readBoot();
  const observations: NativeSameMachinePidFact[] = selected.map(pid => ({ pid, state: probe(pid), processIdentity: null }));
  const present = observations.filter(fact => fact.state === "present");
  if (present.length > 0) {
    const readBirths = () => {
      const output = command("/bin/ps", ["-p", present.map(fact => fact.pid).join(","), "-o", "pid=", "-o", "lstart="]);
      const rows = new Map<number, ReturnType<typeof parseUtcPsStart>>();
      const wanted = new Set(present.map(fact => fact.pid));
      for (const line of output.replace(/\n$/, "").split("\n")) {
        const match = /^ *([0-9]{1,10}) +(.+?) *$/.exec(line);
        if (!match) return fail("ambiguous-pid");
        const pid = Number(match[1]);
        if (!wanted.has(pid) || rows.has(pid)) return fail("ambiguous-pid");
        rows.set(pid, parseUtcPsStart(match[2]));
      }
      if (rows.size !== present.length) return fail("ambiguous-pid");
      return rows;
    };
    const rows = readBirths();
    for (const fact of present) {
      const birth = rows.get(fact.pid);
      if (!birth || probe(fact.pid) !== "present") return fail("ambiguous-pid");
      Object.assign(fact, birth, { processIdentity: hash(`${initialBoot.bootSessionHash}:${fact.pid}:${birth.startedLowerBoundMs}:${birth.startedUpperBoundMs}`) });
    }
    // Detect visible PID reuse during collection; same-second reuse remains unknowable.
    const repeated = readBirths();
    for (const fact of present) {
      const birth = repeated.get(fact.pid);
      if (!birth || birth.startedLowerBoundMs !== fact.startedLowerBoundMs || birth.startedUpperBoundMs !== fact.startedUpperBoundMs) return fail("inconsistent-facts");
    }
  }
  const finalBoot = readBoot();
  for (const fact of observations) {
    if (probe(fact.pid) !== fact.state) return fail("inconsistent-facts");
  }
  let finalHost: string;
  try { finalHost = hostname(); } catch { return fail("inconsistent-facts"); }
  const observedAtMs = Date.now();
  budget();
  if (currentHost !== finalHost || initialBoot.bootSessionHash !== finalBoot.bootSessionHash ||
    initialBoot.bootLowerBoundMs !== finalBoot.bootLowerBoundMs || initialBoot.bootUpperBoundMs !== finalBoot.bootUpperBoundMs ||
    observedAtMs < wallStart || Math.abs((observedAtMs - wallStart) - (performance.now() - monotonicStart)) > 1000 ||
    initialBoot.bootUpperBoundMs >= wallStart) return fail("inconsistent-facts");
  const facts = { boot: { currentHost, ...finalBoot, observedAtMs }, pids: observations };
  if (!validFacts(facts)) return fail("inconsistent-facts");
  return facts;
}
