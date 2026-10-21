# gsd-core ↔ gsd-pi Backwards Compatibility Implementation Plan

> Historical implementation plan, not the current authority contract. See [Switching between gsd-core and gsd-pi](../../user-docs/switching-between-gsd-tools.md) for current behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open the same `.gsd/` project interchangeably in gsd-core (markdown-only) and gsd-pi (DB-authoritative) without either tool silently destroying the other's edits, by folding a compatibility layer into gsd-pi's existing ADR-017 reconciliation pipeline.

**Architecture:** A single new marker file `.gsd/.compat.json` records hash-based per-file projection state. One new drift kind `external-markdown-edit` (detect + idempotent repair) is registered in the existing `DRIFT_REGISTRY`, so startup reconcile already invokes it. `/gsd sync` exposes the same pipeline on demand. A round-trip property test suite catches lossy-projection bugs before users do. gsd-core stays untouched and oblivious.

**Tech Stack:** TypeScript, Node.js built-in `node:test`, `node:crypto`, `node:fs`. Tests run via `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test`.

**Design spec:** `docs/superpowers/specs/2026-06-21-gsd-core-pi-backwards-compat-design.md`

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `src/resources/extensions/gsd/compat/compat-marker.ts` | Marker schema, read/write `.gsd/.compat.json`, content normalization + sha computation | **Create** |
| `src/resources/extensions/gsd/compat/index.ts` | Public exports for the compat module | **Create** |
| `src/resources/extensions/gsd/state-reconciliation/types.ts` | Add `external-markdown-edit` variant to `DriftRecord` union (lines 11–46) | **Modify** |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts` | `DriftHandler` for the new kind: detect drift vs marker, idempotent repair via `md-importer` | **Create** |
| `src/resources/extensions/gsd/state-reconciliation/registry.ts` | Register the new handler in `DRIFT_REGISTRY` | **Modify** |
| `src/resources/extensions/gsd/markdown-renderer.ts` | Update compat marker entry in the existing `invalidateCaches()` callback chain | **Modify** |
| `src/resources/extensions/gsd/commands-maintenance.ts` | Add `handleSync` (mirrors `handleRecover` shape; uses reconcile + marker) | **Modify** |
| `src/resources/extensions/gsd/commands/handlers/ops.ts` | Wire `/gsd sync` to `handleSync` | **Modify** |
| `src/resources/extensions/gsd/commands-handlers.ts` | Extend `handleDoctor` with a compat-health check | **Modify** |
| `src/resources/extensions/gsd/tests/compat-marker.test.ts` | Unit tests for marker read/write/normalize | **Create** |
| `src/resources/extensions/gsd/tests/external-markdown-edit.test.ts` | Unit tests for detect + idempotent repair | **Create** |
| `src/resources/extensions/gsd/tests/round-trip-property.test.ts` | Round-trip property suite (import→render→import stable) | **Create** |
| `src/resources/extensions/gsd/tests/__fixtures__/round-trip/` | Real-shape gsd-core `.gsd/` fixtures | **Create** |
| `docs/how-to/switching-between-gsd-tools.md` | User-facing workflow doc | **Create** |

---

## Task 1: Compat marker module (`compat-marker.ts`)

**Files:**
- Create: `src/resources/extensions/gsd/compat/compat-marker.ts`
- Create: `src/resources/extensions/gsd/compat/index.ts`
- Test: `src/resources/extensions/gsd/tests/compat-marker.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `src/resources/extensions/gsd/tests/compat-marker.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Unit tests for the gsd-core compat marker (`.gsd/.compat.json`).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  readCompatMarker,
  writeCompatMarker,
  normalizeForHash,
  computeProjectionSha,
  EMPTY_MARKER,
  compatMarkerPath,
} from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-compat-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  tmpDirs.length = 0;
});

test("readCompatMarker returns EMPTY_MARKER when file is missing", () => {
  const base = makeTmpBase();
  const marker = readCompatMarker(base);
  assert.deepEqual(marker, EMPTY_MARKER);
});

test("writeCompatMarker then readCompatMarker round-trips", () => {
  const base = makeTmpBase();
  const marker = {
    schema: 1,
    lastWriter: "gsd-pi" as const,
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "roadmap.md": { sha: "abc123", entities: ["m1"] },
    },
    piVersion: "1.4.0",
  };
  writeCompatMarker(base, marker);
  const read = readCompatMarker(base);
  assert.deepEqual(read, marker);
});

test("readCompatMarker quarantines malformed JSON and returns EMPTY_MARKER", () => {
  const base = makeTmpBase();
  writeFileSync(compatMarkerPath(base), "{ not valid json", "utf-8");
  const marker = readCompatMarker(base);
  assert.deepEqual(marker, EMPTY_MARKER);
  // Quarantine backup should exist
  const files = require("node:fs").readdirSync(join(base, ".gsd"));
  const quarantined = files.some((f: string) => f.startsWith(".compat.json.bad-"));
  assert.ok(quarantined, "expected a quarantined .compat.json.bad-* file");
});

test("normalizeForHash trims trailing whitespace and converts CRLF to LF", () => {
  const input = "line one  \r\nline two\r\n";
  const out = normalizeForHash(input);
  assert.equal(out, "line one\nline two\n");
});

test("computeProjectionSha is stable for cosmetically different but equivalent content", () => {
  const a = computeProjectionSha("hello\r\nworld  \n");
  const b = computeProjectionSha("hello\nworld\n");
  assert.equal(a, b);
});

test("compatMarkerPath resolves under .gsd", () => {
  const base = makeTmpBase();
  assert.equal(compatMarkerPath(base), join(base, ".gsd", ".compat.json"));
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/compat-marker.test.ts`
Expected: FAIL — `Cannot find module '../compat/compat-marker.ts'`

