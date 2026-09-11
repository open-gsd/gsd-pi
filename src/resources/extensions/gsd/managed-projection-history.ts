import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  acquireProjectionRootIdentityLock,
  isProjectionRootIdentityLockAvailable,
  type ProjectionRootIdentityLock,
} from "@gsd/native/file-identity";

import { withProjectionMutationSync } from "./database-maintenance-fence.js";
import { gsdProjectionRoot } from "./paths.js";
import { classifyGsdLogicalPath } from "./projection-path-policy.js";

function historyPath(targetRoot: string): string {
  return join(gsdProjectionRoot(targetRoot), "migration", "managed-outputs.json");
}

function journalRoot(targetRoot: string): string {
  return join(gsdProjectionRoot(targetRoot), "migration", "projection-mutations");
}

const HISTORY_LOGICAL_PATH = "migration/managed-outputs.json";
const JOURNAL_LOGICAL_ROOT = "migration/projection-mutations";
const UNBOUND_EVIDENCE_LOGICAL_PATH = "migration/unbound-projection-evidence.json";
const NATIVE_EVIDENCE_LOGICAL_ROOT = "migration/native-projection-evidence";
const PROJECTION_ROOT_LOCK_RETRY_DELAYS_MS = [5, 10, 20, 40] as const;
const projectionRootLockRetrySleep = new Int32Array(new SharedArrayBuffer(4));

interface NativeProjectionEvidenceDescriptor {
  readonly version: 2;
  readonly sequence: number;
  readonly token: string;
  readonly checksum: string;
  readonly phase: "retained" | "resolving";
  readonly kind: "quarantine";
  readonly scope: "file";
  readonly evidencePath: string;
  readonly sourcePath: string;
  readonly evidenceIdentity: string;
  readonly logicalPath: string;
  readonly contentDigest: string;
  readonly reason: string;
}

let managedProjectionApplyFaultForTest: (() => void) | null = null;
let managedProjectionWriteFaultForTest: ((logicalPath: string) => void) | null = null;
let legacyProjectionCleanupBoundaryForTest: (() => void) | null = null;
let legacyProjectionCleanupExchangeFaultForTest: (() => void) | null = null;
let unboundEvidenceResolutionFaultForTest: (() => void) | null = null;
let unboundEvidenceCopyFaultForTest: (() => void) | null = null;
let unboundEvidenceGuardFaultForTest: (() => void) | null = null;
let unboundEvidenceRemovalFaultForTest: (() => void) | null = null;
let unboundEvidenceAcknowledgementFaultForTest: (() => void) | null = null;

export function _setManagedProjectionApplyFaultForTest(fault: (() => void) | null): void {
  managedProjectionApplyFaultForTest = fault;
}

export function _setManagedProjectionWriteFaultForTest(fault: ((logicalPath: string) => void) | null): void {
  managedProjectionWriteFaultForTest = fault;
}

export function _setLegacyProjectionCleanupBoundaryForTest(fault: (() => void) | null): void {
  legacyProjectionCleanupBoundaryForTest = fault;
}

export function _setLegacyProjectionCleanupExchangeFaultForTest(fault: (() => void) | null): void {
  legacyProjectionCleanupExchangeFaultForTest = fault;
}

export function _setUnboundEvidenceResolutionFaultForTest(fault: (() => void) | null): void {
  unboundEvidenceResolutionFaultForTest = fault;
}

export function _setUnboundEvidenceCopyFaultForTest(fault: (() => void) | null): void {
  unboundEvidenceCopyFaultForTest = fault;
}

export function _setUnboundEvidenceGuardFaultForTest(fault: (() => void) | null): void {
  unboundEvidenceGuardFaultForTest = fault;
}

export function _setUnboundEvidenceRemovalFaultForTest(fault: (() => void) | null): void {
  unboundEvidenceRemovalFaultForTest = fault;
}

export function _setUnboundEvidenceAcknowledgementFaultForTest(fault: (() => void) | null): void {
  unboundEvidenceAcknowledgementFaultForTest = fault;
}

interface PersistedManagedProjectionMutation {
  readonly targetRoot: string;
  readonly journalPath: string;
  readonly logicalPath: string;
  readonly operation: "write" | "remove" | "remove-tree";
  readonly legacyCleanup: boolean;
  readonly content: string | null;
  readonly encoding: BufferEncoding | null;
  temporaryPath: string | null;
  temporaryIdentity: string | null;
  replacementPath: string | null;
  replacementIdentity: string | null;
  quarantinePath: string | null;
  quarantineIdentity: string | null;
  placeholderIdentity: string | null;
  exchangeGuardPath: string;
  exchangeGuardIdentity: string | null;
  exchangeState: PersistedProjectionExchange | null;
}

interface PersistedProjectionExchange {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly leftIdentity: string;
  readonly rightIdentity: string;
  readonly guardPath: string;
  readonly guardIdentity: string;
}

export interface ManagedProjectionMutation extends PersistedManagedProjectionMutation {
  readonly handle: ProjectionRootIdentityLock;
}

export interface UnboundProjectionEvidence {
  readonly evidenceId: string;
  readonly evidencePath: string;
  readonly evidenceIdentity: string | null;
  readonly contentDigest: string;
  readonly kind: "temporary" | "quarantine" | "canonical";
  readonly logicalPath: string;
  readonly scope: "file" | "tree";
  readonly transition: "retained" | "resolving";
  readonly origin?: "native-control";
  readonly resolution?: UnboundProjectionEvidenceResolution;
}

interface PersistedNativeDeletionAcknowledgement {
  readonly phase: "prepared";
  readonly beforeContentDigest: string;
  readonly afterContentDigest: string;
}

type PersistedUnboundProjectionEvidence = UnboundProjectionEvidence & {
  readonly nativeDeletionAckPending?: true;
  readonly nativeDeletionAck?: PersistedNativeDeletionAcknowledgement;
};

export type UnboundProjectionEvidenceResolutionAction = "discard" | "preserve" | "restore";

interface UnboundProjectionEvidenceResolution {
  readonly action: UnboundProjectionEvidenceResolutionAction;
  readonly currentIdentity: string;
  readonly contentDigest: string;
  readonly destinationPath: string | null;
  readonly guardPath: string;
  guardIdentity: string | null;
  readonly stagingPath: string | null;
  stagingIdentity: string | null;
  exchangeIdentity: string | null;
  phase: "prepared" | "guarded" | "published" | "deleting";
}

function logicalProjectionPath(targetRoot: string, filePath: string): string {
  // Use realpathSync.native on both sides so the root and the target resolve to
  // the same canonical form. gsdProjectionRoot already normalizes via
  // realpathSync.native, which on Windows expands 8.3 short names (RUNNER~1 ->
  // runneradmin) and normalizes drive-letter case; the plain realpathSync used
  // for the target did not, so relative() saw two different roots and rejected
  // an in-root path as "outside the GSD root".
  const root = realpathSync.native(gsdProjectionRoot(targetRoot));
  let ancestor = resolve(filePath);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const absolute = join(realpathSync.native(ancestor), ...tail);
  const logicalPath = relative(root, absolute).replaceAll("\\", "/");
  if (logicalPath.length === 0
    || logicalPath.startsWith("../")
    || logicalPath.includes("\0")
    || logicalPath.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("managed projection path is outside the GSD root");
  }
  return logicalPath;
}

function openManagedProjectionRoot(targetRoot: string): ProjectionRootIdentityLock {
  const projectionRoot = gsdProjectionRoot(targetRoot);
  const stat = lstatSync(projectionRoot, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("managed projection root is not an identity-stable directory");
  }
  return acquireProjectionRootIdentityLock(
    realpathSync(projectionRoot),
    stat.dev.toString(),
    stat.ino.toString(),
  );
}

function isTransientProjectionRootLockError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "EBUSY") return true;
    if (typeof candidate.message === "string"
      && /\bEBUSY\b|sharing violation|os error 32|projection root is busy/iu.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function projectionErrorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

// Deterministic exchange/deletion protocol failures, classified by error
// class rather than a single error-message substring: a native wording change
// must not turn a recoverable retention into a permanent journal wedge.
function isUnexpectedOccupantError(error: unknown): boolean {
  const message = projectionErrorMessage(error);
  return message !== null
    && /unexpected occupant retained in guard|retained unexpected occupants/u.test(message);
}

function isJournaledExchangeIdentityChangedError(error: unknown): boolean {
  const message = projectionErrorMessage(error);
  return message !== null
    && message.includes("projection identity changed during journaled exchange");
}

function isDeterministicExchangeIdentityError(error: unknown): boolean {
  return isUnexpectedOccupantError(error) || isJournaledExchangeIdentityChangedError(error);
}

function openManagedProjectionRootWithRetry<T>(
  open: () => T,
  wait: (delayMs: number) => void = (delayMs) => {
    Atomics.wait(projectionRootLockRetrySleep, 0, 0, delayMs);
  },
): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return open();
    } catch (error) {
      const delay = PROJECTION_ROOT_LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientProjectionRootLockError(error)) throw error;
      wait(delay);
    }
  }
}

export function _openManagedProjectionRootWithRetryForTest<T>(
  open: () => T,
  wait: (delayMs: number) => void,
): T {
  return openManagedProjectionRootWithRetry(open, wait);
}

function withManagedProjectionRoot<T>(
  targetRoot: string,
  operation: (handle: ProjectionRootIdentityLock) => T,
  open: (root: string) => ProjectionRootIdentityLock = openManagedProjectionRoot,
): T {
  const handle = openManagedProjectionRootWithRetry(() => open(targetRoot));
  try {
    return operation(handle);
  } finally {
    handle.close();
  }
}

export function _withManagedProjectionRootForTest<T>(
  open: () => ProjectionRootIdentityLock,
  operation: (handle: ProjectionRootIdentityLock) => T,
): T {
  return withManagedProjectionRoot("", operation, open);
}

export function _recoverManagedProjectionMutationsForTest(
  open: (targetRoot: string) => ProjectionRootIdentityLock,
  targetRoot: string,
): void {
  withManagedProjectionRoot(targetRoot, (handle) => {
    recoverManagedProjectionMutations(targetRoot, handle);
  }, open);
}

function parseManagedProjectionPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("managed projection history is invalid");
  }
  return [...new Set(value)].sort();
}

// Plain-fs counterpart of the native history read. The native
// ProjectionRootIdentityLock reads with AT_SYMLINK_NOFOLLOW, so a symlinked (or
// otherwise non-regular) managed-outputs.json is never followed: doing so could
// read from outside the projection root, or mask the history as "missing" when
// a symlink's target is absent. Mirror that here with an lstat-based check that
// treats only a genuinely absent file as empty and rejects symlinks/non-files
// before reading.
function readFallbackManagedProjectionPaths(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("managed projection history is not a regular file");
  }
  return parseManagedProjectionPaths(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function readManagedProjectionPaths(handle: ProjectionRootIdentityLock): string[] {
  if (!handle.pathExists(HISTORY_LOGICAL_PATH)) return [];
  return parseManagedProjectionPaths(JSON.parse(handle.readFile(HISTORY_LOGICAL_PATH).toString("utf8")) as unknown);
}

function recordManagedProjectionLogicalPath(handle: ProjectionRootIdentityLock, logicalPath: string): void {
  const paths = new Set(readManagedProjectionPaths(handle));
  if (paths.has(logicalPath)) return;
  paths.add(logicalPath);
  handle.writeFile(HISTORY_LOGICAL_PATH, Buffer.from(`${JSON.stringify([...paths].sort(), null, 2)}\n`));
}

// Retention contract: the history doubles as a deletion allowlist for later
// migrations, so entries are kept even after their paths are removed through
// the managed mutation channel (a migration may still need to delete an
// artifact that was rendered again between attempts). Dropping missing-path
// entries is therefore unsafe: the flat string array carries no metadata to
// distinguish a channel-removed path from one that vanished externally, and
// the allowlist semantics are pinned by the migration safety tests. Growth is
// bounded structurally instead: entries are deduplicated by logical path, so
// the file holds at most one short string per distinct managed projection
// path the project has ever produced.

function evidenceId(evidencePath: string, kind: string, logicalPath: string, scope: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ evidencePath, kind, logicalPath, scope }))
    .digest("hex");
  return `evidence:sha256:${digest}`;
}

function fallbackProjectionPath(targetRoot: string, logicalPath: string): string {
  const root = gsdProjectionRoot(targetRoot);
  const absolute = resolve(root, logicalPath);
  if (relative(root, absolute).replaceAll("\\", "/") !== logicalPath) {
    throw new Error("fallback projection evidence path is invalid");
  }
  return absolute;
}

function fallbackProjectionIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error("fallback projection evidence is a symbolic link");
  return `${stat.dev}:${stat.ino}`;
}

function fallbackProjectionContentDigest(path: string, scope: "file" | "tree"): string {
  const hash = createHash("sha256");
  const visit = (entryPath: string, entryName: string): void => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error("fallback projection evidence contains a symbolic link");
    let kind: "directory" | "file" | null = null;
    if (stat.isDirectory()) kind = "directory";
    else if (stat.isFile()) kind = "file";
    if (kind === null) throw new Error("fallback projection evidence contains an unsupported entry");
    hash.update(`${entryName}\0${kind}\0`);
    if (kind === "file") {
      hash.update(readFileSync(entryPath));
      hash.update("\0");
      return;
    }
    for (const name of readdirSync(entryPath).sort()) {
      visit(join(entryPath, name), entryName.length === 0 ? name : `${entryName}/${name}`);
    }
  };
  if (scope === "file") {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("fallback projection evidence kind changed");
    hash.update(readFileSync(path));
  } else {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fallback projection evidence kind changed");
    visit(path, "");
  }
  return `sha256:${hash.digest("hex")}`;
}

