// Project/App: gsd-pi
// File Purpose: Pure hierarchy interpretation for captured legacy .gsd projections.

import { createHash } from "node:crypto";

import { compareText } from "./legacy-import-utils.js";

import type { LegacyImportValue } from "./legacy-import-contract.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
  type LegacyImportSourceLine,
} from "./legacy-import-preview-interpretation.js";

type SourceFile = LegacyImportDecodedSourceFile;
type SourceLine = LegacyImportSourceLine;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;
type HierarchyLayout = "flat" | "nested";

interface TextSpan {
  start: number;
  end: number;
}

interface HierarchyClaim {
  file: SourceFile;
  layout: HierarchyLayout;
  directory: string;
  canonicalId: string;
  sourceAlias: string;
  title: string;
  heading: SourceLine;
  status?: string;
  statusLine?: SourceLine;
  teamId: boolean;
  bareNumericAlias: boolean;
  bareNumericPath: boolean;
}

interface SliceClaim {
  id: string;
  title: string;
  status: "complete" | "pending";
  line: SourceLine;
  span: TextSpan;
  dependsOn?: readonly string[];
  risk?: string;
  sketch?: boolean;
}

interface FrontmatterField {
  value: string;
  line: SourceLine;
}

const FLAT_PREFIX = ".gsd/phases/";
const NESTED_PREFIX = ".gsd/milestones/";

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function matchSpan(line: SourceLine, match: RegExpExecArray): TextSpan {
  const prefix = line.text.slice(0, match.index);
  return {
    start: line.start + utf8Length(prefix),
    end: line.start + utf8Length(prefix + match[0]),
  };
}

function firstMatch(
  file: SourceFile,
  pattern: RegExp,
): { line: SourceLine; match: RegExpExecArray; span: TextSpan } | undefined {
  for (const line of file.lines) {
    const match = pattern.exec(line.text);
    if (match !== null) return { line, match, span: matchSpan(line, match) };
  }
  return undefined;
}

function allMatches(
  file: SourceFile,
  patterns: readonly RegExp[],
): { line: SourceLine; match: RegExpExecArray; span: TextSpan }[] {
  const found: { line: SourceLine; match: RegExpExecArray; span: TextSpan }[] = [];
  for (const line of file.lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line.text);
      if (match === null) continue;
      found.push({ line, match, span: matchSpan(line, match) });
      break;
    }
  }
  return found;
}

function frontmatterField(file: SourceFile, name: string): FrontmatterField | undefined {
  if (file.lines[0]?.text !== "---") return undefined;
  const closingIndex = file.lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (closingIndex < 0) return undefined;
  const pattern = new RegExp(`^${name}:\\s*["']?([^"']+?)["']?\\s*$`, "u");
  for (const line of file.lines.slice(1, closingIndex)) {
    const match = pattern.exec(line.text);
    if (match !== null) return { value: match[1].trim(), line };
  }
  return undefined;
}