- [ ] **Step 1.3: Write the implementation**

Create `src/resources/extensions/gsd/compat/compat-marker.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: gsd-core ↔ gsd-pi compatibility marker (`.gsd/.compat.json`).
//
// Records per-projection content hashes so the ADR-017 reconcile pipeline can
// distinguish gsd-pi's own writes (expected) from external edits made by gsd-core
// (drift to import). gsd-core is oblivious to this file and ignores it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Current marker schema version. Bump on breaking format changes + migrate. */
export const COMPAT_MARKER_SCHEMA = 1;

/**
 * Per-file projection entry. `sha` is a normalized-content SHA-256; `entities`
 * is the list of DB entity ids (milestone/slice/task) that the file projects.
 * Current repair derives milestone ids from this list to scope markdown status
 * authority while the importer still walks the whole tree.
 */
export interface ProjectionEntry {
  sha: string;
  entities: string[];
}

export interface CompatMarker {
  schema: number;
  lastWriter: "gsd-pi";
  lastProjectedAt: string;
  projections: Record<string, ProjectionEntry>;
  piVersion: string;
}

/** Marker returned when no marker exists yet (fresh project, first gsd-pi run). */
export const EMPTY_MARKER: CompatMarker = {
  schema: COMPAT_MARKER_SCHEMA,
  lastWriter: "gsd-pi",
  lastProjectedAt: "",
  projections: {},
  piVersion: "",
};

export function compatMarkerPath(basePath: string): string {
  return join(basePath, ".gsd", ".compat.json");
}

/**
 * Normalize markdown content before hashing so cosmetic differences (trailing
 * whitespace, CRLF) don't produce false-positive drift. Conservative: only
 * transforms that are provably round-trippable through gsd-pi's projection.
 */
export function normalizeForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

export function computeProjectionSha(content: string): string {
  return createHash("sha256").update(normalizeForHash(content)).digest("hex").slice(0, 16);
}

/**
 * Read & validate the marker. A missing marker → EMPTY_MARKER (treat every
 * projection as external on next reconcile). A malformed marker is quarantined
 * to `.compat.json.bad-<ts>` (never overwrite without backup) then returns
 * EMPTY_MARKER. A schema-mismatch returns EMPTY_MARKER (forward-compat: refuse
 * to act on a future format we don't understand).
 */
export function readCompatMarker(basePath: string): CompatMarker {
  const path = compatMarkerPath(basePath);
  if (!existsSync(path)) return { ...EMPTY_MARKER };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ...EMPTY_MARKER };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(basePath, raw);
    return { ...EMPTY_MARKER };
  }

  if (!isValidMarker(parsed)) {
    quarantine(basePath, raw);
    return { ...EMPTY_MARKER };
  }
  if (parsed.schema !== COMPAT_MARKER_SCHEMA) {
    // Future schema: refuse rather than guess. Re-running reconcile regenerates.
    quarantine(basePath, raw);
    return { ...EMPTY_MARKER };
  }
  return parsed;
}

/**
 * Write the marker atomically (write-temp then rename) so a crash mid-write
 * can't leave a half-written file that next startup would quarantine.
 */
export function writeCompatMarker(basePath: string, marker: CompatMarker): void {
  const path = compatMarkerPath(basePath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf-8");
  renameSync(tmp, path);
}

function quarantine(basePath: string, raw: string): void {
  const badPath = compatMarkerPath(basePath).replace(/\.json$/, `.bad-${Date.now()}.json`);
  try {
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, raw, "utf-8");
  } catch {
    // Best-effort: if we can't quarantine, leave the original in place — next
    // read will quarantine. Never throw out of marker I/O.
  }
}

function isValidMarker(x: unknown): x is CompatMarker {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.lastWriter !== "gsd-pi") return false;
  if (typeof m.schema !== "number") return false;
  if (typeof m.lastProjectedAt !== "string") return false;
  if (typeof m.piVersion !== "string") return false;
  if (typeof m.projections !== "object" || m.projections === null) return false;
  for (const v of Object.values(m.projections as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) return false;
    const e = v as Record<string, unknown>;
    if (typeof e.sha !== "string") return false;
    if (!Array.isArray(e.entities) || !e.entities.every((s) => typeof s === "string")) return false;
  }
  return true;
}
```

Create `src/resources/extensions/gsd/compat/index.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Public exports for the gsd-core compat module.
export {
  COMPAT_MARKER_SCHEMA,
  EMPTY_MARKER,
  compatMarkerPath,
  computeProjectionSha,
  normalizeForHash,
  readCompatMarker,
  writeCompatMarker,
} from "./compat-marker.js";
export type { CompatMarker, ProjectionEntry } from "./compat-marker.js";
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/compat-marker.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 1.5: Commit**

```bash
git add src/resources/extensions/gsd/compat/compat-marker.ts \
        src/resources/extensions/gsd/compat/index.ts \
        src/resources/extensions/gsd/tests/compat-marker.test.ts
git commit -m "feat(compat): add .gsd/.compat.json marker module

