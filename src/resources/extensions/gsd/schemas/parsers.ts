// gsd-pi / Deep planning mode — Markdown → structured object parsers for artifact validation.
//
// Each parser converts a markdown artifact into a typed object suitable for
// JSON Schema validation. The parsers are intentionally minimal — they only
// extract the structure the validators care about, not full semantic content.
//
// This module is the home of the shared hierarchy markdown parsers
// (parseProjectionRoadmap / parseProjectionPlan), relocated from the deleted
// parsers-legacy.ts shim (T012/T020).

import { extractSection, parseBullets, extractBoldField, extractAllSections, registerCacheClearCallback } from '../files.js';
import { splitFrontmatter } from '../../shared/frontmatter.js';
import { nativeParseRoadmap, nativeParsePlanFile } from '../native-parser-bridge.js';
import { debugTime, debugCount } from '../debug-logger.js';
import { CACHE_MAX } from '../constants.js';
import { parseRoadmapSlices } from '../roadmap-slices.js';

import type {
  Roadmap, BoundaryMapEntry,
  SlicePlan, TaskPlanEntry,
} from '../types.js';

export interface ParsedProject {
  sections: Record<string, string>;
  /** Names of H2 sections in the order they appear */
  sectionOrder: string[];
  milestones: Array<{ id: string; title: string; oneLiner: string; done: boolean }>;
  /** True if any section body contains an unsubstituted {{...}} template token */
  hasTemplateTokens: boolean;
  /** Section names whose bodies contain template tokens */
  sectionsWithTokens: string[];
}

export interface ParsedRequirement {
  id: string;
  title: string;
  class: string;
  status: string;
  description: string;
  whyItMatters: string;
  source: string;
  primaryOwner: string;
  supportingSlices: string;
  validation: string;
  notes: string;
  /** The H2 section this entry was found under */
  parentSection: string;
}

export interface ParsedRequirements {
  sections: Record<string, string>;
  sectionOrder: string[];
  requirements: ParsedRequirement[];
  /** Parsed traceability table rows */
  traceabilityRows: Array<Record<string, string>>;
  /** Parsed coverage summary key/value lines */
  coverageSummary: Record<string, string>;
  hasTemplateTokens: boolean;
}

export interface ParsedRoadmapSlice {
  id: string;
  title: string;
  risk: string;
  depends: string[];
  demo: string;
}

export interface ParsedRoadmap {
  sections: Record<string, string>;
  sectionOrder: string[];
  slices: ParsedRoadmapSlice[];
  definitionOfDone: string[];
  hasTemplateTokens: boolean;
  /**
   * Tokens in a slice's "Depends" field that did not match S\d{2}. Surfaced
   * by the validator as a "malformed-depends" warning so the user sees the
   * typo instead of having it silently dropped from the dependency graph.
   */
  malformedDepends: Array<{ sliceId: string; values: string[] }>;
}

const TEMPLATE_TOKEN_RE = /\{\{[^}]+\}\}/;
const H2_RE = /^##\s+(.+)$/gm;
const H3_RE = /^###\s+(.+)$/gm;
// A milestone line is single-line by construction. Every inter-token gap uses
// horizontal-whitespace classes (`[^\S\n]`) rather than `\s`, because `\s`
// matches newlines: a line missing a valid separator would otherwise let the
// `\s+(?:—|--|-)\s+` clause "bridge" onto the NEXT bullet's `- `, consuming it
// as the separator and silently swallowing the following well-formed milestone.
const MILESTONE_LINE_RE = /^-[^\S\n]+\[([ x])\][^\S\n]+(M\d{3}):[^\S\n]+(.+?)[^\S\n]+(?:—|--|-)[^\S\n]+(.+)$/gm;
const SLICE_HEADER_RE = /^###\s+(S\d{2})\s*(?:—|--|-)\s+(.+)$/m;
const REQUIREMENT_HEADER_RE = /^###\s+(R\d{3})\s*(?:—|--|-)\s+(.+)$/m;

