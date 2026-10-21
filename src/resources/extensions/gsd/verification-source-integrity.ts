// Project/App: gsd-pi
// File Purpose: Deterministic fail-closed source snapshots for host verification targets.

import { createHash, type Hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SliceRow, TaskRow } from "./db-task-slice-rows.js";
import type { GSDPreferences } from "./preferences-types.js";
import {
  createRepositoryRegistryFromPreferences,
  defaultRepositoryTargets,
  deriveRepositoryTargetsFromPlannedPaths,
  type RegisteredRepository,
} from "./repository-registry.js";

export interface VerificationSourceTarget {
  id: string;
  cwd: string;
}

export interface VerificationTargetRevision {
  targetId: string;
  revision: string;
}

export interface VerificationSourceSnapshot {
  aggregateRevision: string;
  targets: VerificationTargetRevision[];
}

export interface ResolvedVerificationRepositoryTargets {
  repositories: RegisteredRepository[];
  explicitTargetsRequested: boolean;
  missingRepositoryIds: string[];
}

export type VerificationSourceSnapshotResult =
  | { ok: true; snapshot: VerificationSourceSnapshot }
  | { ok: false; targetId: string; error: string };

export type MilestoneVerificationSourceRevisionResult =
  | { ok: true; sourceRevision: string }
  | { ok: false; error: string };

export interface VerificationSourceSnapshotOptions {
  excludePaths?: readonly string[];
}

export interface VerificationSourceDriftDiagnosis {
  paths: string[];
  autoCommitDetected: boolean;
}

const SOURCE_PATHSPEC = [
  "--",
  ".",
  ":(exclude).gsd/**",
  ":(exclude)receipts/**",
];

/**
 * Git pathspecs match tracked path names, not symlink targets. In a GSD-managed
 * project `.gsd` is always a symlink to the real per-project state directory, so
 * the literal `:(exclude).gsd/**` above never matches the bookkeeping files —
 * git indexes them under the symlink's real path. When that real path lives
 * inside the repository (the documented layout for committing durable audit
 * artifacts), GSD rewriting its own SUMMARY/VERIFY/CODEBASE files would
 * otherwise change the source hash and invalidate a just-recorded pass verdict
 * on replay, producing a stuck retry loop (#1590).
 */
function gsdBookkeepingExclusions(cwd: string): string[] {
  let repoRoot: string;
  let gsdTarget: string;
  try {
    repoRoot = realpathSync(cwd);
    gsdTarget = realpathSync(join(cwd, ".gsd"));
  } catch {
    return [];
  }
  const rel = relative(repoRoot, gsdTarget).replaceAll("\\", "/");
  if (!rel || rel === ".gsd" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return [];
  return [`:(exclude)${rel}`, `:(exclude)${rel}/**`];
}

export function resolveVerificationRepositoryTargets(
  basePath: string,
  preferences: GSDPreferences | undefined,
  task: TaskRow | null,
  slice: SliceRow | null,
): ResolvedVerificationRepositoryTargets {
  const registry = createRepositoryRegistryFromPreferences(basePath, preferences);
  const taskTargets = task?.target_repositories?.length ? task.target_repositories : null;
  const sliceTargets = slice?.target_repositories?.length ? slice.target_repositories : null;
  const explicitIds = taskTargets ?? sliceTargets;
  // Without stored targets, honor where the task's files actually live before
  // falling back to the registry default — in parent mode the default fans out
  // to every child repo, which a root-targeting task can never satisfy (#1630).
  const derivedIds = explicitIds
    ? null
    : deriveRepositoryTargetsFromPlannedPaths(registry, task?.files ?? []);
  // Nothing derivable either (no task, or no path-shaped planned files): a
  // parent workspace verifies the orchestration root rather than fanning out
  // across every child repository (#1656).
  const parentWorkspaceFallback = registry.mode === "parent" && registry.byId.has("project")
    ? ["project"]
    : null;
  const requestedIds = explicitIds
    ?? derivedIds
    ?? parentWorkspaceFallback
    ?? defaultRepositoryTargets(registry);
  const repositories: RegisteredRepository[] = [];
  const missingRepositoryIds: string[] = [];
  const seen = new Set<string>();

  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const repository = registry.byId.get(id);
    if (repository) repositories.push(repository);
    else missingRepositoryIds.push(id);
  }

  const explicitTargetsRequested = explicitIds !== null;
  if (!explicitTargetsRequested && repositories.length === 0) {
    const project = registry.byId.get("project");
    if (project) repositories.push(project);
  }
  return { repositories, explicitTargetsRequested, missingRepositoryIds };
}

