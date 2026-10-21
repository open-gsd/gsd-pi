// Migration transformer — converts parsed PlanningProject into GSDProject.
// Pure function: no I/O, no side effects, no imports outside migrate/.

import type {
  PlanningProject,
  PlanningPhase,
  PlanningPlan,
  PlanningSummary,
  PlanningRoadmapEntry,
  PlanningRoadmapMilestone,
  PlanningResearch,
  PlanningRequirement,
  PlanningMilestone,
  GSDProject,
  GSDMilestone,
  GSDSlice,
  GSDTask,
  GSDRequirement,
  GSDSliceSummaryData,
  GSDTaskSummaryData,
  GSDBoundaryEntry,
} from './types.js';
import { parseOldRequirements } from './parsers.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function padId(prefix: string, n: number, width = 2): string {
  return `${prefix}${String(n).padStart(width, '0')}`;
}

function milestoneId(n: number): string {
  return padId('M', n, 3);
}

function kebabToTitle(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : trimmed;
}

function comparePlanNumbers(a: string, b: string): number {
  const left = a.match(/^(\d+)([a-z]*)$/i);
  const right = b.match(/^(\d+)([a-z]*)$/i);
  if (left && right) {
    const numeric = Number(left[1]) - Number(right[1]);
    if (numeric !== 0) return numeric;
    return left[2].localeCompare(right[2], undefined, { sensitivity: 'base' });
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Preferred research ordering for consolidation. */
const RESEARCH_ORDER = ['SUMMARY.md', 'ARCHITECTURE.md', 'STACK.md', 'FEATURES.md', 'PITFALLS.md'];

function sortResearch(files: PlanningResearch[]): PlanningResearch[] {
  return [...files].sort((a, b) => {
    const ai = RESEARCH_ORDER.indexOf(a.fileName);
    const bi = RESEARCH_ORDER.indexOf(b.fileName);
    const aw = ai === -1 ? RESEARCH_ORDER.length : ai;
    const bw = bi === -1 ? RESEARCH_ORDER.length : bi;
    if (aw !== bw) return aw - bw;
    return a.fileName.localeCompare(b.fileName);
  });
}

function consolidateResearch(files: PlanningResearch[]): string | null {
  if (files.length === 0) return null;
  return sortResearch(files)
    .map((f) => f.content.trim())
    .join('\n\n');
}

// ─── Task Mapping ──────────────────────────────────────────────────────────

function buildTaskSummary(summary: PlanningSummary): GSDTaskSummaryData {
  return {
    completedAt: summary.frontmatter.completed ?? '',
    provides: summary.frontmatter.provides ?? [],
    keyFiles: summary.frontmatter['key-files'] ?? [],
    duration: summary.frontmatter.duration ?? '',
    whatHappened: summary.body?.trim() ?? '',
  };
}

function mapTask(plan: PlanningPlan, index: number, summaries: Record<string, PlanningSummary>): GSDTask {
  const summary = summaries[plan.planNumber];
  const done = summary !== undefined;
  return {
    id: padId('T', index + 1),
    title: buildTaskTitle(plan),
    description: plan.objective ?? '',
    done,
    estimate: done ? (summary.frontmatter.duration ?? '') : '',
    files: plan.frontmatter.files_modified ?? [],
    mustHaves: plan.frontmatter.must_haves?.truths ?? [],
    summary: done ? buildTaskSummary(summary) : null,
  };
}

function buildTaskTitle(plan: PlanningPlan): string {
  const fm = plan.frontmatter;
  if (fm.phase && fm.plan) {
    return `${fm.phase} ${fm.plan}`;
  }
  return `Plan ${plan.planNumber}`;
}

// ─── Slice Mapping ─────────────────────────────────────────────────────────

function buildSliceSummary(phase: PlanningPhase): GSDSliceSummaryData | null {
  // Aggregate from all summaries in the phase
  const summaryEntries = Object.values(phase.summaries);
  if (summaryEntries.length === 0) return null;

  const provides: string[] = [];
  const keyFiles: string[] = [];
  const keyDecisions: string[] = [];
  const patternsEstablished: string[] = [];
  let lastCompleted = '';
  let totalDuration = '';
  const bodies: string[] = [];

  for (const s of summaryEntries) {
    provides.push(...(s.frontmatter.provides ?? []));
    keyFiles.push(...(s.frontmatter['key-files'] ?? []));
    keyDecisions.push(...(s.frontmatter['key-decisions'] ?? []));
    patternsEstablished.push(...(s.frontmatter['patterns-established'] ?? []));
    if (s.frontmatter.completed) lastCompleted = s.frontmatter.completed;
    if (s.frontmatter.duration) totalDuration = s.frontmatter.duration;
    if (s.body?.trim()) bodies.push(s.body.trim());
  }

  return {
    completedAt: lastCompleted,
    provides,
    keyFiles,
    keyDecisions,
    patternsEstablished,
    duration: totalDuration,
    whatHappened: bodies.join('\n\n'),
  };
}

function deriveDemo(phase: PlanningPhase, slug: string): string {
  // First plan's objective, first sentence
  const planNumbers = Object.keys(phase.plans).sort(comparePlanNumbers);
  if (planNumbers.length > 0) {
    const firstPlan = phase.plans[planNumbers[0]];
    if (firstPlan?.objective) {
      return firstSentence(firstPlan.objective);
    }
  }
  return `unit tests prove ${slug} works`;
}

function mapSlice(
  phase: PlanningPhase | undefined,
  entry: PlanningRoadmapEntry,
  index: number,
  prevSliceId: string | null,
): GSDSlice {
  const sliceId = padId('S', index + 1);
  const slug = phase?.slug ?? entry.title;
  const demo = phase ? deriveDemo(phase, slug) : `unit tests prove ${entry.title} works`;

  let tasks: GSDTask[] = [];
  if (phase) {
    const planNumbers = Object.keys(phase.plans).sort(comparePlanNumbers);
    tasks = planNumbers.map((pn, i) => mapTask(phase.plans[pn], i, phase.summaries));
  }

  // #1606: a ROADMAP checkbox alone is insufficient — verify every child task is
  // also done. A slice with pending tasks must remain open to avoid phantom
  // completion that causes auto-mode to skip unfinished work.
  const allTasksDone = tasks.length === 0 || tasks.every((t) => t.done);
  const done = entry.done && allTasksDone;
  const sliceSummary = done && phase ? buildSliceSummary(phase) : null;

  return {
    id: sliceId,
    title: kebabToTitle(slug),
    risk: 'medium',
    depends: prevSliceId ? [prevSliceId] : [],
    done,
    demo,
    goal: demo,
    tasks,
    research: phase ? consolidateResearch(phase.research) : null,
    summary: sliceSummary,
  };
}

// ─── Milestone Building ───────────────────────────────────────────────────

function findPhase(phases: Record<string, PlanningPhase>, phaseNumber: number, entryTitle?: string): PlanningPhase | undefined {
  const matches = Object.values(phases).filter((p) => p.number === phaseNumber);
  if (matches.length <= 1) return matches[0];
  // Multiple phases with the same number — try to match by title/slug similarity
  if (entryTitle) {
    const normalizedTitle = entryTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const best = matches.find((p) => {
      const normalizedSlug = p.slug.replace(/-/g, ' ').toLowerCase();
      return normalizedSlug === normalizedTitle || normalizedTitle.includes(normalizedSlug) || normalizedSlug.includes(normalizedTitle);
    });
    if (best) return best;
  }
  return matches[0];
}

function buildMilestoneFromEntries(
  id: string,
  title: string,
  entries: PlanningRoadmapEntry[],
  phases: Record<string, PlanningPhase>,
  research: PlanningResearch[],
): GSDMilestone {
  // Sort entries by phase number (float sort)
  const sorted = [...entries].sort((a, b) => a.number - b.number);

  const slices: GSDSlice[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const phase = findPhase(phases, entry.number, entry.title);
    const prevId = i > 0 ? slices[i - 1].id : null;
    slices.push(mapSlice(phase, entry, i, prevId));
  }

  return {
    id,
    title,
    vision: '',
    successCriteria: [],
    slices,
    research: consolidateResearch(research),
    boundaryMap: [],
  };
}

// ─── Requirements Mapping ──────────────────────────────────────────────────

const VALID_STATUSES = new Set(['active', 'validated', 'deferred']);
const COMPLETE_ALIASES = new Set(['complete', 'completed', 'done', 'shipped']);
const OUT_OF_SCOPE_ALIASES = new Set(['rejected', 'reject', 'out-of-scope', 'out of scope']);

function normalizeStatus(status: string): 'active' | 'validated' | 'deferred' | 'out-of-scope' {
  const lower = status.toLowerCase().trim();
  if (VALID_STATUSES.has(lower)) return lower as 'active' | 'validated' | 'deferred';
  if (COMPLETE_ALIASES.has(lower)) return 'validated';
  if (OUT_OF_SCOPE_ALIASES.has(lower)) return 'out-of-scope';
  return 'active';
}

function normalizeRequirementId(id: string): string | null {
  const trimmed = id.trim().toUpperCase();
  const rMatch = trimmed.match(/^R(\d+)$/);
  if (rMatch) return `R${rMatch[1].padStart(3, '0')}`;
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(trimmed)) return trimmed;
  return null;
}

function mapRequirements(reqs: PlanningRequirement[]): GSDRequirement[] {
  let autoId = 0;
  const reservedIds = new Set(
    reqs
      .map((req) => normalizeRequirementId(req.id))
      .filter((id): id is string => id !== null),
  );
  const usedIds = new Set<string>();

  function nextRequirementId(): string {
    let id = '';
    do {
      autoId++;
      id = padId('R', autoId, 3);
    } while (usedIds.has(id) || reservedIds.has(id));
    usedIds.add(id);
    return id;
  }

  return reqs.map((req) => {
    const originalId = req.id.trim();
    const canonicalId = normalizeRequirementId(originalId);
    let id: string;
    let description = req.description;

    if (canonicalId && !usedIds.has(canonicalId)) {
      id = canonicalId;
      usedIds.add(id);
    } else {
      id = nextRequirementId();
      if (originalId) {
        description = `Legacy ID: ${originalId}\n\n${description}`;
      }
    }

    return {
      id,
      title: req.title,
      class: 'core-capability',
      status: normalizeStatus(req.status),
      description,
      source: 'inferred',
      primarySlice: 'none yet',
    };
  });
}

function collectRequirements(parsed: PlanningProject): PlanningRequirement[] {
  const requirements = [...parsed.requirements];
  for (const milestone of parsed.milestones) {
    if (milestone.requirements) {
      requirements.push(...parseOldRequirements(milestone.requirements));
    }
  }
  return requirements;
}

// ─── Project-Level Derivation ──────────────────────────────────────────────

function deriveVision(parsed: PlanningProject): string {
  // Try first non-heading line from PROJECT.md
  if (parsed.project) {
    const lines = parsed.project.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return firstSentence(trimmed);
      }
    }
  }
  // Fallback: roadmap title
  if (parsed.roadmap) {
    if (parsed.roadmap.milestones.length > 0) {
      return parsed.roadmap.milestones[0].title;
    }
  }
  return 'Project migration from .planning format';
}