Hash-based per-projection marker so ADR-017 reconcile can distinguish
gsd-pi's own writes from external (gsd-core) edits. Missing marker is
treated as 'all projections external'; malformed marker is quarantined."
```

---

## Task 2: `external-markdown-edit` drift handler

**Files:**
- Modify: `src/resources/extensions/gsd/state-reconciliation/types.ts` (lines 11–46 — the `DriftRecord` union)
- Create: `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts`
- Test: `src/resources/extensions/gsd/tests/external-markdown-edit.test.ts`

- [ ] **Step 2.1: Add the drift kind to the `DriftRecord` union**

In `src/resources/extensions/gsd/state-reconciliation/types.ts`, add this variant to the union (after the `missing-completion-timestamp` variant, before the closing `;`):

```ts
  | {
      kind: "external-markdown-edit";
      projectionPath: string;       // relative to basePath, e.g. "m1/plan.md"
      expectedSha: string;          // sha recorded in .compat.json
      actualSha: string;            // freshly computed from disk
      entities: string[];           // DB entity ids used to scope status authority
    };
```

- [ ] **Step 2.2: Write the failing test**

Create `src/resources/extensions/gsd/tests/external-markdown-edit.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Unit tests for the external-markdown-edit drift handler.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import { writeCompatMarker, computeProjectionSha } from "../compat/compat-marker.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-extedit-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

const stubState = { phase: "idle" } as unknown as GSDState;

function ctx(base: string): DriftContext {
  return { basePath: base, state: stubState };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  tmpDirs.length = 0;
});

test("detect returns no drift when file sha matches marker", () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  const abs = join(base, ".gsd", rel);
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(abs, "# Roadmap\n\n- [x] S1 done\n", "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: computeProjectionSha("# Roadmap\n\n- [x] S1 done\n"), entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);
});

test("detect returns drift when file content differs from marker", () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n\n- [ ] S1 NOT done\n", "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "stale000000000000", entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, "external-markdown-edit");
  assert.equal(drift[0].projectionPath, rel);
  assert.deepEqual(drift[0].entities, ["m1"]);
});

test("detect treats missing marker as drift on every tracked projection file", () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n", "utf-8");
  // No writeCompatMarker call → marker missing → EMPTY_MARKER

  // Without a marker we have no projections to compare, so detect should be a
  // no-op (the reconcile pipeline's other handlers cover the "import everything"
  // case via the existing /gsd recover flow). This is by design: this handler
  // only fires when we HAVE a baseline to compare against.
  const drift = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);
});

test("detect ignores files missing from disk (other handlers cover that)", () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "abc123", entities: ["m1"] } },
    piVersion: "1.4.0",
  });
  // No file written.

  const drift = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);
});

test("repair is idempotent: running twice produces no further drift on second detect", async () => {
  const base = makeTmpBase();
  const rel = "m1/roadmap.md";
  const abs = join(base, ".gsd", rel);
  mkdirSync(join(base, ".gsd", "m1"), { recursive: true });
  const content = "# Roadmap\n\n- [x] S1 done\n";
  writeFileSync(abs, content, "utf-8");
  writeCompatMarker(base, {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: "stale000000000000", entities: ["m1"] } },
    piVersion: "1.4.0",
  });

  const drift1 = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift1.length, 1);
  await externalMarkdownEditHandler.repair(drift1[0], ctx(base));

  // After repair, marker should reflect the file's actual sha → no drift.
  const drift2 = externalMarkdownEditHandler.detect(stubState, ctx(base));
  assert.equal(drift2.length, 0);
});
```

- [ ] **Step 2.3: Run the test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/external-markdown-edit.test.ts`
Expected: FAIL — `Cannot find module '../state-reconciliation/drift/external-markdown-edit.ts'`

- [ ] **Step 2.4: Write the implementation**

Create `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler for external (gsd-core) markdown edits.
//
// gsd-pi's DB is canonical, but .gsd/*.md is the inter-tool contract. When
// gsd-core edits a projection file, this handler detects the sha drift vs the
// recorded baseline in .gsd/.compat.json and re-imports from markdown with
// status authority scoped to the affected milestone ids. The next
// renderAllFromDb pass re-projects; the write-time invalidation hook then
// refreshes the marker entry, closing the loop.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../../compat/compat-marker.js";
import { migrateHierarchyToDb, milestoneIdsFromEntities } from "../../md-importer.js";
import { invalidateStateCache } from "../../state.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler } from "../types.js";

type ExternalMarkdownEditDrift = Extract<
  DriftRecord,
  { kind: "external-markdown-edit" }
>;

/**
 * Detect sha drift between the marker baseline and current file contents.
 *
 * - Missing marker → no records (the broader /gsd recover flow handles a
 *   cold-start; this handler only fires when we have a baseline to compare).
 * - Missing file on disk → no record (other handlers cover missing artifacts).
 * - Sha match → no record (gsd-pi's own write or no change).
 * - Sha mismatch → one record per drifted file, scoped to its recorded entities.
 */
function detectExternalMarkdownEdit(
  _state: GSDState,
  ctx: DriftContext,
): ExternalMarkdownEditDrift[] {
  const marker = readCompatMarker(ctx.basePath);
  const entries = Object.entries(marker.projections);
  if (entries.length === 0) return [];

  const records: ExternalMarkdownEditDrift[] = [];
  for (const [projectionPath, entry] of entries) {
    const abs = join(ctx.basePath, ".gsd", projectionPath);
    if (!existsSync(abs)) continue;
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    if (actual === entry.sha) continue;
    records.push({
      kind: "external-markdown-edit",
      projectionPath,
      expectedSha: entry.sha,
      actualSha: actual,
      entities: entry.entities,
    });
  }
  return records;
}

/**
 * Idempotent repair: re-import hierarchy from markdown while allowing
 * markdown status authority only for milestones named by the drifted file's
 * marker entities, then update the marker entry so the next detect pass sees
 * the file as expected. migrateHierarchyToDb is itself idempotent (upsert), so
 * re-running this repair after a successful one is a no-op.
 */
async function repairExternalMarkdownEdit(
  record: ExternalMarkdownEditDrift,
  ctx: DriftContext,
): Promise<void> {
  try {
    // The importer walks the whole tree as a cheap upsert, but repair derives
    // a milestone scope from record.entities and passes it as
    // statusAuthoritativeMilestones so only the drifted milestone(s) can close
    // or reopen rows from markdown checkboxes.
    const statusAuthoritativeMilestones = milestoneIdsFromEntities(record.entities);
    migrateHierarchyToDb(ctx.basePath, { statusAuthoritativeMilestones });
    invalidateStateCache();
  } catch (err) {
    logWarning(
      "compat",
      `external-markdown-edit repair failed for ${record.projectionPath}: ${(err as Error).message}`,
    );
    throw err;
  }

  // Refresh the marker so a second pass (cap=2 reconcile) doesn't re-fire.
  const marker = readCompatMarker(ctx.basePath);
  marker.projections[record.projectionPath] = {
    sha: record.actualSha,
    entities: record.entities,
  };
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(ctx.basePath, marker);
}

export const externalMarkdownEditHandler: DriftHandler<ExternalMarkdownEditDrift> = {
  kind: "external-markdown-edit",
  detect: detectExternalMarkdownEdit,
  repair: repairExternalMarkdownEdit,
};
```

