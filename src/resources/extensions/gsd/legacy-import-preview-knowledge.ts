// Project/App: gsd-pi
// File Purpose: Pure legacy knowledge projection contributions from retained source bytes.

import type { LegacyImportValue } from "./legacy-import-contract.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import { parseLegacyImportJson, type LegacyImportJsonDocument } from "./legacy-import-preview-json.js";
import { hashLegacyImportBytes } from "./legacy-import-preview.js";
import { parseKnowledgeRows } from "./knowledge-parser.js";

interface KnowledgeGraphNode {
  id: string;
  sourceFile: string;
  description?: string;
}

interface KnowledgeGraph {
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly Readonly<Record<string, LegacyImportValue>>[];
}

function isRecord(value: unknown): value is Readonly<Record<string, LegacyImportValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function graphFrom(document: LegacyImportJsonDocument): KnowledgeGraph | undefined {
  if (!isRecord(document.value) || !Array.isArray(document.value.nodes) || !Array.isArray(document.value.edges)) {
    return undefined;
  }
  const nodes: KnowledgeGraphNode[] = [];
  for (const value of document.value.nodes) {
    if (
      !isRecord(value)
      || typeof value.id !== "string"
      || typeof value.sourceFile !== "string"
      || !(value.description === undefined || typeof value.description === "string")
    ) {
      return undefined;
    }
    nodes.push({
      id: value.id,
      sourceFile: value.sourceFile,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    });
  }
  const edges = document.value.edges.filter(isRecord);
  return edges.length === document.value.edges.length ? { nodes, edges } : undefined;
}

function stringTokenSpan(
  document: LegacyImportJsonDocument,
  pointer: string,
): { start: number; end: number } {
  const token = document.locate(pointer);
  return { start: token.start_byte + 1, end: token.end_byte - 1 };
}

function preserveKnowledgeMarkdown(
  file: LegacyImportDecodedSourceFile,
  candidates: LegacyImportPendingCandidate[],
): void {
  file.parserId = "gsd-knowledge-graph";
  file.kind = "markdown";
  file.outcome = "preserved";
  addLegacyImportCandidate(
    candidates,
    file,
    { kind: "legacy-knowledge-source", key: file.entry.logical_path },
    { role: "projection-input", preservation: "verbatim" },
    "knowledge-markdown-preserved",
    0,
    file.bytes.length,
    "preserve",
  );
}

function preserveNestedLearnings(
  file: LegacyImportDecodedSourceFile,
  milestoneId: string,
  artifactId: string,
  candidates: LegacyImportPendingCandidate[],
): void {
  file.parserId = "gsd-knowledge-graph";
  file.kind = "markdown";
  file.outcome = "preserved";
  addLegacyImportCandidate(
    candidates,
    file,
    { kind: "legacy-knowledge-source", key: artifactId },
    { layout: "nested", milestone_id: milestoneId, preservation: "verbatim" },
    "nested-learnings-preserved",
    0,
    file.bytes.length,
    "preserve",
  );
}

function ignoreFlatLearnings(
  file: LegacyImportDecodedSourceFile,
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  file.parserId = "gsd-knowledge-graph";
  file.kind = "markdown";
  file.outcome = "ignored-with-reason";
  const sensitive = /(?:credential|secret|token)\s*:\s*([A-Za-z0-9_-]+)/iu.exec(file.text);
  const sensitiveStart = sensitive === null
    ? 0
    : sensitive.index + sensitive[0].lastIndexOf(sensitive[1]!);
  const start = Buffer.byteLength(file.text.slice(0, sensitiveStart));
  const end = sensitive === null ? file.bytes.length : start + Buffer.byteLength(sensitive[1]!);
  const bytes = file.bytes.subarray(start, end);
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    "legacy-flat-learnings-not-read",
    "info",
    "A flat-layout learnings artifact is outside the nested-only production graph reader and is preserved without rebuilding.",
    "preserved",
    start,
    end,
    undefined,
    { redacted: true, sha256: hashLegacyImportBytes(bytes) },
  );
}