function canonicalMilestoneId(alias: string): string | undefined {
  const numeric = /^(?:M)?(\d+)(.*)$/u.exec(alias);
  if (numeric === null) return undefined;
  const number = Number(numeric[1]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const suffix = numeric[2];
  if (suffix.length > 0 && !/^-[a-z0-9]+$/u.test(suffix)) return undefined;
  return `M${String(number).padStart(3, "0")}${suffix}`;
}

function hierarchyPath(path: string): boolean {
  return path.startsWith(FLAT_PREFIX) || path.startsWith(NESTED_PREFIX);
}

function layoutFor(path: string): HierarchyLayout | undefined {
  if (path.startsWith(FLAT_PREFIX)) return "flat";
  if (path.startsWith(NESTED_PREFIX)) return "nested";
  return undefined;
}

function roadmapPath(path: string): boolean {
  return /-ROADMAP\.md$/u.test(path);
}

function directorySegment(path: string, layout: HierarchyLayout): string {
  const prefix = layout === "flat" ? FLAT_PREFIX : NESTED_PREFIX;
  return path.slice(prefix.length).split("/")[0];
}

function claimFor(file: SourceFile): HierarchyClaim | undefined {
  const layout = layoutFor(file.entry.logical_path);
  if (layout === undefined || !roadmapPath(file.entry.logical_path) || file.encoding !== "utf-8") {
    return undefined;
  }
  const canonicalHeading = firstMatch(file, /^#\s+((?:M)?\d+(?:-[a-z0-9]+)?):\s+(.+)$/u);
  const legacyHeading = canonicalHeading === undefined
    ? firstMatch(file, /^##\s+(?:✅\s+)?(v\d+(?:\.\d+)*)\s+milestone\s+\(\s*(CLOSED)\b[^)]*\)\s*$/iu)
    : undefined;
  const heading = canonicalHeading ?? legacyHeading;
  if (heading === undefined) return undefined;
  const directory = directorySegment(file.entry.logical_path, layout);
  const sourceAlias = canonicalHeading?.match[1] ?? /^(?:M)?\d+/u.exec(directory)?.[0];
  if (sourceAlias === undefined) return undefined;
  const canonicalId = canonicalMilestoneId(sourceAlias);
  if (canonicalId === undefined) return undefined;
  const status = legacyHeading === undefined ? firstMatch(file, /^Status:\s*(\S.*?)\s*$/u) : undefined;
  return {
    file,
    layout,
    directory,
    canonicalId,
    sourceAlias,
    title: canonicalHeading?.match[2].trim() ?? `${legacyHeading!.match[1]} milestone`,
    heading: heading.line,
    status: legacyHeading === undefined ? status?.match[1].trim().toLowerCase() : "complete",
    statusLine: legacyHeading?.line ?? status?.line,
    teamId: canonicalId.includes("-"),
    bareNumericAlias: layout === "flat" && !sourceAlias.startsWith("M"),
    bareNumericPath: layout === "flat" && /^\d/u.test(directory),
  };
}

export function hasModeledLegacyGsdHierarchySource(files: readonly SourceFile[]): boolean {
  return files.some((file) => file.outcome !== "unparsed" && claimFor(file) !== undefined);
}

function addCandidate(
  candidates: PendingCandidate[],
  file: SourceFile,
  target: { kind: string; key: string; field?: string },
  normalized: LegacyImportValue,
  reasonCode: string,
  span: TextSpan,
  classification: "compare" | "preserve" = "compare",
): void {
  addLegacyImportCandidate(
    candidates,
    file,
    target,
    normalized,
    reasonCode,
    span.start,
    span.end,
    classification,
  );
}

function addDiagnosis(
  diagnoses: PendingDiagnosis[],
  file: SourceFile,
  code: string,
  message: string,
  span: TextSpan,
): void {
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    code,
    "blocker",
    message,
    "requires-user",
    span.start,
    span.end,
  );
}

function preserveHeading(
  file: SourceFile,
  candidates: PendingCandidate[],
  reasonCode: string,
  normalized: LegacyImportValue,
): void {
  file.outcome = "preserved";
  const heading = file.lines.find((line) => /^#\s+/u.test(line.text));
  const span = heading === undefined
    ? { start: 0, end: file.bytes.length }
    : { start: heading.start, end: heading.end };
  addCandidate(
    candidates,
    file,
    { kind: "artifact", key: file.entry.logical_path },
    normalized,
    reasonCode,
    span,
    "preserve",
  );
}

/**
 * Map a Milestone CONTEXT or RESEARCH file to its `artifacts` row: the row
 * that gsd_summary_save stores. The key is the path under .gsd and the content
 * is the file text. Returns false for every other file.
 */
function emitMilestoneNarrative(
  file: SourceFile,
  milestoneId: string,
  parserId: string,
  candidates: PendingCandidate[],
): boolean {
  const segments = file.entry.logical_path.split("/");
  const artifactType = segments.length === 4
    ? /^(?:\d+|M\d+(?:-[a-z0-9]+)?)-(CONTEXT|RESEARCH)\.md$/u.exec(segments[3])?.[1]
    : undefined;
  if (artifactType === undefined) return false;
  file.parserId = parserId;
  const path = segments.slice(1).join("/");
  addCandidate(candidates, file, { kind: "artifact", key: path }, {
    path,
    artifact_type: artifactType,
    milestone_id: milestoneId,
    slice_id: null,
    task_id: null,
    full_content: file.text,
    content_hash: createHash("sha256").update(file.bytes).digest("hex"),
  }, "milestone-narrative-artifact", { start: 0, end: file.bytes.length });
  return true;
}

function roadmapSlices(file: SourceFile): SliceClaim[] {
  const claims: SliceClaim[] = [];
  for (const line of file.lines) {
    const currentChecklist = /^-\s+\[([ xX])\]\s+\*\*(S\d+):\s+(.+?)\*\*\s+`risk:([^`]+)`\s+`depends:\[([^\]]*)\]`$/u.exec(line.text);
    if (currentChecklist !== null) {
      claims.push({
        id: currentChecklist[2],
        title: currentChecklist[3].trim(),
        status: currentChecklist[1].toLowerCase() === "x" ? "complete" : "pending",
        line,
        span: matchSpan(line, currentChecklist),
        dependsOn: currentChecklist[5].split(",").map((value) => value.trim()).filter(Boolean),
        risk: currentChecklist[4].trim(),
      });
      continue;
    }
    const checklist = /^-\s+\[([ xX])\]\s+(S\d+)\s+(.+?)(?:\s+\(depends on (S\d+)(?:-(S\d+))?\))?$/u.exec(line.text);
    if (checklist !== null) {
      claims.push({
        id: checklist[2],
        title: checklist[3].trim(),
        status: checklist[1].toLowerCase() === "x" ? "complete" : "pending",
        line,
        span: matchSpan(line, checklist),
        dependsOn: dependencyRange(checklist[4], checklist[5]),
      });
      continue;
    }
    const table = /^\|\s*(S\d+)\s*\|\s*([^|]+?)\s*\|\s*(yes|no)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/iu.exec(line.text);
    if (table !== null && table[1] !== "Slice") {
      claims.push({
        id: table[1],
        title: table[2].trim(),
        status: table[3].toLowerCase() === "yes" ? "complete" : "pending",
        line,
        span: matchSpan(line, table),
        dependsOn: table[4].trim().toLowerCase() === "none"
          ? []
          : table[4].split(",").map((value) => value.trim()).filter(Boolean),
        risk: table[5].trim(),
      });
      continue;
    }
    const legacyTable = /^\|\s*(S\d+|\d+(?:\.\d+)*)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/iu.exec(line.text);
    if (legacyTable !== null) {
      claims.push({
        id: legacyTable[1].toUpperCase().startsWith("S")
          ? legacyTable[1].toUpperCase()
          : `S${String(claims.length + 1).padStart(2, "0")}`,
        title: legacyTable[2].trim(),
        status: /^(?:✅\s*)?(?:complete|completed|done|closed)$/iu.test(legacyTable[3].trim())
          ? "complete"
          : "pending",
        line,
        span: matchSpan(line, legacyTable),
      });
      continue;
    }
    const prose = /^The milestone has one slice,\s*(S\d+)\s+([^,]+),.+$/u.exec(line.text);
    if (prose !== null) {
      claims.push({
        id: prose[1],
        title: prose[2].trim(),
        status: "pending",
        line,
        span: matchSpan(line, prose),
      });
      continue;
    }
    const sketch = /^Sketch:\s*(S\d+)\s+(.+?)\.\s+Tasks are intentionally undecided\.$/u.exec(line.text);
    if (sketch !== null) {
      claims.push({
        id: sketch[1],
        title: sketch[2].trim(),
        status: "pending",
        line,
        span: matchSpan(line, sketch),
        sketch: true,
      });
    }
  }
  return claims;
}

function conflictingRoadmapSlices(left: SourceFile, right: SourceFile): boolean {
  const comparable = (file: SourceFile) => roadmapSlices(file).map((slice) => ({
    id: slice.id,
    title: slice.title,
    status: slice.status,
    dependsOn: slice.dependsOn ?? [],
    risk: slice.risk ?? null,
    sketch: slice.sketch ?? false,
  }));
  const leftSlices = comparable(left);
  const rightSlices = comparable(right);
  return (leftSlices.length > 0 || rightSlices.length > 0)
    && JSON.stringify(leftSlices) !== JSON.stringify(rightSlices);
}

function dependencyRange(start?: string, end?: string): readonly string[] {
  if (start === undefined) return [];
  if (end === undefined) return [start];
  const startNumber = Number(start.slice(1));
  const endNumber = Number(end.slice(1));
  if (!Number.isSafeInteger(startNumber) || !Number.isSafeInteger(endNumber) || endNumber < startNumber) {
    return [];
  }
  const values: string[] = [];
  for (let value = startNumber; value <= endNumber; value += 1) {
    values.push(`S${String(value).padStart(2, "0")}`);
  }
  return values;
}

const SLICE_PLAN_LABEL_PATTERN = /^\*\*(Goal|Demo):\*\*\s*(.*)$/u;

interface FenceState {
  char: string;
  length: number;
}

/**
 * CommonMark fenced-code tracking: a fence opens with three or more backticks
 * or tildes indented at most three spaces and closes only with a bare line of
 * the same character at least as long as its opening delimiter at the same
 * indentation limit, so a ``` example inside a ```` block stays fenced and a
 * four-space-indented delimiter is an indented code block, not a fence.
 */
function fenceTransition(state: FenceState | undefined, text: string): FenceState | undefined {
  if (state === undefined) {
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(text);
    return opening === null ? undefined : { char: opening[1][0], length: opening[1].length };
  }
  const closing = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(text);
  if (closing !== null && closing[1][0] === state.char && closing[1].length >= state.length) return undefined;
  return state;
}

interface SlicePlanIdentity {
  heading?: { match: RegExpExecArray; line: SourceLine; span: TextSpan };
  milestone?: { value: string; line: SourceLine };
  slice?: { value: string; line: SourceLine };
  contradictory: boolean;
}

/**
 * The identity declarations of a slice PLAN — its first `# Sxx:` heading and
 * `**Milestone:**` / `**Slice:**` metadata, read outside fenced code. A file
 * that declares one of them twice with different values is contradictory and
 * may not donate content to either row.
 */
function slicePlanIdentity(file: SourceFile): SlicePlanIdentity {
  let fenced: FenceState | undefined;
  let heading: SlicePlanIdentity["heading"];
  let milestone: SlicePlanIdentity["milestone"];
  let slice: SlicePlanIdentity["slice"];
  const headings = new Set<string>();
  const milestones = new Set<string>();
  const slices = new Set<string>();
  for (const line of file.lines) {
    const outside = fenced === undefined;
    fenced = fenceTransition(fenced, line.text);
    if (fenced !== undefined || !outside) continue;
    const headingMatch = /^#\s+(S\d+):\s+(.+)$/u.exec(line.text);
    if (headingMatch !== null) {
      heading ??= { match: headingMatch, line, span: matchSpan(line, headingMatch) };
      headings.add(headingMatch[1]);
    }
    const milestoneMatch = /^\*\*Milestone:\*\*\s+(\S+)\s*$/u.exec(line.text);
    if (milestoneMatch !== null) {
      milestone ??= { value: milestoneMatch[1], line };
      milestones.add(milestoneMatch[1]);
    }
    const sliceMatch = /^\*\*Slice:\*\*\s+(S\d+)\s*$/u.exec(line.text);
    if (sliceMatch !== null) {
      slice ??= { value: sliceMatch[1], line };
      slices.add(sliceMatch[1]);
    }
  }
  return {
    ...(heading === undefined ? {} : { heading }),
    ...(milestone === undefined ? {} : { milestone }),
    ...(slice === undefined ? {} : { slice }),
    contradictory: headings.size > 1 || milestones.size > 1 || slices.size > 1,
  };
}

type SlicePlanContent = {
  goal?: string;
  demo?: string;
  success_criteria?: string;
};

/**
 * Goal and Demo render as single `**Label:** value` lines, but a stored value
 * may itself contain newlines, so the value continues over the following lines
 * until the next bold label, heading or fence; fenced lines never anchor
 * anything. A repeated label is honored only when it repeats the same value —
 * disagreeing duplicates block instead of silently overwriting. Must-Haves
 * models top-level bullets only: the renderer bullets every stored criterion
 * line, so an indented sub-bullet or prose line cannot re-render as itself and
 * is reported as unmodelable instead of imported. A heading below the
 * Must-Haves level starts an unmodelable subsection; only a peer or ancestor
 * heading ends the section.
 */
function slicePlanContent(file: SourceFile): {
  content: SlicePlanContent;
  span: TextSpan;
  unmodelable?: SourceLine;
  conflicting?: SourceLine;
} {
  const content: SlicePlanContent = {};
  let unmodelable: SourceLine | undefined;
  let conflicting: SourceLine | undefined;
  let current: "goal" | "demo" | undefined;
  let currentLabel: SourceLine | undefined;
  let value: string[] = [];
  let mustHavesLevel = 0;
  let childMustHaves = false;
  let fenced: FenceState | undefined;
  let start = 0;
  let end = 0;
  const close = (): void => {
    if (current === undefined) return;
    while (value.length > 0 && value[value.length - 1].trim() === "") value.pop();
    const text = value.join("\n").trim();
    if (text !== "") {
      if (content[current] === undefined) content[current] = text;
      else if (content[current] !== text) conflicting ??= currentLabel;
    }
    current = undefined;
    currentLabel = undefined;
    value = [];
  };
  for (const line of file.lines) {
    const outside = fenced === undefined;
    fenced = fenceTransition(fenced, line.text);
    if (fenced !== undefined || !outside) {
      if (current !== undefined) {
        value.push(line.text);
        end = line.end;
      } else if (mustHavesLevel > 0) {
        unmodelable ??= line;
      }
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(line.text);
    if (heading !== null) {
      close();
      const level = heading[1].length;
      if (mustHavesLevel > 0 && level > mustHavesLevel) {
        childMustHaves = true;
        unmodelable ??= line;
        continue;
      }
      childMustHaves = false;
      mustHavesLevel = line.text.trim() === "## Must-Haves" ? level : 0;
      continue;
    }
    if (mustHavesLevel > 0) {
      if (line.text.trim() === "") continue;
      if (childMustHaves) {
        unmodelable ??= line;
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/u.exec(line.text);
      if (bullet === null) {
        unmodelable ??= line;
        continue;
      }
      const criterion = bullet[1].trim();
      content.success_criteria = content.success_criteria === undefined
        ? criterion
        : `${content.success_criteria}\n${criterion}`;
      if (start === end) start = line.start;
      end = line.end;
      continue;
    }
    const label = SLICE_PLAN_LABEL_PATTERN.exec(line.text);
    if (label !== null) {
      close();
      current = label[1].toLowerCase() as "goal" | "demo";
      currentLabel = line;
      value = [label[2]];
      if (start === end) start = line.start;
      end = line.end;
      continue;
    }
    if (current !== undefined) {
      // Any other bold label starts a different metadata field and ends this
      // value; a <tasks> block is structure, never part of a value. Those
      // lines are not slice-plan content and stay unimported.
      if (/^\*\*[^*]+:\*\*/u.test(line.text) || /^<\/?tasks>$/u.test(line.text.trim())) close();
      else {
        value.push(line.text);
        end = line.end;
      }
    }
  }
  close();
  return {
    content,
    span: { start, end },
    ...(unmodelable === undefined ? {} : { unmodelable }),
    ...(conflicting === undefined ? {} : { conflicting }),
  };
}

/**
 * Emit the Goal, Demo and success-criteria content of a slice's own PLAN file
 * as a second candidate on the same `milestone/slice` key as its ROADMAP
 * bullet. The application plan merges non-conflicting fields into one row
 * write, so the rebuild persists the plan content instead of empty strings
 * (#2739). Hybrid layouts never reach this: their PLAN files already block as
 * `unresolved-hybrid-membership`, so nothing applies without a user decision.
 */
function emitSlicePlanContent(
  file: SourceFile,
  milestoneId: string,
  sliceId: string,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const { content, span, unmodelable, conflicting } = slicePlanContent(file);
  if (unmodelable !== undefined || conflicting !== undefined) {
    file.outcome = "unparsed";
  }
  if (unmodelable !== undefined) {
    addDiagnosis(
      diagnoses,
      file,
      "unmodelable-slice-plan-content",
      "A Must-Haves line is not a success-criteria bullet, so the slice plan content cannot be imported without losing it.",
      { start: unmodelable.start, end: unmodelable.end },
    );
  }
  if (conflicting !== undefined) {
    addDiagnosis(
      diagnoses,
      file,
      "conflicting-slice-plan-metadata",
      "Two Goal or Demo lines in one slice plan disagree, so neither value can be chosen automatically.",
      { start: conflicting.start, end: conflicting.end },
    );
  }
  if (Object.keys(content).length === 0) return;
  addCandidate(
    candidates,
    file,
    { kind: "slice", key: `${milestoneId}/${sliceId}` },
    content,
    "slice-plan-content",
    span,
  );
}

/**
 * A nested slice PLAN carries the slice's Goal, Demo and Must-Haves content.
 * Only a `-PLAN.md` file whose name, `# Sxx:` heading and `**Milestone:**` /
 * `**Slice:**` metadata all agree with the directory's slice identity
 * qualifies, so another slice's plan or a notes artifact never donates its
 * content to the wrong slice row (#2739 review). A contradictory or
 * disagreeing file keeps the existing handling of its tasks and donates no
 * content.
 */
function isSlicePlanForSlice(file: SourceFile, milestoneId: string, sliceId: string): boolean {
  const fileName = file.entry.logical_path.split("/").at(-1) ?? "";
  if (!new RegExp(`^${sliceId}(?:-[a-z0-9]+)?-PLAN\\.md$`, "u").test(fileName)) return false;
  const identity = slicePlanIdentity(file);
  if (identity.contradictory || identity.heading?.match[1] !== sliceId) return false;
  if (identity.milestone !== undefined && identity.milestone.value !== milestoneId) return false;
  return identity.slice === undefined || identity.slice.value === sliceId;
}

function emitHybridClaim(
  claim: HierarchyClaim,
  candidates: PendingCandidate[],
): void {
  const reason = claim.teamId ? "hybrid-non-overlap-team-id" : "hybrid-non-overlap";
  addCandidate(candidates, claim.file, { kind: "milestone", key: claim.canonicalId }, {
    id: claim.canonicalId,
    layout: claim.layout,
    ...(claim.status === undefined ? {} : { status: claim.status }),
    title: claim.title,
  }, reason, { start: claim.heading.start, end: claim.heading.end });
  for (const slice of roadmapSlices(claim.file)) {
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    }, reason, slice.span);
  }
}

function markClaimsUnparsed(claims: readonly HierarchyClaim[]): void {
  for (const claim of claims) claim.file.outcome = "unparsed";
}

function diagnoseHybridGroup(
  id: string,
  claims: readonly HierarchyClaim[],
  diagnoses: PendingDiagnosis[],
): void {
  const flat = claims.filter((claim) => claim.layout === "flat").sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path));
  const nested = claims.filter((claim) => claim.layout === "nested").sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path));
  markClaimsUnparsed(claims);

  if (flat.length > 1 || nested.length > 1) {
    const duplicateLayout = flat.length > 1 ? flat : nested;
    const evidence = duplicateLayout[1];
    addDiagnosis(
      diagnoses,
      evidence.file,
      "ambiguous-path",
      `Two ${evidence.layout} directories identify milestone ${id}, so neither path can become canonical.`,
      { start: evidence.heading.start, end: evidence.heading.end },
    );
    if (flat.length > 0 && nested.length > 0) {
      const nestedEvidence = nested[0];
      addDiagnosis(
        diagnoses,
        nestedEvidence.file,
        "duplicate-logical-milestone",
        `Flat and nested layouts both contain logical milestone ${id}.`,
        { start: nestedEvidence.heading.start, end: nestedEvidence.heading.end },
      );
    }
    return;
  }

  const flatClaim = flat[0];
  const nestedClaim = nested[0];
  if (flatClaim === undefined || nestedClaim === undefined) return;
  if (flatClaim.teamId || nestedClaim.teamId) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "ambiguous-team-milestone-alias",
      `Nested and flat team projections both claim ${id} with conflicting content.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
    return;
  }
  if (
    flatClaim.bareNumericPath
    && flatClaim.status === undefined
    && nestedClaim.status === undefined
  ) {
    if (conflictingRoadmapSlices(flatClaim.file, nestedClaim.file)) {
      addDiagnosis(
        diagnoses,
        flatClaim.file,
        "duplicate-logical-milestone",
        `A second hierarchy layout claims ${id}; both sources remain evidence until the user chooses the route.`,
        { start: flatClaim.heading.start, end: flatClaim.heading.end },
      );
      addDiagnosis(
        diagnoses,
        nestedClaim.file,
        "hybrid-conflicting-content",
        `The nested and flat ${id} sources name different routes, so neither is imported without a user choice.`,
        { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
      );
      return;
    }
    const pathAlias = /^\d+/u.exec(flatClaim.directory)?.[0] ?? flatClaim.sourceAlias;
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "duplicate-logical-milestone",
      `Bare numeric flat milestone ${pathAlias} collides with nested milestone ${id}.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
    return;
  }
  if (flatClaim.title !== nestedClaim.title) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "hybrid-conflicting-content",
      `Flat and nested milestone ${id} titles disagree.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
  }
  if (
    flatClaim.status !== undefined
    && nestedClaim.status !== undefined
    && flatClaim.status !== nestedClaim.status
    && nestedClaim.statusLine !== undefined
  ) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "hybrid-conflicting-status",
      `Flat and nested milestone ${id} status evidence disagrees.`,
      { start: nestedClaim.statusLine.start, end: nestedClaim.statusLine.end },
    );
  }
  if (flatClaim.title === nestedClaim.title && flatClaim.status === nestedClaim.status) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "duplicate-logical-milestone",
      `Flat and nested layouts both contain logical milestone ${id}.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
  }
}

