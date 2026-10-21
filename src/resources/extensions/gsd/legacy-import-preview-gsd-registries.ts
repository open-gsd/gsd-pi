// Project/App: gsd-pi
// File Purpose: Pure retained-byte interpreters for legacy decision and requirement registries.

import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";

const DECISIONS_SUFFIX = "/.gsd/decisions.md";
const REQUIREMENTS_SUFFIX = "/.gsd/requirements.md";

interface Cell {
  value: string;
  start: number;
  end: number;
}

interface DecisionRow {
  lineStart: number;
  lineEnd: number;
  cells: readonly Cell[];
}

interface RequirementSection {
  start: number;
  end: number;
  heading: string;
  id: Cell;
  description: string;
  format: "canonical" | "colon-heading";
  category: string;
  fields: ReadonlyMap<string, Cell>;
  usedUnderscoreAlias: boolean;
}

function registryKind(path: string): "decisions" | "requirements" | undefined {
  const normalized = `/${path.toLowerCase().replace(/^\/+/, "")}`;
  if (normalized.endsWith(DECISIONS_SUFFIX)) return "decisions";
  if (normalized.endsWith(REQUIREMENTS_SUFFIX)) return "requirements";
  return undefined;
}

function byteOffset(text: string, characterOffset: number): number {
  return Buffer.byteLength(text.slice(0, characterOffset), "utf8");
}

function tableCells(text: string, lineStart: number): Cell[] {
  const pipes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") pipes.push(index);
  }
  const cells: Cell[] = [];
  for (let index = 0; index + 1 < pipes.length; index += 1) {
    const from = pipes[index] + 1;
    const to = pipes[index + 1];
    const value = text.slice(from, to);
    const leading = value.length - value.trimStart().length;
    const trailing = value.length - value.trimEnd().length;
    const startCharacter = from + leading;
    const endCharacter = Math.max(startCharacter, to - trailing);
    cells.push({
      value: value.trim(),
      start: lineStart + byteOffset(text, startCharacter),
      end: lineStart + byteOffset(text, endCharacter),
    });
  }
  return cells;
}

function amendsId(decision: string): string | undefined {
  return decision.match(/\(amends\s+(D\d+)\)/i)?.[1]?.toUpperCase();
}

function decisionValue(row: DecisionRow, madeBy: "agent" | "human", supersededBy: string | null) {
  const [id, whenContext, scope, decision, choice, rationale, revisable] = row.cells;
  return {
    id: id.value,
    when_context: whenContext.value,
    scope: scope.value,
    decision: decision.value,
    choice: choice.value,
    rationale: rationale.value,
    revisable: revisable.value,
    made_by: madeBy,
    superseded_by: supersededBy,
  };
}

