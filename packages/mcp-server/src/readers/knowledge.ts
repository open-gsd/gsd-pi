// GSD MCP Server — knowledge base reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { readFileSync, existsSync } from 'node:fs';
import { KNOWLEDGE_ROW_ID_PATTERN } from '@opengsd/contracts';
import { resolveGsdRoot, resolveRootFile } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnowledgeType = 'rule' | 'pattern' | 'lesson';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  scope: string;
  content: string;
  addedAt: string;
}

export interface KnowledgeResult {
  entries: KnowledgeEntry[];
  counts: { rules: number; patterns: number; lessons: number };
  /** Set only on the file read: the database was not available, so the rows come from the KNOWLEDGE.md projection. */
  readMetadata?: { source: 'projection'; authority: 'projection-fallback' };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const KNOWLEDGE_ROW_ID = new RegExp(`^${KNOWLEDGE_ROW_ID_PATTERN}$`, 'i');

function parseTableRows(section: string, type: KnowledgeType): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const lines = section.split('\n');

  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    // Skip header/separator
    if (cells[0].startsWith('#') || cells[0].startsWith('-')) continue;

    const id = cells[0];
    if (!KNOWLEDGE_ROW_ID.test(id)) continue;

    if (type === 'rule' && cells.length >= 5) {
      entries.push({
        id, type, scope: cells[1], content: cells[2], addedAt: cells[4] ?? '',
      });
    } else if (type === 'pattern' && cells.length >= 4) {
      entries.push({
        id, type, scope: cells[2] ?? '', content: cells[1], addedAt: cells[3] ?? '',
      });
    } else if (type === 'lesson' && cells.length >= 5) {
      entries.push({
        id, type, scope: cells[4] ?? '',
        content: `${cells[1]} — Root cause: ${cells[2]} — Fix: ${cells[3]}`,
        addedAt: '',
      });
    }
  }

  return entries;
}

function parseKnowledgeMarkdown(content: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];

  // Find ## Rules section
  const rulesMatch = content.match(/## Rules\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (rulesMatch) {
    entries.push(...parseTableRows(rulesMatch[1], 'rule'));
  }

  // Find ## Patterns section
  const patternsMatch = content.match(/## Patterns\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (patternsMatch) {
    entries.push(...parseTableRows(patternsMatch[1], 'pattern'));
  }

  // Find ## Lessons Learned section
  const lessonsMatch = content.match(/## Lessons Learned\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (lessonsMatch) {
    entries.push(...parseTableRows(lessonsMatch[1], 'lesson'));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse KNOWLEDGE.md content (from the database bridge or the file) into a KnowledgeResult. */
export function knowledgeResultFromMarkdown(content: string): KnowledgeResult {
  const entries = parseKnowledgeMarkdown(content);

  return {
    entries,
    counts: {
      rules: entries.filter((e) => e.type === 'rule').length,
      patterns: entries.filter((e) => e.type === 'pattern').length,
      lessons: entries.filter((e) => e.type === 'lesson').length,
    },
  };
}

/**
 * Display-only file read, used when the project database cannot be opened.
 * The result is labelled as a projection fallback so the caller can tell it
 * from a database read.
 */
export function readKnowledge(projectDir: string): KnowledgeResult {
  const gsd = resolveGsdRoot(projectDir);
  const knowledgePath = resolveRootFile(gsd, 'KNOWLEDGE.md');
  const content = existsSync(knowledgePath) ? readFileSync(knowledgePath, 'utf-8') : '';

  return {
    ...knowledgeResultFromMarkdown(content),
    readMetadata: { source: 'projection', authority: 'projection-fallback' },
  };
}
