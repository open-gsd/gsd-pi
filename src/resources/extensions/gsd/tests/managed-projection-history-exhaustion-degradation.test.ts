// Windows projection-exchange exhaustion degradation (#2355 family) for the
// managed projection-history channel. PR #3176 covered the atomicWrite paths;
// the projection-root native path used by resolve-evidence, the history-log
// append, tree shelter/restore, and legacy/orphan removal still wedged on
// ERROR_SHARING_VIOLATION (os error 32) once the native retry budget ran out.
// These tests force an exhausted sharing violation at the native boundary via
// _setManagedProjectionRootBoundaryForTest and assert each entry point falls
// back to the plain-fs degradation instead of wedging.
// File Purpose: degraded-on-exhaustion coverage for managed-projection-history.ts.

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _setManagedProjectionRootBoundaryForTest,
  loadManagedProjectionPaths,
  previewUnboundProjectionEvidenceResolution,
  recordManagedProjectionPath,
  removeManagedProjectionTreeExactSync,
  restoreManagedProjectionTreeSync,
  resolveUnboundProjectionEvidence,
  shelterManagedProjectionTreeSync,
} from "../managed-projection-history.ts";

// Verbatim engine message scaffold matched by isExhaustedTransientProjectionSharingError.
function exhaustedError(): Error {
  return new Error(
    "projection root operation failed: transient projection root sharing violation while "
    + "renaming projection child from C:\\fake\\left to C:\\fake\\right after 5 attempts: "
    + "another process holds an incompatible handle (os error 32)",
  );
}

let base: string;

// Real .gsd root + empty gsd.db marker so the native identity lock opens and
// the boundary hook fires inside withManagedProjectionRoot (managed mode).
function setupRoot(): string {
  base = mkdtempSync(join(tmpdir(), "gsd-history-exhaustion-"));
  const rootPath = join(base, ".gsd");
  mkdirSync(rootPath);
  writeFileSync(join(rootPath, "gsd.db"), "");
  return rootPath;
}

afterEach(() => {
  _setManagedProjectionRootBoundaryForTest(null);
  rmSync(base, { recursive: true, force: true });
});

// Windows noise: the maintenance fence's claim release renames its lock file
// while its own exclusive handle lacks FILE_SHARE_DELETE (same kernel shape as
// #2355). The degraded body has completed before that release, so retry until
// the noise settles and assert afterwards.
function runIgnoringFenceReleaseNoise(fn: () => void): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fn();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EBUSY") continue;
      throw error;
    }
  }
}

function exhaustedBoundary(): void {
  _setManagedProjectionRootBoundaryForTest((boundary) => {
    if (boundary === "operation") throw exhaustedError();
  });
}

test("exhausted history-log append degrades to plain-fs managed-outputs.json", () => {
  const rootPath = setupRoot();
  exhaustedBoundary();
  runIgnoringFenceReleaseNoise(() => recordManagedProjectionPath(base, join(rootPath, "STATE.md")));

  const history = loadManagedProjectionPaths(base);
  assert.ok(history.includes("STATE.md"), "degraded append recorded the logical path");
});

test("exhausted exact tree removal degrades to plain-fs recursive removal", () => {
  const rootPath = setupRoot();
  const tree = join(rootPath, "milestones", "M001");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "ROADMAP.md"), "x\n");
  exhaustedBoundary();
  runIgnoringFenceReleaseNoise(() => removeManagedProjectionTreeExactSync(base, tree));

  assert.ok(!existsSync(tree), "degraded removal wiped the managed tree");
});

test("exhausted shelter degrades to plain-fs rename and marks the receipt degraded", () => {
  const rootPath = setupRoot();
  const source = join(rootPath, "milestones", "M001");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "ROADMAP.md"), "content\n");
  const shelterPath = join(rootPath, "shelter", "M001");
  exhaustedBoundary();
  let receipt: ReturnType<typeof shelterManagedProjectionTreeSync> | undefined;
  runIgnoringFenceReleaseNoise(() => {
    receipt = shelterManagedProjectionTreeSync(base, source, shelterPath);
  });

  assert.ok(receipt?.degraded, "receipt flagged degraded");
  assert.ok(!existsSync(source), "source moved out of place");
  assert.equal(readFileSync(join(shelterPath, "ROADMAP.md"), "utf-8"), "content\n");

  // Restore of a degraded receipt uses the plain-fs rename-back.
  _setManagedProjectionRootBoundaryForTest(null);
  runIgnoringFenceReleaseNoise(() => restoreManagedProjectionTreeSync(receipt!));
  assert.ok(existsSync(source), "degraded restore renamed the tree back");
  assert.ok(!existsSync(shelterPath), "shelter emptied after restore");
});

test("exhausted resolve-evidence degrades to the lock-free resolution", () => {
  const rootPath = setupRoot();
  // A retained canonical record pointing at STATE.md, crafted so the plain-fs
  // reader accepts it (matching evidenceId + content digest).
  const evidencePath = "STATE.md";
  const logicalPath = "STATE.md";
  const scope = "file";
  const kind = "canonical";
  const content = "reviewed bytes\n";
  writeFileSync(join(rootPath, "STATE.md"), content);
  const digest = `sha256:${createHash("sha256").update(Buffer.from(content)).digest("hex")}`;
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath, kind, logicalPath, scope }))
    .digest("hex")}`;
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(
    join(rootPath, "migration", "unbound-projection-evidence.json"),
    `${JSON.stringify([
      {
        evidenceId,
        evidencePath,
        evidenceIdentity: "-",
        contentDigest: digest,
        kind,
        logicalPath,
        scope,
        transition: "retained",
      },
    ], null, 2)}\n`,
  );

  exhaustedBoundary();
  runIgnoringFenceReleaseNoise(() => {
    // previewUnboundProjectionEvidenceResolution also degrades (its native read
    // exhausts at the boundary), so the caller receives the lock-free consent;
    // resolve then exhausts at its own boundary and degrades too.
    const preview = previewUnboundProjectionEvidenceResolution(base, evidenceId, "discard");
    resolveUnboundProjectionEvidence(base, evidenceId, "discard", preview.consent);
  });

  assert.ok(!existsSync(join(rootPath, "STATE.md")), "degraded resolve removed the evidence file");
  const remaining = JSON.parse(
    readFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), "utf8"),
  ) as unknown[];
  assert.equal(remaining.length, 0, "record retired after degraded resolve");
});