- [ ] **Step 2.5: Run the test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/external-markdown-edit.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 2.6: Commit**

```bash
git add src/resources/extensions/gsd/state-reconciliation/types.ts \
        src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts \
        src/resources/extensions/gsd/tests/external-markdown-edit.test.ts
git commit -m "feat(compat): add external-markdown-edit drift handler

Detects sha drift between .gsd/.compat.json and current projection files,
imports markdown via migrateHierarchyToDb with status authority scoped to the
marker entities, and refreshes the marker. Idempotent: re-running after a
successful repair is a no-op."
```

---

## Task 3: Register handler in `DRIFT_REGISTRY`

**Files:**
- Modify: `src/resources/extensions/gsd/state-reconciliation/registry.ts`

- [ ] **Step 3.1: Add the import and registry entry**

In `src/resources/extensions/gsd/state-reconciliation/registry.ts`:

After line 11 (`import { mergeStateHandler } from "./drift/merge-state.js";`) add:

```ts
import { externalMarkdownEditHandler } from "./drift/external-markdown-edit.js";
```

In the `DRIFT_REGISTRY` array (after `completionTimestampHandler,` at line 34, before the closing `];`), add:

```ts
  externalMarkdownEditHandler,
```

- [ ] **Step 3.2: Verify the registry still type-checks and loads**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --eval "import('./src/resources/extensions/gsd/state-reconciliation/registry.ts').then(m => console.log('handlers:', m.DRIFT_REGISTRY.length))"`
Expected: prints `handlers: 11` (was 10, now +1)

- [ ] **Step 3.3: Commit**

```bash
git add src/resources/extensions/gsd/state-reconciliation/registry.ts
git commit -m "feat(compat): register external-markdown-edit in DRIFT_REGISTRY

Reconcile pipeline now picks up gsd-core edits automatically on startup
and before every dispatch, with no changes to reconcileBeforeDispatch."
```

---

## Task 4: Write-time marker invalidation hook

**Files:**
- Modify: `src/resources/extensions/gsd/markdown-renderer.ts`

The goal: after every projection write, update the matching entry in `.gsd/.compat.json` so the next reconcile pass sees gsd-pi's own writes as expected (feedback-loop prevention). The existing `invalidateCaches()` callback chain (line 66–69, registered via `registerCacheClearCallback`) is the documented extension point.

- [ ] **Step 4.1: Inspect the current `invalidateCaches` implementation**

Read `src/resources/extensions/gsd/markdown-renderer.ts` lines 60–80 to confirm the callback chain shape before modifying. (Already verified during planning: `invalidateCaches()` calls `clearParseCache()`; the projection parse cache registers via `registerCacheClearCallback` at line 752.)

- [ ] **Step 4.2: Add a module-level "pending projection writes" tracker**

In `src/resources/extensions/gsd/markdown-renderer.ts`, near the top of the file after the existing imports (around line 40), add a small tracker that the render functions populate and the invalidation callback drains:

```ts
// Compat marker invalidation: every successful projection write pushes its
// (path, entities) here; invalidateCaches() drains it and refreshes
// .gsd/.compat.json so the next reconcile pass sees gsd-pi's own writes as
// expected. This is the feedback-loop-prevention mechanism.
const _pendingProjectionWrites: Array<{ path: string; entities: string[]; basePath: string }> = [];

function recordProjectionWrite(basePath: string, relPath: string, entities: string[]): void {
  _pendingProjectionWrites.push({ basePath, path: relPath, entities });
}