function readFallbackUnboundProjectionEvidence(targetRoot: string): UnboundProjectionEvidence[] {
  const path = join(gsdProjectionRoot(targetRoot), UNBOUND_EVIDENCE_LOGICAL_PATH);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("unbound projection evidence is invalid");
  return value.map((entry): UnboundProjectionEvidence => {
    if (entry === null || typeof entry !== "object") throw new Error("unbound projection evidence is invalid");
    const evidence = entry as Record<string, unknown>;
    const scope = evidence.scope;
    const kind = evidence.kind;
    const evidencePath = evidence.evidencePath;
    const logicalPath = evidence.logicalPath;
    if (typeof evidencePath !== "string"
      || typeof logicalPath !== "string"
      || typeof evidence.evidenceIdentity !== "string"
      || typeof evidence.contentDigest !== "string"
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.contentDigest)
      || (scope !== "file" && scope !== "tree")
      || (kind !== "temporary" && kind !== "quarantine" && kind !== "canonical")
      || evidence.transition !== "retained"
      || classifyGsdLogicalPath(logicalPath) !== "managed"
      || (kind === "canonical" && evidencePath !== logicalPath)
      || evidence.evidenceId !== evidenceId(evidencePath, kind, logicalPath, scope)) {
      throw new Error("unbound projection evidence is invalid");
    }
    fallbackProjectionPath(targetRoot, evidencePath);
    return evidence as unknown as UnboundProjectionEvidence;
  });
}

