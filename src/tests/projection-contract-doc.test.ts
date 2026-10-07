// Project/App: gsd-pi
// File Purpose: Pin the projection contract doc to code reality. Fails when a
// file path, file:line citation, or writer symbol named in
// docs/dev/state-db-cutover-projection-contract.md no longer exists in the
// repository (or when a symbol the contract retired comes back).

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const DOC = "docs/dev/state-db-cutover-projection-contract.md";

// The compiled copy runs from dist-test/src/tests, which has no docs/ tree:
// walk up to the checkout that holds the doc.
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, DOC))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`repo root with ${DOC} not found above ${fileURLToPath(import.meta.url)}`);
}

const REPO_ROOT = findRepoRoot();
const docPath = join(REPO_ROOT, DOC);
const doc = readFileSync(docPath, "utf-8");

// Directories a bare filename in the doc may resolve against, most specific
// first. A bare name is a path token without a "/" (e.g. `export.ts`).
const SEARCH_PREFIXES = [
  "",
  "src/resources/extensions/gsd/",
  "src/resources/extensions/gsd/tools/",
  "src/resources/extensions/gsd/migrate/",
  "src/resources/extensions/gsd/compat/",
  "src/resources/extensions/gsd/tests/",
  "src/resources/extensions/gsd/db/writers/",
  "packages/mcp-server/src/",
  "packages/mcp-server/src/readers/",
  "src/web/",
  "tests/",
  "docs/dev/",
  "scripts/",
];