function deriveDecisions(parsed: PlanningProject): string {
  // Extract key decisions from phase summaries if available
  // #1607: use extractDecisionFields for file-sourced decisions to preserve semantics.
  interface RowEntry { decision: string; choice: string; rationale: string; scope: string }
  const rows: RowEntry[] = [];

  const decisionFiles = [...parsed.decisions].sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const df of decisionFiles) {
    rows.push(extractDecisionFields(df.fileName, df.content));
  }

  for (const phase of Object.values(parsed.phases)) {
    for (const summary of Object.values(phase.summaries)) {
      const kd = summary.frontmatter['key-decisions'] ?? [];
      for (const entry of kd) {
        rows.push({ decision: entry, choice: '(from summary)', rationale: '(from summary key-decisions)', scope: 'migration' });
      }
    }
  }

  if (rows.length === 0) return '';
  const lines = [
    '# Decisions Register',
    '',
    '<!-- Append-only. Never edit or remove existing rows.',
    '     To reverse a decision, add a new row that supersedes it.',
    '     Read this file at the start of any planning or research phase. -->',
    '',
    '| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  rows.forEach((row, index) => {
    const id = padId('D', index + 1, 3);
    const esc = (v: string) => v.replace(/\|/g, '\\|');
    lines.push(`| ${id} | migration | ${esc(row.scope)} | ${esc(row.decision)} | ${esc(row.choice)} | ${esc(row.rationale)} | Yes | human |`);
  });

  return lines.join('\n') + '\n';
}

