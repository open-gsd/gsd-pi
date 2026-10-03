// GSD MCP Server — project state reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import {
  resolveGsdRoot,
  resolveRootFile,
  findMilestoneIds,
  resolveMilestoneDir,
  resolveMilestoneFile,
  findSliceIds,
  findTaskFiles,
} from './paths.js';
import type { ProjectProgressReadMetadata } from '@opengsd/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressResult {
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  phase: string;
  milestones: { total: number; done: number; active: number; pending: number; parked: number };
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
  requirements: { active: number; validated: number; deferred: number; outOfScope: number } | null;
  blockers: string[];
  nextAction: string;
  readMetadata?: ProjectProgressReadMetadata;
}

const PROJECTION_READ_METADATA: ProjectProgressReadMetadata = {
  source: 'projection',
  authority: 'projection-fallback',
};

// ---------------------------------------------------------------------------
// STATE.md parser — reads what renderStateContent writes
// (src/resources/extensions/gsd/workflow-projections.ts)
// ---------------------------------------------------------------------------

/** Milestone ids carry an optional unique suffix: M001 or M001-ab12cd. */
const MILESTONE_ID = 'M\\d+(?:-[a-z0-9]{6})?';

function parseBoldField(content: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function parseActiveRef(value: string | null): { id: string; title: string } | null {
  if (!value || value.toLowerCase() === 'none' || value === '—') return null;
  // "M001: Flight Simulator", "M001-ab12cd: Flight Simulator" or "M001"
  const m = value.match(new RegExp(`^(${MILESTONE_ID}|S\\d+|T\\d+):?\\s*(.*)`));
  if (m) return { id: m[1], title: m[2] || m[1] };
  return { id: value, title: value };
}

function parseRequirementsLine(value: string | null): ProgressResult['requirements'] | null {
  if (!value) return null;
  const active = value.match(/(\d+)\s*active/i);
  const validated = value.match(/(\d+)\s*validated/i);
  const deferred = value.match(/(\d+)\s*deferred/i);
  const outOfScope = value.match(/(\d+)\s*out.of.scope/i);
  if (!active && !validated && !deferred && !outOfScope) return null;
  return {
    active: active ? parseInt(active[1], 10) : 0,
    validated: validated ? parseInt(validated[1], 10) : 0,
    deferred: deferred ? parseInt(deferred[1], 10) : 0,
    outOfScope: outOfScope ? parseInt(outOfScope[1], 10) : 0,
  };
}

function parseBlockers(content: string): string[] {
  const section = content.match(/## Blockers\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return [];
  return section[1]
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    // The renderer writes "- None" for an empty list.
    .filter((l) => l && l !== 'None');
}

function parseNextAction(content: string): string {
  const section = content.match(/## Next Action\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return '';
  const first = section[1].trim().split('\n')[0] || '';
  // The renderer writes "None" for an empty next action.
  return first === 'None' ? '' : first;
}

// ---------------------------------------------------------------------------
// Milestone registry from STATE.md
// ---------------------------------------------------------------------------

interface RegistryEntry { id: string; status: 'done' | 'active' | 'pending' | 'parked' }

function parseMilestoneRegistry(content: string): RegistryEntry[] {
  const section = content.match(/## Milestone Registry\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (!section) return [];
  const entries: RegistryEntry[] = [];
  for (const line of section[1].split('\n')) {
    // The renderer writes the parked glyph with a variation selector (U+FE0F).
    const m = line.match(new RegExp(`[-*]\\s*(☑|✅|🔄|⬜|⏸)\\uFE0F?\\s*\\*\\*(${MILESTONE_ID}):\\*\\*`, 'u'));
    if (!m) continue;
    const [, icon, id] = m;
    let status: RegistryEntry['status'] = 'pending';
    if (icon === '☑' || icon === '✅') status = 'done';
    else if (icon === '🔄') status = 'active';
    else if (icon === '⏸') status = 'parked';
    entries.push({ id, status });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Count slices/tasks by walking filesystem
// ---------------------------------------------------------------------------

function countSlicesAndTasks(gsdRoot: string, milestoneIds: string[]): {
  slices: ProgressResult['slices'];
  tasks: ProgressResult['tasks'];
} {
  let sliceTotal = 0, sliceDone = 0, sliceActive = 0;
  let taskTotal = 0, taskDone = 0;

  for (const mid of milestoneIds) {
    const sliceIds = findSliceIds(gsdRoot, mid);
    sliceTotal += sliceIds.length;

    for (const sid of sliceIds) {
      const tasks = findTaskFiles(gsdRoot, mid, sid);
      taskTotal += tasks.length;

      // Flat-phase inventories carry the plan checkbox state in `done`
      // (tasks are checkboxes inside the slice plan, not separate files).
      // An explicit unchecked box means staged-not-verified: the writer
      // writes the task summary before host verification.
      const isDone = (t: { hasSummary: boolean; done?: boolean }) =>
        t.done === true ? true : t.done === false ? false : t.hasSummary;
      const allDone = tasks.length > 0 && tasks.every(isDone);
      const anyDone = tasks.some(isDone);

      if (allDone) {
        sliceDone++;
        taskDone += tasks.length;
      } else {
        if (anyDone) sliceActive++;
        taskDone += tasks.filter(isDone).length;
      }
    }
  }

  return {
    slices: {
      total: sliceTotal,
      done: sliceDone,
      active: sliceActive,
      pending: sliceTotal - sliceDone - sliceActive,
    },
    tasks: { total: taskTotal, done: taskDone, pending: taskTotal - taskDone },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readProgress(projectDir: string): ProgressResult {
  const gsd = resolveGsdRoot(projectDir);
  const statePath = resolveRootFile(gsd, 'STATE.md');

  // Defaults
  const result: ProgressResult = {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: 'unknown',
    milestones: { total: 0, done: 0, active: 0, pending: 0, parked: 0 },
    slices: { total: 0, done: 0, active: 0, pending: 0 },
    tasks: { total: 0, done: 0, pending: 0 },
    requirements: null,
    blockers: [],
    nextAction: '',
    readMetadata: { ...PROJECTION_READ_METADATA },
  };

  if (!existsSync(statePath)) {
    // No STATE.md — derive from filesystem only
    const milestoneIds = findMilestoneIds(gsd);
    result.milestones.total = milestoneIds.length;
    result.milestones.pending = milestoneIds.length;
    const counts = countSlicesAndTasks(gsd, milestoneIds);
    result.slices = counts.slices;
    result.tasks = counts.tasks;
    return result;
  }

  const content = readFileSync(statePath, 'utf-8');

  // Parse STATE.md fields
  result.activeMilestone = parseActiveRef(parseBoldField(content, 'Active Milestone'));
  result.activeSlice = parseActiveRef(parseBoldField(content, 'Active Slice'));
  result.phase = parseBoldField(content, 'Phase') ?? 'unknown';
  result.requirements = parseRequirementsLine(parseBoldField(content, 'Requirements Status'));
  result.blockers = parseBlockers(content);
  result.nextAction = parseNextAction(content);

  // Milestone counts from registry
  const registry = parseMilestoneRegistry(content);
  if (registry.length > 0) {
    result.milestones.total = registry.length;
    result.milestones.done = registry.filter((e) => e.status === 'done').length;
    result.milestones.active = registry.filter((e) => e.status === 'active').length;
    result.milestones.parked = registry.filter((e) => e.status === 'parked').length;
    result.milestones.pending = registry.length -
      result.milestones.done - result.milestones.active - result.milestones.parked;
  } else {
    // Fallback: count directories
    const milestoneIds = findMilestoneIds(gsd);
    result.milestones.total = milestoneIds.length;
    result.milestones.pending = milestoneIds.length;
  }

  // Slice/task counts from filesystem
  const milestoneIds = findMilestoneIds(gsd);
  const counts = countSlicesAndTasks(gsd, milestoneIds);
  result.slices = counts.slices;
  result.tasks = counts.tasks;

  return result;
}
