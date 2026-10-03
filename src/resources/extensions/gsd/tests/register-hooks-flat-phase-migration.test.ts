// Project/App: gsd-pi
// File Purpose: Verifies session bootstrap never imports legacy Markdown whose
// identities the canonical database does not hold, still starts so the operator
// can run the explicit import, and keeps migration backups.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { closeDatabase, getAllMilestones, insertMilestone, openDatabase } from "../gsd-db.ts";

type HookHandler = (event: unknown, ctx: any) => Promise<void> | void;

function createSessionStartHandler(): HookHandler {
  const handlers = new Map<string, HookHandler>();
  const pi = {
    on(event: string, handler: HookHandler) {
      handlers.set(event, handler);
    },
  };

  registerHooks(pi as any, []);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler should be registered");
  return sessionStart;
}

function makeContext(basePath: string, notifications: Array<{ message: string; level: string }> = []) {
  return {
    cwd: basePath,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
    },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: () => {},
    },
    sessionManager: {
      getSessionId: () => null,
    },
    setCompactionThresholdOverride: () => {},
  };
}

test("session_start starts and gives explicit recovery guidance for legacy Markdown identities absent from the DB", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-flat-migration-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001: Foundation\n", "utf-8");
  // M999 has no canonical DB identity, so the legacy tree carries state the
  // database does not hold and only explicit recovery may import it. Known
  // identities (M001) are archived and rebuilt from the DB instead.
  mkdirSync(join(base, ".gsd", "milestones", "M999"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M999", "M999-CONTEXT.md"), "# M999: Unknown\n", "utf-8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  closeDatabase();

  const sessionStart = createSessionStartHandler();
  const notifications: Array<{ message: string; level: string }> = [];

  // The session must start: /gsd recover runs inside it.
  await sessionStart({}, makeContext(base, notifications));

  const guidance = notifications.filter((entry) => /flat-phase migration skipped/.test(entry.message));
  assert.equal(guidance.length, 1, "one explicit instruction, not a thrown error");
  assert.equal(guidance[0]?.level, "warning");
  assert.match(guidance[0]?.message ?? "", /\/gsd recover.*gsd headless recover.*Preview hash/);
  assert.ok(existsSync(join(base, ".gsd", "milestones", "M001")), "legacy layout should remain for recovery");
  assert.ok(existsSync(join(base, ".gsd", "milestones", "M999")), "unknown identity should remain for recovery");
  assert.equal(existsSync(join(base, ".gsd", "phases")), false, "nothing is imported or rendered implicitly");
  assert.equal(
    existsSync(join(base, ".gsd-backups")),
    false,
    "the migration must not touch disk",
  );
});

for (const database of ["missing", "schema-only"] as const) {
  test(`session_start starts and names recovery for a planned legacy tree beside a ${database} database`, async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-lost-authority-"));
    t.after(() => {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    });

    const roadmap = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(roadmap, "# M001: Foundation\n", "utf-8");
    const dbPath = join(base, ".gsd", "gsd.db");
    if (database === "schema-only") {
      openDatabase(dbPath);
      closeDatabase();
    }

    const notifications: Array<{ message: string; level: string }> = [];

    // The session must start: /gsd recover runs inside it.
    await createSessionStartHandler()({}, makeContext(base, notifications));

    const guidance = notifications.filter((entry) => /authority-missing/.test(entry.message));
    assert.equal(guidance.length, 1, "one explicit instruction, not a thrown error");
    assert.equal(guidance[0]?.level, "warning");
    assert.match(guidance[0]?.message ?? "", /\/gsd recover/);
    assert.equal(existsSync(dbPath), database === "schema-only", "no database is created");
    assert.ok(existsSync(roadmap), "legacy layout should remain for recovery");
    assert.equal(existsSync(join(base, ".gsd", "phases")), false, "nothing is imported or rendered implicitly");
    assert.equal(existsSync(join(base, ".gsd-backups")), false, "the migration must not touch disk");
    if (database === "schema-only") {
      openDatabase(dbPath);
      assert.deepEqual(getAllMilestones(), [], "the database stays empty until an explicit import");
    }
  });
}

test("session_start keeps old flat-phase migration backups", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-backup-retention-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // A migrated project: .gsd/phases/ exists and the legacy tree is gone.
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });
  const backup = join(base, ".gsd-backups", "migrate-1");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "M001-CONTEXT.md"), "# only copy of unmodeled legacy content\n", "utf-8");
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  utimesSync(backup, old, old);

  await createSessionStartHandler()({}, makeContext(base));

  assert.ok(existsSync(join(backup, "M001-CONTEXT.md")), "migration backups are never pruned at session start");
});