function interpretDecisions(
  file: LegacyImportDecodedSourceFile,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  file.parserId = "gsd-decisions-table";
  file.parserVersion = "1";
  file.kind = "markdown";
  const rows: DecisionRow[] = [];
  let lastTableEnd = 0;
  let format: "canonical" | "scope-first" = "canonical";

  for (const line of file.lines) {
    if (!line.text.trimStart().startsWith("|")) continue;
    lastTableEnd = Math.max(lastTableEnd, line.end);
    const cells = tableCells(line.text, line.start);
    if (cells[0]?.value.toLowerCase() === "id" && cells[1]?.value.toLowerCase() === "scope") {
      format = "scope-first";
      continue;
    }
    if (cells.length < 7 || cells[0].value === "#" || /^-+$/.test(cells[0].value)) continue;
    rows.push({ lineStart: line.start, lineEnd: line.end, cells });
  }

  const validRows = rows.filter((row) => /^D\d+$/.test(row.cells[0].value));
  const counts = new Map<string, number>();
  for (const row of validRows) {
    const id = row.cells[0].value;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const supersededBy = new Map<string, string>();
  for (const row of validRows) {
    if (format === "scope-first") continue;
    const author = row.cells[7]?.value || "agent";
    if ((author === "agent" || author === "human") && counts.get(row.cells[0].value) === 1) {
      const amended = amendsId(row.cells[3].value);
      if (amended !== undefined) supersededBy.set(amended, row.cells[0].value);
    }
  }

  for (const row of rows) {
    const id = row.cells[0];
    if (!/^D\d+$/.test(id.value)) {
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "invalid-decision-id",
        "blocker",
        "A decision identifier that only begins with a canonical ID is invalid and must not be inferred.",
        "requires-user",
        id.start,
        id.end,
      );
      continue;
    }
    if ((counts.get(id.value) ?? 0) > 1) {
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "duplicate-decision-id",
        "blocker",
        "A duplicate decision identifier has conflicting content and cannot be merged safely.",
        "requires-user",
        id.start,
        id.end,
      );
      continue;
    }
    if (format === "scope-first") {
      const author = row.cells[6].value;
      if (author !== "agent" && author !== "human" && author !== "user") {
        addLegacyImportDiagnosis(
          diagnoses,
          file,
          "invalid-made-by",
          "warning",
          "An unsupported decision author value is explicitly coerced to the legacy agent default.",
          "requires-user",
          row.cells[6].start,
          row.cells[6].end,
        );
        continue;
      }
      addLegacyImportCandidate(
        candidates,
        file,
        { kind: "decision", key: id.value },
        {
          id: id.value,
          scope: row.cells[1].value,
          decision: row.cells[2].value,
          choice: row.cells[3].value,
          rationale: row.cells[4].value,
          revisable: row.cells[5].value,
          made_by: author,
        },
        "scope-first-decision-row",
        row.lineStart,
        row.lineEnd,
      );
      continue;
    }
    const authorCell = row.cells[7];
    const author = authorCell?.value || "agent";
    if (author !== "agent" && author !== "human") {
      const amended = amendsId(row.cells[3].value);
      addLegacyImportCandidate(
        candidates,
        file,
        { kind: "legacy-decision-row", key: id.value },
        {
          id: id.value,
          when_context: row.cells[1].value,
          scope: row.cells[2].value,
          decision: row.cells[3].value,
          choice: row.cells[4].value,
          rationale: row.cells[5].value,
          revisable: row.cells[6].value,
          ...(amended === undefined ? {} : { amends: amended }),
          unresolved_field: "made_by",
        },
        "invalid-made-by-preserved",
        row.lineStart,
        row.lineEnd,
        "preserve",
      );
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "invalid-made-by",
        "warning",
        "An unsupported decision author value is explicitly coerced to the legacy agent default.",
        "requires-user",
        authorCell.start,
        authorCell.end,
      );
      continue;
    }
    addLegacyImportCandidate(
      candidates,
      file,
      { kind: "decision", key: id.value },
      decisionValue(row, author, supersededBy.get(id.value) ?? null),
      row.cells.length === 7 ? "canonical-seven-column-decision" : "canonical-eight-column-decision",
      row.lineStart,
      row.lineEnd,
    );
  }

  const freeformStart = file.lines.find((line) => line.start > lastTableEnd && line.text.trim() !== "")?.start;
  if (freeformStart === undefined) return;
  const trailing = file.bytes.subarray(freeformStart).toString("utf8");
  const content = trailing.trimEnd();
  const end = freeformStart + Buffer.byteLength(content, "utf8");
  const target = { kind: "legacy-decision-fragment", key: `${file.entry.logical_path}#freeform` };
  addLegacyImportCandidate(
    candidates,
    file,
    target,
    { path: file.entry.logical_path, fragment: "freeform", preservation: "verbatim" },
    "freeform-decision-content-preserved",
    freeformStart,
    end,
    "preserve",
  );
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    "freeform-decision-content",
    "warning",
    "Freeform decision prose is preserved verbatim because the table parser cannot model it.",
    "preserved",
    freeformStart,
    end,
    target,
  );
}

function normalizedFieldName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
  switch (normalized) {
    case "class": return "class";
    case "status": return "status";
    case "description": return "description";
    case "why it matters": return "why";
    case "source": return "source";
    case "primary owner":
    case "primary owning slice": return "primary_owner";
    case "supporting slices": return "supporting_slices";
    case "validation":
    case "validated by": return "validation";
    case "notes":
    case "proof": return "notes";
    default: return undefined;
  }
}

function categoryStatus(heading: string): string | undefined {
  switch (heading.trim().toLowerCase()) {
    case "active": return "active";
    case "validated": return "validated";
    case "deferred": return "deferred";
    case "out of scope": return "out-of-scope";
    default: return undefined;
  }
}