function flushProjectionWritesToMarker(): void {
  if (_pendingProjectionWrites.length === 0) return;
  // Group by basePath (defensive — multiple projects are unusual but possible).
  const byBase = new Map<string, Map<string, string[]>>();
  for (const w of _pendingProjectionWrites) {
    let bucket = byBase.get(w.basePath);
    if (!bucket) { bucket = new Map(); byBase.set(w.basePath, bucket); }
    bucket.set(w.path, w.entities);
  }
  _pendingProjectionWrites.length = 0;

  for (const [basePath, writes] of byBase) {
    try {
      const marker = readCompatMarker(basePath);
      for (const [relPath, entities] of writes) {
        const abs = join(basePath, ".gsd", relPath);
        if (existsSync(abs)) {
          marker.projections[relPath] = {
            sha: computeProjectionSha(readFileSync(abs, "utf-8")),
            entities,
          };
        }
      }
      marker.lastWriter = "gsd-pi";
      marker.lastProjectedAt = new Date().toISOString();
      writeCompatMarker(basePath, marker);
    } catch {
      // Marker I/O must never break projection. Reconcile will heal on next run.
    }
  }
}
```

And add the necessary imports near the existing `files.js` import (line 40):

```ts
import { readCompatMarker, writeCompatMarker, computeProjectionSha } from "./compat/compat-marker.js";
```

- [ ] **Step 4.3: Hook the flush into `invalidateCaches`**

In `invalidateCaches()` (around line 66), add `flushProjectionWritesToMarker();` as the first line (before `clearParseCache()`):

```ts
function invalidateCaches(): void {
  flushProjectionWritesToMarker();
  clearParseCache();
}
```

- [ ] **Step 4.4: Instrument the render functions to record writes**

For each of the four render entry points that write files — `renderRoadmapFromDb`, `renderPlanCheckboxes`, `renderSliceSummary`, `renderTaskSummary` — add a `recordProjectionWrite(basePath, relPath, entities)` call immediately after a successful write. The exact insertion points are within each function, after the `saveFile(...)` call that writes the markdown. For `renderRoadmapFromDb`, after the roadmap file is written:

```ts
recordProjectionWrite(basePath, relRoadmapPath, [milestoneId]);
```

For `renderPlanCheckboxes`:

```ts
recordProjectionWrite(basePath, relPlanPath, [`${milestoneId}/${sliceId}`]);
```

For `renderSliceSummary`:

```ts
recordProjectionWrite(basePath, relSummaryPath, [`${milestoneId}/${sliceId}`]);
```

For `renderTaskSummary`:

```ts
recordProjectionWrite(basePath, relTaskSummaryPath, [`${milestoneId}/${sliceId}/${taskId}`]);
```

(The relative path variables already exist in each function — use the same value passed to `saveFile`. If the variable name differs, use the value that was written.)

- [ ] **Step 4.5: Add a focused test**

Create or extend `src/resources/extensions/gsd/tests/compat-marker-invalidation.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Verifies that projection writes update .gsd/.compat.json.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderRoadmapFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { readCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-inv-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "T", status: "pending", risk: "low", depends: [] });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderRoadmapFromDb writes a compat marker entry for the roadmap file", async () => {
  const base = makeTmp();
  await renderRoadmapFromDb(base, "M001");
  const marker = readCompatMarker(base);
  const rels = Object.keys(marker.projections);
  assert.ok(rels.some((r) => r.includes("M001") && r.endsWith("ROADMAP.md")), `expected roadmap entry, got ${JSON.stringify(rels)}`);
});
```

- [ ] **Step 4.6: Run the test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/compat-marker-invalidation.test.ts`
Expected: PASS (1 test)

- [ ] **Step 4.7: Run the full markdown-renderer test suite to confirm no regressions**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts`
Expected: PASS (no regressions vs. baseline)

- [ ] **Step 4.8: Commit**

```bash
git add src/resources/extensions/gsd/markdown-renderer.ts \
        src/resources/extensions/gsd/tests/compat-marker-invalidation.test.ts
git commit -m "feat(compat): refresh .gsd/.compat.json on every projection write

Hooks the existing invalidateCaches() callback chain to drain a pending-
writes queue into the marker. Prevents reconcile from flagging gsd-pi's
own writes as external drift."
```

---

## Task 5: `/gsd sync` command wiring

**Files:**
- Modify: `src/resources/extensions/gsd/commands-maintenance.ts` (add `handleSync`)
- Modify: `src/resources/extensions/gsd/commands/handlers/ops.ts` (wire the route)

- [ ] **Step 5.1: Add `handleSync` to `commands-maintenance.ts`**

Add this export (placed near `handleRecover`, around line 584 — after `handleRecover`'s closing brace or before it, whichever keeps related functions together):

```ts
/**
 * `/gsd sync` — pull in external (gsd-core) markdown edits and re-project.
 *
 * Non-destructive cousin of `/gsd recover`: does NOT clear the DB. Runs the
 * ADR-017 reconcile pipeline (which picks up the external-markdown-edit handler
 * automatically), then re-projects via renderAllFromDb, then refreshes the
 * compat marker. Use this when switching from gsd-core mid-session.
 *
 * Accepts `--dry-run` to report what would change without writing.
 */