function splitH2Sections(content: string): { sections: Record<string, string>; order: string[] } {
  const sections: Record<string, string> = {};
  const order: string[] = [];
  const headerMatches: Array<{ name: string; index: number; lineEnd: number }> = [];

  for (const m of content.matchAll(H2_RE)) {
    if (m.index === undefined) continue;
    headerMatches.push({
      name: m[1].trim(),
      index: m.index,
      lineEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const start = headerMatches[i].lineEnd;
    const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : content.length;
    const body = content.slice(start, end).trim();
    sections[headerMatches[i].name] = body;
    order.push(headerMatches[i].name);
  }

  return { sections, order };
}

function detectTemplateTokens(sections: Record<string, string>): { has: boolean; flagged: string[] } {
  const flagged: string[] = [];
  for (const [name, body] of Object.entries(sections)) {
    if (TEMPLATE_TOKEN_RE.test(body)) flagged.push(name);
  }
  return { has: flagged.length > 0, flagged };
}

export function parseProject(content: string): ParsedProject {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const milestones: ParsedProject["milestones"] = [];
  const sequenceBody = sections["Milestone Sequence"] ?? "";
  for (const m of sequenceBody.matchAll(MILESTONE_LINE_RE)) {
    milestones.push({
      done: m[1] === "x",
      id: m[2],
      title: m[3].trim(),
      oneLiner: m[4].trim(),
    });
  }

  return {
    sections,
    sectionOrder: order,
    milestones,
    hasTemplateTokens: tokens.has,
    sectionsWithTokens: tokens.flagged,
  };
}

function parseRequirementEntry(block: string, parentSection: string): ParsedRequirement | null {
  const headerMatch = block.match(REQUIREMENT_HEADER_RE);
  if (!headerMatch) return null;

  const id = headerMatch[1];
  const title = headerMatch[2].trim();

  const fieldOf = (key: string): string => {
    const re = new RegExp(`^-\\s+${key}:\\s*(.*)$`, "m");
    const matched = block.match(re);
    return matched ? matched[1].trim() : "";
  };

  return {
    id,
    title,
    class: fieldOf("Class"),
    status: fieldOf("Status"),
    description: fieldOf("Description"),
    whyItMatters: fieldOf("Why it matters"),
    source: fieldOf("Source"),
    primaryOwner: fieldOf("Primary owning slice"),
    supportingSlices: fieldOf("Supporting slices"),
    validation: fieldOf("Validation"),
    notes: fieldOf("Notes"),
    parentSection,
  };
}

function splitH3Blocks(sectionBody: string): string[] {
  if (!sectionBody) return [];
  const indices: number[] = [];
  for (const m of sectionBody.matchAll(H3_RE)) {
    if (m.index !== undefined) indices.push(m.index);
  }
  if (indices.length === 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1] : sectionBody.length;
    blocks.push(sectionBody.slice(indices[i], end));
  }
  return blocks;
}

export function parseRequirements(content: string): ParsedRequirements {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const requirements: ParsedRequirement[] = [];
  for (const sectionName of ["Active", "Validated", "Deferred", "Out of Scope"]) {
    const body = sections[sectionName] ?? "";
    for (const block of splitH3Blocks(body)) {
      const parsed = parseRequirementEntry(block, sectionName);
      if (parsed) requirements.push(parsed);
    }
  }

  const traceBody = sections["Traceability"] ?? "";
  const traceabilityRows: Array<Record<string, string>> = [];
  const lines = traceBody.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].startsWith("|") && lines[1].startsWith("|")) {
    const headers = lines[0].replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
    for (let i = 2; i < lines.length; i++) {
      if (!lines[i].startsWith("|")) continue;
      const cells = lines[i].replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
      if (cells.length === headers.length) {
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => { row[h] = cells[idx]; });
        traceabilityRows.push(row);
      }
    }
  }

  const coverageBody = sections["Coverage Summary"] ?? "";
  const coverageSummary: Record<string, string> = {};
  for (const line of coverageBody.split("\n")) {
    const m2 = line.match(/^-\s+(.+?):\s*(.+)$/);
    if (m2) coverageSummary[m2[1].trim()] = m2[2].trim();
  }

  return {
    sections,
    sectionOrder: order,
    requirements,
    traceabilityRows,
    coverageSummary,
    hasTemplateTokens: tokens.has,
  };
}

/**
 * Parse a "Depends" cell (e.g. "S01, S02" or "none" or "—") into a list of
 * slice IDs and a list of malformed values that did not match S\d{2}.
 * Used by both H3-format and Slice-Overview-table parsing paths.
 */
function parseDependsCell(raw: string): { ids: string[]; malformed: string[] } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed === "—" || trimmed === "-") {
    return { ids: [], malformed: [] };
  }
  const ids: string[] = [];
  const malformed: string[] = [];
  for (const tok of trimmed.split(/[,\s]+/).filter(Boolean)) {
    if (/^S\d{2}$/.test(tok)) ids.push(tok);
    else malformed.push(tok);
  }
  return { ids, malformed };
}

