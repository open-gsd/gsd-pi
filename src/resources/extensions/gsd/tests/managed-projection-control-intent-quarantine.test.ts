// Supervised pre-open quarantine of stale control-publication intents.
// File Purpose: Verifies that a deterministic native control-publication
// replay failure (#2154) quarantines stale .gsd-control-*.json.intent files
// outside the journal directory and retries the open once, while an
// in-flight (fresh) publication is never quarantined.

import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  acquireProjectionRootIdentityLock,
  type ProjectionRootIdentityLock,
} from "@gsd/native/file-identity";

import { _withManagedProjectionRootAtForTest } from "../managed-projection-history.ts";

const CONTROL_ERROR = new Error(
  "projection root operation failed: control publication content evidence changed",
);

interface IntentFixture {
  base: string;
  rootPath: string;
  journalDir: string;
  intentPath: string;
  preparedPath: string;
  intentContent: Buffer;
  preparedContent: Buffer;
}

function prepareIntentFixture(prefix: string): IntentFixture {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const rootPath = join(base, ".gsd");
  const journalDir = join(rootPath, "migration", "projection-mutations");
  mkdirSync(journalDir, { recursive: true });
  const intentContent = Buffer.from(JSON.stringify({
    sequence: 1,
    phase: "temporary-durable",
    contentDigest: `sha256:${createHash("sha256").update("stale\n").digest("hex")}`,
    oldIdentity: "-",
    newIdentity: "-",
  }));
  const preparedContent = Buffer.from("{}");
  const intentPath = join(journalDir, ".gsd-control-00000000-0000-0000-0000-000000000001.json.intent");
  const preparedPath = join(journalDir, ".gsd-control-00000000-0000-0000-0000-000000000002.json.intent.prepared");
  writeFileSync(intentPath, intentContent);
  writeFileSync(preparedPath, preparedContent);
  return {
    base,
    rootPath,
    journalDir,
    intentPath,
    preparedPath,
    intentContent,
    preparedContent,
  };
}