function addHashFieldHeader(hash: Hash, label: string, byteLength: number): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(byteLength));
  hash.update("\0");
}

function addHashField(hash: Hash, label: string, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  addHashFieldHeader(hash, label, bytes.length);
  hash.update(bytes);
}

function addFileHashField(hash: Hash, label: string, path: string, expectedSize: number): void {
  addHashFieldHeader(hash, label, expectedSize);
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  if (total !== expectedSize) throw new Error(`verification source changed while reading: ${path}`);
}

function gitOutput(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(detail || `git ${args.join(" ")} exited ${result.status ?? "without status"}`);
  }
  return result.stdout;
}

function sourcePaths(cwd: string, options: VerificationSourceSnapshotOptions): string[] {
  const exclusions = (options.excludePaths ?? []).map((path) => `:(exclude)${path}`);
  const paths = gitOutput(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    ...SOURCE_PATHSPEC,
    ...gsdBookkeepingExclusions(cwd),
    ...exclusions,
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return [...new Set(paths)].sort();
}

function driftPathsForTarget(cwd: string): { paths: string[]; autoCommitDetected: boolean } {
  const pathspec = [...SOURCE_PATHSPEC, ...gsdBookkeepingExclusions(cwd)];
  const workingPaths = gitOutput(cwd, [
    "ls-files",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
    "-z",
    ...pathspec,
  ]).toString("utf8").split("\0").filter(Boolean);
  const subject = gitOutput(cwd, ["log", "-1", "--format=%s", "HEAD"])
    .toString("utf8")
    .trim();
  const autoCommitDetected = subject === "chore: auto-commit before milestone merge";
  const autoCommitPaths = autoCommitDetected
    ? gitOutput(cwd, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
        ...pathspec,
      ]).toString("utf8").split("\0").filter(Boolean)
    : [];
  return {
    paths: [...new Set([...workingPaths, ...autoCommitPaths])].sort(),
    autoCommitDetected,
  };
}

/**
 * Best-effort diagnostics for a source-revision mismatch. Dirty source paths
 * are reported directly; for the historical #1793 wedge, paths captured by
 * GSD's immediately preceding pre-merge auto-commit are also reported.
 */
export function diagnoseMilestoneVerificationSourceDrift(
  basePath: string,
  preferences: GSDPreferences | undefined,
): VerificationSourceDriftDiagnosis {
  const targets = resolveVerificationRepositoryTargets(basePath, preferences, null, null);
  const paths: string[] = [];
  let autoCommitDetected = false;
  try {
    for (const repository of targets.repositories) {
      const diagnosis = driftPathsForTarget(repository.root);
      autoCommitDetected ||= diagnosis.autoCommitDetected;
      for (const path of diagnosis.paths) {
        paths.push(targets.repositories.length === 1 ? path : `${repository.id}:${path}`);
      }
    }
  } catch {
    // Diagnostics must never replace the authoritative mismatch with a git
    // inspection failure.
  }
  return { paths: [...new Set(paths)].sort(), autoCommitDetected };
}

function trackedEntry(cwd: string, path: string): { mode: string; objectId: string } | null {
  const entries = gitOutput(cwd, ["ls-files", "--stage", "-z", "--", path])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (entries.length !== 1) return null;
  const match = entries[0]?.match(/^(\d{6})\s+([0-9a-f]+)\s+0\t/);
  return match ? { mode: match[1], objectId: match[2] } : null;
}