/**
 * Parse the "Slice Overview" table format emitted by `renderRoadmapContent`
 * in workflow-projections.ts. Columns are: ID | Slice | Risk | Depends |
 * Done | After this. Returns [] when no recognizable table is present.
 */
function parseSliceOverviewTable(body: string): {
  slices: ParsedRoadmapSlice[];
  malformedDepends: Array<{ sliceId: string; values: string[] }>;
} {
  const slices: ParsedRoadmapSlice[] = [];
  const malformedDepends: Array<{ sliceId: string; values: string[] }> = [];
  const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
  // Find the header row (starts with "|" and contains "ID")
  const headerIdx = lines.findIndex(l => l.startsWith("|") && /\bID\b/i.test(l));
  if (headerIdx < 0) return { slices, malformedDepends };
  const headers = lines[headerIdx]
    .replace(/^\|/, "").replace(/\|$/, "")
    .split("|").map(s => s.trim().toLowerCase());
  const idCol = headers.indexOf("id");
  const sliceCol = headers.indexOf("slice");
  const riskCol = headers.indexOf("risk");
  const dependsCol = headers.indexOf("depends");
  // "After this" is the demo/outcome column. Some templates may use "demo" instead.
  let demoCol = headers.indexOf("after this");
  if (demoCol < 0) demoCol = headers.indexOf("demo");
  if (idCol < 0 || sliceCol < 0) return { slices, malformedDepends };

  // Skip the separator row (|---|---|...) and walk data rows.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
    if (cells.length < headers.length) continue;
    const id = cells[idCol];
    if (!/^S\d{2}$/.test(id)) continue;
    const dependsRaw = dependsCol >= 0 ? cells[dependsCol] : "";
    const { ids: dependsIds, malformed } = parseDependsCell(dependsRaw);
    if (malformed.length > 0) malformedDepends.push({ sliceId: id, values: malformed });
    slices.push({
      id,
      title: cells[sliceCol] ?? "",
      risk: riskCol >= 0 ? cells[riskCol] : "",
      depends: dependsIds,
      demo: demoCol >= 0 ? cells[demoCol] : "",
    });
  }
  return { slices, malformedDepends };
}

export function parseRoadmap(content: string): ParsedRoadmap {
  const { sections, order } = splitH2Sections(content);
  const tokens = detectTemplateTokens(sections);

  const slices: ParsedRoadmapSlice[] = [];
  const malformedDepends: Array<{ sliceId: string; values: string[] }> = [];

  // Format A: legacy "## Slices" H3 format (used by fixtures + some templates).
  const slicesBody = sections["Slices"] ?? "";
  for (const block of splitH3Blocks(slicesBody)) {
    const headerMatch = block.match(SLICE_HEADER_RE);
    if (!headerMatch) continue;
    const id = headerMatch[1];
    const title = headerMatch[2].trim();
    const fieldOf = (key: string): string => {
      const re = new RegExp(`^-\\s+${key}:\\s*(.*)$`, "m");
      const matched = block.match(re);
      return matched ? matched[1].trim() : "";
    };
    const { ids: dependsIds, malformed } = parseDependsCell(fieldOf("Depends"));
    if (malformed.length > 0) malformedDepends.push({ sliceId: id, values: malformed });
    slices.push({
      id,
      title,
      risk: fieldOf("Risk"),
      depends: dependsIds,
      demo: fieldOf("Demo"),
    });
  }

  // Format B: "## Slice Overview" table format emitted by workflow-projections
  // (gsd_plan_milestone). Used as a fallback when format A produced nothing,
  // so a roadmap that contains both H3 and table sections is parsed once.
  if (slices.length === 0) {
    const overviewBody = sections["Slice Overview"] ?? "";
    if (overviewBody) {
      const parsed = parseSliceOverviewTable(overviewBody);
      slices.push(...parsed.slices);
      malformedDepends.push(...parsed.malformedDepends);
    }
  }

  const dodBody = sections["Definition of Done"] ?? "";
  const definitionOfDone: string[] = [];
  for (const line of dodBody.split("\n")) {
    const m3 = line.match(/^-\s+(.+)$/);
    if (m3) definitionOfDone.push(m3[1].trim());
  }

  return {
    sections,
    sectionOrder: order,
    slices,
    definitionOfDone,
    hasTemplateTokens: tokens.has,
    malformedDepends,
  };
}

