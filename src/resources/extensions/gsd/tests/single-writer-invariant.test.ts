// Structural invariant: gsd-db.ts and the typed writer layer own writes for .gsd/gsd.db.
//
// No file under src/resources/extensions/gsd/ may issue raw write SQL
// (INSERT/UPDATE/DELETE/REPLACE) or raw transaction control (BEGIN/COMMIT/
// ROLLBACK via `.exec(...)`) against the engine database. Every bypass must
// route through an explicitly allowlisted typed writer.
//
// Allowlist:
// - gsd-db.ts itself — compatibility barrel and remaining mid-migration wrappers
// - db/engine.ts — schema, migrations, lifecycle, and transaction primitives
// - db/domain-operation.ts — revision-checked authoritative transaction seam
// - db/writers/** — domain writers
// - typed coordination/runtime writer modules listed in TYPED_DB_WRITER_FILES
// - schema/migration helper modules listed in SCHEMA_DB_WRITER_FILES
// - ADR migration/backfill helpers listed in MIGRATION_BACKFILL_WRITER_FILES
// - unit-ownership.ts — manages a separate .gsd/unit-claims.db for
//   cross-worktree claim races; intentionally outside this invariant
// - tests/** — fixtures and direct DB inspection are fair game
//
// When this test fails, do not add a new suppression. Instead:
// 1. Add a typed wrapper to the explicit writer layer that captures the SQL
// 2. Switch the flagged site to call the wrapper
//
// See `.claude/plans/joyful-doodling-pony.md` for the full rationale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const gsdDir = join(process.cwd(), "src/resources/extensions/gsd");

// The single-writer invariant is enforced on a directory layer, not a single
// filename. Write SQL may live only in:
//   - db/engine.ts — connection lifecycle, schema/migrations (DDL), and the
//     BEGIN/COMMIT transaction primitives. The shared handle every writer reads.
//   - db/domain-operation.ts — revision-checked Domain Operations.
//   - db/writers/**.ts — the Single Writer Layer: one cohesive write subsystem
//     per file.
//   - gsd-db.ts — the barrel that re-exports the layer (still holds wrappers
//     mid-migration).
//   - typed coordination/runtime writers listed below.
//   - schema/migration helpers listed below.
//   - ADR migration/backfill helpers listed below.
//   - unit-ownership.ts — a separate .gsd/unit-claims.db, intentionally outside.
// db/queries.ts is explicitly NOT allowed write SQL (asserted separately below).
const TYPED_DB_WRITER_FILES = new Set([
  "db/auto-workers.ts",
  "db/command-queue.ts",
  "db/domain-operation.ts",
  "db/milestone-leases.ts",
  "db/runtime-kv.ts",
  "db/unit-dispatches.ts",
]);

const SCHEMA_DB_WRITER_FILES = new Set([
  "db-authority-recovery-schema.ts",
  "db-blocker-accepted-closeout-schema.ts",
  "db-canonical-foundation-schema.ts",
  "db-attempt-recovery-schema.ts",
  "db-conversation-foundation-schema.ts",
  "db-lifecycle-foundation-schema.ts",
  "db-projection-import-kernel-closeout-foundation-schema.ts",
  "db-recovery-evidence-foundation-schema.ts",
  "db-slice-completion-schema.ts",
  "db-task-recovery-current-head-schema.ts",
  "db-task-verification-recovery-schema.ts",
  "db-memory-fts-schema.ts",
  "db-milestone-completion-schema.ts",
  "db-milestone-reopen-schema.ts",
  "db-milestone-validation-schema.ts",
  "db-schema-metadata.ts",
  "db-verification-evidence-schema.ts",
]);

const MIGRATION_BACKFILL_WRITER_FILES = new Set([
  "memory-backfill.ts",
]);

const DB_WRITER_ALLOWLIST_GUIDANCE = [
  "gsd-db.ts",
  "db/engine.ts",
  "db/writers/**",
  ...TYPED_DB_WRITER_FILES,
  ...SCHEMA_DB_WRITER_FILES,
  ...MIGRATION_BACKFILL_WRITER_FILES,
  "unit-ownership.ts only for .gsd/unit-claims.db",
].join(", ");

function isSingleWriterFile(rel: string): boolean {
  const norm = rel.split("\\").join("/");
  if (norm === "sqlite-readonly.ts") return true;
  if (norm === "gsd-db.ts" || norm === "unit-ownership.ts") return true;
  if (norm === "db/engine.ts") return true;
  if (norm.startsWith("db/writers/") && norm.endsWith(".ts")) return true;
  if (TYPED_DB_WRITER_FILES.has(norm)) return true;
  if (SCHEMA_DB_WRITER_FILES.has(norm)) return true;
  if (MIGRATION_BACKFILL_WRITER_FILES.has(norm)) return true;
  return false;
}

/** Walk the gsd extension dir and return all .ts files outside tests/. */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip tests/ — fixtures and direct DB inspection are expected there
        if (ent.name === "tests") continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts")) continue;
      // Skip dotfiles and backup/generated files
      if (ent.name.startsWith(".")) continue;
      out.push(full);
    }
  }

  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
  kind: string;
}

