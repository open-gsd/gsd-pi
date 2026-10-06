/**
 * Remote Questions — status helpers
 */

import { readLatestPromptRecord } from "./store.js";

export interface LatestPromptSummary {
  id: string;
  status: string;
  updatedAt: number;
}

export function getLatestPromptSummary(): LatestPromptSummary | null {
  const record = readLatestPromptRecord();
  return record ? { id: record.id, status: record.status, updatedAt: record.updatedAt } : null;
}