function interpretHybrid(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding === "utf-8") file.parserId = "gsd-hybrid-hierarchy";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) {
    byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  }
  for (const [id, group] of [...byId.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (group.length === 1) {
      emitHybridClaim(group[0], candidates);
    } else {
      diagnoseHybridGroup(id, group, diagnoses);
    }
  }
  for (const file of files) {
    if (file.encoding === "utf-8" && !roadmapPath(file.entry.logical_path)) {
      file.outcome = "unparsed";
      addDiagnosis(
        diagnoses,
        file,
        "unresolved-hybrid-membership",
        "Hybrid hierarchy artifact lacks one unambiguous milestone projection.",
        { start: 0, end: file.bytes.length },
      );
    }
  }
}

function emitFlatRoadmap(
  claim: HierarchyClaim,
  candidates: PendingCandidate[],
): void {
  let reason = "flat-milestone-alias";
  let normalized: LegacyImportValue = { id: claim.canonicalId, title: claim.title };
  if (claim.bareNumericAlias) {
    reason = "flat-bare-numeric-milestone";
    normalized = {
      id: claim.canonicalId,
      source_alias: claim.sourceAlias,
      ...(claim.status === undefined ? {} : { status: claim.status }),
      title: claim.title,
    };
  } else if (claim.directory.startsWith("M")) {
    reason = "flat-descriptor-milestone";
    normalized = {
      id: claim.canonicalId,
      source_alias: claim.directory,
      ...(claim.status === undefined ? {} : { status: claim.status }),
      title: claim.title,
    };
  } else if (claim.status !== undefined) {
    normalized = { id: claim.canonicalId, status: claim.status, title: claim.title };
  }
  addCandidate(
    candidates,
    claim.file,
    { kind: "milestone", key: claim.canonicalId },
    normalized,
    reason,
    { start: claim.heading.start, end: claim.heading.end },
  );
  for (const slice of roadmapSlices(claim.file)) {
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    }, "flat-slice-checklist", slice.span);
  }
}