export async function handleSync(
  ctx: ExtensionCommandContext,
  basePath: string,
  args = "",
): Promise<void> {
  const { isDbAvailable } = await import("./gsd-db.js");
  const { reconcileBeforeDispatch } = await import("./state-reconciliation/index.js");
  const { renderAllFromDb } = await import("./markdown-renderer.js");
  const { writeCompatMarker, readCompatMarker } = await import("./compat/compat-marker.js");
  const { deriveState } = await import("./state.js");

  const dryRun = args.trim() === "--dry-run";

  if (!isDbAvailable()) {
    ctx.ui.notify("gsd sync: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }

  const lines: string[] = ["gsd sync: reconciling .gsd/ for cross-tool edits…"];

  try {
    const result = await reconcileBeforeDispatch(basePath);
    const repairedExternal = result.repaired.filter((r) => r.kind === "external-markdown-edit");
    lines.push(`  External edits imported: ${repairedExternal.length}`);
    for (const r of repairedExternal) {
      const e = r as { kind: "external-markdown-edit"; projectionPath: string };
      lines.push(`    • ${e.projectionPath}`);
    }
    if (result.blockers.length > 0) {
      lines.push("", "  ⚠ Blockers:");
      for (const b of result.blockers) lines.push(`    • ${b}`);
    }

    if (dryRun) {
      lines.push("", "  (dry-run: no projection or marker writes performed)");
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    const renderResult = await renderAllFromDb(basePath);
    if (renderResult.errors.length > 0) {
      lines.push("", "  ⚠ Projection errors:");
      for (const e of renderResult.errors) lines.push(`    • ${e}`);
    }

    // Refresh the marker to reflect the freshly re-projected state.
    const marker = readCompatMarker(basePath);
    marker.lastWriter = "gsd-pi";
    marker.lastProjectedAt = new Date().toISOString();
    writeCompatMarker(basePath, marker);

    const state = await deriveState(basePath);
    lines.push(
      "",
      `  Phase:  ${state.phase}`,
      `  Marker: .gsd/.compat.json refreshed`,
    );
    if (state.activeMilestone) {
      lines.push(`  Active: ${state.activeMilestone.id}: ${state.activeMilestone.title}`);
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } catch (err) {
    ctx.ui.notify(`gsd sync failed: ${(err as Error).message}`, "error");
  }
}
```

- [ ] **Step 5.2: Wire `/gsd sync` in `ops.ts`**

In `src/resources/extensions/gsd/commands/handlers/ops.ts`, update the existing import from `../../commands-maintenance.js` (line 12) to include `handleSync`:

```ts
import { handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleCleanupProjects, handleCleanupWorktrees, handleRecover, handleRebuild, handleSync } from "../../commands-maintenance.js";
```

Add a new route block near the `recover`/`rebuild` routes (around line 134–141):

```ts
  if (trimmed === "sync" || trimmed.startsWith("sync ")) {
    await handleSync(ctx, projectRoot(), trimmed.replace(/^sync\s*/, "").trim());
    return true;
  }
```

- [ ] **Step 5.3: Verify the route resolves (manual smoke)**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --eval "import('./src/resources/extensions/gsd/commands-maintenance.ts').then(m => console.log('handleSync:', typeof m.handleSync))"`
Expected: prints `handleSync: function`

- [ ] **Step 5.4: Commit**

```bash
git add src/resources/extensions/gsd/commands-maintenance.ts \
        src/resources/extensions/gsd/commands/handlers/ops.ts
git commit -m "feat(compat): add /gsd sync command

Non-destructive reconcile for mid-session tool switches. Runs the ADR-017
pipeline (auto-picks-up external-markdown-edit), re-projects, refreshes
the marker. Supports --dry-run."
```

---

## Task 6: `/gsd doctor` compat-health check

**Files:**
- Modify: `src/resources/extensions/gsd/commands-handlers.ts` (`handleDoctor`)

- [ ] **Step 6.1: Locate `handleDoctor`**

Run: `grep -n "export async function handleDoctor" src/resources/extensions/gsd/commands-handlers.ts`
Note the line number; this is where we add a compat-health section to the doctor report.

- [ ] **Step 6.2: Add a compat-health block**

Within `handleDoctor`, after the existing health checks and before the final report assembly, add:

```ts
// Compat health: marker presence + drift vs current projections.
try {
  const { readCompatMarker } = await import("./compat/compat-marker.js");
  const { computeProjectionSha } = await import("./compat/compat-marker.js");
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const marker = readCompatMarker(basePath);
  const projectionEntries = Object.entries(marker.projections);
  let drifted = 0;
  for (const [rel, entry] of projectionEntries) {
    const abs = join(basePath, ".gsd", rel);
    if (!existsSync(abs)) continue;
    if (computeProjectionSha(readFileSync(abs, "utf-8")) !== entry.sha) drifted++;
  }
  const status = projectionEntries.length === 0
    ? "no baseline (run /gsd sync to establish)"
    : drifted === 0
      ? "OK"
      : `${drifted} file(s) drifted — run /gsd sync`;
  // Append to whatever the doctor's report-lines variable is named (confirm
  // the variable name in Step 6.1; commonly `lines` or `report`).
  lines.push(`  Compat health:      ${status}`);
} catch (err) {
  lines.push(`  Compat health:      unavailable (${(err as Error).message})`);
}
```

(If the report-lines variable in `handleDoctor` is named differently than `lines`, substitute the actual name from Step 6.1.)

- [ ] **Step 6.3: Verify doctor still runs**

Run the doctor unit test (if it exists): `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test $(grep -rl "handleDoctor" src/resources/extensions/gsd/tests/ | head -1)`
Expected: PASS. If no test exists for `handleDoctor`, skip this step — the unit suite at Task 8 will cover integration.

- [ ] **Step 6.4: Commit**

```bash
git add src/resources/extensions/gsd/commands-handlers.ts
git commit -m "feat(compat): add compat-health check to /gsd doctor

Reports marker presence and drifted-file count so users can see at a
glance whether /gsd sync is needed."
```

---

## Task 7: Round-trip property test suite

**Files:**
- Create: `src/resources/extensions/gsd/tests/__fixtures__/round-trip/m001-basic/.gsd/...` (a small but real-shape gsd-core tree)
- Create: `src/resources/extensions/gsd/tests/round-trip-property.test.ts`

The property: **for any gsd-core `.gsd/` fixture, `import → render → import` must be stable** — the DB after the second import is row-equivalent to the DB after the first (modulo timestamps). This is the load-bearing safety net that catches lossy projection.

- [ ] **Step 7.1: Create a real-shape fixture**

Create a minimal but representative gsd-core `.gsd/` tree under `src/resources/extensions/gsd/tests/__fixtures__/round-trip/m001-basic/.gsd/`:

- `DECISIONS.md` (one decision row)
- `REQUIREMENTS.md` (one requirement)
- `milestones/M001-foo/ROADMAP.md` (one slice, one task)
- `milestones/M001-foo/slices/S01/PLAN.md` (one task with checkbox)
- `milestones/M001-foo/slices/S01/tasks/T01/PLAN.md`

Content (example for ROADMAP.md):
```markdown
# Roadmap — M001: Foo

## Slices
- [ ] S01: First slice
```

Example for PLAN.md (slice):
```markdown
# Plan — S01

## Tasks
- [ ] T01: First task
```

Example for DECISIONS.md:
```markdown
# Decisions

| ID | Decision | Rationale | Status |
|----|----------|-----------|--------|
| D001 | Use SQLite | Fast, embedded | accepted |
```

Example for REQUIREMENTS.md:
```markdown
# Requirements

## REQ-001: Must round-trip
The system must round-trip.
```

Example for tasks/T01/PLAN.md:
```markdown
# Plan — T01
Steps to complete T01.
```

- [ ] **Step 7.2: Write the property test**

Create `src/resources/extensions/gsd/tests/round-trip-property.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Round-trip property test — import → render → import must be
// stable for any gsd-core .gsd/ fixture. Catches lossy-projection bugs that
// would otherwise silently destroy state across cross-tool round-trips.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase, clearEngineHierarchy, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "round-trip");

const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-rt-${randomUUID()}`));
  cpSync(join(FIXTURE_ROOT, name), base, { recursive: true });
  tmpDirs.push(base);
  return base;
}

interface HierarchySnapshot {
  milestones: Array<{ id: string; title: string; status: string }>;
  slices: Array<{ mid: string; id: string; title: string; status: string }>;
  tasks: Array<{ mid: string; sid: string; id: string; title: string; status: string }>;
}

function snapshotHierarchy(): HierarchySnapshot {
  const milestones = getAllMilestones().map((m) => ({ id: m.id, title: m.title, status: m.status }));
  const slices: HierarchySnapshot["slices"] = [];
  const tasks: HierarchySnapshot["tasks"] = [];
  for (const m of milestones) {
    for (const s of getMilestoneSlices(m.id)) {
      slices.push({ mid: m.id, id: s.id, title: s.title, status: s.status });
      for (const t of getSliceTasks(m.id, s.id)) {
        tasks.push({ mid: m.id, sid: s.id, id: t.id, title: t.title, status: t.status });
      }
    }
  }
  return { milestones, slices, tasks };
}

test("round-trip is stable: import → render → import produces the same hierarchy snapshot", async () => {
  const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert.ok(fixtures.length > 0, "expected at least one round-trip fixture");

  for (const name of fixtures) {
    const base = copyFixture(name);
    openDatabase(join(base, ".gsd", "gsd.db"));

    // Pass 1: import fixture markdown → DB
    migrateHierarchyToDb(base);
    invalidateStateCache();
    const snapshot1 = snapshotHierarchy();

    // Render DB → markdown (projection)
    const render1 = await renderAllFromDb(base);
    assert.deepEqual(render1.errors, [], `pass 1 render errors for ${name}: ${JSON.stringify(render1.errors)}`);

    // Pass 2: clear DB, re-import the projected markdown → DB
    clearEngineHierarchy();
    migrateHierarchyToDb(base);
    invalidateStateCache();
    const snapshot2 = snapshotHierarchy();

    // Property: hierarchy must be stable across the round-trip.
    assert.deepEqual(
      snapshot2,
      snapshot1,
      `round-trip drift for fixture ${name}: hierarchy changed across import → render → import`,
    );
  }
});

test("round-trip is idempotent: rendering twice produces stable markdown", async () => {
  const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const name of fixtures) {
    const base = copyFixture(name);
    openDatabase(join(base, ".gsd", "gsd.db"));
    migrateHierarchyToDb(base);
    invalidateStateCache();
    await renderAllFromDb(base);

    // Snapshot all rendered markdown files
    const snapshotFiles = (b: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".md")) out[p.replace(b + "/", "")] = readFileSync(p, "utf-8");
        }
      };
      walk(join(b, ".gsd"));
      return out;
    };
    const after1 = snapshotFiles(base);

    // Render again
    await renderAllFromDb(base);
    const after2 = snapshotFiles(base);

    assert.deepEqual(after2, after1, `re-rendering changed markdown for fixture ${name}`);
  }
});
```

- [ ] **Step 7.3: Run the test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/round-trip-property.test.ts`
Expected: PASS (2 tests). If FAIL, the failure identifies the exact projection field that isn't round-tripping — fix the renderer, not the test, and re-run until stable.

