// GSD MCP Server — metrics/history reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import { resolveGsdRoot, resolveRootFile } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsUnit {
  type: string;
  id: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  toolCalls: number;
  apiRequests: number;
}

export interface HistoryResult {
  entries: MetricsUnit[];
  totals: {
    cost: number;
    tokens: { input: number; output: number; total: number };
    units: number;
    durationMs: number;
  };
  /** Set only on the file read: the database was not available, so the rows come from .gsd/metrics.json. */
  readMetadata?: { source: 'projection'; authority: 'projection-fallback' };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function toMetricsUnit(u: Record<string, unknown>): MetricsUnit {
  const tokens = u.tokens as Record<string, unknown> | undefined;
  return {
    type: String(u.type ?? 'unknown'),
    id: String(u.id ?? ''),
    model: String(u.model ?? 'unknown'),
    startedAt: Number(u.startedAt ?? 0),
    finishedAt: Number(u.finishedAt ?? 0),
    tokens: {
      input: Number(tokens?.input ?? 0),
      output: Number(tokens?.output ?? 0),
      cacheRead: Number(tokens?.cacheRead ?? 0),
      cacheWrite: Number(tokens?.cacheWrite ?? 0),
      total: Number(tokens?.total ?? 0),
    },
    cost: Number(u.cost ?? 0),
    toolCalls: Number(u.toolCalls ?? 0),
    apiRequests: Number(u.apiRequests ?? 0),
  };
}

function parseMetricsJson(content: string): MetricsUnit[] {
  try {
    const data = JSON.parse(content);
    if (!data.units || !Array.isArray(data.units)) return [];
    return data.units.map(toMetricsUnit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function historyResult(allUnits: MetricsUnit[], limit?: number): HistoryResult {
  // Sort by startedAt descending (most recent first)
  let entries = [...allUnits].sort((a, b) => b.startedAt - a.startedAt);
  if (limit && limit > 0) entries = entries.slice(0, limit);

  // Totals cover ALL units (not just the limited set)
  const totals = {
    cost: 0,
    tokens: { input: 0, output: 0, total: 0 },
    units: allUnits.length,
    durationMs: 0,
  };
  for (const u of allUnits) {
    totals.cost += u.cost;
    totals.tokens.input += u.tokens.input;
    totals.tokens.output += u.tokens.output;
    totals.tokens.total += u.tokens.total;
    totals.durationMs += (u.finishedAt - u.startedAt);
  }
  // Round cost to 4 decimal places
  totals.cost = Math.round(totals.cost * 10000) / 10000;

  return { entries, totals };
}

/** Build the tool result from the unit_metrics rows of the workflow database. */
export function historyResultFromDatabase(rows: readonly unknown[], limit?: number): HistoryResult {
  return historyResult(rows.map((row) => toMetricsUnit(row as Record<string, unknown>)), limit);
}

/**
 * Display-only file read, used when the project database cannot be opened.
 * The result is labelled as a projection fallback so the caller can tell it
 * from a database read.
 */
export function readHistory(projectDir: string, limit?: number): HistoryResult {
  const metricsPath = resolveRootFile(resolveGsdRoot(projectDir), 'metrics.json');
  const units = existsSync(metricsPath) ? parseMetricsJson(readFileSync(metricsPath, 'utf-8')) : [];
  return {
    ...historyResult(units, limit),
    readMetadata: { source: 'projection', authority: 'projection-fallback' },
  };
}
