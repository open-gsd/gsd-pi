// Project/App: gsd-pi
// File Purpose: /api/files must refuse mutations of the GSD database, runtime state, and rendered projections.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { POST, PATCH, DELETE, PUT } = await import("../../../web/app/api/files/route.ts");

const DB_BYTES = "SQLite format 3\u0000 authority bytes";
const PROJECTION_BYTES = "# S01 UAT\n\nRendered from the database.\n";
const RUNTIME_BYTES = '{"gate":"armed"}\n';
const NOTES_BYTES = "# Notes\n";

let project: string;

function url(query = ""): string {
  return `http://localhost/api/files?project=${encodeURIComponent(project)}${query}`;
}

function send(method: "POST" | "PATCH" | "PUT", body: Record<string, unknown>): Request {
  return new Request(url(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function remove(root: string, path: string): Request {
  return new Request(url(`&root=${root}&path=${encodeURIComponent(path)}`), { method: "DELETE" });
}

const PROTECTED: Array<{ label: string; path: string; bytes: string }> = [
  { label: "the database file", path: "gsd.db", bytes: DB_BYTES },
  { label: "the database WAL", path: "gsd.db-wal", bytes: DB_BYTES },
  { label: "a runtime state file", path: "runtime/write-gate-state.json", bytes: RUNTIME_BYTES },
  { label: "a slice projection", path: "milestones/M001/slices/S01/S01-UAT.md", bytes: PROJECTION_BYTES },
  { label: "a root projection", path: "STATE.md", bytes: PROJECTION_BYTES },
];

describe("/api/files write guard", () => {
  before(() => {
    project = mkdtempSync(join(tmpdir(), "gsd-files-guard-"));
    const gsd = join(project, ".gsd");
    mkdirSync(join(gsd, "runtime"), { recursive: true });
    mkdirSync(join(gsd, "milestones", "M001", "slices", "S01"), { recursive: true });
    for (const entry of PROTECTED) writeFileSync(join(gsd, entry.path), entry.bytes, "utf-8");
    writeFileSync(join(gsd, "NOTES.md"), NOTES_BYTES, "utf-8");
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  for (const entry of PROTECTED) {
    test(`POST, PATCH and DELETE on ${entry.label} return an error and leave the file unchanged`, async () => {
      const abs = join(project, ".gsd", entry.path);

      const write = await POST(send("POST", { path: entry.path, content: "overwritten" }));
      assert.equal(write.status, 403);
      assert.match((await write.json()).error, /Cannot modify/);

      const rename = await PATCH(send("PATCH", { from: entry.path, to: "moved-away.bak" }));
      assert.equal(rename.status, 403);

      const del = await DELETE(remove("gsd", entry.path));
      assert.equal(del.status, 403);

      assert.equal(readFileSync(abs, "utf-8"), entry.bytes);
      assert.equal(existsSync(join(project, ".gsd", "moved-away.bak")), false);
    });
  }

  test("project-root mode cannot reach the database or a projection through .gsd/", async () => {
    const write = await POST(send("POST", { path: ".gsd/gsd.db", content: "overwritten", root: "project" }));
    assert.equal(write.status, 403);
    const del = await DELETE(remove("project", ".gsd/milestones"));
    assert.equal(del.status, 403);
    const delGsd = await DELETE(remove("project", ".gsd"));
    assert.equal(delGsd.status, 403);

    assert.equal(readFileSync(join(project, ".gsd", "gsd.db"), "utf-8"), DB_BYTES);
    assert.equal(
      readFileSync(join(project, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md"), "utf-8"),
      PROJECTION_BYTES,
    );
  });

  test("a rename cannot overwrite authority and a create cannot plant a file in a protected directory", async () => {
    const rename = await PATCH(send("PATCH", { from: "NOTES.md", to: "runtime/NOTES.md" }));
    assert.equal(rename.status, 403);
    const create = await PUT(send("PUT", { path: "milestones/M001/M001-SUMMARY.md" }));
    assert.equal(create.status, 403);
    const deleteTree = await DELETE(remove("gsd", "milestones"));
    assert.equal(deleteTree.status, 403);

    assert.equal(readFileSync(join(project, ".gsd", "NOTES.md"), "utf-8"), NOTES_BYTES);
    assert.equal(existsSync(join(project, ".gsd", "runtime", "NOTES.md")), false);
    assert.equal(existsSync(join(project, ".gsd", "milestones", "M001", "M001-SUMMARY.md")), false);
    assert.equal(existsSync(join(project, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md")), true);
  });

  test("a file that is not database authority stays editable", async () => {
    const write = await POST(send("POST", { path: "NOTES.md", content: "# Notes\n\nEdited.\n" }));
    assert.equal(write.status, 200);
    assert.equal(readFileSync(join(project, ".gsd", "NOTES.md"), "utf-8"), "# Notes\n\nEdited.\n");

    const source = await PUT(send("PUT", { path: "src-note.txt", root: "project" }));
    assert.equal(source.status, 200);
    assert.equal(existsSync(join(project, "src-note.txt")), true);
  });
});
