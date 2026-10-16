/**
 * Firecrawl API types and helper functions for normalizing Firecrawl search
 * results into the shared SearchResultFormatted shape.
 *
 * Consumed by: tool-search.ts, search_and_read Firecrawl path
 * (tool-llm-context.ts). All exports are pure functions with no side effects.
 *
 * API: POST https://api.firecrawl.dev/v2/search (bearer auth).
 */

import type { SearchResultFormatted } from "./format.js";

// =============================================================================
// Firecrawl API Types
// =============================================================================

/** A single result from the Firecrawl Search API (a data.web[] item). */
export interface FirecrawlWebResult {
  title: string;
  url: string;
  description: string;
  /** Page markdown, present only when scrapeOptions asked for it. */
  markdown?: string | null;
  [key: string]: unknown;
}

/** Top-level response from POST https://api.firecrawl.dev/v2/search */
export interface FirecrawlSearchResponse {
  success: boolean;
  data: {
    web?: FirecrawlWebResult[] | null;
  };
  warning?: string | null;
  [key: string]: unknown;
}

// =============================================================================
// Result Normalization
// =============================================================================

/**
 * Map a single Firecrawl result to the shared SearchResultFormatted shape.
 *
 * - `description` → `description`
 * - No `age` — data.web[] items carry no publish date (only data.news[] does)
 */
export function normalizeFirecrawlResult(r: FirecrawlWebResult): SearchResultFormatted {
  return {
    title: r.title || "(untitled)",
    url: r.url,
    description: r.description || "",
  };
}

// =============================================================================
// Freshness Format Mapping
// =============================================================================

/** Brave freshness string → Firecrawl `tbs` value mapping. */
const BRAVE_TO_FIRECRAWL_FRESHNESS: Record<string, string> = {
  pd: "qdr:d",
  pw: "qdr:w",
  pm: "qdr:m",
  py: "qdr:y",
};

/**
 * Convert a Brave-format freshness string (pd/pw/pm/py) to a Firecrawl
 * `tbs` value (qdr:d/qdr:w/qdr:m/qdr:y).
 *
 * Returns null if input is null or not a recognized Brave freshness value.
 */
export function mapFreshnessToFirecrawl(braveFreshness: string | null): string | null {
  if (braveFreshness === null) return null;
  return BRAVE_TO_FIRECRAWL_FRESHNESS[braveFreshness] ?? null;
}