const DB_CALL_RE = /\.(prepare|exec)\s*\(/g;
const PREPARE_WRITE_SQL_RE = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const EXEC_WRITE_SQL_RE = /\b(INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|ROLLBACK)\b/i;

function findRawWriteSqlViolations(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  DB_CALL_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = DB_CALL_RE.exec(content)) !== null) {
    const method = match[1] as "prepare" | "exec";
    const sql = readFirstStringArgument(content, DB_CALL_RE.lastIndex);
    if (sql === null) continue;

    const keywordMatch =
      method === "prepare"
        ? PREPARE_WRITE_SQL_RE.exec(sql)
        : EXEC_WRITE_SQL_RE.exec(sql);
    if (keywordMatch === null) continue;

    violations.push({
      file,
      line: lineNumberAt(content, match.index),
      snippet: lineSnippetAt(content, match.index),
      kind: `${method}(${keywordMatch[1].toUpperCase()})`,
    });
  }

  return violations;
}

function readFirstStringArgument(content: string, index: number): string | null {
  const quoteIndex = skipWhitespace(content, index);
  const quote = content[quoteIndex];
  if (quote !== "`" && quote !== "'" && quote !== '"') return null;
  return readStringLiteral(content, quoteIndex, quote);
}

function skipWhitespace(content: string, index: number): number {
  let cursor = index;
  while (cursor < content.length && /\s/.test(content[cursor] ?? "")) {
    cursor++;
  }
  return cursor;
}