function expectedFlatParent(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
): { milestoneId: string; sliceIds: ReadonlySet<string>; sliceId?: string; taskId: string } | undefined {
  const relative = file.entry.logical_path.slice(FLAT_PREFIX.length);
  const [directory, fileName] = relative.split("/");
  const claim = claimsByDirectory.get(directory);
  const currentIdentity = /^S(\d+)-(T\d+)-(?:PLAN|SUMMARY)\.md$/u.exec(fileName ?? "");
  const legacyFlatIdentity = /^.+?-(\d+)-(?:PLAN|SUMMARY)\.md$/u.exec(fileName ?? "");
  const taskId = currentIdentity?.[2]
    ?? (legacyFlatIdentity === null
      ? undefined
      : `T${String(Number(legacyFlatIdentity[1])).padStart(2, "0")}`);
  if (claim === undefined || taskId === undefined) return undefined;
  const sliceIds = new Set(roadmapSlices(claim.file).map((slice) => slice.id));
  if (sliceIds.size === 0) return undefined;
  return {
    milestoneId: claim.canonicalId,
    sliceIds,
    ...(currentIdentity === null
      ? {}
      : { sliceId: `S${currentIdentity[1]}` }),
    taskId,
  };
}

function selectFlatParent(
  file: SourceFile,
  parent: {
    milestoneId: string;
    sliceIds: ReadonlySet<string>;
    sliceId?: string;
    taskId: string;
  } | undefined,
): {
  selected?: { milestoneId: string; sliceId: string; taskId: string };
  evidence?: SourceLine;
} {
  const milestone = frontmatterField(file, "milestone");
  const slice = frontmatterField(file, "slice");
  const parentSlice = frontmatterField(file, "parent");
  const task = frontmatterField(file, "task");
  const id = frontmatterField(file, "id");
  if (parent === undefined) {
    return { evidence: slice?.line ?? parentSlice?.line ?? milestone?.line ?? task?.line ?? id?.line ?? file.lines[0] };
  }
  if (milestone !== undefined && milestone.value !== parent.milestoneId) {
    return { evidence: milestone.line };
  }
  const sliceFields = [slice, parentSlice].filter((field): field is FrontmatterField => field !== undefined);
  const selectedSliceId = parent.sliceId
    ?? sliceFields[0]?.value
    ?? (parent.sliceIds.size === 1 ? [...parent.sliceIds][0] : undefined);
  const conflictingSlice = sliceFields.find((field) => (
    !parent.sliceIds.has(field.value) || (selectedSliceId !== undefined && field.value !== selectedSliceId)
  ));
  if (selectedSliceId === undefined || !parent.sliceIds.has(selectedSliceId) || conflictingSlice !== undefined) {
    return { evidence: conflictingSlice?.line ?? sliceFields[0]?.line ?? file.lines[0] };
  }
  const taskFields = [task, id].filter((field): field is FrontmatterField => field !== undefined);
  const conflictingTask = taskFields.find((field) => field.value !== parent.taskId);
  if (conflictingTask !== undefined) return { evidence: conflictingTask.line };
  return { selected: { milestoneId: parent.milestoneId, sliceId: selectedSliceId, taskId: parent.taskId } };
}