/** Resolve a path token from the doc to an existing repo file, or null. */
function resolveRepoPath(token: string): string | null {
  for (const prefix of SEARCH_PREFIXES) {
    const candidate = join(REPO_ROOT, prefix, token);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test("projection contract doc exists", () => {
  assert.ok(existsSync(docPath), `${DOC} is missing`);
});

test("every path-like token in the doc names an existing repo file", () => {
  // Source-tree citations only. Runtime projection names (`STATE.md`,
  // `QUEUE-ORDER.json`, `.gsd/...`) and placeholder shapes (`NN-<TYPE>.md`)
  // are outputs on a user's disk, not files in this repository.
  const REPO_PREFIXES = ["src/", "packages/", "docs/", "scripts/", "tests/", "integrations/", "web/", "native/"];
  const tokens = [...doc.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const offenders: string[] = [];
  for (const raw of new Set(tokens)) {
    if (raw.includes("*") || raw.includes(" ") || /[<>~]/.test(raw)) continue;
    const token = raw.replace(/:\d+$/, ""); // strip a trailing :line citation
    if (!token.includes(".") || !/\w/.test(token.replace(/\.[a-z]+$/, ""))) continue;
    const underRepoRoot = REPO_PREFIXES.some((prefix) => token.startsWith(prefix));
    const isSourceFile = /\.(ts|tsx|mjs)$/.test(token);
    if (!underRepoRoot && !isSourceFile) continue;
    if (resolveRepoPath(token) === null) offenders.push(token);
  }
  assert.deepEqual(offenders, [], `doc names files that do not exist: ${offenders.join(", ")}`);
});

test("every file:line citation in the doc points at a non-empty line in range", () => {
  const offenders: string[] = [];
  // Citations look like `some/path.ts:334` or `name.ts:171`-`:205`. Only the
  // line attached to the file token is checked; a bare trailing `:NNN` range
  // end has no file of its own.
  for (const match of doc.matchAll(/[A-Za-z0-9_/.-]+\.(?:ts|tsx|mjs|md|json):(\d+)/g)) {
    const token = match[0]!;
    const lineNo = Number(match[1]);
    const filePart = token.slice(0, token.lastIndexOf(":"));
    const absolute = resolveRepoPath(filePart);
    if (absolute === null) {
      offenders.push(`${token} (file not found)`);
      continue;
    }
    const lines = readFileSync(absolute, "utf-8").split("\n");
    if (lineNo < 1 || lineNo > lines.length) {
      offenders.push(`${token} (line beyond end of file, ${lines.length} lines)`);
      continue;
    }
    if (lines[lineNo - 1]!.trim() === "") {
      offenders.push(`${token} (cited line is blank)`);
    }
  }
  assert.deepEqual(offenders, [], `stale file:line citations in ${DOC}: ${offenders.join(", ")}`);
});

test("every writer the contract names is defined in the file that section cites", () => {
  // [symbol, file the doc names for it]. The file resolves like a doc token.
  const SYMBOLS: Array<[string, string]> = [
    ["writeAndStore", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderAllFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderPlanFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderTaskPlanFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderRoadmapFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderMilestoneArtifactsFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderMilestoneSummary", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderSliceArtifactsFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderSliceSummary", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderTaskSummary", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderReplanFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderRoadmapAssessmentFromDb", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderMilestoneValidation", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderWorkCheckpoint", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["writeTaskSummaryProjection", "src/resources/extensions/gsd/markdown-renderer.ts"],
    ["renderStateProjection", "src/resources/extensions/gsd/workflow-projections.ts"],
    ["renderStateContent", "src/resources/extensions/gsd/workflow-projections.ts"],
    ["renderTopLevelRoadmapFromDb", "src/resources/extensions/gsd/workflow-projections.ts"],
    ["renderTopLevelQueueFromDb", "src/resources/extensions/gsd/workflow-projections.ts"],
    ["writeRootProjection", "src/resources/extensions/gsd/workflow-projections.ts"],
    ["regenerateDecisionsMarkdown", "src/resources/extensions/gsd/db-writer.ts"],
    ["regenerateRequirementsMarkdown", "src/resources/extensions/gsd/db-writer.ts"],
    ["regenerateRootArtifactsMarkdown", "src/resources/extensions/gsd/db-writer.ts"],
    ["saveArtifactToDbForWorkspace", "src/resources/extensions/gsd/db-writer.ts"],
    ["writeProjectionFile", "src/resources/extensions/gsd/compat/compat-marker.ts"],
    ["writeProjectionFileSync", "src/resources/extensions/gsd/compat/compat-marker.ts"],
    ["renderKnowledgeProjection", "src/resources/extensions/gsd/knowledge-projection.ts"],
    ["renderOverridesProjection", "src/resources/extensions/gsd/overrides.ts"],
    ["importFileOverrides", "src/resources/extensions/gsd/overrides.ts"],
    ["renderCapturesProjection", "src/resources/extensions/gsd/captures.ts"],
    ["importFileCaptures", "src/resources/extensions/gsd/captures.ts"],
    ["renderBacklogProjection", "src/resources/extensions/gsd/backlog.ts"],
    ["renderQueueOrderFromDb", "src/resources/extensions/gsd/queue-order.ts"],
    ["renderQueueOrder", "src/resources/extensions/gsd/queue-order.ts"],
    ["renderMilestoneParkedMarker", "src/resources/extensions/gsd/milestone-park-projection.ts"],
    ["writeCodebaseMap", "src/resources/extensions/gsd/codebase-generator.ts"],
    ["renderEveryProjection", "src/resources/extensions/gsd/projection-worker.ts"],
    ["rebuildMarkdownProjectionsFromDb", "src/resources/extensions/gsd/projection-worker.ts"],
    ["projectionRendererFor", "src/resources/extensions/gsd/projection-worker.ts"],
    ["writePlanningDirectory", "src/resources/extensions/gsd/migrate/planning-writer.ts"],
    ["saveFile", "src/resources/extensions/gsd/files.ts"],
    ["GSD_ROOT_FILES", "src/resources/extensions/gsd/paths.ts"],
    ["gsdProjectionRoot", "src/resources/extensions/gsd/paths.ts"],
    ["incrementLegacyTelemetry", "src/resources/extensions/gsd/legacy-telemetry.ts"],
    ["writeExportFile", "src/resources/extensions/gsd/export.ts"],
  ];
  const offenders: string[] = [];
  for (const [symbol, file] of SYMBOLS) {
    const absolute = join(REPO_ROOT, file);
    if (!existsSync(absolute)) {
      offenders.push(`${symbol} <- ${file} (file missing)`);
      continue;
    }
    const defined = new RegExp(
      `(export\\s+)?(async\\s+)?function\\s+${symbol}\\b|export\\s+const\\s+${symbol}\\b`,
    ).test(readFileSync(absolute, "utf-8"));
    if (!defined) offenders.push(`${symbol} is not defined in ${file}`);
  }
  assert.deepEqual(offenders, [], `contract names writers that do not exist: ${offenders.join(", ")}`);
});

test("symbols the contract retired stay retired", () => {
  // The doc must never name these again as live code; if one reappears in
  // src/ or packages/ the cutover regressed.
  const retired = ["renderAssessmentFromDb", "writeGsdProjection", "skipBrowserEvidenceGate", "allowPassThroughValidation"];
  const offenders: string[] = [];
  for (const symbol of retired) {
    if (doc.includes(symbol)) offenders.push(`${symbol} is named in ${DOC}`);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("runtime stores named in §3.6 exist at their declared paths", () => {
  const declared: Array<[string, string]> = [
    ["notifications.jsonl", "src/resources/extensions/gsd/notification-store.ts"],
    ["doctor-history.jsonl", "src/resources/extensions/gsd/doctor-history.ts"],
    ["activity-log.ts", "src/resources/extensions/gsd/activity-log.ts"],
    ["exec-history.ts", "src/resources/extensions/gsd/exec-history.ts"],
    ["export.ts", "src/resources/extensions/gsd/export.ts"],
    ["export-service.ts", "src/web/export-service.ts"],
  ];
  for (const [needle, file] of declared) {
    const absolute = join(REPO_ROOT, file);
    assert.ok(existsSync(absolute), `${file} is missing`);
    if (needle.endsWith(".ts")) continue;
    assert.ok(
      readFileSync(absolute, "utf-8").includes(needle),
      `${file} no longer references ${needle}`,
    );
  }
});

test("§5 reader citations name live surfaces", () => {
  // Each §5 evidence file must still read the projection it claims to read.
  const expectations: Array<[string, string]> = [
    ["packages/mcp-server/src/server.ts", "STATE.md"],
    ["packages/mcp-server/src/readers/state.ts", "STATE.md"],
    ["packages/mcp-server/src/readers/doctor-lite.ts", "STATE.md"],
    ["src/welcome-screen.ts", "STATE.md"],
    ["src/web/project-discovery-service.ts", "STATE.md"],
  ];
  for (const [file, needle] of expectations) {
    const text = readFileSync(join(REPO_ROOT, file), "utf-8");
    assert.ok(text.includes(needle), `${file} no longer reads ${needle}; update §5 of ${DOC}`);
  }
});
