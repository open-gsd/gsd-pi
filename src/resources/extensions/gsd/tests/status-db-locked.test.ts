// Project/App: gsd-pi
// File Purpose: /gsd status reports a live lock-holder instead of a raw open error (#2712).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { handleStatus } from "../commands/handlers/core.ts";
import { withCommandCwd } from "../commands/context.ts";
import { closeDatabase } from "../gsd-db.ts";

describe("status with a live workflow-DB lock holder", () => {
  test("/gsd status reports the holder instead of the raw open error", async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-status-locked-"));
    let holder: DatabaseSync | undefined;
    t.after(() => {
      holder?.close();
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    {
      // A database that opens into startup maintenance (no schema_version
      // table), so the open performs the same BEGIN EXCLUSIVE write a live
      // peer blocks in production (#2712). The peer holds the database
      // write lock (BEGIN IMMEDIATE) while its connection stays open.
      // Rollback-journal mode keeps the fixture inside the path production
      // takes: an in-process WAL holder trips the same-process WAL-index
      // rebuild inside the open-identity correlation before maintenance is
      // ever reached, which a cross-process peer does not cause.
      const dbPath = join(base, ".gsd", "gsd.db");
      const bare = new DatabaseSync(dbPath);
      bare.exec("CREATE TABLE pre_schema_filler (x)");
      bare.close();

      holder = new DatabaseSync(dbPath);
      holder.exec("BEGIN IMMEDIATE");

      const notes: Array<{ message: string; level: string }> = [];
      const ctx = { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } };

      await withCommandCwd(base, () => handleStatus(ctx as never));

      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.level, "error");
      assert.match(
        notes[0]!.message,
        /^Cannot read GSD status: workflow database is locked by another GSD process/,
      );
      assert.match(notes[0]!.message, /Run `\/gsd doctor --fix`/);
      assert.doesNotMatch(notes[0]!.message, /ensureDbOpen failed/);
      assert.doesNotMatch(notes[0]!.message, /No GSD milestones found/);
    }
  });
});