function selectFlatSlicePlanParent(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
  heading: { line: SourceLine; match: RegExpExecArray; span: TextSpan },
  identity: SlicePlanIdentity,
): {
  selected?: { milestoneId: string; sliceId: string };
  evidence?: SourceLine;
} {
  const claim = claimsByDirectory.get(directorySegment(file.entry.logical_path, "flat"));
  const fileName = file.entry.logical_path.split("/").at(-1) ?? "";
  const currentIdentity = /^S(\d+)-T\d+-PLAN\.md$/u.exec(fileName);
  const legacyIdentity = /^.+?-(\d+)-PLAN\.md$/u.exec(fileName);
  const fileSliceId = currentIdentity !== null
    ? `S${currentIdentity[1]}`
    : legacyIdentity !== null
      ? `S${String(Number(legacyIdentity[1])).padStart(2, "0")}`
      : undefined;
  const headingSliceId = heading.match[1];
  const sliceIds = claim === undefined
    ? new Set<string>()
    : new Set(roadmapSlices(claim.file).map((candidate) => candidate.id));
  if (identity.contradictory) return { evidence: heading.line };
  if (claim === undefined || fileSliceId === undefined || !sliceIds.has(headingSliceId)) {
    return { evidence: heading.line };
  }
  if (fileSliceId !== headingSliceId) return { evidence: heading.line };
  if (identity.milestone !== undefined && identity.milestone.value !== claim.canonicalId) {
    return { evidence: identity.milestone.line };
  }
  if (identity.slice !== undefined && identity.slice.value !== headingSliceId) {
    return { evidence: identity.slice.line };
  }
  return { selected: { milestoneId: claim.canonicalId, sliceId: headingSliceId } };
}

