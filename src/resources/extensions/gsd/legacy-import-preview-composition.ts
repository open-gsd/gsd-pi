// Project/App: gsd-pi
// File Purpose: Pure exactly-once composition of captured legacy import Preview interpretations.

import { compareText, deepFreeze } from "./legacy-import-utils.js";

import type { LegacyImportPreviewSource } from "./legacy-import-contract.js";
import type { LegacyImportDatabaseTargetInspectionEvidence } from "./legacy-import-preview-database-target.js";
import {
  interpretLegacyGsdCapture,
  type LegacyImportGsdDatabaseEvidence,
} from "./legacy-import-preview-gsd.js";
import {
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportInterpretation,
  type LegacyImportInterpretationCandidate,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import { interpretLegacyPlanningCapture } from "./legacy-import-preview-planning.js";
import type {
  LegacyImportSourceCapture,
  LegacyImportSourceEntry,
} from "./legacy-import-preview-source.js";
import { contributeLegacySupplementalFiles } from "./legacy-import-preview-supplemental.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "./legacy-import-preview.js";

const UNCLAIMED_PARSER_ID = "preview-composition-unclaimed";

export interface LegacyImportCompositionContext {
  bundledDefinitionNames?: readonly string[];
  databaseTargetEvidence?: readonly LegacyImportDatabaseTargetInspectionEvidence[];
  gsdDatabaseEvidence?: readonly LegacyImportGsdDatabaseEvidence[];
}

export class LegacyImportCompositionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string>>;

  constructor(code: string, message: string, context: Record<string, string> = {}) {
    super(message);
    this.name = "LegacyImportCompositionError";
    this.code = code;
    this.retryable = false;
    this.context = Object.freeze({ ...context });
  }
}

function projectCapture(
  capture: LegacyImportSourceCapture,
  includedSourceIds: ReadonlySet<string>,
): LegacyImportSourceCapture {
  const entries = capture.entries.filter((entry) => (
    entry.kind === "directory" || includedSourceIds.has(entry.source_id)
  ));
  const payloadIds = new Set(entries.flatMap((entry) => (
    entry.payload_id === undefined ? [] : [entry.payload_id]
  )));
  const value = {
    capture_version: capture.capture_version,
    roots: capture.roots,
    entries,
    payloads: capture.payloads.filter((payload) => payloadIds.has(payload.payload_id)),
  };
  return deepFreeze({ ...value, capture_hash: hashLegacyImportValue(value) });
}

function supplementalInterpretation(
  capture: LegacyImportSourceCapture,
  context: LegacyImportCompositionContext,
): { interpretation: LegacyImportInterpretation; claimedSourceIds: ReadonlySet<string> } {
  const files = decodeLegacyImportCapture(capture, {
    sourceLabel: "composed supplemental GSD",
    includes: (entry) => entry.kind !== "directory",
    parserId: () => UNCLAIMED_PARSER_ID,
    kind: () => "unclassified",
    parserVersion: "1",
  });
  const candidates: LegacyImportPendingCandidate[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  contributeLegacySupplementalFiles(capture, files, candidates, diagnoses, {
    bundledDefinitionNames: context.bundledDefinitionNames,
    databaseTargetEvidence: context.databaseTargetEvidence,
  });
  const claimedFiles = files.filter((file) => file.parserId !== UNCLAIMED_PARSER_ID);
  const claimedSourceIds = new Set<string>(claimedFiles.map((file) => file.entry.source_id));
  for (const candidate of candidates) {
    if (!claimedSourceIds.has(candidate.provenance.source_id)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_UNCLAIMED",
        "supplemental legacy import evidence has no owned source",
        { source_id: candidate.provenance.source_id },
      );
    }
  }
  for (const diagnosis of diagnoses) {
    if (!claimedSourceIds.has(diagnosis.source_id)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_UNCLAIMED",
        "supplemental legacy import diagnosis has no owned source",
        { source_id: diagnosis.source_id },
      );
    }
  }
  return {
    interpretation: finalizeLegacyImportInterpretation(
      claimedFiles,
      candidates,
      diagnoses,
    ),
    claimedSourceIds,
  };
}