- [ ] **Step 7.4: Commit**

```bash
git add src/resources/extensions/gsd/tests/__fixtures__/round-trip/ \
        src/resources/extensions/gsd/tests/round-trip-property.test.ts
git commit -m "test(compat): add round-trip property suite

For any gsd-core fixture, import → render → import must produce a stable
hierarchy snapshot, and re-rendering must produce stable markdown. This
is the safety net that catches lossy-projection bugs before users do."
```

---

## Task 8: User-facing doc

**Files:**
- Create: `docs/how-to/switching-between-gsd-tools.md`

- [ ] **Step 8.1: Write the doc**

Create `docs/how-to/switching-between-gsd-tools.md`:

````markdown
# Switching between gsd-core and gsd-pi

Both `@opengsd/gsd-core` and `@opengsd/gsd-pi` read and write the same `.gsd/` directory. You can open a project in either tool, switch freely, and even interleave them across sessions. This doc explains the workflow and what to do when the two tools disagree.

## The shared contract

`.gsd/*.md` files are the contract between the two tools. gsd-core treats them as the source of truth. gsd-pi uses a SQLite DB internally (faster queries, transactional state) but projects to the same `.md` files and imports any external edits on startup.

## Recommended workflow: commit before switching

Git is the integration layer. Before switching tools, commit:

