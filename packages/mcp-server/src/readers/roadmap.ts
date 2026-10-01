// GSD MCP Server — roadmap structure reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import {
  resolveGsdRoot,
  findMilestoneIds,
  resolveMilestoneFile,
  findSliceIds,
  resolveSliceFile,
  findTaskFiles,
} from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskInfo {
  id: string;
  title: string;
  status: 'done' | 'pending';
}

export interface SliceInfo {
  id: string;
  title: string;
  status: 'done' | 'active' | 'pending';
  risk: string;
  depends: string[];
  demo: string;
  tasks: TaskInfo[];
}

export interface MilestoneInfo {
  id: string;
  title: string;
  status: 'done' | 'active' | 'pending' | 'parked';
  vision: string;
  slices: SliceInfo[];
}

export interface RoadmapResult {
  milestones: MilestoneInfo[];
}

// ---------------------------------------------------------------------------
// ROADMAP.md table parser
// ---------------------------------------------------------------------------

/** @internal — exported for doctor-lite's slice inventory union */
export function parseRoadmapTable(content: string): Array<{
  id: string; title: string; risk: string; depends: string[]; done: boolean; demo: string;
}> {
  const results: Array<{
    id: string; title: string; risk: string; depends: string[]; done: boolean; demo: string;
  }> = [];

  // Try table format first: | S01 | Title | risk | depends | done-icon | demo |
  const tableSection = content.match(/## (?:Slice[s]?|Slice Overview|Slice Table)\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (tableSection) {
    const lines = tableSection[1].split('\n');
    for (const line of lines) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      if (cells[0] === 'ID' || cells[0].startsWith('--')) continue;

      // Slice ids: planned S01… and remediation R01… (gsd_reassess_roadmap)
      const id = cells[0].match(/[A-Z]\d+/)?.[0];
      if (!id) continue;

      const done = cells.some((c) => c === '\u2611' || c === '\u2705' || c.toLowerCase() === 'done');
      const depends = (cells[3] ?? '').replace(/\u2014/g, '').split(',').map((d) => d.trim()).filter(Boolean);

      results.push({
        id,
        title: cells[1] ?? '',
        risk: cells[2] ?? 'medium',
        depends,
        done,
        demo: cells[5] ?? '',
      });
    }
    if (results.length > 0) return results;
  }

  // Try checkbox format: - [x] **S01: Title** `risk:high` `depends:[S01]`
  const checkboxRe = /^-\s+\[([ xX])\]\s+\*\*([A-Z]\d+):\s*(.+?)\*\*(?:.*?`risk:(\w+)`)?(?:.*?`depends:\[([^\]]*)\]`)?/gm;
  let match: RegExpExecArray | null;
  while ((match = checkboxRe.exec(content)) !== null) {
    const [, checked, id, title, risk, deps] = match;
    results.push({
      id,
      title: title.trim(),
      risk: risk ?? 'medium',
      depends: deps ? deps.split(',').map((d) => d.trim()).filter(Boolean) : [],
      done: checked !== ' ',
      demo: '',
    });
  }
  if (results.length > 0) return results;

  // Try prose headers: ## S01: Title
  const headerRe = /^##\s+([A-Z]\d+):\s*(.+)/gm;
  while ((match = headerRe.exec(content)) !== null) {
    results.push({
      id: match[1],
      title: match[2].trim(),
      risk: 'medium',
      depends: [],
      done: false,
      demo: '',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// PLAN.md task parser
// ---------------------------------------------------------------------------

function parseSlicePlanTasks(content: string): Array<{ id: string; title: string; done: boolean }> {
  const results: Array<{ id: string; title: string; done: boolean }> = [];

  // Checkbox format: - [x] **T01: Title** — description
  const taskRe = /^-\s+\[([ xX])\]\s+\*\*(T\d+):\s*(.+?)\*\*/gm;
  let match: RegExpExecArray | null;
  while ((match = taskRe.exec(content)) !== null) {
    results.push({
      id: match[2]!,
      title: match[3]!.trim(),
      done: match[1] !== ' ',
    });
  }
  if (results.length > 0) return results;

  // Flat-phase renderer format: <tasks> block with - [x] **T01**: Title
  // lines (optionally suffixed with an estimate like _(2h)_).
  const tasksBlock = content.match(/<tasks>\s*\n([\s\S]*?)\n\s*<\/tasks>/);
  if (tasksBlock) {
    const flatRe = /^-\s+\[([ xX])\]\s+\*\*(T\d+)\*\*:\s*(.+?)$/gm;
    while ((match = flatRe.exec(tasksBlock[1]!)) !== null) {
      results.push({
        id: match[2]!,
        title: match[3]!.trim().replace(/\s*_\([^)]*\)_\s*$/, '').trim(),
        done: match[1] !== ' ',
      });
    }
    if (results.length > 0) return results;
  }

  // H3 format: ### T01: Title
  const h3Re = /^###\s+(T\d+):\s*(.+)/gm;
  while ((match = h3Re.exec(content)) !== null) {
    results.push({
      id: match[1]!,
      title: match[2]!.trim(),
      done: false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Milestone title from CONTEXT.md or ROADMAP.md H1
// ---------------------------------------------------------------------------

function readMilestoneTitle(gsdRoot: string, mid: string): string {
  // ROADMAP.md H1 wins: it names the milestone as the roadmap presents it;
  // CONTEXT.md H1 may be a phase-level or rewritten heading.
  const roadmapPath = resolveMilestoneFile(gsdRoot, mid, 'ROADMAP');
  if (roadmapPath && existsSync(roadmapPath)) {
    const content = readFileSync(roadmapPath, 'utf-8');
    const h1 = content.match(/^#\s+(?:M\d+:?\s*)?(.+)/m);
    if (h1) return h1[1].trim();
  }

  const ctxPath = resolveMilestoneFile(gsdRoot, mid, 'CONTEXT');
  if (ctxPath && existsSync(ctxPath)) {
    const content = readFileSync(ctxPath, 'utf-8');
    const h1 = content.match(/^#\s+(?:M\d+:?\s*)?(.+)/m);
    if (h1) return h1[1].trim();
  }

  return mid;
}

function readVision(gsdRoot: string, mid: string): string {
  const roadmapPath = resolveMilestoneFile(gsdRoot, mid, 'ROADMAP');
  if (!roadmapPath || !existsSync(roadmapPath)) return '';

  const content = readFileSync(roadmapPath, 'utf-8');
  const section = content.match(/## Vision\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  return section ? section[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readRoadmap(projectDir: string, filterMilestoneId?: string): RoadmapResult {
  const gsd = resolveGsdRoot(projectDir);
  let milestoneIds = findMilestoneIds(gsd);

  if (filterMilestoneId) {
    milestoneIds = milestoneIds.filter((id) => id === filterMilestoneId);
  }

  const milestones: MilestoneInfo[] = [];

  for (const mid of milestoneIds) {
    const title = readMilestoneTitle(gsd, mid);
    const vision = readVision(gsd, mid);

    const summaryPath = resolveMilestoneFile(gsd, mid, 'SUMMARY');
    const hasSummary = summaryPath !== null && existsSync(summaryPath);

    const roadmapPath = resolveMilestoneFile(gsd, mid, 'ROADMAP');
    let roadmapSlices: ReturnType<typeof parseRoadmapTable> = [];
    if (roadmapPath && existsSync(roadmapPath)) {
      roadmapSlices = parseRoadmapTable(readFileSync(roadmapPath, 'utf-8'));
    }

    const fsSliceIds = findSliceIds(gsd, mid);
    const sliceIdSet = new Set([
      ...roadmapSlices.map((s) => s.id),
      ...fsSliceIds,
    ]);

    const slices: SliceInfo[] = [];
    for (const sid of Array.from(sliceIdSet).sort()) {
      const roadmapEntry = roadmapSlices.find((s) => s.id === sid);
      const taskFiles = findTaskFiles(gsd, mid, sid);

      const planPath = resolveSliceFile(gsd, mid, sid, 'PLAN');
      let planTasks: ReturnType<typeof parseSlicePlanTasks> = [];
      if (planPath && existsSync(planPath)) {
        planTasks = parseSlicePlanTasks(readFileSync(planPath, 'utf-8'));
      }

      const tasks: TaskInfo[] = [];
      const seenIds = new Set<string>();

      for (const pt of planTasks) {
        const fsTask = taskFiles.find((t) => t.id === pt.id);
        // An explicit plan checkbox is the task's state carrier in the flat
        // layout and wins over artifact presence: the writer stages a task
        // summary BEFORE host verification, so a staged (unchecked) task has
        // a summary but is not complete. Artifacts decide only when no
        // checkbox state is known (H3-style plans, legacy task files).
        const checked = pt.done || fsTask?.done === true;
        const unchecked = !pt.done && fsTask?.done === false;
        const done = checked ? true : unchecked ? false : (fsTask?.hasSummary ?? false);
        tasks.push({ id: pt.id, title: pt.title, status: done ? 'done' : 'pending' });
        seenIds.add(pt.id);
      }
      for (const ft of taskFiles) {
        if (seenIds.has(ft.id)) continue;
        tasks.push({
          id: ft.id,
          title: ft.id,
          status: ft.done === false ? 'pending' : (ft.done === true || ft.hasSummary) ? 'done' : 'pending',
        });
      }

      // Slices with no task signal (empty plan, no task files) fall back to
      // the roadmap table's .done mark — flat-phase projects often carry
      // status only in the ROADMAP table.
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'done');
      const anyDone = tasks.some((t) => t.status === 'done');
      const sliceStatus: SliceInfo['status'] = tasks.length === 0
        ? (roadmapEntry?.done ? 'done' : 'pending')
        : allDone ? 'done' : anyDone ? 'active' : 'pending';

      slices.push({
        id: sid,
        title: roadmapEntry?.title ?? sid,
        status: sliceStatus,
        risk: roadmapEntry?.risk ?? 'medium',
        depends: roadmapEntry?.depends ?? [],
        demo: roadmapEntry?.demo ?? '',
        tasks,
      });
    }

    // Milestone status comes from slice content when slices are known — a
    // SUMMARY file existing proves nothing (a failed verification round still
    // writes one). SUMMARY existence decides only when no slices parse.
    const allSlicesDone = slices.length > 0 && slices.every((s) => s.status === 'done');
    const anySliceActive = slices.some((s) => s.status === 'active' || s.status === 'done');
    const milestoneStatus: MilestoneInfo['status'] = slices.length > 0
      ? (allSlicesDone ? 'done' : anySliceActive ? 'active' : 'pending')
      : hasSummary ? 'done' : 'pending';

    milestones.push({ id: mid, title, status: milestoneStatus, vision, slices });
  }

  return { milestones };
}