function capturedFilesBySourceId(
  capture: LegacyImportSourceCapture,
): ReadonlyMap<string, LegacyImportSourceEntry> {
  return new Map(capture.entries.flatMap((entry) => (
    entry.kind === "directory" ? [] : [[entry.source_id, entry] as const]
  )));
}

function rebindGsdDatabaseEvidence(
  capture: LegacyImportSourceCapture,
  gsdView: LegacyImportSourceCapture,
  claimedSourceIds: ReadonlySet<string>,
  evidenceSet: readonly LegacyImportGsdDatabaseEvidence[],
): readonly LegacyImportGsdDatabaseEvidence[] {
  const files = capturedFilesBySourceId(capture);
  const seen = new Set<string>();
  return evidenceSet.map((evidence) => {
    const { evidence_hash: evidenceHash, ...evidenceValue } = evidence;
    const source = files.get(evidence.source_id);
    if (
      evidence.capture_hash !== capture.capture_hash
      || hashLegacyImportValue(evidenceValue) !== evidenceHash
      || source === undefined
      || source.logical_path.toLowerCase() !== ".gsd/gsd.db"
      || source.sha256 !== evidence.source_sha256
      || source.byte_size !== evidence.source_byte_size
      || !claimedSourceIds.has(evidence.source_id)
      || seen.has(evidence.source_id)
    ) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_DATABASE_EVIDENCE_INVALID",
        "legacy GSD database evidence is not bound to one supplemental-owned captured database",
        { source_id: evidence.source_id },
      );
    }
    seen.add(evidence.source_id);
    const reboundValue = { ...evidenceValue, capture_hash: gsdView.capture_hash };
    return { ...reboundValue, evidence_hash: hashLegacyImportValue(reboundValue) };
  });
}

function sameSourceMetadata(
  left: LegacyImportPreviewSource,
  right: LegacyImportPreviewSource,
): boolean {
  return canonicalLegacyImportJson(left) === canonicalLegacyImportJson(right);
}

function gsdInterpretation(
  capture: LegacyImportSourceCapture,
  claimedSourceIds: ReadonlySet<string>,
  supplemental: LegacyImportInterpretation,
  evidenceSet: readonly LegacyImportGsdDatabaseEvidence[],
): LegacyImportInterpretation {
  const evidenceConsumerIds = new Set<string>(evidenceSet.map((evidence) => evidence.source_id));
  const includedSourceIds = new Set(capture.entries.flatMap((entry) => (
    entry.kind !== "directory"
      && (!claimedSourceIds.has(entry.source_id) || evidenceConsumerIds.has(entry.source_id))
      ? [entry.source_id]
      : []
  )));
  const gsdView = projectCapture(capture, includedSourceIds);
  const reboundEvidence = rebindGsdDatabaseEvidence(
    capture,
    gsdView,
    claimedSourceIds,
    evidenceSet,
  );
  const interpreted = interpretLegacyGsdCapture(gsdView, reboundEvidence);
  const supplementalSources = new Map(supplemental.sources.map((source) => [source.source_id, source]));
  for (const sourceId of evidenceConsumerIds) {
    const supplementalSource = supplementalSources.get(sourceId);
    const gsdSource = interpreted.sources.find((source) => source.source_id === sourceId);
    if (
      supplementalSource === undefined
      || gsdSource === undefined
      || !sameSourceMetadata(supplementalSource, gsdSource)
    ) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_DATABASE_SOURCE_CONFLICT",
        "legacy database evidence consumers disagree with supplemental source ownership",
        { source_id: sourceId },
      );
    }
  }
  return {
    ...interpreted,
    sources: interpreted.sources.filter((source) => !evidenceConsumerIds.has(source.source_id)),
  };
}