// ─── Shared hierarchy markdown parsers (relocated from parsers-legacy.ts, T012) ─
//
// Moved byte-identically; T020 renamed the exports to parseProjectionRoadmap /
// parseProjectionPlan so they cannot be mistaken for live-path state parsers.

// ─── Parse Cache (local to this module) ───────────────────────────────────

/** Fast composite key: length + first/mid/last 100 chars. The middle sample
 *  prevents collisions when only a few characters change in the interior of
 *  a file (e.g., a checkbox [ ] → [x] that doesn't alter length or endpoints). */
function cacheKey(content: string): string {
  const len = content.length;
  const head = content.slice(0, 100);
  const midStart = Math.max(0, Math.floor(len / 2) - 50);
  const mid = len > 200 ? content.slice(midStart, midStart + 100) : '';
  const tail = len > 100 ? content.slice(-100) : '';
  return `${len}:${head}:${mid}:${tail}`;
}

const _parseCache = new Map<string, unknown>();

function cachedParse<T>(content: string, tag: string, parseFn: (c: string) => T): T {
  const key = tag + '|' + cacheKey(content);
  if (_parseCache.has(key)) return _parseCache.get(key) as T;
  if (_parseCache.size >= CACHE_MAX) _parseCache.clear();
  const result = parseFn(content);
  _parseCache.set(key, result);
  return result;
}

/** Clear the legacy parser cache. Called by clearParseCache() in files.ts. */
export function clearLegacyParseCache(): void {
  _parseCache.clear();
}

// Register with files.ts so clearParseCache() also clears our cache
registerCacheClearCallback(clearLegacyParseCache);

// ─── Roadmap Parser ────────────────────────────────────────────────────────

export function parseProjectionRoadmap(content: string): Roadmap {
  return cachedParse(content, 'roadmap', _parseRoadmapImpl);
}

/**
 * ADR-011: the roadmap renderer writes a `[sketch]` badge for sketch slices,
 * but the native parser does not surface it. Re-scan the markdown and set
 * isSketch on the matching slice so the flag survives a markdown → DB re-import
 * (e.g. /gsd recover) instead of being silently dropped.
 */
function applySketchFlags(roadmap: Roadmap, content: string): void {
  const sketchIds = new Set<string>();
  for (const line of content.split("\n")) {
    if (!/\[sketch\]/i.test(line)) continue;
    const m = line.match(/\*\*([\w.]+):/);
    if (m) sketchIds.add(m[1]!);
  }
  if (sketchIds.size === 0) return;
  for (const slice of roadmap.slices) {
    if (sketchIds.has(slice.id)) slice.isSketch = true;
  }
}

function _parseRoadmapImpl(content: string): Roadmap {
  const stopTimer = debugTime("parse-roadmap");
  // Try native parser first for better performance
  const nativeResult = nativeParseRoadmap(content);
  if (nativeResult) {
    applySketchFlags(nativeResult, content);
    stopTimer({ native: true, slices: nativeResult.slices.length, boundaryEntries: nativeResult.boundaryMap.length });
    debugCount("parseRoadmapCalls");
    return nativeResult;
  }

  const lines = content.split('\n');

  const h1 = lines.find(l => l.startsWith('# '));
  const title = h1 ? h1.slice(2).trim() : '';
  const vision = extractBoldField(content, 'Vision') || '';

  const scSection = extractSection(content, 'Success Criteria', 2) ||
    (() => {
      const idx = content.indexOf('**Success Criteria:**');
      if (idx === -1) return '';
      const rest = content.slice(idx);
      const nextSection = rest.indexOf('\n---');
      const block = rest.slice(0, nextSection === -1 ? undefined : nextSection);
      const firstNewline = block.indexOf('\n');
      return firstNewline === -1 ? '' : block.slice(firstNewline + 1);
    })();
  const successCriteria = scSection ? parseBullets(scSection) : [];

  // Slices
  const slices = parseRoadmapSlices(content);

  // Boundary map
  const boundaryMap: BoundaryMapEntry[] = [];
  const bmSection = extractSection(content, 'Boundary Map');

  if (bmSection) {
    const h3Sections = extractAllSections(bmSection, 3);
    for (const [heading, sectionContent] of h3Sections) {
      const arrowMatch = heading.match(/^(\S+)\s*→\s*(\S+)/);
      if (!arrowMatch) continue;

      const fromSlice = arrowMatch[1];
      const toSlice = arrowMatch[2];

      let produces = '';
      let consumes = '';

      // Use indexOf-based parsing instead of [\s\S]*? regex to avoid
      // catastrophic backtracking on content with code fences (#468).
      const prodIdx = sectionContent.search(/^Produces:\s*$/m);
      if (prodIdx !== -1) {
        const afterProd = sectionContent.indexOf('\n', prodIdx);
        if (afterProd !== -1) {
          const consIdx = sectionContent.search(/^Consumes/m);
          const endIdx = consIdx !== -1 && consIdx > afterProd ? consIdx : sectionContent.length;
          produces = sectionContent.slice(afterProd + 1, endIdx).trim();
        }
      }

      const consLineMatch = sectionContent.match(/^Consumes[^:]*:\s*(.+)$/m);
      if (consLineMatch) {
        consumes = consLineMatch[1].trim();
      }
      if (!consumes) {
        const consIdx = sectionContent.search(/^Consumes[^:]*:\s*$/m);
        if (consIdx !== -1) {
          const afterCons = sectionContent.indexOf('\n', consIdx);
          if (afterCons !== -1) {
            consumes = sectionContent.slice(afterCons + 1).trim();
          }
        }
      }

      boundaryMap.push({ fromSlice, toSlice, produces, consumes });
    }
  }

  const result = { title, vision, successCriteria, slices, boundaryMap };
  stopTimer({ native: false, slices: slices.length, boundaryEntries: boundaryMap.length });
  debugCount("parseRoadmapCalls");
  return result;
}