function requirementSections(file: LegacyImportDecodedSourceFile): RequirementSection[] {
  const headings = file.lines.flatMap((line) => {
    const match = line.text.match(/^###\s+(\S+)\s*([:—-])\s*(.*)$/);
    if (match === null || match.index === undefined) return [];
    const idCharacter = line.text.indexOf(match[1], match.index);
    const format = match[2] === ":" ? "colon-heading" as const : "canonical" as const;
    return [{
      line,
      description: match[3].trim(),
      format,
      id: {
        value: match[1],
        start: line.start + byteOffset(line.text, idCharacter),
        end: line.start + byteOffset(line.text, idCharacter + match[1].length),
      },
    }];
  });
  return headings.map(({ line, id, description, format }, index) => {
    const boundary = headings[index + 1]?.line.start ?? file.bytes.length;
    let category = "";
    for (const candidate of file.lines) {
      if (candidate.start >= line.start) break;
      const match = candidate.text.match(/^##\s+(.+?)\s*$/);
      if (match !== null) category = match[1];
    }
    const fields = new Map<string, Cell>();
    let usedUnderscoreAlias = false;
    let end = line.end;
    for (const candidate of file.lines) {
      if (candidate.start <= line.start || candidate.start >= boundary) continue;
      if (/^##\s+/.test(candidate.text)) break;
      if (candidate.text.trim() !== "") {
        end = candidate.end;
        if (file.bytes[end] === 13) end += 1;
        if (file.bytes[end] === 10) end += 1;
      }
      const match = candidate.text.match(/^-\s+([^:]+):\s*(.*)$/);
      if (match === null) continue;
      const name = normalizedFieldName(match[1]);
      if (name === undefined) continue;
      usedUnderscoreAlias ||= match[1].includes("_");
      const valueCharacter = candidate.text.length - match[2].length;
      fields.set(name, {
        value: match[2].trim(),
        start: candidate.start + byteOffset(candidate.text, valueCharacter),
        end: candidate.start + byteOffset(candidate.text, candidate.text.length),
      });
    }
    return {
      start: line.start,
      end,
      heading: line.text,
      id,
      description,
      format,
      category,
      fields,
      usedUnderscoreAlias,
    };
  });
}

function requirementReason(section: RequirementSection): string {
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(section.id.value)) return "categorical-requirement-id";
  if (categoryStatus(section.category) === "out-of-scope") return "canonical-out-of-scope-requirement";
  if (section.usedUnderscoreAlias) return "requirement-field-aliases-normalized";
  return "canonical-active-requirement";
}

function interpretRequirements(
  file: LegacyImportDecodedSourceFile,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  file.parserId = "gsd-requirements-sections";
  file.parserVersion = "1";
  file.kind = "markdown";
  const sections = requirementSections(file);
  const counts = new Map<string, number>();
  const duplicateEvidence = new Map<string, RequirementSection>();
  for (const section of sections) {
    const id = section.id.value;
    if (!/^R\d+$/.test(id) && !/^[A-Z][A-Z0-9]*-\d+$/.test(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    duplicateEvidence.set(id, section);
  }

  for (const section of sections) {
    const id = section.id.value;
    if (!/^R\d+$/.test(id) && !/^[A-Z][A-Z0-9]*-\d+$/.test(id)) {
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "invalid-requirement-id",
        "blocker",
        "A malformed requirement identifier cannot be normalized without user intent.",
        "requires-user",
        section.id.start,
        section.id.end,
      );
      continue;
    }
    if ((counts.get(id) ?? 0) > 1) {
      if (duplicateEvidence.get(id) === section) {
        const headingEnd = section.start + Buffer.byteLength(section.heading, "utf8");
        addLegacyImportDiagnosis(
          diagnoses,
          file,
          "duplicate-requirement-id",
          "blocker",
          "A duplicate requirement identifier has conflicting content and cannot be merged safely.",
          "requires-user",
          section.start,
          headingEnd,
        );
      }
      continue;
    }
    const expectedStatus = categoryStatus(section.category);
    const status = section.fields.get("status");
    if (section.format === "colon-heading" && expectedStatus !== undefined) {
      addLegacyImportCandidate(
        candidates,
        file,
        { kind: "requirement", key: id },
        {
          id,
          description: section.description,
          primary_owner: section.fields.get("primary_owner")?.value ?? "",
          status: expectedStatus,
        },
        "colon-heading-requirement",
        section.start,
        section.start + Buffer.byteLength(section.heading, "utf8"),
      );
      continue;
    }
    if (expectedStatus === undefined || status === undefined || status.value !== expectedStatus) {
      const start = status?.start ?? section.start;
      const end = status?.end ?? (section.start + Buffer.byteLength(section.heading, "utf8"));
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "requirement-status-conflict",
        "blocker",
        "The requirement section and status bullet disagree, so no canonical status is inferred.",
        "requires-user",
        start,
        end,
      );
      continue;
    }
    const value = (field: string) => section.fields.get(field)?.value ?? "";
    addLegacyImportCandidate(
      candidates,
      file,
      { kind: "requirement", key: id },
      {
        id,
        class: value("class"),
        status: status.value,
        description: value("description"),
        why: value("why"),
        source: value("source"),
        primary_owner: value("primary_owner"),
        supporting_slices: value("supporting_slices"),
        validation: value("validation"),
        notes: value("notes"),
      },
      requirementReason(section),
      section.start,
      section.end,
    );
  }
}

export function interpretLegacyGsdRegistries(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  for (const file of files) {
    const kind = registryKind(file.entry.logical_path);
    if (kind === undefined || file.encoding !== "utf-8") continue;
    if (kind === "decisions") interpretDecisions(file, candidates, diagnoses);
    else interpretRequirements(file, candidates, diagnoses);
  }
}
