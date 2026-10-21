// Structural invariant: the legacy markdown state-path is gone (T020/T022).
//
// The DB is the single source of truth; `.gsd/*.md` files are projections.
// Dispatch/gate/completion code must read state via gsd-db queries (e.g.
// getMilestoneSliceSummaries), never by parsing markdown projections.
//
// KEYED ON SYMBOLS, NOT THE MODULE SPECIFIER (T033). This registry counts a
// module as a legacy-parser consumer when it references
// `parseLegacyRoadmap`/`parseLegacyPlan` OR imports a module named
// `parsers-legacy`. Projection parsers live under `parseProjection*` in
// schemas/parsers.ts and are not this path. Mirrors
// scripts/legacy-state-path-proof.mjs.
//
// Assertions:
// 1. Decision-path modules must NOT consume the legacy parsers (hard ban).
// 2. Zero production importers of the retired symbols or shim.
// 3. parsers-legacy.ts does not exist.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const extensionsDir = join(process.cwd(), "src/resources/extensions");

// Modules that make dispatch/gate/completion decisions. Consuming the legacy
// parsers here is always a violation, allowlist or not.
const BANNED_DECISION_PATHS = new Set([
  "gsd/auto-direct-dispatch.ts",
  "gsd/dispatch-guard.ts",
  "gsd/auto-verification.ts",
  "gsd/auto-dispatch.ts",
  "gsd/auto-post-unit.ts",
  "gsd/milestone-closeout.ts",
  "gsd/auto/phases.ts",
  "gsd/auto/pre-dispatch.ts",
  "gsd/auto/dispatch.ts",
  "gsd/auto/unit-phase.ts",
  "gsd/auto/finalize.ts",
  "gsd/auto/closeout.ts",
  "gsd/auto/orchestrator.ts",
  "gsd/auto/loop.ts",
  "gsd/tools/complete-slice.ts",
]);

const SHIM_PATH = join(process.cwd(), "src/resources/extensions/gsd/parsers-legacy.ts");

// The declaration home of the projection parsers is not a consumer of the
// retired symbols.
const SELF_PATHS = new Set(["gsd/schemas/parsers.ts"]);

// Specifier anywhere in a string literal — covers `from '…'`, `import('…')`,
// `require('…')`, the side-effect form (`import './parsers-legacy.js';`) and
// the specifier-on-its-own-line form.
const SPECIFIER_RE = /["'][^"']*parsers-legacy(?:\.js)?["']/;
// The legacy exports of schemas/parsers.ts that parse projection markdown as a
// data source. `parseRoadmap` is the unrelated validation parser, not listed.
const LEGACY_PARSER_SYMBOL_RE = /\b(?:parseLegacyRoadmap|parseLegacyPlan)\b/;

/** Blank out `//` and `/* … *\/` comments, preserving string literals, so a
 *  banned symbol named in prose is not a false positive. */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let inBlock = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

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
        if (ent.name === "tests" || ent.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts")) continue;
      if (ent.name.startsWith(".")) continue;
      if (ent.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

function findImporters(): string[] {
  const importers: string[] = [];
  for (const file of walkTsFiles(extensionsDir)) {
    const rel = relative(extensionsDir, file).split("\\").join("/");
    if (SELF_PATHS.has(rel)) continue; // the shim and the symbols' own home
    const code = stripComments(readFileSync(file, "utf-8"));
    if (SPECIFIER_RE.test(code) || LEGACY_PARSER_SYMBOL_RE.test(code)) importers.push(rel);
  }
  return importers.sort();
}

test("decision-path modules do not consume the legacy parsers (ADR-017)", () => {
  const violations = findImporters().filter((rel) => BANNED_DECISION_PATHS.has(rel));
  assert.deepEqual(
    violations,
    [],
    `Decision-path modules must read the DB (db/queries.ts, e.g. getMilestoneSliceSummaries), ` +
      `not parse .gsd/*.md projections. Violations:\n  ${violations.join("\n  ")}`,
  );
});

test("zero production importers of retired legacy parser symbols or shim", () => {
  const importers = findImporters();
  assert.deepEqual(
    importers,
    [],
    `Retired legacy-parser consumer(s) detected:\n  ${importers.join("\n  ")}\n` +
      `Projection reads must use parseProjection* from schemas/parsers.ts. ` +
      `Decision paths must read the DB (db/queries.ts). Do not reintroduce ` +
      `parseLegacyRoadmap, parseLegacyPlan, or parsers-legacy.`,
  );
});

test("parsers-legacy.ts does not exist", () => {
  assert.equal(
    existsSync(SHIM_PATH),
    false,
    "parsers-legacy.ts was deleted in T020; re-adding it is a regression",
  );
});