interface MigrationDecisionFields {
  decision: string;
  choice: string;
  rationale: string;
  scope: string;
}

/** #1607: extract structured fields from a legacy decision file.
 * Tries ## Choice / ## Rationale / ## Scope sections first; falls back to
 * preserving body content in Rationale rather than fabricating values.
 */
function extractDecisionFields(fileName: string, content: string): MigrationDecisionFields {
  const heading = content.split('\n').find((line) => /^#\s+/.test(line.trim()));
  const decision = heading
    ? heading.replace(/^#\s+/, '').trim()
    : fileName.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');

  const sectionMatch = (label: string) => {
    const m = content.match(new RegExp(`^##\\s+${label}\\s*\n([\\s\\S]*?)(?=^##\\s|\$)`, 'm'));
    return m ? m[1].trim() : null;
  };

  const choiceSection = sectionMatch('Choice');
  const rationaleSection = sectionMatch('Rationale');
  const scopeSection = sectionMatch('Scope');

  // Preserve as much signal as possible; never fabricate structured fields.
  const choice = choiceSection
    ? choiceSection.split('\n')[0]!.trim()
    : '(not parsed -- see migration source)';

  const rationale = rationaleSection
    ? rationaleSection.replace(/\n+/g, ' ').trim().slice(0, 300)
    : content.replace(/^#[^\n]*\n/, '').trim().replace(/\n+/g, ' ').slice(0, 300) ||
      '(not parsed -- see migration source)';

  const scope = scopeSection ? scopeSection.split('\n')[0]!.trim() : 'migration';

  return { decision, choice, rationale, scope };
}

function buildMilestoneFromLegacyMilestone(source: PlanningMilestone, index: number): GSDMilestone {
  const entries: PlanningRoadmapEntry[] = [];
  if (source.roadmap) {
    entries.push(...parseRoadmapEntries(source.roadmap));
  }

  const phases = source.phases;
  if (entries.length === 0) {
    for (const phase of Object.values(phases).sort((a, b) => a.number - b.number)) {
      entries.push({
        number: phase.number,
        title: phase.slug,
        // #1606: require ALL plans to have summaries, not just any summary.
        done: Object.keys(phase.plans).length > 0 &&
              Object.keys(phase.plans).every((pn) => phase.summaries[pn] !== undefined),
        raw: '',
      });
    }
  }

  const title = `${source.id} Migration`;
  return buildMilestoneFromEntries(milestoneId(index + 1), title, entries, phases, []);
}

function parseRoadmapEntries(content: string): PlanningRoadmapEntry[] {
  const entries: PlanningRoadmapEntry[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^-\s+\[([ xX])\]\s+(\d+(?:\.\d+)?)\s+[—–-]\s+(.+)$/);
    if (!match) continue;
    entries.push({
      number: Number(match[2]),
      title: match[3].trim(),
      done: match[1].toLowerCase() === 'x',
      raw: line,
    });
  }
  return entries;
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

export function transformToGSD(parsed: PlanningProject): GSDProject {
  const milestones: GSDMilestone[] = [];

  const roadmap = parsed.roadmap;
  const legacyMilestonesWithPhases = parsed.milestones.filter((milestone) => Object.keys(milestone.phases).length > 0);
  const hasMilestoneDirectories = legacyMilestonesWithPhases.length > 0;
  const isMultiMilestone = roadmap !== null && roadmap.milestones.length > 0;
  const hasFlatPhases = roadmap !== null && roadmap.phases.length > 0;

  if (hasMilestoneDirectories) {
    const sorted = [...legacyMilestonesWithPhases].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
    for (let mi = 0; mi < sorted.length; mi++) {
      milestones.push(buildMilestoneFromLegacyMilestone(sorted[mi], mi));
    }
  } else if (isMultiMilestone) {
    // Multi-milestone mode: each roadmap milestone section → one GSDMilestone
    for (let mi = 0; mi < roadmap!.milestones.length; mi++) {
      const rm = roadmap!.milestones[mi];
      milestones.push(
        buildMilestoneFromEntries(
          milestoneId(mi + 1),
          rm.title,
          rm.phases,
          parsed.phases,
          mi === 0 ? parsed.research : [],
        ),
      );
    }
  } else if (hasFlatPhases) {
    // Single-milestone mode from roadmap phases
    milestones.push(
      buildMilestoneFromEntries('M001', 'Migration', roadmap!.phases, parsed.phases, parsed.research),
    );
  } else {
    // Null/empty roadmap fallback: use filesystem phases, all not-done
    const fsPhases = Object.values(parsed.phases).sort((a, b) => a.number - b.number);
    const entries: PlanningRoadmapEntry[] = fsPhases.map((p) => ({
      number: p.number,
      title: p.slug,
      done: false,
      raw: '',
    }));
    milestones.push(
      buildMilestoneFromEntries('M001', 'Migration', entries, parsed.phases, parsed.research),
    );
  }

  // Set vision on first milestone (or all if multi)
  const vision = deriveVision(parsed);
  for (const m of milestones) {
    if (!m.vision) m.vision = vision;
  }

  return {
    milestones,
    projectContent: parsed.project ?? '',
    requirements: mapRequirements(collectRequirements(parsed)),
    decisionsContent: deriveDecisions(parsed),
    migrationInputs: {
      milestonePhaseDirs: parsed.milestones.filter((milestone) => Object.keys(milestone.phases).length > 0).length,
      decisions: parsed.decisions.length,
      seeds: parsed.seeds.length,
    },
  };
}