function diagnoseGraphEvidence(
  file: LegacyImportDecodedSourceFile,
  document: LegacyImportJsonDocument,
  graph: KnowledgeGraph,
  files: readonly LegacyImportDecodedSourceFile[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  const knowledge = files.find((candidate) => candidate.entry.logical_path === ".gsd/KNOWLEDGE.md");
  const rules = new Map(
    parseKnowledgeRows(knowledge?.text ?? "")
      .filter((row) => row.table === "rules")
      .map((row) => [row.id, row.cells[2] ?? ""]),
  );
  const paths = new Set(files.map((candidate) => candidate.entry.logical_path));
  graph.nodes.forEach((node, index) => {
    if (node.description !== undefined && node.id.startsWith("rule:")) {
      const expected = rules.get(node.id.slice("rule:".length));
      if (expected !== undefined && expected !== node.description) {
        const span = stringTokenSpan(document, `/nodes/${index}/description`);
        addLegacyImportDiagnosis(
          diagnoses,
          file,
          "derived-graph-source-conflict",
          "warning",
          "The derived graph disagrees with its Markdown input; both are preserved and neither is promoted to authority.",
          "preserved",
          span.start,
          span.end,
          undefined,
          node.description,
        );
      }
    }
    const sourcePath = `.gsd/${node.sourceFile.replace(/^\.gsd\//u, "")}`;
    if (!paths.has(sourcePath)) {
      const span = stringTokenSpan(document, `/nodes/${index}/sourceFile`);
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "graph-source-missing",
        "warning",
        "A derived graph node references a source artifact that is absent from the corpus.",
        "preserved",
        span.start,
        span.end,
        undefined,
        node.sourceFile,
      );
    }
  });
}

function interpretGraph(
  file: LegacyImportDecodedSourceFile,
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  file.parserId = "gsd-knowledge-graph";
  file.kind = "json";
  let document: LegacyImportJsonDocument;
  try {
    document = parseLegacyImportJson(file.bytes);
  } catch {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses,
      file,
      "malformed-graph-snapshot",
      "warning",
      "The prior graph snapshot is malformed and remains preserved as raw evidence.",
      "preserved",
    );
    return;
  }
  const graph = graphFrom(document);
  if (graph === undefined) {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses,
      file,
      "malformed-graph-snapshot",
      "warning",
      "The prior graph snapshot is malformed and remains preserved as raw evidence.",
      "preserved",
    );
    return;
  }
  file.outcome = "preserved";
  addLegacyImportCandidate(
    candidates,
    file,
    { kind: "legacy-knowledge-graph-snapshot", key: file.entry.logical_path },
    {
      role: "derived-snapshot",
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      preservation: "verbatim",
    },
    "derived-graph-preserved-without-rebuild",
    0,
    file.bytes.length,
    "preserve",
  );
  diagnoseGraphEvidence(file, document, graph, files, diagnoses);
}

export function contributeLegacyKnowledgeProjection(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  for (const file of files) {
    const path = file.entry.logical_path;
    if (file.encoding !== "utf-8") continue;
    if (path === ".gsd/KNOWLEDGE.md") {
      preserveKnowledgeMarkdown(file, candidates);
      continue;
    }
    const nestedPath = /^\.gsd\/milestones\/[^/]+\/((M\d+)(?:-[A-Za-z0-9-]+)?-LEARNINGS)\.md$/u.exec(path);
    if (nestedPath !== null) {
      preserveNestedLearnings(file, nestedPath[2]!, nestedPath[1]!, candidates);
      continue;
    }
    if (/^\.gsd\/phases\/[^/]+\/[^/]+-LEARNINGS\.md$/u.test(path)) {
      ignoreFlatLearnings(file, diagnoses);
      continue;
    }
    if (path === ".gsd/graphs/graph.json" || path === ".gsd/graphs/.last-build-snapshot.json") {
      interpretGraph(file, files, candidates, diagnoses);
    }
  }
}