function addSubmoduleRevision(hash: Hash, cwd: string, path: string): void {
  const entry = trackedEntry(cwd, path);
  if (entry?.mode !== "160000") {
    throw new Error(`verification source nested repository is not publishable: ${path}`);
  }
  const absolutePath = join(cwd, path);
  const head = gitOutput(absolutePath, ["rev-parse", "--verify", "HEAD"])
    .toString("utf8")
    .trim();
  if (head !== entry.objectId) {
    throw new Error(`verification source submodule commit is not staged in its parent: ${path}`);
  }
  const dirty = gitOutput(absolutePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).gsd/**",
    ...gsdBookkeepingExclusions(absolutePath),
  ]).length > 0;
  if (dirty) throw new Error(`verification source submodule has unpublished changes: ${path}`);
  addHashField(hash, "source-repository", entry.objectId);
}

function addSourceEntry(hash: Hash, cwd: string, path: string): void {
  const absolutePath = join(cwd, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (trackedEntry(cwd, path)?.mode === "160000") {
        throw new Error(`verification source submodule is unavailable: ${path}`);
      }
      return;
    }
    throw error;
  }
  addHashField(hash, "source-path", path);
  if (stat.isSymbolicLink()) {
    addHashField(hash, "source-mode", "120000");
    addHashField(hash, "source-symlink", readlinkSync(absolutePath));
    return;
  }
  if (stat.isFile()) {
    addHashField(hash, "source-mode", (stat.mode & 0o111) === 0 ? "100644" : "100755");
    addFileHashField(hash, "source-content", absolutePath, stat.size);
    return;
  }
  if (stat.isDirectory()) {
    addHashField(hash, "source-mode", "160000");
    addSubmoduleRevision(hash, cwd, path);
    return;
  }
  throw new Error(`unsupported source entry: ${path}`);
}

function captureTargetRevision(
  target: VerificationSourceTarget,
  options: VerificationSourceSnapshotOptions,
): VerificationTargetRevision {
  const hash = createHash("sha256");
  for (const path of sourcePaths(target.cwd, options)) addSourceEntry(hash, target.cwd, path);
  return { targetId: target.id, revision: `sha256:${hash.digest("hex")}` };
}

function captureVerificationSourceSnapshotOnce(
  targets: VerificationSourceTarget[],
  options: VerificationSourceSnapshotOptions = {},
): VerificationSourceSnapshotResult {
  if (targets.length === 0) {
    return { ok: false, targetId: "<targets>", error: "Verification source snapshot requires at least one target repository" };
  }
  const ordered = [...targets].sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const revisions: VerificationTargetRevision[] = [];
  for (const target of ordered) {
    if (seen.has(target.id)) {
      return { ok: false, targetId: target.id, error: `Duplicate verification source target: ${target.id}` };
    }
    seen.add(target.id);
    try {
      revisions.push(captureTargetRevision(target, options));
    } catch (error) {
      return {
        ok: false,
        targetId: target.id,
        error: `Unable to snapshot verification source for ${target.id}: ${(error as Error).message}`,
      };
    }
  }
  const aggregate = createHash("sha256");
  for (const target of revisions) {
    addHashField(aggregate, "target-id", target.targetId);
    addHashField(aggregate, "target-revision", target.revision);
  }
  return {
    ok: true,
    snapshot: {
      aggregateRevision: `sha256:${aggregate.digest("hex")}`,
      targets: revisions,
    },
  };
}

export function confirmVerificationSourceSnapshot(
  targets: VerificationSourceTarget[],
  expected: VerificationSourceSnapshot,
  options: VerificationSourceSnapshotOptions = {},
): VerificationSourceSnapshotResult {
  const confirmation = captureVerificationSourceSnapshotOnce(targets, options);
  if (!confirmation.ok) return confirmation;
  if (!verificationSourceChanged(expected, confirmation.snapshot)) return confirmation;
  const changedTarget = confirmation.snapshot.targets.find((target, index) =>
    target.targetId !== expected.targets[index]?.targetId ||
    target.revision !== expected.targets[index]?.revision
  );
  return {
    ok: false,
    targetId: changedTarget?.targetId ?? "<targets>",
    error: "Verification source changed while confirming a stable snapshot",
  };
}

export function captureVerificationSourceSnapshot(
  targets: VerificationSourceTarget[],
  options: VerificationSourceSnapshotOptions = {},
): VerificationSourceSnapshotResult {
  const first = captureVerificationSourceSnapshotOnce(targets, options);
  if (!first.ok) return first;
  return confirmVerificationSourceSnapshot(targets, first.snapshot, options);
}

export function captureMilestoneVerificationSourceRevision(
  basePath: string,
  preferences: GSDPreferences | undefined,
  options: VerificationSourceSnapshotOptions = {},
): MilestoneVerificationSourceRevisionResult {
  const targets = resolveVerificationRepositoryTargets(basePath, preferences, null, null);
  if (targets.missingRepositoryIds.length > 0) {
    return {
      ok: false,
      error: `verification source repositories are missing: ${targets.missingRepositoryIds.join(", ")}`,
    };
  }
  const source = captureVerificationSourceSnapshot(
    targets.repositories.map((repository) => ({
      id: repository.id,
      cwd: repository.root,
    })),
    options,
  );
  if (!source.ok) return { ok: false, error: source.error };
  return { ok: true, sourceRevision: source.snapshot.aggregateRevision };
}

export function verificationSourceChanged(
  before: VerificationSourceSnapshot,
  after: VerificationSourceSnapshot,
): boolean {
  return before.aggregateRevision !== after.aggregateRevision;
}