function interpretFlatArtifact(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const path = file.entry.logical_path;
  if (roadmapPath(path) || file.encoding !== "utf-8") return;
  if (/-PLAN\.md$/u.test(path)) {
    // Fence-aware identity: a fenced `# S01:` example is not the plan heading.
    const identity = slicePlanIdentity(file);
    const sliceHeading = identity.heading;
    if (sliceHeading !== undefined) {
      const parent = selectFlatSlicePlanParent(file, claimsByDirectory, sliceHeading, identity);
      if (parent.selected === undefined) {
        file.outcome = "unparsed";
        const evidence = parent.evidence ?? sliceHeading.line;
        addDiagnosis(
          diagnoses,
          file,
          "task-plan-parent-conflict",
          "Task plan parent metadata conflicts with its containing phase and cannot select a task.",
          { start: evidence.start, end: evidence.end },
        );
        return;
      }
      emitSlicePlanContent(
        file,
        parent.selected.milestoneId,
        parent.selected.sliceId,
        candidates,
        diagnoses,
      );
      nestedTaskCandidates(
        file,
        parent.selected.milestoneId,
        parent.selected.sliceId,
        candidates,
        diagnoses,
        "flat-checkbox-task",
      );
      return;
    }
    const parent = selectFlatParent(file, expectedFlatParent(file, claimsByDirectory));
    const heading = firstMatch(file, /^#\s+(T\d+):\s+(.+)$/u);
    if (parent.selected === undefined || heading === undefined || heading.match[1] !== parent.selected.taskId) {
      file.outcome = "unparsed";
      const evidence = parent.evidence ?? heading?.line ?? file.lines[0];
      addDiagnosis(
        diagnoses,
        file,
        "task-plan-parent-conflict",
        "Task plan parent metadata conflicts with its containing phase and cannot select a task.",
        { start: evidence.start, end: evidence.end },
      );
      return;
    }
    addCandidate(candidates, file, {
      kind: "task",
      key: `${parent.selected.milestoneId}/${parent.selected.sliceId}/${parent.selected.taskId}`,
    }, {
      id: parent.selected.taskId,
      milestone_id: parent.selected.milestoneId,
      slice_id: parent.selected.sliceId,
      status: "pending",
      title: heading.match[2].trim(),
    }, "flat-task-frontmatter-parent", heading.span);
    return;
  }
  if (/-SUMMARY\.md$/u.test(path)) {
    const summaryId = frontmatterField(file, "id")?.value;
    const summarySlice = frontmatterField(file, "slice")?.value;
    const summaryTask = frontmatterField(file, "task")?.value;
    if (summaryId !== undefined && summaryTask === undefined && /^M\d+/u.test(summaryId)) {
      const claim = claimsByDirectory.get(directorySegment(file.entry.logical_path, "flat"));
      const canonicalId = canonicalMilestoneId(summaryId);
      const status = frontmatterField(file, "status");
      if (claim !== undefined && canonicalId === claim.canonicalId && status !== undefined) {
        addCandidate(
          candidates,
          file,
          { kind: "milestone", key: claim.canonicalId, field: "status" },
          status.value,
          "flat-matching-milestone-summary-attestation",
          { start: status.line.start, end: status.line.end },
        );
      }
      else if (claim !== undefined && canonicalId !== undefined && canonicalId !== claim.canonicalId && status !== undefined) {
        addDiagnosis(
          diagnoses,
          file,
          "milestone-summary-id-ambiguous",
          `Milestone summary id "${summaryId}" does not exactly match the containing phase's ROADMAP claim "${claim.canonicalId}" and cannot be attested automatically.`,
          { start: status.line.start, end: status.line.end },
        );
      }
      preserveHeading(file, candidates, "flat-non-task-summary-preserved", {
        reason: "non-task-summary",
        id: summaryId,
      });
      return;
    }
    if (summaryId !== undefined && summaryTask === undefined && /^S\d+/u.test(summaryId)) {
      preserveHeading(file, candidates, "flat-non-task-summary-preserved", {
        reason: "non-task-summary",
        id: summaryId,
      });
      return;
    }
    if (summaryId === undefined && summaryTask === undefined && summarySlice !== undefined && /^S\d+$/u.test(summarySlice)) {
      preserveHeading(file, candidates, "flat-non-task-summary-preserved", {
        reason: "non-task-summary",
        id: summarySlice,
      });
      return;
    }
    const parent = selectFlatParent(file, expectedFlatParent(file, claimsByDirectory));
    const status = frontmatterField(file, "status");
    if (parent.selected === undefined) {
      file.outcome = "unparsed";
      const evidence = parent.evidence ?? file.lines[0];
      addDiagnosis(
        diagnoses,
        file,
        "task-summary-parent-conflict",
        "Summary parent metadata conflicts with its containing phase and cannot select a task.",
        { start: evidence.start, end: evidence.end },
      );
      return;
    }
    const evidence = status?.line ?? frontmatterField(file, "id")?.line ?? file.lines[0];
    addCandidate(candidates, file, {
      kind: "task",
      key: `${parent.selected.milestoneId}/${parent.selected.sliceId}/${parent.selected.taskId}`,
      field: "status",
    }, status?.value ?? "complete", "flat-matching-summary-attestation", {
      start: evidence.start,
      end: evidence.end,
    });
    return;
  }
  const claim = claimsByDirectory.get(directorySegment(path, "flat"));
  if (claim !== undefined && emitMilestoneNarrative(file, claim.canonicalId, "gsd-flat-hierarchy", candidates)) return;
  preserveHeading(
    file,
    candidates,
    "flat-unknown-artifact-preserved",
    { reason: "unknown-phase-suffix" },
  );
}

function interpretFlat(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding !== "utf-8") continue;
    file.parserId = roadmapPath(file.entry.logical_path) || /-(?:PLAN|SUMMARY)\.md$/u.test(file.entry.logical_path)
      ? "gsd-flat-hierarchy"
      : "gsd-artifact-classifier";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  const validClaims: HierarchyClaim[] = [];
  for (const [id, group] of byId) {
    if (group.length === 1) {
      validClaims.push(group[0]);
      continue;
    }
    markClaimsUnparsed(group);
    const evidence = [...group].sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path))[1];
    addDiagnosis(
      diagnoses,
      evidence.file,
      "ambiguous-path",
      `Two flat directories identify milestone ${id}, so neither path can become canonical.`,
      { start: evidence.heading.start, end: evidence.heading.end },
    );
  }
  const claimsByDirectory = new Map(validClaims.map((claim) => [claim.directory, claim]));
  for (const claim of validClaims) emitFlatRoadmap(claim, candidates);
  for (const file of files) interpretFlatArtifact(file, claimsByDirectory, candidates, diagnoses);
}

