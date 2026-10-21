// Project/App: gsd-pi
// File Purpose: Explicit canonical target adapters for legacy Preview classification.

import type { LegacyImportBaseRowSet } from "./legacy-import-preview-base.js";

export interface LegacyImportTargetAdapter {
  rowSet: LegacyImportBaseRowSet;
  identity:
    | { kind: "scalar"; fields: readonly [string] }
    | { kind: "hierarchy"; fields: readonly [string, string] | readonly [string, string, string] }
    | { kind: "assessment"; fields: readonly ["milestone_id", "slice_id", "task_id", "scope"] };
  fields: ReadonlySet<string>;
  metadata: ReadonlySet<string>;
  aliases: Readonly<Record<string, string>>;
}

export const LEGACY_IMPORT_TARGET_ADAPTERS = {
  milestone: {
    rowSet: "milestones",
    identity: { kind: "scalar", fields: ["id"] },
    fields: new Set([
      "id", "title", "status", "depends_on", "completed_at", "vision", "success_criteria",
      "key_risks", "proof_strategy", "verification_contract", "verification_integration",
      "verification_operational", "verification_uat", "definition_of_done", "requirement_coverage",
      "boundary_map_markdown", "sequence",
    ]),
    metadata: new Set(["layout", "grammar", "source_alias", "legacy_provenance"]),
    aliases: {},
  },
  slice: {
    rowSet: "slices",
    identity: { kind: "hierarchy", fields: ["milestone_id", "id"] },
    fields: new Set([
      "milestone_id", "id", "title", "status", "risk", "depends", "demo", "completed_at",
      "full_summary_md", "full_uat_md", "goal", "success_criteria", "proof_level",
      "integration_closure", "observability_impact", "target_repositories", "sequence",
      "replan_triggered_at", "is_sketch", "sketch_scope",
    ]),
    metadata: new Set([
      "layout", "grammar", "source_alias", "task_count", "tasks", "legacy_phase_number",
      "legacy_provenance",
    ]),
    aliases: { depends_on: "depends", sketch: "is_sketch", canonical_sequence: "sequence" },
  },
  task: {
    rowSet: "tasks",
    identity: { kind: "hierarchy", fields: ["milestone_id", "slice_id", "id"] },
    fields: new Set([
      "milestone_id", "slice_id", "id", "title", "status", "one_liner", "narrative",
      "verification_result", "duration", "completed_at", "blocker_discovered", "blocker_source",
      "escalation_pending", "escalation_awaiting_review", "escalation_artifact_path",
      "escalation_override_applied_at", "deviations", "known_issues", "key_files", "key_decisions",
      "full_summary_md", "description", "estimate", "files", "verify", "inputs", "expected_output",
      "observability_impact", "full_plan_md", "target_repositories", "sequence",
    ]),
    metadata: new Set([
      "layout", "grammar", "source_alias", "numbering_provenance", "legacy_provenance",
    ]),
    aliases: {
      summary: "full_summary_md",
      objective: "description",
      canonical_sequence: "sequence",
    },
  },
  requirement: {
    rowSet: "requirements",
    identity: { kind: "scalar", fields: ["id"] },
    fields: new Set([
      "id", "class", "status", "description", "why", "source", "primary_owner",
      "supporting_slices", "validation", "notes", "full_content", "superseded_by",
    ]),
    metadata: new Set(["title"]),
    aliases: { text: "description" },
  },
  artifact: {
    rowSet: "artifacts",
    identity: { kind: "scalar", fields: ["path"] },
    fields: new Set(["path", "artifact_type", "milestone_id", "slice_id", "task_id", "full_content", "content_hash"]),
    metadata: new Set(),
    aliases: { content: "full_content" },
  },
  assessment: {
    rowSet: "assessments",
    identity: { kind: "assessment", fields: ["milestone_id", "slice_id", "task_id", "scope"] },
    fields: new Set(["milestone_id", "slice_id", "task_id", "status", "scope", "full_content", "path"]),
    metadata: new Set(["authority", "legacy_verdict", "result_shape"]),
    aliases: { verdict: "status" },
  },
  decision: {
    rowSet: "decisions",
    identity: { kind: "scalar", fields: ["id"] },
    fields: new Set([
      "id", "when_context", "scope", "decision", "choice", "rationale", "revisable",
      "made_by", "source", "superseded_by",
    ]),
    metadata: new Set(["seq"]),
    aliases: {},
  },
} as const satisfies Readonly<Partial<Record<string, LegacyImportTargetAdapter>>>;

export interface LegacyImportTargetIdentity {
  identity: Readonly<Record<string, string | null>>;
  fields: ReadonlySet<string>;
}

function requireCanonicalKeyPart(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("legacy import target key contains a noncanonical part");
  }
  return value;
}

export function legacyImportTargetIdentity(
  adapter: LegacyImportTargetAdapter,
  key: string,
): LegacyImportTargetIdentity {
  if (adapter.identity.kind === "scalar") {
    return {
      identity: { [adapter.identity.fields[0]]: requireCanonicalKeyPart(key) },
      fields: new Set(adapter.identity.fields),
    };
  }
  const parts = key.split("/").map(requireCanonicalKeyPart);
  if (adapter.identity.kind === "hierarchy") {
    if (parts.length !== adapter.identity.fields.length) {
      throw new Error("legacy import hierarchy target key has the wrong depth");
    }
    return {
      identity: Object.fromEntries(adapter.identity.fields.map((field, index) => [field, parts[index]!])),
      fields: new Set(adapter.identity.fields),
    };
  }
  if (parts.length < 2 || parts.length > 4) {
    throw new Error("legacy import assessment target key has the wrong depth");
  }
  return {
    identity: {
      milestone_id: parts[0]!,
      slice_id: parts.length >= 3 ? parts[1]! : null,
      task_id: parts.length === 4 ? parts[2]! : null,
      scope: parts.at(-1)!,
    },
    fields: new Set(adapter.identity.fields),
  };
}

export const LEGACY_IMPORT_JSON_COLUMNS = new Set([
  "milestones.depends_on",
  "milestones.success_criteria",
  "milestones.key_risks",
  "milestones.proof_strategy",
  "milestones.definition_of_done",
  "slices.depends",
  "slices.target_repositories",
  "tasks.key_files",
  "tasks.key_decisions",
  "tasks.files",
  "tasks.inputs",
  "tasks.expected_output",
  "tasks.target_repositories",
]);

export const LEGACY_IMPORT_BOOLEAN_COLUMNS = new Set([
  "slices.is_sketch",
  "tasks.blocker_discovered",
  "tasks.escalation_pending",
  "tasks.escalation_awaiting_review",
]);

export const LEGACY_IMPORT_COMPLETE_TARGET_KINDS: Partial<Record<LegacyImportBaseRowSet, string>> = {
  milestones: "milestone",
  slices: "slice",
  tasks: "task",
  requirements: "requirement",
  artifacts: "artifact",
  assessments: "assessment",
  decisions: "decision",
};