```bash
git add .gsd/
git commit -m "wip: switching to gsd-pi"
```

Then open the other tool. If anything goes wrong, `git reset --hard` restores the pre-switch state. This is the simplest and safest workflow.

## What gsd-pi does on startup

When you open a project in gsd-pi, it runs a reconciliation pass that:

1. Compares every `.gsd/*.md` file against its recorded baseline in `.gsd/.compat.json`.
2. Imports any file that changed since the last gsd-pi session (e.g., gsd-core edits).
3. Re-projects all markdown from the DB.
4. Updates `.gsd/.compat.json` with the new baseline.

This is automatic — you don't need to do anything special. gsd-pi will not silently overwrite gsd-core edits.

## `/gsd sync` — mid-session switch

If you switch tools while gsd-pi is running (e.g., a teammate edits `.gsd/plan.md` via gsd-core and pushes), run:

```
/gsd sync
```

This re-runs the reconciliation pipeline, imports the external edits, and re-projects. Use `--dry-run` to preview what would change:

```
/gsd sync --dry-run
```

## `/gsd doctor` — check compat health

`/gsd doctor` includes a compat-health line that tells you whether the marker is present and whether any files have drifted:

```
Compat health:      OK
```

or

```
Compat health:      2 file(s) drifted — run /gsd sync
```

## What gsd-core sees

gsd-core is unaware of gsd-pi. It sees `.gsd/*.md` as ordinary markdown and edits them directly. gsd-pi's `.gsd/.compat.json` and `gsd.db` files are ignored by gsd-core (it preserves unknown files, so they won't be deleted).

## Conflicts: same entity edited in both

If both tools edit the *same* entity (e.g., both change the status of slice `S01`) between syncs, the last writer wins after the next reconcile, and gsd-pi surfaces the resolution in the `/gsd sync` output. Git review remains the final safety net — that's why the "commit before switching" workflow matters.

## Troubleshooting

**`gsd doctor` says "no baseline"**: run `/gsd sync` once to establish the marker.

**`.gsd/.compat.json.bad-*` files appear**: gsd-pi quarantined a malformed marker and started fresh. Safe to delete the `.bad-*` file after reviewing it.

**`/gsd sync` reports drift every time you open the project**: this means gsd-pi's projection isn't idempotent — a real bug. The round-trip property test suite in CI catches most of these; report the fixture if you hit one in the wild.
````

- [ ] **Step 8.2: Commit**

```bash
git add docs/how-to/switching-between-gsd-tools.md
git commit -m "docs(compat): add switching-between-gsd-tools how-to"
```

---

## Task 9: Final verification

- [ ] **Step 9.1: Run the new unit tests together**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/compat-marker.test.ts \
  src/resources/extensions/gsd/tests/external-markdown-edit.test.ts \
  src/resources/extensions/gsd/tests/compat-marker-invalidation.test.ts \
  src/resources/extensions/gsd/tests/round-trip-property.test.ts
```
Expected: all PASS.

- [ ] **Step 9.2: Run the broader unit suite for regressions**

```bash
pnpm run test:unit
```
Expected: PASS (no regressions vs. baseline). Watch in particular for:
- `markdown-renderer.test.ts` (Task 4 touched it)
- `state-reconciliation` tests (Task 2–3 added a drift kind)
- `commands-maintenance` tests (Task 5 added `handleSync`)

- [ ] **Step 9.3: Typecheck the extensions**

```bash
pnpm run typecheck:extensions
```
Expected: PASS.

- [ ] **Step 9.4: Final commit (if any fixups)**

If steps 9.1–9.3 surfaced fixups, commit them. Otherwise nothing to commit.

---

## Self-Review Notes

**Spec coverage:**
- §4.2 compat marker → Task 1 ✓
- §4.3 new drift kind + detect/repair → Task 2 ✓
- §4.4 startup reconcile flow → covered by Task 3 (registering in `DRIFT_REGISTRY` means `reconcileBeforeDispatch` already runs on startup via the orchestrator); Task 5 adds the manual `/gsd sync` entry point ✓
- §4.5 mid-session `/gsd sync` → Task 5 ✓
- §4.6 write-time invalidation → Task 4 ✓
- §4.7 command parity → out of scope for this plan (already in-progress in the working tree as a separate effort; called out in the spec's scope section)
- §4.8 round-trip property suite → Task 7 ✓
- §5.1 file changes → all mapped ✓
- §5.2 module boundaries → compat module exposes only `readCompatMarker`/`writeCompatMarker` + types; drift handler depends on it ✓
- §8 testing → Tasks 1, 2, 4, 7 cover unit + property; integration covered by Task 9.2 ✓
- §3 success criteria #4 (doctor health) → Task 6 ✓

**Placeholder scan:** Steps 4.4 and 6.2 reference variable names that must be confirmed against the actual source at execution time (the plan flags this explicitly rather than guessing). All other steps contain complete code.

**Type consistency:** `CompatMarker` and `ProjectionEntry` are defined in Task 1 and used identically in Tasks 2, 4, 5, 6. `externalMarkdownEditHandler` is exported from Task 2 and imported in Task 3. `handleSync` is defined in Task 5 and imported in Task 5.2. Naming consistent throughout.

**Scope decomposition:** This plan covers the compat layer + sync + doctor + property tests + docs. Command parity (§4.7) is a separate in-progress effort tracked in the working tree and is correctly out of this plan's scope.
