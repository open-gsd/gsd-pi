// GSD MCP Server — captures reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import { resolveGsdRoot, resolveRootFile } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptureStatus = 'pending' | 'triaged' | 'resolved';
export type CaptureClassification =
  | 'quick-task' | 'inject' | 'defer' | 'replan' | 'note' | 'stop' | 'backtrack';

export interface CaptureEntry {
  id: string;
  text: string;
  timestamp: string;
  status: CaptureStatus;
  classification: CaptureClassification | null;
  resolution: string | null;
  rationale: string | null;
  resolvedAt: string | null;
  milestone: string | null;
  executed: string | null;
}

export interface CapturesResult {
  captures: CaptureEntry[];
  counts: {
    total: number;
    pending: number;
    resolved: number;
    actionable: number;
  };
  /** Set only on the file read: the database was not available, so the rows come from the CAPTURES.md projection. */
  readMetadata?: { source: 'projection'; authority: 'projection-fallback' };
}

/** One capture as the workflow database bridge returns it (captures.ts loadAllCaptures). */
export interface DatabaseCapture {
  id: string;
  text: string;
  timestamp: string;
  status: CaptureStatus;
  classification?: CaptureClassification;
  resolution?: string;
  rationale?: string;
  resolvedAt?: string;
  resolvedInMilestone?: string;
  executedAt?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseCapturesMarkdown(content: string): CaptureEntry[] {
  const entries: CaptureEntry[] = [];

  // Split on H3 headers: ### CAP-xxxxxxxx
  const sections = content.split(/(?=^### CAP-)/m);

  for (const section of sections) {
    const idMatch = section.match(/^### (CAP-[\da-f]+)/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const field = (label: string): string | null => {
      const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
      const m = section.match(re);
      return m ? m[1].trim() : null;
    };

    const status = (field('Status') ?? 'pending').toLowerCase() as CaptureStatus;
    const classification = field('Classification') as CaptureClassification | null;

    entries.push({
      id,
      text: field('Text') ?? '',
      timestamp: field('Captured') ?? '',
      status,
      classification,
      resolution: field('Resolution'),
      rationale: field('Rationale'),
      resolvedAt: field('Resolved'),
      milestone: field('Milestone'),
      executed: field('Executed'),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ACTIONABLE_CLASSIFICATIONS = new Set<string>(['quick-task', 'inject', 'replan']);

function capturesResult(all: CaptureEntry[], filter: 'all' | 'pending' | 'actionable'): CapturesResult {
  const isActionable = (c: CaptureEntry) =>
    c.classification !== null && ACTIONABLE_CLASSIFICATIONS.has(c.classification);
  const counts = {
    total: all.length,
    pending: all.filter((c) => c.status === 'pending').length,
    resolved: all.filter((c) => c.status === 'resolved').length,
    actionable: all.filter(isActionable).length,
  };
  const captures = filter === 'pending'
    ? all.filter((c) => c.status === 'pending')
    : filter === 'actionable' ? all.filter(isActionable) : all;
  return { captures, counts };
}

/** Build the tool result from the capture rows of the workflow database. */
export function capturesResultFromDatabase(
  rows: readonly DatabaseCapture[],
  filter: 'all' | 'pending' | 'actionable' = 'all',
): CapturesResult {
  return capturesResult(rows.map((row) => ({
    id: row.id,
    text: row.text,
    timestamp: row.timestamp,
    status: row.status,
    classification: row.classification ?? null,
    resolution: row.resolution ?? null,
    rationale: row.rationale ?? null,
    resolvedAt: row.resolvedAt ?? null,
    milestone: row.resolvedInMilestone ?? null,
    executed: row.executedAt ?? null,
  })), filter);
}

/**
 * Display-only file read, used when the project database cannot be opened.
 * The result is labelled as a projection fallback so the caller can tell it
 * from a database read.
 */
export function readCaptures(
  projectDir: string,
  filter: 'all' | 'pending' | 'actionable' = 'all',
): CapturesResult {
  const gsd = resolveGsdRoot(projectDir);
  const capturesPath = resolveRootFile(gsd, 'CAPTURES.md');
  const content = existsSync(capturesPath) ? readFileSync(capturesPath, 'utf-8') : '';

  return {
    ...capturesResult(parseCapturesMarkdown(content), filter),
    readMetadata: { source: 'projection', authority: 'projection-fallback' },
  };
}