function writeFallbackUnboundProjectionEvidence(
  targetRoot: string,
  entries: readonly UnboundProjectionEvidence[],
): void {
  const path = join(gsdProjectionRoot(targetRoot), UNBOUND_EVIDENCE_LOGICAL_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function recordFallbackProjectionObstruction(targetRoot: string, logicalPath: string): void {
  const path = fallbackProjectionPath(targetRoot, logicalPath);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const entries = readFallbackUnboundProjectionEvidence(targetRoot);
  if (entries.some((entry) => entry.evidencePath === logicalPath)) return;
  entries.push({
    evidenceId: evidenceId(logicalPath, "canonical", logicalPath, "tree"),
    evidencePath: logicalPath,
    evidenceIdentity: fallbackProjectionIdentity(path),
    contentDigest: fallbackProjectionContentDigest(path, "tree"),
    kind: "canonical",
    logicalPath,
    scope: "tree",
    transition: "retained",
  });
  entries.sort((left, right) => left.evidencePath.localeCompare(right.evidencePath));
  writeFallbackUnboundProjectionEvidence(targetRoot, entries);
}

function nativeEvidenceBinding(
  descriptor: Omit<NativeProjectionEvidenceDescriptor, "token" | "checksum">,
): string {
  return [
    descriptor.version,
    descriptor.sequence,
    descriptor.phase,
    descriptor.kind,
    descriptor.scope,
    descriptor.evidencePath,
    descriptor.sourcePath,
    descriptor.evidenceIdentity,
    descriptor.logicalPath,
    descriptor.contentDigest,
    descriptor.reason,
  ].join("\0");
}

function nativeEvidenceToken(descriptor: Omit<NativeProjectionEvidenceDescriptor, "token" | "checksum">): string {
  const tokenBinding = [
    descriptor.version,
    descriptor.sequence,
    descriptor.kind,
    descriptor.scope,
    descriptor.evidenceIdentity,
    descriptor.sourcePath,
    descriptor.logicalPath,
    descriptor.contentDigest,
    descriptor.reason,
  ].join("\0");
  const hex = createHash("sha256").update(`native-evidence\0${tokenBinding}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function nativeControlLogicalPath(sourcePath: string, reason: string): string | null {
  const directory = dirname(sourcePath).replaceAll("\\", "/");
  const sourceName = basename(sourcePath);
  const prefix = ".gsd-control-";
  const suffix = reason === "interrupted-control-temporary"
    ? ".temporary"
    : reason === "interrupted-control-replacement"
      ? ".replaced"
      : reason === "malformed-prepared-intent"
        ? ".intent.prepared"
        : null;
  if (reason === "later-control-target") {
    return `${directory === "." ? "" : `${directory}/`}${sourceName}`;
  }
  if (suffix === null || !sourceName.startsWith(prefix) || !sourceName.endsWith(suffix)) return null;
  const targetName = sourceName.slice(prefix.length, -suffix.length);
  if (targetName.length === 0) return null;
  return `${directory === "." ? "" : `${directory}/`}${targetName}`;
}

function parseNativeEvidenceDescriptor(name: string, value: unknown): NativeProjectionEvidenceDescriptor {
  if (value === null || typeof value !== "object") throw new Error("native projection evidence is invalid");
  const descriptor = value as Record<string, unknown>;
  const base = {
    version: descriptor.version,
    sequence: descriptor.sequence,
    phase: descriptor.phase,
    kind: descriptor.kind,
    scope: descriptor.scope,
    evidencePath: descriptor.evidencePath,
    sourcePath: descriptor.sourcePath,
    evidenceIdentity: descriptor.evidenceIdentity,
    logicalPath: descriptor.logicalPath,
    contentDigest: descriptor.contentDigest,
    reason: descriptor.reason,
  };
  if (base.version !== 2
    || !Number.isSafeInteger(base.sequence) || (base.sequence as number) < 1
    || (base.phase !== "retained" && base.phase !== "resolving")
    || base.kind !== "quarantine"
    || base.scope !== "file"
    || typeof base.evidencePath !== "string"
    || typeof base.sourcePath !== "string"
    || typeof base.evidenceIdentity !== "string"
    || typeof base.logicalPath !== "string"
    || typeof base.contentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(base.contentDigest)
    || typeof base.reason !== "string"
    || typeof descriptor.token !== "string"
    || typeof descriptor.checksum !== "string") {
    throw new Error("native projection evidence is invalid");
  }
  const binding = nativeEvidenceBinding(base as Omit<NativeProjectionEvidenceDescriptor, "token" | "checksum">);
  const token = nativeEvidenceToken(base as Omit<NativeProjectionEvidenceDescriptor, "token" | "checksum">);
  const checksum = `sha256:${createHash("sha256").update(`native-evidence-checksum\0${token}\0${binding}`).digest("hex")}`;
  const evidenceDirectory = dirname(base.evidencePath as string).replaceAll("\\", "/");
  const sourceDirectory = dirname(base.sourcePath as string).replaceAll("\\", "/");
  const logicalDirectory = dirname(base.logicalPath as string).replaceAll("\\", "/");
  if (name !== `${token}.json` || descriptor.token !== token || descriptor.checksum !== checksum) {
    throw new Error("native projection evidence is invalid");
  }
  if (basename(base.evidencePath as string) !== `.gsd-projection-remove-${token}`
    || evidenceDirectory !== sourceDirectory
    || evidenceDirectory !== logicalDirectory
    || nativeControlLogicalPath(base.sourcePath as string, base.reason as string) !== base.logicalPath) {
    throw new Error("native projection evidence path is invalid");
  }
  return descriptor as unknown as NativeProjectionEvidenceDescriptor;
}

function persistedEvidenceDestination(
  action: unknown,
  logicalPath: string,
  id: string,
): string | null | undefined {
  if (action === "discard") return null;
  if (action === "restore") return logicalPath;
  if (action === "preserve") {
    return `migration/preserved-projection-evidence/${id.slice("evidence:sha256:".length)}`;
  }
  return undefined;
}

function projectionContentDigest(
  handle: ProjectionRootIdentityLock,
  rootPath: string,
  scope: "file" | "tree",
  excludedRootNames: ReadonlySet<string> = new Set(),
): string {
  const hash = createHash("sha256");
  const visit = (path: string, relativePath: string): void => {
    const kind = handle.pathKind(path);
    hash.update(`${relativePath}\0${kind}\0`);
    if (kind === "file") {
      hash.update(handle.readFile(path));
      hash.update("\0");
      return;
    }
    for (const name of handle.listDirectory(path)) {
      if (relativePath.length === 0 && excludedRootNames.has(name)) continue;
      visit(`${path}/${name}`, relativePath.length === 0 ? name : `${relativePath}/${name}`);
    }
  };
  if (scope === "file") {
    if (handle.pathKind(rootPath) !== "file") throw new Error("unbound projection evidence kind changed");
    hash.update(handle.readFile(rootPath));
  } else {
    if (handle.pathKind(rootPath) !== "directory") throw new Error("unbound projection evidence kind changed");
    visit(rootPath, "");
  }
  return `sha256:${hash.digest("hex")}`;
}

function writeUnboundProjectionEvidence(
  handle: ProjectionRootIdentityLock,
  entries: readonly PersistedUnboundProjectionEvidence[],
): void {
  handle.writeFile(
    UNBOUND_EVIDENCE_LOGICAL_PATH,
    Buffer.from(`${JSON.stringify(entries, null, 2)}\n`),
  );
}

function parseNativeDeletionAcknowledgement(
  value: unknown,
  beforeContentDigest: string,
): PersistedNativeDeletionAcknowledgement | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    throw new Error("unbound projection deletion acknowledgement is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "afterContentDigest,beforeContentDigest,phase"
    || record.phase !== "prepared"
    || record.beforeContentDigest !== beforeContentDigest
    || typeof record.afterContentDigest !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(record.afterContentDigest)) {
    throw new Error("unbound projection deletion acknowledgement is invalid");
  }
  return record as unknown as PersistedNativeDeletionAcknowledgement;
}

function readUnboundProjectionEvidence(handle: ProjectionRootIdentityLock): UnboundProjectionEvidence[] {
  const value = handle.pathExists(UNBOUND_EVIDENCE_LOGICAL_PATH)
    ? JSON.parse(handle.readFile(UNBOUND_EVIDENCE_LOGICAL_PATH).toString("utf8")) as unknown
    : [];
  if (!Array.isArray(value)) throw new Error("unbound projection evidence is invalid");
  const nativeEvidencePaths = new Set<string>();
  if (handle.pathExists(NATIVE_EVIDENCE_LOGICAL_ROOT)) {
    for (const name of handle.listDirectory(NATIVE_EVIDENCE_LOGICAL_ROOT)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) throw new Error("native projection evidence is invalid");
      const descriptor = parseNativeEvidenceDescriptor(name, JSON.parse(
        handle.readFile(`${NATIVE_EVIDENCE_LOGICAL_ROOT}/${name}`).toString("utf8"),
      ));
      const resolving = value.some(entry => entry !== null
        && typeof entry === "object"
        && (entry as Record<string, unknown>).evidencePath === descriptor.evidencePath
        && (entry as Record<string, unknown>).transition === "resolving");
      if (descriptor.phase === "resolving" && !resolving) {
        if (handle.pathExists(descriptor.evidencePath)) {
          throw new Error("native projection evidence resolution is invalid");
        }
        const descriptorPath = `${NATIVE_EVIDENCE_LOGICAL_ROOT}/${name}`;
        handle.removeFileViaGuardExact(
          descriptorPath,
          handle.pathIdentity(descriptorPath),
          descriptorPath,
          false,
          projectionContentDigest(handle, descriptorPath, "file"),
        );
        continue;
      }
      if (!resolving && (!handle.pathExists(descriptor.evidencePath)
        || handle.pathIdentity(descriptor.evidencePath) !== descriptor.evidenceIdentity
        || projectionContentDigest(handle, descriptor.evidencePath, "file") !== descriptor.contentDigest)) {
        throw new Error("native projection evidence is invalid");
      }
      if (descriptor.phase === "retained" && !value.some(entry => entry !== null
        && typeof entry === "object"
        && (entry as Record<string, unknown>).evidencePath === descriptor.evidencePath)) {
        value.push({
          contentDigest: descriptor.contentDigest,
          evidenceIdentity: descriptor.evidenceIdentity,
          evidencePath: descriptor.evidencePath,
          kind: descriptor.kind,
          logicalPath: descriptor.logicalPath,
          origin: "native-control",
          scope: descriptor.scope,
          transition: "retained",
        });
      }
      nativeEvidencePaths.add(descriptor.evidencePath);
    }
  }
  const parseEntries = (): UnboundProjectionEvidence[] => value.map((entry): UnboundProjectionEvidence => {
    if (entry === null || typeof entry !== "object") throw new Error("unbound projection evidence is invalid");
    const {
      evidenceId: recordedEvidenceId,
      evidencePath,
      evidenceIdentity = null,
      contentDigest: recordedContentDigest,
      kind,
      logicalPath,
      scope = kind === "temporary" ? "file" : "tree",
      transition = "retained",
      origin,
      resolution,
    } = entry as Record<string, unknown>;
    const evidenceDirectory = typeof evidencePath === "string" ? dirname(evidencePath).replaceAll("\\", "/") : "";
    const logicalDirectory = typeof logicalPath === "string" ? dirname(logicalPath).replaceAll("\\", "/") : "";
    const evidenceName = typeof evidencePath === "string" ? basename(evidencePath) : "";
    const resolvedId = typeof evidencePath === "string" && typeof logicalPath === "string" && typeof kind === "string"
      ? evidenceId(evidencePath, kind, logicalPath, String(scope))
      : "";
    const rawResolution = resolution as Record<string, unknown> | undefined;
    const recordedDestination = typeof rawResolution?.destinationPath === "string"
      ? rawResolution.destinationPath
      : null;
    const defaultResolutionPaths = resolvedId.length === 0 || typeof evidencePath !== "string"
      ? null
      : evidenceResolutionPaths(resolvedId, evidencePath, recordedDestination);
    const parsedResolution: Record<string, unknown> | undefined = rawResolution === undefined || defaultResolutionPaths === null
      ? undefined
      : {
          ...rawResolution,
          guardPath: rawResolution.guardPath ?? defaultResolutionPaths.guardPath,
          guardIdentity: rawResolution.guardIdentity ?? null,
          stagingPath: rawResolution.stagingPath ?? defaultResolutionPaths.stagingPath,
          stagingIdentity: rawResolution.stagingIdentity ?? null,
          exchangeIdentity: rawResolution.exchangeIdentity ?? null,
          phase: rawResolution.phase ?? "prepared",
        };
    const expectedDestination = persistedEvidenceDestination(
      parsedResolution?.action,
      typeof logicalPath === "string" ? logicalPath : "",
      resolvedId,
    );
    if (typeof evidencePath !== "string"
      || typeof logicalPath !== "string"
      || (evidenceIdentity !== null && typeof evidenceIdentity !== "string")
      || (kind !== "temporary" && kind !== "quarantine" && kind !== "canonical")
      || (classifyGsdLogicalPath(logicalPath) !== "managed"
        && (origin !== "native-control" || !nativeEvidencePaths.has(evidencePath)))
      || (origin !== undefined && origin !== "native-control")
      || (origin !== "native-control"
        && (kind === "canonical" ? evidencePath !== logicalPath : evidenceDirectory !== logicalDirectory))
      || (kind !== "canonical" && (kind === "temporary"
        ? !/^\.gsd-projection-tmp-[0-9a-f-]{36}$/u.test(evidenceName)
        : !(/^\.gsd-projection-remove-[0-9a-f-]{36}$/u.test(evidenceName)
          || /^\.gsd-projection-exchange-[0-9a-f-]{36}$/u.test(evidenceName)
          || /^\.gsd-projection-tmp-[0-9a-f-]{36}\.replaced$/u.test(evidenceName))))
      || (scope !== "file" && scope !== "tree")
      || (recordedEvidenceId !== undefined && recordedEvidenceId !== resolvedId)
      || (recordedContentDigest !== undefined && (typeof recordedContentDigest !== "string"
        || !/^sha256:[0-9a-f]{64}$/u.test(recordedContentDigest)))
      || (transition !== "retained" && transition !== "resolving")
      || (transition === "resolving" && (parsedResolution === undefined
        || (parsedResolution.action !== "discard" && parsedResolution.action !== "preserve" && parsedResolution.action !== "restore")
        || parsedResolution.destinationPath !== expectedDestination
        || recordedContentDigest !== parsedResolution.contentDigest
        || evidenceIdentity !== parsedResolution.currentIdentity
        || typeof parsedResolution.currentIdentity !== "string"
        || typeof parsedResolution.contentDigest !== "string"
        || (parsedResolution.destinationPath !== null && typeof parsedResolution.destinationPath !== "string")
        || typeof parsedResolution.guardPath !== "string"
        || parsedResolution.guardPath !== defaultResolutionPaths?.guardPath
        || (parsedResolution.guardIdentity !== null && typeof parsedResolution.guardIdentity !== "string")
        || (parsedResolution.stagingPath !== null && typeof parsedResolution.stagingPath !== "string")
        || parsedResolution.stagingPath !== defaultResolutionPaths?.stagingPath
        || (parsedResolution.stagingIdentity !== null && typeof parsedResolution.stagingIdentity !== "string")
        || (parsedResolution.exchangeIdentity !== null && typeof parsedResolution.exchangeIdentity !== "string")
        || (parsedResolution.phase !== "prepared"
          && parsedResolution.phase !== "guarded"
          && parsedResolution.phase !== "published"
          && parsedResolution.phase !== "deleting")))) {
      throw new Error("unbound projection evidence is invalid");
    }
    const contentDigest = typeof recordedContentDigest === "string"
      ? recordedContentDigest
      : handle.pathExists(evidencePath)
        ? projectionContentDigest(handle, evidencePath, scope as "file" | "tree")
        : (() => { throw new Error("unbound projection evidence content is unavailable"); })();
    return {
      evidenceId: resolvedId,
      evidencePath,
      evidenceIdentity: evidenceIdentity as string | null,
      contentDigest,
      kind,
      logicalPath,
      scope: scope as "file" | "tree",
      transition,
      ...(origin === "native-control" ? { origin } : {}),
      ...(parsedResolution === undefined ? {} : { resolution: parsedResolution as unknown as UnboundProjectionEvidenceResolution }),
    };
  });
  const parsedEntries = parseEntries();
  const deletionManifestNames = new Set([".gsd-delete-manifest", ".gsd-delete-manifest.prepared"]);
  let preparedDeletionAcknowledgement = false;
  const deletionAcknowledgements = value.flatMap((raw, index) => {
    const entry = raw as Record<string, unknown>;
    if (entry.nativeDeletionAckPending !== true) return [];
    const parsed = parsedEntries[index]!;
    if (typeof entry.evidencePath !== "string"
      || typeof entry.evidenceIdentity !== "string"
      || entry.scope !== "tree"
      || parsed.evidencePath !== entry.evidencePath
      || parsed.evidenceIdentity !== entry.evidenceIdentity
      || parsed.scope !== "tree"
      || !handle.pathExists(entry.evidencePath)
      || handle.pathIdentity(entry.evidencePath) !== entry.evidenceIdentity) {
      throw new Error("unbound projection deletion acknowledgement is invalid");
    }
    const observedContentDigest = projectionContentDigest(handle, entry.evidencePath, "tree");
    const persistedAcknowledgement = parseNativeDeletionAcknowledgement(
      entry.nativeDeletionAck,
      parsed.contentDigest,
    );
    const manifestPresent = [...deletionManifestNames].some(
      name => handle.pathExists(`${entry.evidencePath}/${name}`),
    );
    if (persistedAcknowledgement === null
      && (!manifestPresent || observedContentDigest !== parsed.contentDigest)) {
      throw new Error("unbound projection deletion acknowledgement content changed");
    }
    const acknowledgement = persistedAcknowledgement ?? {
      phase: "prepared",
      beforeContentDigest: parsed.contentDigest,
      afterContentDigest: projectionContentDigest(
        handle,
        entry.evidencePath,
        "tree",
        deletionManifestNames,
      ),
    } satisfies PersistedNativeDeletionAcknowledgement;
    if (observedContentDigest !== acknowledgement.beforeContentDigest
      && (manifestPresent || observedContentDigest !== acknowledgement.afterContentDigest)) {
      throw new Error("unbound projection deletion acknowledgement content changed");
    }
    if (persistedAcknowledgement === null) {
      entry.nativeDeletionAck = acknowledgement;
      preparedDeletionAcknowledgement = true;
    }
    return [{
      acknowledgement,
      entry,
      evidencePath: entry.evidencePath,
      evidenceIdentity: entry.evidenceIdentity,
      manifestPresent,
    }];
  });
  if (preparedDeletionAcknowledgement) {
    writeUnboundProjectionEvidence(handle, value as PersistedUnboundProjectionEvidence[]);
  }
  let recoveredDeletionAcknowledgement = false;
  for (const acknowledgement of deletionAcknowledgements) {
    if (acknowledgement.manifestPresent) {
      handle.acknowledgeTreeDeletionEvidence(
        acknowledgement.evidencePath,
        acknowledgement.evidenceIdentity,
      );
      if (projectionContentDigest(handle, acknowledgement.evidencePath, "tree")
        !== acknowledgement.acknowledgement.afterContentDigest) {
        throw new Error("unbound projection deletion acknowledgement content changed");
      }
      unboundEvidenceAcknowledgementFaultForTest?.();
    }
    acknowledgement.entry.contentDigest = acknowledgement.acknowledgement.afterContentDigest;
    delete acknowledgement.entry.nativeDeletionAckPending;
    delete acknowledgement.entry.nativeDeletionAck;
    recoveredDeletionAcknowledgement = true;
  }
  if (recoveredDeletionAcknowledgement) {
    writeUnboundProjectionEvidence(handle, value as PersistedUnboundProjectionEvidence[]);
  }
  return parseEntries();
}

function recordUnboundProjectionEvidence(
  handle: ProjectionRootIdentityLock,
  evidence: Omit<UnboundProjectionEvidence, "evidenceId" | "evidenceIdentity" | "contentDigest" | "transition"> & {
    readonly evidenceIdentity?: string | null;
  },
): void {
  const entries = readUnboundProjectionEvidence(handle);
  if (entries.some(entry => entry.evidencePath === evidence.evidencePath
    && entry.kind === evidence.kind
    && entry.logicalPath === evidence.logicalPath)) return;
  const identity = evidence.evidenceIdentity ?? (handle.pathExists(evidence.evidencePath)
    ? handle.pathIdentity(evidence.evidencePath)
    : null);
  entries.push({
    ...evidence,
    evidenceId: evidenceId(evidence.evidencePath, evidence.kind, evidence.logicalPath, evidence.scope),
    evidenceIdentity: identity,
    contentDigest: projectionContentDigest(handle, evidence.evidencePath, evidence.scope),
    transition: "retained",
  });
  entries.sort((left, right) => left.evidencePath.localeCompare(right.evidencePath));
  writeUnboundProjectionEvidence(handle, entries);
}

function removeNativeEvidenceDescriptor(
  handle: ProjectionRootIdentityLock,
  evidencePath: string,
): void {
  if (!handle.pathExists(NATIVE_EVIDENCE_LOGICAL_ROOT)) return;
  for (const name of handle.listDirectory(NATIVE_EVIDENCE_LOGICAL_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = `${NATIVE_EVIDENCE_LOGICAL_ROOT}/${name}`;
    const descriptor = JSON.parse(handle.readFile(path).toString("utf8")) as Record<string, unknown>;
    if (descriptor.evidencePath === evidencePath) {
      handle.removeFileViaGuardExact(
        path,
        handle.pathIdentity(path),
        path,
        false,
        projectionContentDigest(handle, path, "file"),
      );
    }
  }
}

function markNativeEvidenceDescriptorResolving(
  handle: ProjectionRootIdentityLock,
  evidencePath: string,
): void {
  if (!handle.pathExists(NATIVE_EVIDENCE_LOGICAL_ROOT)) return;
  for (const name of handle.listDirectory(NATIVE_EVIDENCE_LOGICAL_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const path = `${NATIVE_EVIDENCE_LOGICAL_ROOT}/${name}`;
    const descriptor = parseNativeEvidenceDescriptor(
      name,
      JSON.parse(handle.readFile(path).toString("utf8")),
    );
    if (descriptor.evidencePath !== evidencePath || descriptor.phase === "resolving") continue;
    const resolving = { ...descriptor, phase: "resolving" as const };
    const binding = nativeEvidenceBinding(resolving);
    const checksum = `sha256:${createHash("sha256").update(
      `native-evidence-checksum\0${descriptor.token}\0${binding}`,
    ).digest("hex")}`;
    handle.writeFile(path, Buffer.from(`${JSON.stringify({ ...resolving, checksum })}\n`));
  }
}

function evidenceConflictsWithPath(
  evidence: UnboundProjectionEvidence,
  logicalPath: string,
): boolean {
  const affects = (protectedPath: string, scope: "file" | "tree"): boolean => protectedPath === logicalPath
    || protectedPath.startsWith(`${logicalPath}/`)
    || (scope === "tree" && logicalPath.startsWith(`${protectedPath}/`));
  return affects(evidence.logicalPath, evidence.scope)
    || affects(evidence.evidencePath, evidence.scope);
}

function validateMutation(value: unknown, targetRoot: string, path: string): PersistedManagedProjectionMutation {
  if (value === null || typeof value !== "object") throw new Error("managed projection mutation is invalid");
  const mutation = value as Record<string, unknown>;
  const logicalPath = mutation["logicalPath"];
  const operation = mutation["operation"];
  const legacyCleanup = mutation["legacyCleanup"] ?? false;
  const content = mutation["content"];
  const encoding = mutation["encoding"];
  const temporaryPath = mutation["temporaryPath"];
  const temporaryIdentity = mutation["temporaryIdentity"] ?? null;
  const replacementPath = mutation["replacementPath"] ?? (typeof temporaryPath === "string" ? `${temporaryPath}.replaced` : null);
  const replacementIdentity = mutation["replacementIdentity"] ?? null;
  const quarantinePath = mutation["quarantinePath"] ?? ((operation === "remove-tree" || operation === "remove") && typeof logicalPath === "string"
    ? `${dirname(logicalPath) === "." ? "" : `${dirname(logicalPath)}/`}.gsd-projection-remove-${basename(path, ".json")}`
    : null);
  const quarantineIdentity = mutation["quarantineIdentity"] ?? null;
  const placeholderIdentity = mutation["placeholderIdentity"] ?? null;
  const exchangeGuardPath = mutation["exchangeGuardPath"] ?? (typeof logicalPath === "string"
    ? `${dirname(logicalPath) === "." ? "" : `${dirname(logicalPath)}/`}.gsd-projection-exchange-${basename(path, ".json")}`
    : null);
  const exchangeGuardIdentity = mutation["exchangeGuardIdentity"] ?? null;
  const exchangeState = mutation["exchangeState"] ?? null;
  const parsedExchange = exchangeState as Record<string, unknown> | null;
  const exchangeRightPaths = operation === "write"
    ? [temporaryPath, replacementPath]
    : [quarantinePath];
  let exchangeLeftIdentity: unknown;
  let exchangeRightIdentity: unknown;
  if (parsedExchange?.rightPath === temporaryPath) {
    exchangeLeftIdentity = placeholderIdentity;
    exchangeRightIdentity = temporaryIdentity;
  } else if (parsedExchange?.rightPath === replacementPath) {
    exchangeLeftIdentity = replacementIdentity;
    exchangeRightIdentity = placeholderIdentity;
  } else if (parsedExchange?.rightPath === quarantinePath) {
    exchangeLeftIdentity = quarantineIdentity;
    exchangeRightIdentity = placeholderIdentity;
  }
  const temporaryName = typeof temporaryPath === "string" ? basename(temporaryPath) : "";
  const targetDirectory = typeof logicalPath === "string" ? dirname(logicalPath).replaceAll("\\", "/") : "";
  const temporaryDirectory = typeof temporaryPath === "string"
    ? dirname(temporaryPath).replaceAll("\\", "/")
    : "";
  const quarantineDirectory = typeof quarantinePath === "string"
    ? dirname(quarantinePath).replaceAll("\\", "/")
    : "";
  if (typeof logicalPath !== "string"
    || logicalPath.length === 0
    || logicalPath.startsWith("../")
    || logicalPath.includes("\0")
    || logicalPath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || classifyGsdLogicalPath(logicalPath) !== "managed"
    || (operation !== "write" && operation !== "remove" && operation !== "remove-tree")
    || typeof legacyCleanup !== "boolean"
    || (legacyCleanup && operation !== "remove-tree")
    || (operation === "write"
      ? typeof content !== "string" || typeof encoding !== "string" || !Buffer.isEncoding(encoding)
      : content !== null || encoding !== null)
    || (operation === "write"
      ? typeof temporaryPath !== "string"
        || !/^\.gsd-projection-tmp-[0-9a-f-]{36}$/u.test(temporaryName)
        || temporaryDirectory !== targetDirectory
      : temporaryPath !== null)
    || (temporaryIdentity !== null && typeof temporaryIdentity !== "string")
    || (operation === "write"
      ? typeof replacementPath !== "string"
        || (replacementPath !== `${temporaryPath}.replaced`
          && !/^\.gsd-projection-remove-[0-9a-f-]{36}$/u.test(basename(replacementPath)))
        || dirname(replacementPath).replaceAll("\\", "/") !== targetDirectory
      : replacementPath !== null)
    || (replacementIdentity !== null && typeof replacementIdentity !== "string")
    || (operation === "remove-tree" || operation === "remove"
      ? typeof quarantinePath !== "string"
        || !/^\.gsd-projection-remove-[0-9a-f-]{36}$/u.test(basename(quarantinePath))
        || quarantineDirectory !== targetDirectory
      : quarantinePath !== null)
    || (quarantineIdentity !== null && typeof quarantineIdentity !== "string")
    || (placeholderIdentity !== null && typeof placeholderIdentity !== "string")
    || typeof exchangeGuardPath !== "string"
    || !/^\.gsd-projection-exchange-[0-9a-f-]{36}$/u.test(basename(exchangeGuardPath))
    || dirname(exchangeGuardPath).replaceAll("\\", "/") !== targetDirectory
    || (exchangeGuardIdentity !== null && typeof exchangeGuardIdentity !== "string")
    || (parsedExchange !== null && (typeof parsedExchange !== "object"
      || typeof parsedExchange.leftPath !== "string"
      || typeof parsedExchange.rightPath !== "string"
      || typeof parsedExchange.leftIdentity !== "string"
      || typeof parsedExchange.rightIdentity !== "string"
      || parsedExchange.leftPath !== logicalPath
      || !exchangeRightPaths.includes(parsedExchange.rightPath)
      || parsedExchange.leftIdentity !== exchangeLeftIdentity
      || parsedExchange.rightIdentity !== exchangeRightIdentity
      || parsedExchange.guardPath !== exchangeGuardPath
      || parsedExchange.guardIdentity !== exchangeGuardIdentity))) {
    throw new Error("managed projection mutation is invalid");
  }
  return {
    targetRoot,
    journalPath: path,
    logicalPath,
    operation,
    legacyCleanup,
    content: content as string | null,
    encoding: encoding as BufferEncoding | null,
    temporaryPath: temporaryPath as string | null,
    temporaryIdentity: temporaryIdentity as string | null,
    replacementPath: replacementPath as string | null,
    replacementIdentity: replacementIdentity as string | null,
    quarantinePath: quarantinePath as string | null,
    quarantineIdentity: quarantineIdentity as string | null,
    placeholderIdentity: placeholderIdentity as string | null,
    exchangeGuardPath: exchangeGuardPath as string,
    exchangeGuardIdentity: exchangeGuardIdentity as string | null,
    exchangeState: parsedExchange as unknown as PersistedProjectionExchange | null,
  };
}

function persistMutation(handle: ProjectionRootIdentityLock, mutation: PersistedManagedProjectionMutation): void {
  const path = `${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`;
  const { journalPath: _journalPath, targetRoot: _targetRoot, ...persisted } = mutation;
  handle.writeFile(path, Buffer.from(`${JSON.stringify(persisted)}\n`));
}

function removePlaceholder(
  handle: ProjectionRootIdentityLock,
  path: string,
  identity: string,
  directory: boolean,
): void {
  if (!handle.pathExists(path)) return;
  handle.removeFileViaGuardExact(
    path,
    identity,
    path,
    directory,
    projectionContentDigest(handle, path, directory ? "tree" : "file"),
  );
}

function exchangeMutationPaths(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
  leftPath: string,
  rightPath: string,
  leftIdentity: string,
  rightIdentity: string,
  directory: boolean,
): void {
  if (handle.pathExists(mutation.exchangeGuardPath) && mutation.exchangeGuardIdentity === null) {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.exchangeGuardPath,
      kind: "quarantine",
      logicalPath: mutation.logicalPath,
      scope: directory ? "tree" : "file",
    });
    const parent = dirname(mutation.exchangeGuardPath).replaceAll("\\", "/");
    mutation.exchangeGuardPath = `${parent === "." ? "" : `${parent}/`}.gsd-projection-exchange-${randomUUID()}`;
    persistMutation(handle, mutation);
  }
  if (mutation.exchangeGuardIdentity === null) {
    mutation.exchangeGuardIdentity = directory
      ? handle.prepareDirectoryPlaceholder(mutation.exchangeGuardPath)
      : handle.prepareFileTemporary(mutation.exchangeGuardPath, Buffer.alloc(0));
    persistMutation(handle, mutation);
  }
  mutation.exchangeState = {
    leftPath,
    rightPath,
    leftIdentity,
    rightIdentity,
    guardPath: mutation.exchangeGuardPath,
    guardIdentity: mutation.exchangeGuardIdentity,
  };
  persistMutation(handle, mutation);
  try {
    handle.exchangePaths(
      leftPath,
      rightPath,
      leftIdentity,
      rightIdentity,
      mutation.exchangeGuardPath,
      mutation.exchangeGuardIdentity,
    );
  } catch (error) {
    retainFailedExchangeEvidence(handle, mutation, error, directory);
    throw error;
  }
  mutation.exchangeState = null;
  mutation.exchangeGuardIdentity = null;
  persistMutation(handle, mutation);
}

const ABSENT_PROJECTION_IDENTITY = "-";

function projectedIdentity(handle: ProjectionRootIdentityLock, path: string): string {
  return handle.pathExists(path) ? handle.pathIdentity(path) : ABSENT_PROJECTION_IDENTITY;
}

function retainExchangeParticipants(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): void {
  const retain = (evidencePath: string | null, kind: "temporary" | "quarantine" | "canonical"): void => {
    if (evidencePath === null || !handle.pathExists(evidencePath)) return;
    const scope = handle.pathKind(evidencePath) === "directory" ? "tree" : "file";
    recordUnboundProjectionEvidence(handle, {
      evidencePath,
      evidenceIdentity: handle.pathIdentity(evidencePath),
      kind,
      logicalPath: mutation.logicalPath,
      scope,
    });
  };
  retain(mutation.logicalPath, "canonical");
  retain(mutation.temporaryPath, "temporary");
  retain(mutation.replacementPath, "quarantine");
  retain(mutation.quarantinePath, "quarantine");
  retain(mutation.exchangeGuardPath, "quarantine");
}

// Degrades a contradictory journaled exchange to reviewable evidence and
// retires the journal entry (the semantics the remove path already ships)
// instead of re-throwing raw and wedging every later projection operation.
function retireExchangeWithRetainedEvidence(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): never {
  retainExchangeParticipants(handle, mutation);
  handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
  throw new Error("managed projection target identity changed; recovery evidence retained");
}

function reconcileProjectionExchange(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): PersistedProjectionExchange | null {
  const exchange = mutation.exchangeState;
  if (exchange === null) return null;
  // The swap landed before the clearing persist ran: only the journal needs
  // to converge. Retire the entry instead of re-issuing the exchange.
  if (exchange.rightIdentity !== ABSENT_PROJECTION_IDENTITY
    && projectedIdentity(handle, exchange.leftPath) === exchange.rightIdentity) {
    mutation.exchangeState = null;
    mutation.exchangeGuardIdentity = null;
    persistMutation(handle, mutation);
    return null;
  }
  // Anything other than a converged or staging-only drift is a contradiction
  // between the persisted exchange and disk that replay cannot resolve.
  if (projectedIdentity(handle, exchange.leftPath) !== exchange.leftIdentity
    || projectedIdentity(handle, exchange.guardPath) !== exchange.guardIdentity) {
    retireExchangeWithRetainedEvidence(handle, mutation);
  }
  if (projectedIdentity(handle, exchange.rightPath) === exchange.rightIdentity) return exchange;
  return restageProjectionExchangeRight(handle, mutation, exchange);
}

function restageProjectionExchangeRight(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
  exchange: PersistedProjectionExchange,
): PersistedProjectionExchange {
  const role = exchange.rightPath === mutation.temporaryPath
    ? "temporary"
    : exchange.rightPath === mutation.replacementPath
      ? "replacement"
      : "quarantine";
  const directory = dirname(exchange.rightPath).replaceAll("\\", "/");
  const prefix = directory === "." ? "" : `${directory}/`;
  if (handle.pathExists(exchange.rightPath)) {
    const scope = handle.pathKind(exchange.rightPath) === "directory" ? "tree" : "file";
    // The right slot is protocol-owned staging we created. If it still holds
    // the intended content under a drifted identity (the volume-serial flip
    // shape), re-bind the journal to the actual identity and replay.
    const intendedContent = role === "temporary"
      ? Buffer.from(mutation.content!, mutation.encoding!)
      : Buffer.alloc(0);
    if (projectionContentDigest(handle, exchange.rightPath, scope)
      === `sha256:${createHash("sha256").update(intendedContent).digest("hex")}`) {
      const actualIdentity = handle.pathIdentity(exchange.rightPath);
      if (role === "temporary") mutation.temporaryIdentity = actualIdentity;
      else mutation.placeholderIdentity = actualIdentity;
      const rebound = { ...exchange, rightIdentity: actualIdentity };
      mutation.exchangeState = rebound;
      persistMutation(handle, mutation);
      return rebound;
    }
    recordUnboundProjectionEvidence(handle, {
      evidencePath: exchange.rightPath,
      evidenceIdentity: handle.pathIdentity(exchange.rightPath),
      kind: role === "temporary" ? "temporary" : "quarantine",
      logicalPath: mutation.logicalPath,
      scope,
    });
  }
  // The staging slot no longer holds the intended content (or is gone):
  // re-stage under a fresh random name — reusing the diverged deterministic
  // name is what makes the wedge restart-proof — and keep any displaced
  // protocol artifact the rename orphans as reviewable evidence.
  let rightPath: string;
  if (role === "temporary") {
    if (handle.pathExists(mutation.replacementPath!)) {
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.replacementPath!,
        evidenceIdentity: handle.pathIdentity(mutation.replacementPath!),
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: "file",
      });
    }
    mutation.temporaryPath = `${prefix}.gsd-projection-tmp-${randomUUID()}`;
    mutation.replacementPath = `${mutation.temporaryPath}.replaced`;
    mutation.temporaryIdentity = handle.prepareFileTemporary(
      mutation.temporaryPath,
      Buffer.from(mutation.content!, mutation.encoding!),
    );
    rightPath = mutation.temporaryPath;
  } else if (role === "replacement") {
    mutation.replacementPath = `${prefix}.gsd-projection-remove-${randomUUID()}`;
    mutation.placeholderIdentity = handle.prepareFileTemporary(mutation.replacementPath, Buffer.alloc(0));
    rightPath = mutation.replacementPath;
  } else {
    mutation.quarantinePath = `${prefix}.gsd-projection-remove-${randomUUID()}`;
    mutation.placeholderIdentity = mutation.operation === "remove-tree"
      ? handle.prepareDirectoryPlaceholder(mutation.quarantinePath)
      : handle.prepareFileTemporary(mutation.quarantinePath, Buffer.alloc(0));
    rightPath = mutation.quarantinePath!;
  }
  const restaged: PersistedProjectionExchange = {
    ...exchange,
    rightPath,
    rightIdentity: role === "temporary" ? mutation.temporaryIdentity! : mutation.placeholderIdentity!,
  };
  mutation.exchangeState = restaged;
  persistMutation(handle, mutation);
  return restaged;
}

function resumeProjectionExchange(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): void {
  const exchange = reconcileProjectionExchange(handle, mutation);
  if (exchange === null) return;
  try {
    handle.exchangePaths(
      exchange.leftPath,
      exchange.rightPath,
      exchange.leftIdentity,
      exchange.rightIdentity,
      exchange.guardPath,
      exchange.guardIdentity,
    );
  } catch (error) {
    retainFailedExchangeEvidence(handle, mutation, error, mutation.operation === "remove-tree");
    throw error;
  }
  mutation.exchangeState = null;
  mutation.exchangeGuardIdentity = null;
  persistMutation(handle, mutation);
}

function retainFailedExchangeEvidence(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
  error: unknown,
  _directory: boolean,
): void {
  // Only deterministic identity contradictions convert to retained evidence.
  // Transient classes (EBUSY / sharing violation / EXDEV) keep the entry and
  // rethrow so the existing outer retry schedules keep ownership.
  if (!isDeterministicExchangeIdentityError(error)) return;
  retireExchangeWithRetainedEvidence(handle, mutation);
}

function applyWriteMutation(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): void {
  managedProjectionWriteFaultForTest?.(mutation.logicalPath);
  resumeProjectionExchange(handle, mutation);
  const expected = Buffer.from(mutation.content!, mutation.encoding!);
  if (handle.pathExists(mutation.logicalPath)
    && mutation.temporaryIdentity !== null
    && handle.pathIdentity(mutation.logicalPath) === mutation.temporaryIdentity
    && handle.readFile(mutation.logicalPath).equals(expected)) {
    if (mutation.placeholderIdentity !== null) {
      removePlaceholder(handle, mutation.temporaryPath!, mutation.placeholderIdentity, false);
    }
    if (mutation.replacementIdentity !== null) {
      removePlaceholder(handle, mutation.replacementPath!, mutation.replacementIdentity, false);
    }
    return;
  }
  if (handle.pathExists(mutation.temporaryPath!) && mutation.temporaryIdentity === null) {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.temporaryPath!,
      kind: "temporary",
      logicalPath: mutation.logicalPath,
      scope: "file",
    });
    const directory = dirname(mutation.temporaryPath!).replaceAll("\\", "/");
    mutation.temporaryPath = `${directory === "." ? "" : `${directory}/`}.gsd-projection-tmp-${randomUUID()}`;
    mutation.replacementPath = `${mutation.temporaryPath}.replaced`;
    persistMutation(handle, mutation);
  }
  if (!handle.pathExists(mutation.temporaryPath!)) {
    mutation.temporaryIdentity = handle.prepareFileTemporary(mutation.temporaryPath!, expected);
    persistMutation(handle, mutation);
  }
  if (handle.pathExists(mutation.logicalPath) && handle.pathKind(mutation.logicalPath) !== "file") {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.logicalPath,
      evidenceIdentity: handle.pathIdentity(mutation.logicalPath),
      kind: "canonical",
      logicalPath: mutation.logicalPath,
      scope: "tree",
    });
    removePlaceholder(handle, mutation.temporaryPath!, mutation.temporaryIdentity!, false);
    handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
    throw new Error("managed projection target kind changed; recovery evidence retained");
  }
  if (handle.pathExists(mutation.replacementPath!)) {
    const actualIdentity = handle.pathIdentity(mutation.replacementPath!);
    if (mutation.replacementIdentity === null || (actualIdentity !== mutation.replacementIdentity
      && actualIdentity !== mutation.placeholderIdentity)) {
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.replacementPath!,
        evidenceIdentity: actualIdentity,
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: "file",
      });
      const directory = dirname(mutation.replacementPath!).replaceAll("\\", "/");
      mutation.replacementPath = `${directory === "." ? "" : `${directory}/`}.gsd-projection-remove-${randomUUID()}`;
      mutation.replacementIdentity = handle.pathExists(mutation.logicalPath)
        ? handle.pathIdentity(mutation.logicalPath)
        : "-";
      mutation.placeholderIdentity = null;
      persistMutation(handle, mutation);
    }
  }
  if (mutation.replacementIdentity === "-"
    && mutation.placeholderIdentity !== null
    && handle.pathExists(mutation.logicalPath)
    && handle.pathIdentity(mutation.logicalPath) === mutation.placeholderIdentity) {
    exchangeMutationPaths(
      handle,
      mutation,
      mutation.logicalPath,
      mutation.temporaryPath!,
      mutation.placeholderIdentity,
      mutation.temporaryIdentity!,
      false,
    );
    removePlaceholder(handle, mutation.temporaryPath!, mutation.placeholderIdentity, false);
    return;
  }
  if (!handle.pathExists(mutation.logicalPath)) {
    if (mutation.replacementIdentity !== null && mutation.replacementIdentity !== "-") {
      throw new Error("managed projection target identity changed");
    }
    mutation.placeholderIdentity = handle.prepareFileTemporary(mutation.logicalPath, Buffer.alloc(0));
    persistMutation(handle, mutation);
    exchangeMutationPaths(
      handle,
      mutation,
      mutation.logicalPath,
      mutation.temporaryPath!,
      mutation.placeholderIdentity,
      mutation.temporaryIdentity!,
      false,
    );
    if (handle.pathExists(mutation.temporaryPath!)) {
      removePlaceholder(handle, mutation.temporaryPath!, mutation.placeholderIdentity, false);
    }
    return;
  }
  if (mutation.replacementIdentity === null) {
    mutation.replacementIdentity = handle.pathIdentity(mutation.logicalPath);
    persistMutation(handle, mutation);
  }
  if (!handle.pathExists(mutation.replacementPath!)) {
    mutation.placeholderIdentity = handle.prepareFileTemporary(mutation.replacementPath!, Buffer.alloc(0));
    persistMutation(handle, mutation);
  } else if (mutation.placeholderIdentity === null) {
    throw new Error("managed projection replacement placeholder is not journal-bound");
  }
  const logicalIdentity = handle.pathIdentity(mutation.logicalPath);
  const replacementIdentity = handle.pathIdentity(mutation.replacementPath!);
  if (logicalIdentity === mutation.replacementIdentity
    && replacementIdentity === mutation.placeholderIdentity) {
    exchangeMutationPaths(
      handle,
      mutation,
      mutation.logicalPath,
      mutation.replacementPath!,
      mutation.replacementIdentity,
      mutation.placeholderIdentity!,
      false,
    );
  } else if (logicalIdentity !== mutation.placeholderIdentity
    || replacementIdentity !== mutation.replacementIdentity) {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.logicalPath,
      evidenceIdentity: logicalIdentity,
      kind: "canonical",
      logicalPath: mutation.logicalPath,
      scope: "file",
    });
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.replacementPath!,
      evidenceIdentity: replacementIdentity,
      kind: "quarantine",
      logicalPath: mutation.logicalPath,
      scope: "file",
    });
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.temporaryPath!,
      evidenceIdentity: mutation.temporaryIdentity,
      kind: "temporary",
      logicalPath: mutation.logicalPath,
      scope: "file",
    });
    handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
    throw new Error("managed projection target identity changed; recovery evidence retained");
  }
  exchangeMutationPaths(
    handle,
    mutation,
    mutation.logicalPath,
    mutation.temporaryPath!,
    mutation.placeholderIdentity!,
    mutation.temporaryIdentity!,
    false,
  );
  removePlaceholder(handle, mutation.temporaryPath!, mutation.placeholderIdentity!, false);
  removePlaceholder(handle, mutation.replacementPath!, mutation.replacementIdentity!, false);
}

function applyRemoveMutation(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): void {
  resumeProjectionExchange(handle, mutation);
  const directory = mutation.operation === "remove-tree";
  if (handle.pathExists(mutation.exchangeGuardPath)) {
    const guardIdentity = handle.pathIdentity(mutation.exchangeGuardPath);
    if (mutation.placeholderIdentity === null || guardIdentity !== mutation.placeholderIdentity) {
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.exchangeGuardPath,
        evidenceIdentity: guardIdentity,
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: directory ? "tree" : "file",
      });
      if (handle.pathExists(mutation.quarantinePath!)) {
        recordUnboundProjectionEvidence(handle, {
          evidencePath: mutation.quarantinePath!,
          evidenceIdentity: handle.pathIdentity(mutation.quarantinePath!),
          kind: "quarantine",
          logicalPath: mutation.logicalPath,
          scope: directory ? "tree" : "file",
        });
      }
      return;
    }
    handle.removeFileViaGuardExact(
      mutation.logicalPath,
      mutation.placeholderIdentity,
      mutation.logicalPath,
      directory,
      projectionContentDigest(handle, mutation.logicalPath, directory ? "tree" : "file"),
    );
  }
  if (!handle.pathExists(mutation.logicalPath)) {
    if (!handle.pathExists(mutation.quarantinePath!)) return;
    if (mutation.quarantineIdentity === null
      || handle.pathIdentity(mutation.quarantinePath!) !== mutation.quarantineIdentity) {
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.quarantinePath!,
        evidenceIdentity: handle.pathIdentity(mutation.quarantinePath!),
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: directory ? "tree" : "file",
      });
      return;
    }
    removePlaceholder(handle, mutation.quarantinePath!, mutation.quarantineIdentity, directory);
    return;
  }
  if (mutation.quarantineIdentity === null) {
    mutation.quarantineIdentity = handle.pathIdentity(mutation.logicalPath);
    persistMutation(handle, mutation);
  }
  if (!handle.pathExists(mutation.quarantinePath!)) {
    mutation.placeholderIdentity = directory
      ? handle.prepareDirectoryPlaceholder(mutation.quarantinePath!)
      : handle.prepareFileTemporary(mutation.quarantinePath!, Buffer.alloc(0));
    persistMutation(handle, mutation);
  } else if (mutation.placeholderIdentity === null) {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.quarantinePath!,
      evidenceIdentity: handle.pathIdentity(mutation.quarantinePath!),
      kind: "quarantine",
      logicalPath: mutation.logicalPath,
      scope: directory ? "tree" : "file",
    });
    const parent = dirname(mutation.quarantinePath!).replaceAll("\\", "/");
    mutation.quarantinePath = `${parent === "." ? "" : `${parent}/`}.gsd-projection-remove-${randomUUID()}`;
    persistMutation(handle, mutation);
    mutation.placeholderIdentity = directory
      ? handle.prepareDirectoryPlaceholder(mutation.quarantinePath)
      : handle.prepareFileTemporary(mutation.quarantinePath, Buffer.alloc(0));
    persistMutation(handle, mutation);
  }
  const logicalIdentity = handle.pathIdentity(mutation.logicalPath);
  const quarantineIdentity = handle.pathIdentity(mutation.quarantinePath!);
  if (logicalIdentity === mutation.quarantineIdentity
    && quarantineIdentity === mutation.placeholderIdentity) {
    exchangeMutationPaths(
      handle,
      mutation,
      mutation.logicalPath,
      mutation.quarantinePath!,
      mutation.quarantineIdentity,
      mutation.placeholderIdentity!,
      directory,
    );
  } else if (logicalIdentity !== mutation.placeholderIdentity
    || quarantineIdentity !== mutation.quarantineIdentity) {
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.logicalPath,
      evidenceIdentity: logicalIdentity,
      kind: "canonical",
      logicalPath: mutation.logicalPath,
      scope: directory ? "tree" : "file",
    });
    recordUnboundProjectionEvidence(handle, {
      evidencePath: mutation.quarantinePath!,
      evidenceIdentity: quarantineIdentity,
      kind: "quarantine",
      logicalPath: mutation.logicalPath,
      scope: directory ? "tree" : "file",
    });
    handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
    throw new Error("managed projection target identity changed; recovery evidence retained");
  }
  handle.removeFileViaGuardExact(
    mutation.logicalPath,
    mutation.placeholderIdentity!,
    mutation.logicalPath,
    directory,
    projectionContentDigest(handle, mutation.logicalPath, directory ? "tree" : "file"),
  );
  managedProjectionApplyFaultForTest?.();
  removePlaceholder(handle, mutation.quarantinePath!, mutation.quarantineIdentity!, directory);
}

function containsProjectionFile(handle: ProjectionRootIdentityLock, path: string): boolean {
  return handle.listDirectory(path).some((name) => {
    const child = `${path}/${name}`;
    return handle.pathKind(child) === "file" || containsProjectionFile(handle, child);
  });
}

function applyLegacyCleanupMutation(
  handle: ProjectionRootIdentityLock,
  mutation: PersistedManagedProjectionMutation,
): void {
  resumeProjectionExchange(handle, mutation);
  const quarantinePath = mutation.quarantinePath!;
  if (handle.pathExists(mutation.logicalPath)) {
    if (mutation.quarantineIdentity === null) {
      mutation.quarantineIdentity = handle.pathIdentity(mutation.logicalPath);
      persistMutation(handle, mutation);
    }
    if (!handle.pathExists(quarantinePath)) {
      mutation.placeholderIdentity = handle.prepareDirectoryPlaceholder(quarantinePath);
      persistMutation(handle, mutation);
    } else if (mutation.placeholderIdentity === null) {
      recordUnboundProjectionEvidence(handle, {
        evidencePath: quarantinePath,
        evidenceIdentity: handle.pathIdentity(quarantinePath),
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: "tree",
      });
      const parent = dirname(quarantinePath).replaceAll("\\", "/");
      mutation.quarantinePath = `${parent === "." ? "" : `${parent}/`}.gsd-projection-remove-${randomUUID()}`;
      persistMutation(handle, mutation);
      mutation.placeholderIdentity = handle.prepareDirectoryPlaceholder(mutation.quarantinePath);
      persistMutation(handle, mutation);
    }
    const logicalIdentity = handle.pathIdentity(mutation.logicalPath);
    const quarantineIdentity = handle.pathIdentity(mutation.quarantinePath!);
    if (logicalIdentity === mutation.quarantineIdentity
      && quarantineIdentity === mutation.placeholderIdentity) {
      exchangeMutationPaths(
        handle,
        mutation,
        mutation.logicalPath,
        mutation.quarantinePath!,
        mutation.quarantineIdentity,
        mutation.placeholderIdentity,
        true,
      );
    } else if (logicalIdentity !== mutation.placeholderIdentity
      || quarantineIdentity !== mutation.quarantineIdentity) {
      // The journaled exchange already completed but the process died before
      // the placeholder was removed; re-issuing the exchange against the
      // completed state wedges the journal on Windows. Anything other than
      // the completed state is an identity change: retain reviewable evidence
      // and close the journal instead of exchanging against stale identities.
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.logicalPath,
        evidenceIdentity: logicalIdentity,
        kind: "canonical",
        logicalPath: mutation.logicalPath,
        scope: "tree",
      });
      recordUnboundProjectionEvidence(handle, {
        evidencePath: mutation.quarantinePath!,
        evidenceIdentity: quarantineIdentity,
        kind: "quarantine",
        logicalPath: mutation.logicalPath,
        scope: "tree",
      });
      handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
      throw new Error("managed projection target identity changed; recovery evidence retained");
    }
  }
  legacyProjectionCleanupExchangeFaultForTest?.();
  if (handle.pathExists(mutation.logicalPath)) {
    handle.removeFileViaGuardExact(
      mutation.logicalPath,
      mutation.placeholderIdentity!,
      mutation.logicalPath,
      true,
      projectionContentDigest(handle, mutation.logicalPath, "tree"),
    );
  }
  legacyProjectionCleanupBoundaryForTest?.();
  const milestone = basename(mutation.logicalPath);
  const activeQuarantinePath = mutation.quarantinePath!;
  const laterAuthority = handle.pathExists("gsd.db")
    || handle.pathExists(`worktrees/${milestone}`)
    || containsProjectionFile(handle, activeQuarantinePath);
  if (laterAuthority) {
    handle.restoreQuarantinedTreeExact(
      activeQuarantinePath,
      mutation.logicalPath,
      mutation.quarantineIdentity!,
      projectionContentDigest(handle, activeQuarantinePath, "tree"),
    );
    handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
    throw new Error("later authority appeared during orphan cleanup");
  }
  handle.removeFileViaGuardExact(
    activeQuarantinePath,
    mutation.quarantineIdentity!,
    activeQuarantinePath,
    true,
    projectionContentDigest(handle, activeQuarantinePath, "tree"),
  );
}

function recoverManagedProjectionMutations(
  targetRoot: string,
  handle: ProjectionRootIdentityLock,
): void {
  if (!handle.pathExists(JOURNAL_LOGICAL_ROOT)) return;
  for (const name of handle.listDirectory(JOURNAL_LOGICAL_ROOT)) {
    if (!name.endsWith(".json")) {
      // Files inside the .gsd namespace may be interrupted journal-bound
      // artifacts and stay fail-closed; clearly foreign files (e.g.
      // .DS_Store) must not wedge every projection operation forever.
      if (name.startsWith(".gsd")) throw new Error("managed projection mutation journal is invalid");
      console.warn(`gsd: skipping foreign file in managed projection mutation journal: ${name}`);
      continue;
    }
    const journalPath = `${JOURNAL_LOGICAL_ROOT}/${name}`;
    const mutation = validateMutation(
      JSON.parse(handle.readFile(journalPath).toString("utf8")),
      targetRoot,
      join(journalRoot(targetRoot), name),
    );
    if (mutation.legacyCleanup) applyLegacyCleanupMutation(handle, mutation);
    else if (mutation.operation === "write") applyWriteMutation(handle, mutation);
    else applyRemoveMutation(handle, mutation);
    if (mutation.operation !== "remove-tree") {
      recordManagedProjectionLogicalPath(handle, mutation.logicalPath);
    }
    handle.removeFile(journalPath);
  }
}

export function loadManagedProjectionPaths(targetRoot: string): string[] {
  if (!isProjectionRootIdentityLockAvailable()) {
    // Journals cannot be replayed without the native identity lock. Skip them
    // and read history directly so a stale projection-mutations dir cannot
    // wedge ROADMAP repair forever (#1755).
    const path = historyPath(targetRoot);
    return withProjectionMutationSync(path, () => readFallbackManagedProjectionPaths(path));
  }
  const path = historyPath(targetRoot);
  return withProjectionMutationSync(path, () => withManagedProjectionRoot(targetRoot, (handle) => {
    recoverManagedProjectionMutations(targetRoot, handle);
    return readManagedProjectionPaths(handle);
  }));
}

export function loadUnboundProjectionEvidence(targetRoot: string): UnboundProjectionEvidence[] {
  if (!isProjectionRootIdentityLockAvailable()) {
    return withProjectionMutationSync(
      historyPath(targetRoot),
      () => readFallbackUnboundProjectionEvidence(targetRoot),
    );
  }
  const path = historyPath(targetRoot);
  return withProjectionMutationSync(path, () => withManagedProjectionRoot(targetRoot, (handle) => {
    recoverManagedProjectionMutations(targetRoot, handle);
    recoverEvidenceResolutions(handle);
    return readUnboundProjectionEvidence(handle);
  }));
}

export interface UnboundProjectionEvidenceResolutionPreview extends UnboundProjectionEvidence {
  readonly currentIdentity: string;
  readonly destinationPath: string | null;
  readonly consent: string;
}

function evidenceDestination(
  evidence: UnboundProjectionEvidence,
  action: UnboundProjectionEvidenceResolutionAction,
): string | null {
  if (action === "discard") return null;
  if (action === "restore") return evidence.logicalPath;
  return `migration/preserved-projection-evidence/${evidence.evidenceId.slice("evidence:sha256:".length)}`;
}

function pathToken(value: string, label: string): string {
  const hex = createHash("sha256").update(`${label}\0${value}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function evidenceResolutionPaths(
  id: string,
  evidencePath: string,
  destinationPath: string | null,
): { guardPath: string; stagingPath: string | null; exchangePath: string } {
  const evidenceParent = dirname(evidencePath).replaceAll("\\", "/");
  const destinationParent = destinationPath === null ? null : dirname(destinationPath).replaceAll("\\", "/");
  const prefix = (parent: string): string => parent === "." ? "" : `${parent}/`;
  return {
    guardPath: `${prefix(evidenceParent)}.gsd-projection-remove-${pathToken(id, "guard")}`,
    stagingPath: destinationParent === null
      ? null
      : `${prefix(destinationParent)}.gsd-projection-tmp-${pathToken(id, "staging")}`,
    exchangePath: `${prefix(evidenceParent)}.gsd-projection-exchange-${pathToken(id, "exchange")}`,
  };
}

function evidenceConsent(
  evidence: UnboundProjectionEvidence,
  action: UnboundProjectionEvidenceResolutionAction,
  currentIdentity: string,
  contentDigest: string,
  destinationPath: string | null,
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action,
    contentDigest,
    destinationPath,
    evidenceId: evidence.evidenceId,
    evidencePath: evidence.evidencePath,
    currentIdentity,
    logicalPath: evidence.logicalPath,
    scope: evidence.scope,
  })).digest("hex");
  return `${action}:sha256:${digest}`;
}

function findEvidence(entries: readonly UnboundProjectionEvidence[], id: string): UnboundProjectionEvidence | undefined {
  return entries.find(entry => entry.evidenceId === id || entry.evidencePath === id);
}

function copyEvidence(
  handle: ProjectionRootIdentityLock,
  sourcePath: string,
  destinationPath: string,
  scope: "file" | "tree",
): void {
  if (scope === "file") {
    handle.writeFile(destinationPath, handle.readFile(sourcePath));
    unboundEvidenceCopyFaultForTest?.();
    return;
  }
  const copyTree = (source: string, destination: string): void => {
    for (const name of handle.listDirectory(source)) {
      const childSource = `${source}/${name}`;
      const childDestination = `${destination}/${name}`;
      if (handle.pathKind(childSource) === "file") {
        handle.writeFile(childDestination, handle.readFile(childSource));
      } else {
        handle.createDirectory(childDestination);
        copyTree(childSource, childDestination);
      }
      unboundEvidenceCopyFaultForTest?.();
    }
  };
  copyTree(sourcePath, destinationPath);
}

function persistResolvingEvidence(handle: ProjectionRootIdentityLock, evidence: UnboundProjectionEvidence): void {
  const entries = readUnboundProjectionEvidence(handle);
  writeUnboundProjectionEvidence(
    handle,
    entries.map(entry => entry.evidenceId === evidence.evidenceId ? evidence : entry),
  );
}

function removeResolutionPath(
  handle: ProjectionRootIdentityLock,
  path: string,
  identity: string,
  tree: boolean,
): void {
  if (handle.pathExists(path)) {
    handle.removeFileViaGuardExact(
      path,
      identity,
      path,
      tree,
      projectionContentDigest(handle, path, tree ? "tree" : "file"),
    );
  }
}

function moveEvidenceIntoGuard(
  handle: ProjectionRootIdentityLock,
  evidence: UnboundProjectionEvidence,
): string {
  const resolution = evidence.resolution!;
  const paths = evidenceResolutionPaths(evidence.evidenceId, evidence.evidencePath, resolution.destinationPath);
  if (resolution.phase !== "prepared") return resolution.guardPath;
  if (!handle.pathExists(evidence.evidencePath)) {
    if (!handle.pathExists(resolution.guardPath)
      || handle.pathIdentity(resolution.guardPath) !== resolution.currentIdentity) {
      throw new Error("unbound projection evidence is unavailable");
    }
    resolution.guardIdentity = resolution.currentIdentity;
    resolution.phase = "guarded";
    persistResolvingEvidence(handle, evidence);
    return resolution.guardPath;
  }
  if (resolution.guardIdentity === null) {
    if (handle.pathExists(resolution.guardPath)) {
      throw new Error("unbound projection evidence guard is not journal-bound");
    }
    resolution.guardIdentity = evidence.scope === "tree"
      ? handle.prepareDirectoryPlaceholder(resolution.guardPath)
      : handle.prepareFileTemporary(resolution.guardPath, Buffer.alloc(0));
    persistResolvingEvidence(handle, evidence);
  }
  if (resolution.exchangeIdentity === null) {
    if (handle.pathExists(paths.exchangePath)) {
      throw new Error("unbound projection exchange guard is not journal-bound");
    }
    resolution.exchangeIdentity = evidence.scope === "tree"
      ? handle.prepareDirectoryPlaceholder(paths.exchangePath)
      : handle.prepareFileTemporary(paths.exchangePath, Buffer.alloc(0));
    persistResolvingEvidence(handle, evidence);
  }
  handle.exchangePaths(
    evidence.evidencePath,
    resolution.guardPath,
    resolution.currentIdentity,
    resolution.guardIdentity,
    paths.exchangePath,
    resolution.exchangeIdentity,
  );
  resolution.exchangeIdentity = null;
  persistResolvingEvidence(handle, evidence);
  removeResolutionPath(
    handle,
    evidence.evidencePath,
    resolution.guardIdentity,
    evidence.scope === "tree",
  );
  resolution.guardIdentity = resolution.currentIdentity;
  resolution.phase = "guarded";
  persistResolvingEvidence(handle, evidence);
  return resolution.guardPath;
}

function publishEvidenceDestination(
  handle: ProjectionRootIdentityLock,
  evidence: UnboundProjectionEvidence,
  sourcePath: string,
): void {
  const resolution = evidence.resolution!;
  if (resolution.action === "discard" || resolution.phase === "published") return;
  const destination = resolution.destinationPath!;
  if (evidence.scope === "file") {
    if (!handle.pathExists(destination)) copyEvidence(handle, sourcePath, destination, "file");
  } else {
    const staging = resolution.stagingPath!;
    if (handle.pathExists(staging)) {
      if (resolution.stagingIdentity === null
        || handle.pathIdentity(staging) !== resolution.stagingIdentity) {
        throw new Error("unbound projection evidence staging identity changed");
      }
      removeResolutionPath(handle, staging, resolution.stagingIdentity, true);
      resolution.stagingIdentity = null;
      persistResolvingEvidence(handle, evidence);
    }
    resolution.stagingIdentity = handle.prepareDirectoryPlaceholder(staging);
    persistResolvingEvidence(handle, evidence);
    copyEvidence(handle, sourcePath, staging, "tree");
    if (projectionContentDigest(handle, staging, "tree") !== resolution.contentDigest) {
      throw new Error("unbound projection evidence staging verification failed");
    }
    if (!handle.pathExists(destination)) {
      try {
        handle.restoreQuarantinedTreeExact(
          staging,
          destination,
          resolution.stagingIdentity,
          resolution.contentDigest,
        );
      } catch (error) {
        const destinationPublished = handle.pathExists(destination)
          && projectionContentDigest(handle, destination, "tree") === resolution.contentDigest;
        if (handle.pathExists(destination) && !destinationPublished) {
          throw new Error("unbound projection evidence destination changed during publication");
        }
        if (handle.pathExists(staging)
          && (resolution.stagingIdentity === null
            || handle.pathIdentity(staging) !== resolution.stagingIdentity
            || projectionContentDigest(handle, staging, "tree") !== resolution.contentDigest)) {
          if (destinationPublished) {
            const logicalParent = dirname(evidence.logicalPath).replaceAll("\\", "/");
            const replacementPath = `${logicalParent === "." ? "" : `${logicalParent}/`}.gsd-projection-remove-${randomUUID()}`;
            const replacementIdentity = handle.quarantineTree(staging, replacementPath);
            recordUnboundProjectionEvidence(handle, {
              evidencePath: replacementPath,
              evidenceIdentity: replacementIdentity,
              kind: "quarantine",
              logicalPath: evidence.logicalPath,
              scope: "tree",
            });
            resolution.stagingIdentity = null;
            resolution.phase = "published";
            persistResolvingEvidence(handle, evidence);
          }
        }
        throw error;
      }
    } else if (projectionContentDigest(handle, destination, "tree") !== resolution.contentDigest) {
      throw new Error("unbound projection evidence destination already contains different content");
    } else {
      removeResolutionPath(handle, staging, resolution.stagingIdentity, true);
    }
    resolution.stagingIdentity = null;
  }
  if (!handle.pathExists(destination)
    || projectionContentDigest(handle, destination, evidence.scope) !== resolution.contentDigest) {
    throw new Error("unbound projection evidence destination verification failed");
  }
  resolution.phase = "published";
  persistResolvingEvidence(handle, evidence);
}

function applyEvidenceResolution(
  handle: ProjectionRootIdentityLock,
  evidence: UnboundProjectionEvidence,
): void {
  const resolution = evidence.resolution!;
  if (evidence.origin === "native-control") {
    markNativeEvidenceDescriptorResolving(handle, evidence.evidencePath);
  }
  if ((resolution.phase === "published" || resolution.phase === "deleting")
    && !handle.pathExists(resolution.guardPath)) {
    if (resolution.destinationPath !== null
      && (!handle.pathExists(resolution.destinationPath)
        || projectionContentDigest(handle, resolution.destinationPath, evidence.scope) !== resolution.contentDigest)) {
      throw new Error("unbound projection evidence completed destination changed");
    }
    return;
  }
  const source = moveEvidenceIntoGuard(handle, evidence);
  unboundEvidenceGuardFaultForTest?.();
  if (resolution.phase !== "deleting" && (handle.pathIdentity(source) !== resolution.currentIdentity
    || projectionContentDigest(handle, source, evidence.scope) !== resolution.contentDigest)) {
    const changed: UnboundProjectionEvidence = {
      evidenceId: evidenceId(source, "quarantine", evidence.logicalPath, evidence.scope),
      evidencePath: source,
      evidenceIdentity: handle.pathIdentity(source),
      contentDigest: projectionContentDigest(handle, source, evidence.scope),
      kind: "quarantine",
      logicalPath: evidence.logicalPath,
      scope: evidence.scope,
      transition: "retained",
    };
    const entries = readUnboundProjectionEvidence(handle);
    writeUnboundProjectionEvidence(
      handle,
      entries.map(entry => entry.evidenceId === evidence.evidenceId ? changed : entry),
    );
    throw new Error("unbound projection evidence changed inside its private guard");
  }
  if (resolution.phase !== "deleting") publishEvidenceDestination(handle, evidence, source);
  if (resolution.phase !== "published" && resolution.phase !== "deleting") {
    resolution.phase = "published";
    persistResolvingEvidence(handle, evidence);
  }
  unboundEvidenceRemovalFaultForTest?.();
  resolution.phase = "deleting";
  persistResolvingEvidence(handle, evidence);
  try {
    handle.removeFileViaGuardExact(
      source,
      resolution.currentIdentity,
      source,
      evidence.scope === "tree",
      resolution.contentDigest,
      true,
    );
  } catch (error) {
    if (!isUnexpectedOccupantError(error) || !handle.pathExists(source)) throw error;
    const pending: PersistedUnboundProjectionEvidence = {
      evidenceId: evidenceId(source, "quarantine", evidence.logicalPath, "tree"),
      evidencePath: source,
      evidenceIdentity: handle.pathIdentity(source),
      contentDigest: projectionContentDigest(handle, source, "tree"),
      kind: "quarantine",
      logicalPath: evidence.logicalPath,
      scope: "tree",
      transition: "retained",
      nativeDeletionAckPending: true,
    };
    const entries = readUnboundProjectionEvidence(handle);
    writeUnboundProjectionEvidence(
      handle,
      entries.map(entry => entry.evidenceId === evidence.evidenceId ? pending : entry),
    );
    readUnboundProjectionEvidence(handle);
    throw error;
  }
}

function recoverEvidenceResolutions(handle: ProjectionRootIdentityLock): void {
  const entries = readUnboundProjectionEvidence(handle);
  const retained: UnboundProjectionEvidence[] = [];
  let changed = false;
  for (const evidence of entries) {
    if (evidence.transition === "retained") {
      retained.push(evidence);
      continue;
    }
    applyEvidenceResolution(handle, evidence);
    changed = true;
  }
  if (changed) {
    writeUnboundProjectionEvidence(handle, retained);
    for (const evidence of entries) {
      if (evidence.transition === "resolving" && evidence.origin === "native-control") {
        removeNativeEvidenceDescriptor(handle, evidence.evidencePath);
      }
    }
  }
}

export function previewUnboundProjectionEvidenceResolution(
  targetRoot: string,
  evidenceId: string,
  action: UnboundProjectionEvidenceResolutionAction = "discard",
): UnboundProjectionEvidenceResolutionPreview {
  if (!isProjectionRootIdentityLockAvailable()) {
    return withProjectionMutationSync(historyPath(targetRoot), () => {
      const evidence = findEvidence(readFallbackUnboundProjectionEvidence(targetRoot), evidenceId);
      if (!evidence) throw new Error("unbound projection evidence is unavailable");
      const path = fallbackProjectionPath(targetRoot, evidence.evidencePath);
      if (!existsSync(path)) throw new Error("unbound projection evidence is unavailable");
      const currentIdentity = fallbackProjectionIdentity(path);
      const contentDigest = fallbackProjectionContentDigest(path, evidence.scope);
      const destinationPath = evidenceDestination(evidence, action);
      return {
        ...evidence,
        currentIdentity,
        contentDigest,
        destinationPath,
        consent: evidenceConsent(evidence, action, currentIdentity, contentDigest, destinationPath),
      };
    });
  }
  return withProjectionMutationSync(historyPath(targetRoot), () => withManagedProjectionRoot(targetRoot, handle => {
    recoverManagedProjectionMutations(targetRoot, handle);
    recoverEvidenceResolutions(handle);
    const evidence = findEvidence(readUnboundProjectionEvidence(handle), evidenceId);
    if (!evidence || !handle.pathExists(evidence.evidencePath)) {
      throw new Error("unbound projection evidence is unavailable");
    }
    const currentIdentity = handle.pathIdentity(evidence.evidencePath);
    const contentDigest = projectionContentDigest(handle, evidence.evidencePath, evidence.scope);
    const destinationPath = evidenceDestination(evidence, action);
    return {
      ...evidence,
      contentDigest,
      currentIdentity,
      destinationPath,
      consent: evidenceConsent(evidence, action, currentIdentity, contentDigest, destinationPath),
    };
  }));
}

export function resolveUnboundProjectionEvidence(
  targetRoot: string,
  evidenceId: string,
  action: UnboundProjectionEvidenceResolutionAction,
  consent: string,
): void {
  if (!isProjectionRootIdentityLockAvailable()) {
    withProjectionMutationSync(historyPath(targetRoot), () => {
      if (action !== "discard") {
        throw new Error("native projection root identity locking is required to preserve or restore evidence");
      }
      const entries = readFallbackUnboundProjectionEvidence(targetRoot);
      const evidence = findEvidence(entries, evidenceId);
      if (!evidence) throw new Error("unbound projection evidence is unavailable");
      const path = fallbackProjectionPath(targetRoot, evidence.evidencePath);
      if (!existsSync(path)) throw new Error("unbound projection evidence is unavailable");
      const currentIdentity = fallbackProjectionIdentity(path);
      const contentDigest = fallbackProjectionContentDigest(path, evidence.scope);
      if (consent !== evidenceConsent(evidence, action, currentIdentity, contentDigest, null)) {
        throw new Error("unbound projection evidence consent does not match the reviewed content");
      }
      if (evidence.scope !== "tree" || readdirSync(path).length !== 0) {
        throw new Error("native projection root identity locking is required to discard non-empty evidence");
      }
      if (currentIdentity !== fallbackProjectionIdentity(path)
        || contentDigest !== fallbackProjectionContentDigest(path, evidence.scope)) {
        throw new Error("unbound projection evidence changed after review");
      }
      rmdirSync(path);
      writeFallbackUnboundProjectionEvidence(
        targetRoot,
        entries.filter((entry) => entry.evidenceId !== evidence.evidenceId),
      );
    });
    return;
  }
  withProjectionMutationSync(historyPath(targetRoot), () => withManagedProjectionRoot(targetRoot, handle => {
    recoverManagedProjectionMutations(targetRoot, handle);
    recoverEvidenceResolutions(handle);
    const entries = readUnboundProjectionEvidence(handle);
    const evidence = findEvidence(entries, evidenceId);
    if (!evidence || !handle.pathExists(evidence.evidencePath)) {
      throw new Error("unbound projection evidence is unavailable");
    }
    const currentIdentity = handle.pathIdentity(evidence.evidencePath);
    const contentDigest = projectionContentDigest(handle, evidence.evidencePath, evidence.scope);
    const destinationPath = evidenceDestination(evidence, action);
    const { guardPath, stagingPath } = evidenceResolutionPaths(
      evidence.evidenceId,
      evidence.evidencePath,
      destinationPath,
    );
    if (consent !== evidenceConsent(evidence, action, currentIdentity, contentDigest, destinationPath)) {
      throw new Error("unbound projection evidence consent does not match the reviewed content");
    }
    const resolving: UnboundProjectionEvidence = {
      ...evidence,
      evidenceIdentity: currentIdentity,
      contentDigest,
      transition: "resolving",
      resolution: {
        action,
        currentIdentity,
        contentDigest,
        destinationPath,
        guardPath,
        stagingPath,
        guardIdentity: null,
        stagingIdentity: null,
        exchangeIdentity: null,
        phase: "prepared",
      },
    };
    writeUnboundProjectionEvidence(handle, entries.map(entry => entry.evidenceId === evidence.evidenceId ? resolving : entry));
    applyEvidenceResolution(handle, resolving);
    unboundEvidenceResolutionFaultForTest?.();
    writeUnboundProjectionEvidence(
      handle,
      readUnboundProjectionEvidence(handle).filter(entry => entry.evidenceId !== evidence.evidenceId),
    );
    if (evidence.origin === "native-control") removeNativeEvidenceDescriptor(handle, evidence.evidencePath);
  }));
}

export function recordManagedProjectionPath(targetRoot: string, filePath: string): void {
  const logicalPath = logicalProjectionPath(targetRoot, filePath);
  const path = historyPath(targetRoot);
  withProjectionMutationSync(path, () => {
    withManagedProjectionRoot(targetRoot, (handle) => {
      recoverManagedProjectionMutations(targetRoot, handle);
      recordManagedProjectionLogicalPath(handle, logicalPath);
    });
  });
}

function managedProjectionTarget(filePath: string): { targetRoot: string; logicalPath: string } | null {
  let current = dirname(resolve(filePath));
  while (current !== dirname(current)) {
    if (basename(current).toLocaleLowerCase("en-US") === ".gsd") {
      if (!existsSync(join(current, "gsd.db"))) return null;
      const targetRoot = dirname(current);
      const logicalPath = logicalProjectionPath(targetRoot, filePath);
      return classifyGsdLogicalPath(logicalPath) === "managed"
        ? { targetRoot, logicalPath }
        : null;
    }
    current = dirname(current);
  }
  return null;
}

export function beginManagedProjectionMutation(
  filePath: string,
  operation: "write" | "remove" | "remove-tree",
  content: string | null,
  encoding: BufferEncoding | null,
): ManagedProjectionMutation | null {
  const target = managedProjectionTarget(filePath);
  if (target === null) return null;
  if (!isProjectionRootIdentityLockAvailable()) {
    if (operation === "write") {
      recordFallbackProjectionObstruction(target.targetRoot, target.logicalPath);
    }
    return null;
  }
  const root = journalRoot(target.targetRoot);
  const handle = openManagedProjectionRootWithRetry(() => openManagedProjectionRoot(target.targetRoot));
  try {
    recoverManagedProjectionMutations(target.targetRoot, handle);
    recoverEvidenceResolutions(handle);
    const conflict = readUnboundProjectionEvidence(handle)
      .find((entry) => evidenceConflictsWithPath(entry, target.logicalPath));
    if (conflict) {
      throw new Error(
        `managed projection target has unresolved recovery evidence: ${conflict.logicalPath} at ${conflict.evidencePath}; review it with /gsd doctor`,
      );
    }
    // Obstruction gate: a write/remove target occupied by the wrong node kind
    // (e.g. a real directory where a file must land) must fail before the
    // mutation is journaled. Journaling it instead records the obstruction's
    // identity as the reviewed target identity; the apply then exchanges the
    // foreign node into the replacement/quarantine slot and wedges on the
    // kind-bound placeholder removal, poisoning every later projection
    // operation with "identity changed" even after the obstruction is
    // cleared. Failing here keeps the obstruction recoverable: nothing is
    // journaled, so a retry after the obstruction is cleared converges.
    if (handle.pathExists(target.logicalPath)) {
      const occupantKind = handle.pathKind(target.logicalPath);
      const requiredKind = operation === "remove-tree" ? "directory" : "file";
      if (occupantKind !== requiredKind) {
        throw new Error(
          `managed projection ${operation} target is obstructed by a ${occupantKind}: ${target.logicalPath}`,
        );
      }
    }
    const name = `${randomUUID()}.json`;
    const journalPath = join(root, name);
    const targetDirectory = target.logicalPath.split("/").slice(0, -1).join("/");
    const temporaryPath = operation === "write"
      ? `${targetDirectory.length === 0 ? "" : `${targetDirectory}/`}.gsd-projection-tmp-${randomUUID()}`
      : null;
    const quarantinePath = operation === "remove-tree" || operation === "remove"
      ? `${targetDirectory.length === 0 ? "" : `${targetDirectory}/`}.gsd-projection-remove-${randomUUID()}`
      : null;
    const reviewedIdentity = handle.pathExists(target.logicalPath)
      ? handle.pathIdentity(target.logicalPath)
      : "-";
    const mutation: ManagedProjectionMutation = {
      ...target,
      journalPath,
      operation,
      legacyCleanup: false,
      content,
      encoding,
      temporaryPath,
      temporaryIdentity: null,
      replacementPath: temporaryPath === null ? null : `${temporaryPath}.replaced`,
      replacementIdentity: operation === "write" ? reviewedIdentity : null,
      quarantinePath,
      quarantineIdentity: operation === "write" ? null : reviewedIdentity,
      placeholderIdentity: null,
      exchangeGuardPath: `${targetDirectory.length === 0 ? "" : `${targetDirectory}/`}.gsd-projection-exchange-${basename(name, ".json")}`,
      exchangeGuardIdentity: null,
      exchangeState: null,
      handle,
    };
    persistMutation(handle, mutation);
    return mutation;
  } catch (error) {
    handle.close();
    throw error;
  }
}

export function applyManagedProjectionMutation(mutation: ManagedProjectionMutation | null): boolean {
  if (mutation === null) return false;
  if (mutation.operation === "write") {
    applyWriteMutation(mutation.handle, mutation);
    managedProjectionApplyFaultForTest?.();
  } else applyRemoveMutation(mutation.handle, mutation);
  return true;
}

export function commitManagedProjectionMutation(mutation: ManagedProjectionMutation | null): void {
  if (mutation === null) return;
  try {
    if (mutation.operation !== "remove-tree") {
      recordManagedProjectionLogicalPath(mutation.handle, mutation.logicalPath);
    }
    mutation.handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`);
  } finally {
    mutation.handle.close();
  }
}

export function retainManagedProjectionMutation(mutation: ManagedProjectionMutation | null): void {
  mutation?.handle.close();
}

export function abortManagedProjectionMutation(mutation: ManagedProjectionMutation | null): void {
  if (mutation === null) return;
  try {
    const path = `${JOURNAL_LOGICAL_ROOT}/${basename(mutation.journalPath)}`;
    if (mutation.handle.pathExists(path)) mutation.handle.removeFile(path);
  } finally {
    mutation.handle.close();
  }
}

export function recordManagedProjectionFile(filePath: string): void {
  if (!isProjectionRootIdentityLockAvailable()) return;
  const target = managedProjectionTarget(filePath);
  if (target !== null) recordManagedProjectionPath(target.targetRoot, filePath);
}

type InitialProjectionRootHandle = Pick<ProjectionRootIdentityLock, "createDirectory" | "close">;

function openInitialProjectionRoot(projectionRoot: string): ProjectionRootIdentityLock {
  const projectionStat = lstatSync(projectionRoot, { bigint: true });
  if (!projectionStat.isDirectory() || projectionStat.isSymbolicLink()) {
    throw new Error("managed projection root is not identity-stable");
  }
  return acquireProjectionRootIdentityLock(
    realpathSync(projectionRoot),
    projectionStat.dev.toString(),
    projectionStat.ino.toString(),
  );
}

function createInitialProjectionDirectory(
  directoryPath: string,
  nativeLockAvailable: () => boolean = isProjectionRootIdentityLockAvailable,
  openProjectionRoot: (projectionRoot: string) => InitialProjectionRootHandle = openInitialProjectionRoot,
): boolean {
  let projectionRoot = resolve(directoryPath);
  while (projectionRoot !== dirname(projectionRoot)
    && basename(projectionRoot).toLocaleLowerCase("en-US") !== ".gsd") {
    projectionRoot = dirname(projectionRoot);
  }
  if (basename(projectionRoot).toLocaleLowerCase("en-US") !== ".gsd") return false;
  const targetRoot = dirname(projectionRoot);
  if (!nativeLockAvailable()) {
    // Validate the project root before mkdir-ing under it, mirroring the
    // native lock's identity-stable, non-symlink root guard. A missing root
    // is not an error here: the recursive mkdir creates it (fresh worktrees
    // have no .gsd ancestor on disk yet).
    if (existsSync(targetRoot)) {
      const rootStat = lstatSync(targetRoot, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error("managed projection project root is not identity-stable");
      }
    }
    // Reject a pre-existing .gsd projection root that is a symlink (or a
    // non-directory) before mkdir-ing under it. mkdirSync(..., { recursive:
    // true }) follows a symlinked .gsd and would create projection directories
    // outside the project root; the native identity-lock path traverses from
    // the pinned root without following symlink components, so it rejects this.
    // A missing .gsd is fine: it is created below.
    if (existsSync(projectionRoot)) {
      const projectionRootStat = lstatSync(projectionRoot, { bigint: true });
      if (!projectionRootStat.isDirectory() || projectionRootStat.isSymbolicLink()) {
        throw new Error("managed projection root is not identity-stable");
      }
    }
    mkdirSync(directoryPath, { recursive: true });
    return true;
  }
  const rootStat = lstatSync(targetRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("managed projection project root is not identity-stable");
  }
  // Bootstrap the projection root before acquiring the native identity lock.
  // Locking targetRoot here makes a Windows worktree CWD contend with GSD's
  // own current-directory handle. Once .gsd exists, pinning it gives the same
  // fail-closed descendant creation without locking the parent worktree.
  mkdirSync(projectionRoot, { recursive: true });
  const handle = openManagedProjectionRootWithRetry(() => openProjectionRoot(projectionRoot));
  try {
    const logicalPath = relative(projectionRoot, resolve(directoryPath)).replaceAll("\\", "/");
    if (logicalPath.length > 0) handle.createDirectory(logicalPath);
  } finally {
    handle.close();
  }
  return true;
}

export function _createInitialProjectionDirectoryForTest(
  directoryPath: string,
  openProjectionRoot: (
    projectionRoot: string,
  ) => Pick<ProjectionRootIdentityLock, "createDirectory" | "close">,
): boolean {
  return createInitialProjectionDirectory(directoryPath, () => true, openProjectionRoot);
}

export function createManagedProjectionDirectorySync(directoryPath: string): boolean {
  const target = managedProjectionTarget(directoryPath);
  if (target === null) return createInitialProjectionDirectory(directoryPath);
  if (!isProjectionRootIdentityLockAvailable()) {
    mkdirSync(directoryPath, { recursive: true });
    return true;
  }
  withManagedProjectionRoot(target.targetRoot, (handle) => {
    recoverManagedProjectionMutations(target.targetRoot, handle);
    handle.createDirectory(target.logicalPath);
  });
  return true;
}

export interface ManagedProjectionTreeShelterReceipt {
  readonly targetRoot: string;
  readonly sourcePath: string;
  readonly shelterPath: string;
  readonly identity: string;
  readonly contentDigest: string;
}

/** Atomically move a managed projection tree into a private shelter. */
export function shelterManagedProjectionTreeSync(
  targetRoot: string,
  sourcePath: string,
  shelterPath: string,
): ManagedProjectionTreeShelterReceipt {
  const source = logicalProjectionPath(targetRoot, sourcePath);
  const shelter = logicalProjectionPath(targetRoot, shelterPath);
  return withManagedProjectionRoot(targetRoot, (handle) => {
    if (handle.pathExists(shelter)) throw new Error("managed projection shelter target already exists");
    const shelterParent = dirname(shelter).replaceAll("\\", "/");
    if (shelterParent !== ".") handle.createDirectory(shelterParent);
    const contentDigest = projectionContentDigest(handle, source, "tree");
    const identity = handle.quarantineTree(source, shelter);
    return Object.freeze({ targetRoot, sourcePath: source, shelterPath: shelter, identity, contentDigest });
  });
}

/** Restore only the exact tree identity previously moved into a shelter. */
export function restoreManagedProjectionTreeSync(receipt: ManagedProjectionTreeShelterReceipt): void {
  withManagedProjectionRoot(receipt.targetRoot, (handle) => {
    const sourceParent = dirname(receipt.sourcePath).replaceAll("\\", "/");
    if (sourceParent !== "." && !handle.pathExists(sourceParent)) {
      handle.createDirectory(sourceParent);
    }
    handle.restoreQuarantinedTreeExact(
      receipt.shelterPath,
      receipt.sourcePath,
      receipt.identity,
      receipt.contentDigest,
    );
    const shelterParent = dirname(receipt.shelterPath).replaceAll("\\", "/");
    if (shelterParent !== "." && handle.listDirectory(shelterParent).length === 0) {
      handle.removeDirectory(shelterParent);
    }
  });
}

/** Remove an explicitly authorized tree only while its identity and content remain exact. */
export function removeManagedProjectionTreeExactSync(targetRoot: string, directoryPath: string): void {
  const logicalPath = logicalProjectionPath(targetRoot, directoryPath);
  withManagedProjectionRoot(targetRoot, (handle) => {
    if (!handle.pathExists(logicalPath)) return;
    if (handle.pathKind(logicalPath) !== "directory") {
      throw new Error("managed projection removal target is not a directory");
    }
    const identity = handle.pathIdentity(logicalPath);
    const contentDigest = projectionContentDigest(handle, logicalPath, "tree");
    handle.removeFileViaGuardExact(logicalPath, identity, logicalPath, true, contentDigest, true);
  });
}

export function removeLegacyProjectionTreeSync(targetRoot: string, directoryPath: string): void {
  const logicalPath = logicalProjectionPath(targetRoot, directoryPath);
  if (classifyGsdLogicalPath(logicalPath) !== "managed") {
    throw new Error("legacy projection cleanup target is not managed");
  }
  withProjectionMutationSync(historyPath(targetRoot), () => withManagedProjectionRoot(targetRoot, handle => {
    recoverManagedProjectionMutations(targetRoot, handle);
    recoverEvidenceResolutions(handle);
    const conflict = readUnboundProjectionEvidence(handle)
      .find((entry) => evidenceConflictsWithPath(entry, logicalPath));
    if (conflict) {
      throw new Error(
        `managed projection target has unresolved recovery evidence: ${conflict.logicalPath} at ${conflict.evidencePath}; review it with /gsd doctor`,
      );
    }
    if (!handle.pathExists(logicalPath)) return;
    if (handle.pathExists("gsd.db")) throw new Error("database authority appeared during orphan cleanup");
    const parent = dirname(logicalPath).replaceAll("\\", "/");
    const digest = createHash("sha256").update(logicalPath).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const journalPath = join(journalRoot(targetRoot), `${id}.json`);
    const mutation: PersistedManagedProjectionMutation = {
      targetRoot,
      journalPath,
      logicalPath,
      operation: "remove-tree",
      legacyCleanup: true,
      content: null,
      encoding: null,
      temporaryPath: null,
      temporaryIdentity: null,
      replacementPath: null,
      replacementIdentity: null,
      quarantinePath: `${parent === "." ? "" : `${parent}/`}.gsd-projection-remove-${id}`,
      quarantineIdentity: null,
      placeholderIdentity: null,
      exchangeGuardPath: `${parent === "." ? "" : `${parent}/`}.gsd-projection-exchange-${id}`,
      exchangeGuardIdentity: null,
      exchangeState: null,
    };
    persistMutation(handle, mutation);
    applyLegacyCleanupMutation(handle, mutation);
    handle.removeFile(`${JOURNAL_LOGICAL_ROOT}/${id}.json`);
  }));
}