function readStringLiteral(content: string, quoteIndex: number, quote: string): string | null {
  let value = "";

  for (let cursor = quoteIndex + 1; cursor < content.length; cursor++) {
    const char = content[cursor];
    if (char === "\\") {
      value += char;
      cursor++;
      if (cursor < content.length) value += content[cursor];
      continue;
    }
    if (char === quote) return value;
    value += char;
  }

  return null;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function lineSnippetAt(content: string, index: number): string {
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const nextNewline = content.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  return content.slice(lineStart, lineEnd).trim();
}

test("scanner catches multiline template-literal db.prepare write SQL", () => {
  const violations = findRawWriteSqlViolations(
    "fixture.ts",
    [
      "const stmt = db.prepare(",
      "  `INSERT INTO tasks (id)",
      "   VALUES (?)`",
      ");",
    ].join("\n"),
  );

  assert.deepEqual(violations.map(({ line, kind }) => ({ line, kind })), [
    { line: 1, kind: "prepare(INSERT)" },
  ]);
});

test("scanner catches multiline raw transaction control in exec", () => {
  const violations = findRawWriteSqlViolations(
    "fixture.ts",
    [
      "db.exec(",
      "  `BEGIN`",
      ");",
    ].join("\n"),
  );

  assert.deepEqual(violations.map(({ line, kind }) => ({ line, kind })), [
    { line: 1, kind: "exec(BEGIN)" },
  ]);
});

test("scanner ignores multiline SELECT statements", () => {
  const violations = findRawWriteSqlViolations(
    "fixture.ts",
    [
      "const stmt = db.prepare(",
      "  `SELECT id",
      "   FROM tasks`",
      ");",
    ].join("\n"),
  );

  assert.deepEqual(violations, []);
});

const DB_WORKSPACE_MECHANICS = new Set([
  "checkpointDatabase",
  "closeAllDatabases",
  "closeDatabase",
  "closeDatabaseByWorkspace",
  "getDbPath",
  "getDbProvider",
  "getDbStatus",
  "openDatabase",
  "openDatabaseByScope",
  "openDatabaseByWorkspace",
  "refreshOpenDatabaseFromDisk",
  "vacuumDatabase",
  "wasDbOpenAttempted",
]);

function importNames(specifierBlock: string): string[] {
  return specifierBlock
    .split(",")
    .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
    .filter(Boolean);
}

test("no module outside the explicit DB writer allowlist issues raw write SQL", () => {
  const files = walkTsFiles(gsdDir);
  assert.ok(files.length >= 20, `Expected at least 20 .ts files under gsd/, found ${files.length}`);

  const violations: Violation[] = [];

  for (const abs of files) {
    const rel = relative(gsdDir, abs);
    if (isSingleWriterFile(rel)) continue;

    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    violations.push(...findRawWriteSqlViolations(rel, content));
  }

  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  ${v.file}:${v.line} [${v.kind}] — ${v.snippet}`,
    );
    assert.fail(
      `Found ${violations.length} raw write SQL bypass(es) outside the explicit DB writer allowlist:\n` +
        lines.join("\n") +
        `\n\nMove each write to the appropriate allowlisted owner: ${DB_WRITER_ALLOWLIST_GUIDANCE}.`,
    );
  }
});

test("db/queries.ts (the Query Module) is read-only — contains no write SQL", () => {
  // The read seam is separate from the single-writer layer. queries.ts holds
  // SELECT-only wrappers so read-only callers depend on a read seam, not the
  // write surface. (test 1 above also forbids this, since queries.ts is not in
  // db/writers/ — this is the explicit, positive statement of intent.)
  const queriesPath = join(gsdDir, "db", "queries.ts");
  const content = readFileSync(queriesPath, "utf-8");
  const violations = findRawWriteSqlViolations("db/queries.ts", content);
  assert.equal(
    violations.length,
    0,
    `db/queries.ts must contain no write SQL — move write wrappers to the explicit DB writer allowlist:\n` +
      violations.map((v) => `  db/queries.ts:${v.line} [${v.kind}] — ${v.snippet}`).join("\n"),
  );
});

test("gsd-db.ts exports the expected single-writer wrappers", async () => {
  // Positive assertion — fail loudly if the module layout changes so this
  // structural test can't silently become a no-op.
  const db = await import("../gsd-db.js");

  const expected = [
    "deleteDecisionById",
    "deleteRequirementById",
    "deleteArtifactByPath",
    "clearEngineHierarchy",
    "insertOrIgnoreSlice",
    "insertOrIgnoreTask",
    "setSliceReplanTriggeredAt",
    "upsertQualityGate",
    "restoreManifest",
    "bulkInsertLegacyHierarchy",
    "readTransaction",
    "insertMemoryRow",
    "rewriteMemoryId",
    "updateMemoryContentRow",
    "incrementMemoryHitCount",
    "supersedeMemoryRow",
    "markMemoryUnitProcessed",
    "decayMemoriesBefore",
    "supersedeLowestRankedMemories",
    "executeDomainOperation",
  ];

  for (const name of expected) {
    assert.ok(
      typeof (db as Record<string, unknown>)[name] === "function",
      `gsd-db.ts must export ${name} as a function`,
    );
  }
});

test("DB Workspace Interface owns database open-state and maintenance calls", async () => {
  const workspaceDb = await import("../db-workspace.js");

  const expected = [
    "checkpointWorkflowDatabase",
    "closeAllWorkflowDatabases",
    "closeWorkflowDatabase",
    "closeWorkflowDatabaseByWorkspace",
    "getWorkflowDatabasePath",
    "getWorkflowDatabaseProvider",
    "getWorkflowDatabaseStatus",
    "isWorkflowDatabaseOpen",
    "openExistingWorkflowDatabase",
    "openWorkflowDatabase",
    "openWorkflowDatabaseByScope",
    "openWorkflowDatabaseByWorkspace",
    "openWorkflowDatabaseIsolated",
    "openWorkflowDatabasePath",
    "refreshWorkflowDatabaseFromDisk",
    "resolveProjectRootDbPath",
    "resolveWorkflowDatabaseLocation",
    "vacuumWorkflowDatabase",
    "wasWorkflowDatabaseOpenAttempted",
  ];

  for (const name of expected) {
    assert.ok(
      typeof (workspaceDb as Record<string, unknown>)[name] === "function",
      `db-workspace.ts must export ${name} as a function`,
    );
  }
});

test("production modules do not import DB open-state mechanics from gsd-db.ts", () => {
  const files = walkTsFiles(gsdDir);
  const violations: Violation[] = [];
  const staticImportRe = /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']*gsd-db\.(?:js|ts)["']/g;
  const dynamicImportRe = /(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*await\s+import\(["'][^"']*gsd-db\.(?:js|ts)["']\)/g;

  for (const abs of files) {
    const rel = relative(gsdDir, abs);
    if (rel === "gsd-db.ts" || rel === "db-workspace.ts") continue;

    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    for (const re of [staticImportRe, dynamicImportRe]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const leaked = importNames(match[1] ?? "").filter((name) => DB_WORKSPACE_MECHANICS.has(name));
        if (leaked.length === 0) continue;
        violations.push({
          file: rel,
          line: content.slice(0, match.index).split("\n").length,
          snippet: leaked.join(", "),
          kind: "db-workspace-leak",
        });
      }
    }
  }

  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  ${v.file}:${v.line} [${v.kind}] — ${v.snippet}`,
    );
    assert.fail(
      `Found ${violations.length} DB open-state import(s) from gsd-db.ts:\n` +
        lines.join("\n") +
        "\n\nImport these through db-workspace.ts so gsd-db.ts stays the writer compatibility barrel, not the caller-facing DB Workspace Interface.",
    );
  }
});

test("the invariant test touches every .ts module under gsd/ (sanity check)", () => {
  const files = walkTsFiles(gsdDir);
  // Rough sanity: ensure we're not accidentally walking an empty tree
  assert.ok(files.length >= 30, `Expected to scan at least 30 .ts files, scanned ${files.length}`);

  // Spot-check a couple of known files that must be included
  const rels = files.map((f) => relative(gsdDir, f));
  assert.ok(rels.includes("gsd-db.ts"), "walker must include gsd-db.ts");
  assert.ok(rels.includes("memory-store.ts"), "walker must include memory-store.ts");
  assert.ok(rels.includes("workflow-manifest.ts"), "walker must include workflow-manifest.ts");
});