function cleanupFixture(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function ageIntent(path: string): void {
  const stale = new Date(Date.now() - 200_000);
  utimesSync(path, stale, stale);
}

function realOpen(rootPath: string): ProjectionRootIdentityLock {
  const stat = lstatSync(rootPath, { bigint: true });
  return acquireProjectionRootIdentityLock(rootPath, stat.dev.toString(), stat.ino.toString());
}

test("deterministic control-publication failure quarantines stale intents and the retried open succeeds", (t) => {
  const fixture = prepareIntentFixture("gsd-control-intent-quarantine-");
  t.after(() => cleanupFixture(fixture.base));
  ageIntent(fixture.intentPath);
  ageIntent(fixture.preparedPath);

  let opens = 0;
  const outcome = _withManagedProjectionRootAtForTest(
    fixture.base,
    () => {
      opens++;
      if (opens === 1) throw CONTROL_ERROR;
      return realOpen(fixture.rootPath);
    },
    (handle) => {
      assert.equal(handle.pathExists("migration/projection-mutations"), true);
      return "rendered";
    },
  );

  assert.equal(outcome, "rendered");
  assert.equal(opens, 2);
  // Both intent variants left the journal directory...
  assert.equal(existsSync(fixture.intentPath), false);
  assert.equal(existsSync(fixture.preparedPath), false);
  // ...and landed in the quarantine directory under unique names with a
  // reviewable sidecar each.
  const quarantineDir = join(fixture.rootPath, "migration", "quarantined-control-publications");
  const quarantined = readdirSync(quarantineDir).sort();
  assert.equal(quarantined.length, 4);
  assert.ok(quarantined.every((name) => name.startsWith(".gsd-control-") && name.endsWith(".quarantined")
    || name.startsWith(".gsd-control-") && name.endsWith(".quarantined.json")));
  assert.equal(quarantined.filter((name) => name.endsWith(".quarantined.json")).length, 2);
  const record = JSON.parse(
    readFileSync(join(
      quarantineDir,
      quarantined.find((name) => name.startsWith(".gsd-control-00000000-0000-0000-0000-000000000001") && name.endsWith(".quarantined.json"))!,
    ), "utf8"),
  ) as { reason: string; originalPath: string; contentDigest: string };
  assert.equal(record.reason, "stale-control-publication-intent");
  assert.equal(record.originalPath, "migration/projection-mutations/.gsd-control-00000000-0000-0000-0000-000000000001.json.intent");
  assert.equal(
    record.contentDigest,
    `sha256:${createHash("sha256").update(fixture.intentContent).digest("hex")}`,
  );
});

test("a control-publication failure during the operation also quarantines and retries once", (t) => {
  const fixture = prepareIntentFixture("gsd-control-intent-operation-");
  t.after(() => cleanupFixture(fixture.base));
  ageIntent(fixture.intentPath);

  // The native journal replay also runs on the first journal-directory
  // listing inside the operation: the open succeeds, the operation throws.
  let opens = 0;
  let operations = 0;
  const outcome = _withManagedProjectionRootAtForTest(
    fixture.base,
    () => {
      opens++;
      return realOpen(fixture.rootPath);
    },
    (handle) => {
      operations++;
      if (operations === 1) {
        throw new Error(
          "projection root operation failed: control publication evidence retention is incomplete",
        );
      }
      return handle.pathExists("migration/projection-mutations") ? "rendered" : "missing";
    },
  );

  assert.equal(outcome, "rendered");
  assert.equal(opens, 2);
  assert.equal(operations, 2);
  assert.equal(existsSync(fixture.intentPath), false);
  const quarantineDir = join(fixture.rootPath, "migration", "quarantined-control-publications");
  assert.equal(readdirSync(quarantineDir).filter((name) => name.endsWith(".quarantined")).length, 1);
});

test("a fresh (possibly in-flight) intent is never quarantined and the open keeps failing loudly", (t) => {
  const fixture = prepareIntentFixture("gsd-control-intent-inflight-");
  t.after(() => cleanupFixture(fixture.base));

  let opens = 0;
  assert.throws(
    () => _withManagedProjectionRootAtForTest(
      fixture.base,
      () => {
        opens++;
        throw CONTROL_ERROR;
      },
      () => "unreachable",
    ),
    (error: unknown) => error === CONTROL_ERROR,
  );
  // No retry after nothing was quarantined: the second open would fail the
  // same way, so the original error propagates untouched.
  assert.equal(opens, 1);
  assert.equal(existsSync(fixture.intentPath), true);
  assert.equal(existsSync(join(fixture.rootPath, "migration", "quarantined-control-publications")), false);
});

test("an unrelated open failure never quarantines anything", (t) => {
  const fixture = prepareIntentFixture("gsd-control-intent-unrelated-");
  t.after(() => cleanupFixture(fixture.base));
  ageIntent(fixture.intentPath);

  const unrelated = new Error("projection root operation failed: something else");
  assert.throws(
    () => _withManagedProjectionRootAtForTest(
      fixture.base,
      () => {
        throw unrelated;
      },
      () => "unreachable",
    ),
    (error: unknown) => error === unrelated,
  );
  assert.equal(existsSync(fixture.intentPath), true);
});

test("a stale durable intent that is not a control-publication record stays untouched", (t) => {
  const fixture = prepareIntentFixture("gsd-control-intent-ambiguous-");
  t.after(() => cleanupFixture(fixture.base));
  ageIntent(fixture.intentPath);
  // Externally planted or corrupted bytes: ambiguous, so the supervised
  // path leaves them in place and the failure stays loud.
  writeFileSync(fixture.intentPath, "not a control publication record\n");

  assert.throws(
    () => _withManagedProjectionRootAtForTest(
      fixture.base,
      () => {
        throw CONTROL_ERROR;
      },
      () => "unreachable",
    ),
    (error: unknown) => error === CONTROL_ERROR,
  );
  assert.equal(existsSync(fixture.intentPath), true);
  assert.equal(existsSync(join(fixture.rootPath, "migration", "quarantined-control-publications")), false);
});