// ─── Slice Plan Parser ─────────────────────────────────────────────────────

export function parseProjectionPlan(content: string): SlicePlan {
  return cachedParse(content, 'plan', _parsePlanImpl);
}

function _parsePlanImpl(content: string): SlicePlan {
  const stopTimer = debugTime("parse-plan");
  const [, body] = splitFrontmatter(content);
  // Try native parser first for better performance
  const nativeResult = nativeParsePlanFile(body);
  const taskCheckboxCount = body.match(/^\s*-\s+\[[ xX]\]\s+\*\*/gm)?.length ?? 0;
  const nativeTasksAreComplete = nativeResult?.tasks.every((task) => task.id.trim().length > 0) ?? false;
  // Older native engines do not understand flat-phase <tasks> entries. A
  // zero-task, partial, or empty-id native result is therefore not authoritative
  // when the source visibly contains task checkboxes; fall through to JS.
  if (nativeResult && (taskCheckboxCount === 0 || (
    nativeResult.tasks.length === taskCheckboxCount && nativeTasksAreComplete
  ))) {
    stopTimer({ native: true });
    return {
      id: nativeResult.id,
      title: nativeResult.title,
      goal: nativeResult.goal,
      demo: nativeResult.demo,
      mustHaves: nativeResult.mustHaves,
      tasks: nativeResult.tasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        done: t.done,
        estimate: t.estimate,
        ...(t.files.length > 0 ? { files: t.files } : {}),
        ...(t.verify ? { verify: t.verify } : {}),
      })),
      filesLikelyTouched: nativeResult.filesLikelyTouched,
    };
  }

  const lines = body.split('\n');

  const h1 = lines.find(l => l.startsWith('# '));
  let id = '';
  let title = '';
  if (h1) {
    const match = h1.match(/^#\s+(\w+):\s+(.+)/);
    if (match) {
      id = match[1];
      title = match[2].trim();
    } else {
      title = h1.slice(2).trim();
    }
  }

  const goal = extractBoldField(body, 'Goal') || '';
  const demo = extractBoldField(body, 'Demo') || '';

  const mhSection = extractSection(body, 'Must-Haves');
  const mustHaves = mhSection ? parseBullets(mhSection) : [];

  // Parse tasks from ## Tasks section or <tasks> XML block, then scan the full
  // body for any task checkboxes that were missed.
  const tasksSection = extractSection(body, 'Tasks');
  // Flat-phase: extract <tasks>...</tasks> block content
  const tasksBlockMatch = body.match(/<tasks>([\s\S]*?)<\/tasks>/);
  const tasksBlock = tasksBlockMatch ? tasksBlockMatch[1] : null;
  const tasks: TaskPlanEntry[] = [];

  // Parse task entries from a set of lines, appending to `tasks`.
  const parseTaskLines = (lines: string[], knownIds: Set<string>): void => {
    let currentTask: TaskPlanEntry | null = null;

    for (const line of lines) {
      // Match both formats:
      //   Legacy:  - [x] **T01: Title** `est:30m`
      //   Flat-phase: - [x] **T01**: Title _(30m)_
      const cbMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*((?:S\d+-)?[\w.]+):\s+(.+?)\*\*\s*(.*)/)
        || line.match(/^-\s+\[([ xX])\]\s+\*\*((?:S\d+-)?[\w.]+)\*\*:\s+(.+?)\s*(?:_\(([^)]*)\)_\s*)?$/);
      // Heading-style: ### T01 -- Title, ### T01: Title, ### T01 — Title
      const hdMatch = !cbMatch
        ? line.match(/^#{2,4}\s+((?:S\d+-)?[A-Z]+\d+(?:\.[A-Z]+\d+)*)\s*(?:--|—|:)\s*(.+)/)
        : null;
      if (cbMatch || hdMatch) {
        const taskId = cbMatch ? cbMatch[2] : hdMatch![1];
        // Skip tasks already found in the Tasks section
        if (knownIds.has(taskId)) {
          currentTask = null;
          continue;
        }
        knownIds.add(taskId);
        if (currentTask) tasks.push(currentTask);

        if (cbMatch) {
          // Two regex alternatives — distinguish by the shape of group 4.
          // Legacy: group 4 = trailing text (may contain `est:X`). Title in group 3.
          // Flat-phase: group 4 = estimate value directly (e.g. "30m"). Title in group 3.
          const group4 = cbMatch[4] || '';
          const title = (cbMatch[3] || '').trim();
          let estimate = '';

          // Legacy `est:X` tag
          const estMatch = group4.match(/`est:([^`]+)`/);
          if (estMatch) {
            estimate = estMatch[1]!;
          } else if (group4) {
            // Flat-phase: the estimate value was captured directly
            estimate = group4;
          }

          currentTask = {
            id: cbMatch[2],
            title,
            description: '',
            done: cbMatch[1]!.toLowerCase() === 'x',
            estimate,
          };
        } else {
          const rest = hdMatch![2] || '';
          const titleEstMatch = rest.match(/^(.+?)\s*`est:([^`]+)`\s*$/);
          const title = titleEstMatch ? titleEstMatch[1].trim() : rest.trim();
          const estimate = titleEstMatch ? titleEstMatch[2] : '';

          currentTask = {
            id: hdMatch![1],
            title,
            description: '',
            done: false,
            estimate,
          };
        }
      } else if (currentTask && line.match(/^\s*-\s+Files:\s*(.*)/)) {
        const filesMatch = line.match(/^\s*-\s+Files:\s*(.*)/);
        if (filesMatch) {
          currentTask.files = filesMatch[1]
            .split(',')
            .map(f => f.replace(/`/g, '').trim())
            .filter(f => f.length > 0);
        }
      } else if (currentTask && line.match(/^\s*-\s+Verify:\s*(.*)/)) {
        const verifyMatch = line.match(/^\s*-\s+Verify:\s*(.*)/);
        if (verifyMatch) {
          currentTask.verify = verifyMatch[1].trim();
        }
      } else if (currentTask && line.trim() && !line.startsWith('#') && !line.match(/<\/?tasks>/) && !line.match(/^\s*-\s+(Files|Verify):/)) {
        const desc = line.trim();
        if (desc) {
          currentTask.description = currentTask.description
            ? currentTask.description + ' ' + desc
            : desc;
        }
      }
    }
    if (currentTask) tasks.push(currentTask);
  };

  const knownTaskIds = new Set<string>();
  if (tasksSection) {
    parseTaskLines(tasksSection.split('\n'), knownTaskIds);
  }

  // Flat-phase: parse <tasks> block
  if (tasksBlock) {
    parseTaskLines(tasksBlock.split('\n'), knownTaskIds);
  }

  // Second pass: scan the full body for task checkboxes outside ## Tasks.
  // Only do this for legacy plans (no <tasks> block) — flat-phase plans
  // have all tasks inside <tasks> and the second pass would pick up noise.
  if (!tasksBlock && !tasksSection) {
    const foundIds = new Set(tasks.map(t => t.id));
    parseTaskLines(body.split('\n'), foundIds);
  }

  const filesSection = extractSection(body, 'Files Likely Touched');
  const filesLikelyTouched = filesSection ? parseBullets(filesSection) : [];

  const result = { id, title, goal, demo, mustHaves, tasks, filesLikelyTouched };
  stopTimer({ tasks: tasks.length });
  debugCount("parsePlanCalls");
  return result;
}