const TASK_SECTION_FIELDS = {
  "inputs": "inputs",
  "expected output": "expected_output",
  "verification": "verify",
  "verify": "verify",
} as const;

type TaskSectionField = (typeof TASK_SECTION_FIELDS)[keyof typeof TASK_SECTION_FIELDS];

/**
 * Detail (verify/inputs/expected_output) from the task's own `### Txx:`
 * section in the same plan file. Checkbox task lines only carry status and
 * title; the per-task section is where plans state Inputs, Expected Output,
 * and Verification bullets. Missing section or bullets → the field is
 * omitted, leaving the canonical column at its empty default.
 */
/**
 * A Verification bullet is prose around a command: `- Verify: \`node --test\` exits 0.`
 * Only the code span is runnable; the label and trailing prose are not (#1981).
 * Without a code span the whole bullet (minus a leading label) is the command.
 */
function verifyCommandFromBullet(text: string): string {
  const span = /`([^`]+)`/u.exec(text);
  if (span !== null) return span[1]!.trim();
  return text.replace(/^(?:verification|verify):\s*/iu, "").trim();
}

function taskSectionDetail(
  file: SourceFile,
  taskId: string,
): { verify?: string; inputs?: string[]; expected_output?: string[] } {
  const headingPattern = new RegExp(`^###\\s+${taskId}\\b`, "u");
  const start = file.lines.findIndex((line) => headingPattern.test(line.text));
  if (start < 0) return {};
  const buckets: Record<TaskSectionField, string[]> = { verify: [], inputs: [], expected_output: [] };
  let current: TaskSectionField | undefined;
  for (const line of file.lines.slice(start + 1)) {
    if (/^#{1,3}\s/u.test(line.text)) break;
    const text = line.text.trim();
    if (text === "") continue;
    const label = /^(inputs|expected output|verification|verify):$/iu.exec(text);
    if (label !== null) {
      current = TASK_SECTION_FIELDS[label[1].toLowerCase() as keyof typeof TASK_SECTION_FIELDS];
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/u.exec(text);
    if (bullet === null || current === undefined) {
      current = undefined;
      continue;
    }
    buckets[current].push(
      current === "verify" ? verifyCommandFromBullet(bullet[1]) : bullet[1].replaceAll("`", "").trim(),
    );
  }
  return {
    ...(buckets.verify.length > 0 ? { verify: buckets.verify.join("\n") } : {}),
    ...(buckets.inputs.length > 0 ? { inputs: buckets.inputs } : {}),
    ...(buckets.expected_output.length > 0 ? { expected_output: buckets.expected_output } : {}),
  };
}

function nestedTaskCandidates(
  file: SourceFile,
  milestoneId: string,
  sliceId: string,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  checkboxReason = "nested-checkbox-task",
): void {
  const checkboxes = allMatches(file, [
    /^-\s+\[([ xX])\]\s+\*\*(T\d+)\*\*:\s+(.+?)(?:\s+_\([^)]+\)_)?$/u,
    /^-\s+\[([ xX])\]\s+\*\*(T\d+):\s+(.+?)\*\*(?:\s+`est:[^`]+`)?$/u,
    /^-\s+\[([ xX])\]\s+(T\d+)\s+(.+)$/u,
  ]);
  const checkbox = checkboxes[0];
  const heading = firstMatch(file, /^##\s+(T\d+)\s+(.+)$/u);
  const xml = firstMatch(file, /<task\s+id="(T\d+)"\s+status="([^"]+)">([^<]+)<\/task>/u);
  const h1 = firstMatch(file, /^#\s+(T\d+):\s+(.+)$/u);
  const grammars = [checkbox, heading, xml, h1].filter((value) => value !== undefined);
  if (grammars.length !== 1) {
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses,
      file,
      "ambiguous-task-membership",
      "Task projection lacks one unambiguous hierarchy grammar.",
      { start: 0, end: file.bytes.length },
    );
    return;
  }
  if (checkbox !== undefined) {
    // Every checkbox task line in the plan is its own task claim, in file order.
    const matched = new Set(checkboxes.map((entry) => entry.line));
    for (const line of file.lines) {
      if (matched.has(line) || !/^-\s+\[[ xX]\]\s+\**T\d+/u.test(line.text)) continue;
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "unmapped-checkbox-task",
        "warning",
        "Checkbox task line matches no supported task grammar and produced no task claim.",
        "unsupported",
        line.start,
        line.end,
      );
    }
    for (const entry of checkboxes) {
      addCandidate(candidates, file, {
        kind: "task",
        key: `${milestoneId}/${sliceId}/${entry.match[2]}`,
      }, {
        id: entry.match[2],
        milestone_id: milestoneId,
        slice_id: sliceId,
        status: entry.match[1].toLowerCase() === "x" ? "complete" : "pending",
        title: entry.match[3].trim(),
        ...taskSectionDetail(file, entry.match[2]),
      }, checkboxReason, entry.span);
    }
    return;
  }
  const path = file.entry.logical_path;
  let taskId: string;
  let title: string;
  let status: "complete" | "pending";
  let reason: string;
  let span: TextSpan;
  if (heading !== undefined) {
    taskId = heading.match[1];
    title = heading.match[2].trim();
    status = firstMatch(file, /^Status:\s*complete\s*$/iu) === undefined ? "pending" : "complete";
    reason = "nested-heading-task";
    span = heading.span;
  } else if (xml !== undefined) {
    taskId = xml.match[1];
    title = xml.match[3].trim();
    status = xml.match[2].toLowerCase() === "complete" ? "complete" : "pending";
    reason = "nested-xml-task";
    span = xml.span;
  } else {
    taskId = h1!.match[1];
    title = h1!.match[2].trim();
    status = firstMatch(file, /^Status:\s*complete\s*$/iu) === undefined ? "pending" : "complete";
    reason = path.includes("/tasks/") ? "nested-task-subdirectory" : "nested-flat-task-within-slice";
    span = h1!.span;
  }
  addCandidate(candidates, file, {
    kind: "task",
    key: `${milestoneId}/${sliceId}/${taskId}`,
  }, {
    id: taskId,
    milestone_id: milestoneId,
    slice_id: sliceId,
    status,
    title,
  }, reason, span);
}

function nestedPlanParent(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
): { milestoneId: string; sliceId: string } | undefined {
  const match = /^\.gsd\/milestones\/([^/]+)\/slices\/(S\d+)(?:-[^/]+)?\//u.exec(file.entry.logical_path);
  if (match === null) return undefined;
  const milestoneId = claimsByDirectory.get(match[1])?.canonicalId;
  return milestoneId === undefined ? undefined : { milestoneId, sliceId: match[2] };
}

function emitNestedRoadmap(claim: HierarchyClaim, candidates: PendingCandidate[]): Set<string> {
  addCandidate(candidates, claim.file, { kind: "milestone", key: claim.canonicalId }, {
    id: claim.canonicalId,
    ...(claim.status === undefined ? {} : { status: claim.status }),
    title: claim.title,
  }, "nested-milestone-heading", { start: claim.heading.start, end: claim.heading.end });
  const slices = roadmapSlices(claim.file);
  for (const slice of slices) {
    let reason = "nested-roadmap-checklist";
    if (slice.risk !== undefined) reason = "nested-roadmap-table";
    else if (slice.sketch === true) reason = "nested-sketch-placeholder";
    else if (slice.line.text.startsWith("The milestone")) reason = "nested-roadmap-prose";
    else if ((slice.dependsOn?.length ?? 0) > 1) reason = "nested-roadmap-dependency-range";
    const normalized: Record<string, LegacyImportValue> = {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    };
    if (reason === "nested-roadmap-checklist" || reason === "nested-roadmap-dependency-range" || reason === "nested-roadmap-table") {
      normalized.depends_on = slice.dependsOn ?? [];
    }
    if (slice.risk !== undefined) normalized.risk = slice.risk;
    if (slice.sketch === true) {
      normalized.sketch = true;
      normalized.tasks = [];
    }
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, normalized, reason, slice.span);
  }
  return new Set(slices.map((slice) => slice.id));
}

function interpretNested(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding === "utf-8") file.parserId = "gsd-nested-hierarchy";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  const memberships = new Map<string, Set<string>>();
  const claimsByDirectory = new Map<string, HierarchyClaim>();
  for (const [id, group] of byId) {
    if (group.length !== 1) {
      markClaimsUnparsed(group);
      const evidence = [...group].sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path))[1];
      addDiagnosis(
        diagnoses,
        evidence.file,
        "ambiguous-path",
        `Two nested directories identify milestone ${id}, so neither path can become canonical.`,
        { start: evidence.heading.start, end: evidence.heading.end },
      );
      continue;
    }
    claimsByDirectory.set(group[0].directory, group[0]);
    memberships.set(id, emitNestedRoadmap(group[0], candidates));
  }
  for (const file of files) {
    if (roadmapPath(file.entry.logical_path) || file.encoding !== "utf-8") continue;
    const parent = nestedPlanParent(file, claimsByDirectory);
    if (parent !== undefined && memberships.get(parent.milestoneId)?.has(parent.sliceId)) {
      if (isSlicePlanForSlice(file, parent.milestoneId, parent.sliceId)) {
        emitSlicePlanContent(file, parent.milestoneId, parent.sliceId, candidates, diagnoses);
      }
      nestedTaskCandidates(file, parent.milestoneId, parent.sliceId, candidates, diagnoses);
      continue;
    }
    const milestoneDirectory = directorySegment(file.entry.logical_path, "nested");
    if (!claimsByDirectory.has(milestoneDirectory)) {
      preserveHeading(
        file,
        candidates,
        "nested-ghost-preserved",
        { reason: "ghost-milestone-without-roadmap" },
      );
      continue;
    }
    if (!file.entry.logical_path.includes("/slices/")) {
      const milestoneId = claimsByDirectory.get(milestoneDirectory)!.canonicalId;
      if (emitMilestoneNarrative(file, milestoneId, "gsd-nested-hierarchy", candidates)) continue;
      preserveHeading(
        file,
        candidates,
        "nested-milestone-artifact-preserved",
        { milestone_id: milestoneId },
      );
      continue;
    }
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses,
      file,
      "unresolved-nested-membership",
      "Nested hierarchy artifact lacks one unambiguous milestone and slice membership.",
      { start: 0, end: file.bytes.length },
    );
  }
}

/**
 * Interpret hierarchy files already decoded from the immutable source capture.
 * Returns every claimed hierarchy path so the caller can route remaining .gsd
 * registry and truth sources to their own processors.
 */
export function interpretLegacyGsdHierarchyFiles(
  decodedFiles: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): ReadonlySet<string> {
  const files = decodedFiles.filter((file) => hierarchyPath(file.entry.logical_path));
  if (files.length === 0) return new Set();
  const handled = new Set(files.map((file) => file.entry.logical_path));
  const claims = files.flatMap((file) => claimFor(file) ?? []);
  const claimedSources = new Set(claims.map((claim) => claim.file.entry.source_id));
  for (const file of files) {
    if (
      file.encoding === "utf-8"
      && roadmapPath(file.entry.logical_path)
      && !claimedSources.has(file.entry.source_id)
    ) {
      file.outcome = "unparsed";
      const evidence = file.lines.find((line) => line.text.trim().length > 0);
      addDiagnosis(
        diagnoses,
        file,
        "malformed-roadmap",
        "A recognized roadmap lacks a canonical milestone heading and cannot establish hierarchy truth.",
        { start: evidence?.start ?? 0, end: evidence?.end ?? file.bytes.length },
      );
    }
  }
  const layouts = new Set(files.flatMap((file) => {
    if (file.encoding !== "utf-8") return [];
    const layout = layoutFor(file.entry.logical_path);
    return layout === undefined ? [] : [layout];
  }));

  if (layouts.size > 1) interpretHybrid(files, claims, candidates, diagnoses);
  else if (layouts.has("flat")) interpretFlat(files, claims, candidates, diagnoses);
  else interpretNested(files, claims, candidates, diagnoses);

  return handled;
}