function requireUniqueIds<T>(
  values: readonly T[],
  id: (value: T) => string,
  kind: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const valueId = id(value);
    if (seen.has(valueId)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_ID_DUPLICATE",
        `composed legacy import ${kind} identity is duplicated`,
        { id: valueId, kind },
      );
    }
    seen.add(valueId);
  }
}

function composeSources(
  capture: LegacyImportSourceCapture,
  interpretations: readonly LegacyImportInterpretation[],
): LegacyImportPreviewSource[] {
  const captured = capturedFilesBySourceId(capture);
  const sources = interpretations.flatMap((interpretation) => interpretation.sources);
  const owned = new Map<string, LegacyImportPreviewSource>();
  for (const source of sources) {
    if (owned.has(source.source_id)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_DUPLICATE",
        "captured legacy import source has multiple interpreter owners",
        { source_id: source.source_id, logical_path: source.path },
      );
    }
    owned.set(source.source_id, source);
  }
  for (const [sourceId, entry] of captured) {
    if (!owned.has(sourceId)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_UNCLAIMED",
        "captured legacy import source has no interpreter owner",
        { source_id: sourceId, logical_path: entry.logical_path },
      );
    }
  }
  for (const source of sources) {
    if (!captured.has(source.source_id)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_UNKNOWN",
        "legacy import interpretation owns a source outside the capture",
        { source_id: source.source_id, logical_path: source.path },
      );
    }
  }
  return sources.sort((left, right) => compareText(left.source_id, right.source_id));
}

function composeCandidates(
  interpretations: readonly LegacyImportInterpretation[],
): LegacyImportInterpretationCandidate[] {
  const candidates = interpretations.flatMap((interpretation) => interpretation.candidates)
    .sort((left, right) => compareText(left.candidate_id, right.candidate_id));
  requireUniqueIds(candidates, (candidate) => candidate.candidate_id, "candidate");
  return candidates.map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));
}

export function composeLegacyImportInterpretation(
  capture: LegacyImportSourceCapture,
  context: LegacyImportCompositionContext = {},
): LegacyImportInterpretation {
  const supplemental = supplementalInterpretation(capture, context);
  const interpretations = [
    interpretLegacyPlanningCapture(capture),
    gsdInterpretation(
      capture,
      supplemental.claimedSourceIds,
      supplemental.interpretation,
      context.gsdDatabaseEvidence ?? [],
    ),
    supplemental.interpretation,
  ];
  const sources = composeSources(capture, interpretations);
  const candidates = composeCandidates(interpretations);
  const completeRowSets = interpretations.flatMap((interpretation) => interpretation.complete_row_sets)
    .sort((left, right) => compareText(left.complete_set_id, right.complete_set_id));
  const diagnoses = interpretations.flatMap((interpretation) => interpretation.diagnoses)
    .sort((left, right) => compareText(left.diagnosis_id, right.diagnosis_id));
  const resolutions = interpretations.flatMap((interpretation) => interpretation.resolutions)
    .sort((left, right) => compareText(left.diagnosis_id, right.diagnosis_id));
  requireUniqueIds(completeRowSets, (complete) => complete.complete_set_id, "complete row set");
  requireUniqueIds(diagnoses, (diagnosis) => diagnosis.diagnosis_id, "diagnosis");
  requireUniqueIds(resolutions, (resolution) => resolution.diagnosis_id, "resolution");
  const ownedSourceIds = new Set(sources.map((source) => source.source_id));
  for (const candidate of candidates) {
    if (!ownedSourceIds.has(candidate.provenance.source_id)) {
      throw new LegacyImportCompositionError(
        "LEGACY_IMPORT_COMPOSITION_SOURCE_UNKNOWN",
        "legacy import candidate provenance has no composed source owner",
        { source_id: candidate.provenance.source_id },
      );
    }
  }
  return deepFreeze({
    sources,
    candidates,
    complete_row_sets: completeRowSets,
    diagnoses,
    resolutions,
  });
}
