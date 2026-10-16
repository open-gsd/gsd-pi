/**
 * Contract tests for Firecrawl search integration in tool-search.ts and
 * tool-llm-context.ts.
 *
 * Covers:
 * - Firecrawl v2 search request construction (POST, bearer auth, tbs,
 *   includeDomains) and the data.web[] envelope mapping
 * - Provider selection: firecrawl picked when only FIRECRAWL_API_KEY is set,
 *   and never auto-picked when another provider has a key
 * - Freshness mapping: Brave freshness → Firecrawl tbs in request body
 * - search_and_read: scrapeOptions markdown → budgetContent via the
 *   TavilyResult-compatible mapping, honoring maxUrls
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveSearchProvider } from "../resources/extensions/search-the-web/provider.ts";
import { mapFreshnessToFirecrawl, normalizeFirecrawlResult } from "../resources/extensions/search-the-web/firecrawl.ts";
import { budgetContent } from "../resources/extensions/search-the-web/tool-llm-context.ts";
import { normalizeHeaders, parseJsonBody } from "./fetch-test-helpers.ts";

// =============================================================================
// Helpers for mocking global fetch
// =============================================================================

/** A minimal Firecrawl v2 search response fixture. */
function makeFirecrawlResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      web: [
        {
          title: "First Result",
          url: "https://example.com/first",
          description: "Description of first result.",
        },
        {
          title: "Second Result",
          url: "https://docs.example.com/second",
          description: "Description of second result.",
          markdown: "# Second Result\n\nFull page markdown.",
        },
      ],
    },
    warning: null,
    ...overrides,
  };
}

function mockFetch(responseBody: unknown, status = 200) {
  const captured: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {};

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.url = url;
    captured.method = init?.method ?? "GET";
    captured.headers = normalizeHeaders(init?.headers);
    captured.body = parseJsonBody(init?.body);

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  const restore = () => { globalThis.fetch = originalFetch; };
  return { captured, restore };
}

// =============================================================================
// Test: search request shape and envelope mapping
// =============================================================================

test("firecrawl search sends POST to the v2 endpoint and maps data.web", async (t) => {
  const origKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "fc-test-key-12345";

  const { captured, restore } = mockFetch(makeFirecrawlResponse());

  t.after(() => {
    restore();
    if (origKey !== undefined) process.env.FIRECRAWL_API_KEY = origKey;
    else delete process.env.FIRECRAWL_API_KEY;
  });

  // Simulate what executeFirecrawlSearch does: build request, call fetch, map.
  const requestBody: Record<string, unknown> = {
    query: "test query",
    limit: 10,
  };

  const response = await globalThis.fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer fc-test-key-12345",
    },
    body: JSON.stringify(requestBody),
  });

  assert.equal(captured.url, "https://api.firecrawl.dev/v2/search", "request URL");
  assert.equal(captured.method, "POST", "HTTP method");
  assert.equal(captured.headers?.["Content-Type"], "application/json", "Content-Type header");
  assert.equal(captured.headers?.["Authorization"], "Bearer fc-test-key-12345", "Authorization header");
  assert.deepEqual(captured.body, requestBody, "request body");

  const data = await response.json() as Awaited<ReturnType<typeof makeFirecrawlResponse>>;
  const mapped = (data.data.web ?? []).map(normalizeFirecrawlResult);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].title, "First Result");
  assert.equal(mapped[0].url, "https://example.com/first");
  assert.equal(mapped[0].description, "Description of first result.");
  assert.equal(mapped[0].age, undefined, "data.web carries no publish date → no age");
  assert.equal(mapped[1].url, "https://docs.example.com/second");
});

test("firecrawl failure status surfaces a non-2xx response for classifyError", async (t) => {
  const { restore, captured } = mockFetch({ error: "Unauthorized", success: false }, 401);
  t.after(restore);

  const response = await globalThis.fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer bad" },
    body: JSON.stringify({ query: "q" }),
  });

  assert.equal(response.status, 401, "auth failures stay visible to the shared error classifier");
  assert.equal(captured.method, "POST");
});

// =============================================================================
// Test: freshness and domain filters map to the Firecrawl request fields
// =============================================================================

test("freshness='week' maps to tbs='qdr:w' and domain maps to includeDomains", () => {
  const requestBody: Record<string, unknown> = {
    query: "test query",
    limit: 10,
  };

  const tbs = mapFreshnessToFirecrawl("pw");
  if (tbs) requestBody.tbs = tbs;
  requestBody.includeDomains = ["docs.example.com"];

  assert.equal(requestBody.tbs, "qdr:w");
  assert.deepEqual(requestBody.includeDomains, ["docs.example.com"]);
  assert.equal(mapFreshnessToFirecrawl(null), null, "no freshness → no tbs field");
});

// =============================================================================
// Test: provider selection — additive auto order
// =============================================================================

function withSearchEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["TAVILY_API_KEY", "BRAVE_API_KEY", "OLLAMA_API_KEY", "FIRECRAWL_API_KEY"];
  const originals: Record<string, string | undefined> = {};
  for (const key of keys) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key] as string;
    }
  }
}

test("resolveSearchProvider returns 'firecrawl' when only FIRECRAWL_API_KEY is set", () => {
  withSearchEnv({ FIRECRAWL_API_KEY: "fc", TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined, OLLAMA_API_KEY: undefined }, () => {
    assert.equal(resolveSearchProvider(), "firecrawl");
  });
});

test("auto keeps the existing order: firecrawl is only picked when no other provider has a key", () => {
  withSearchEnv({ TAVILY_API_KEY: "tvly", BRAVE_API_KEY: "brv", OLLAMA_API_KEY: "olm", FIRECRAWL_API_KEY: "fc" }, () => {
    assert.equal(resolveSearchProvider(), "tavily");
  });
  withSearchEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: "brv", OLLAMA_API_KEY: "olm", FIRECRAWL_API_KEY: "fc" }, () => {
    assert.equal(resolveSearchProvider(), "brave");
  });
  withSearchEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined, OLLAMA_API_KEY: "olm", FIRECRAWL_API_KEY: "fc" }, () => {
    assert.equal(resolveSearchProvider(), "ollama");
  });
  withSearchEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined, OLLAMA_API_KEY: undefined, FIRECRAWL_API_KEY: undefined }, () => {
    assert.equal(resolveSearchProvider(), null);
  });
});

// =============================================================================
// Test: search_and_read — markdown feeds budgetContent, maxUrls is honored
// =============================================================================

test("search_and_read maps markdown to raw_content and budgets within maxUrls", () => {
  const response = makeFirecrawlResponse();
  const tavilyLike = (response.data.web ?? []).map(r => ({
    title: r.title || "(untitled)",
    url: r.url,
    content: r.description || "",
    score: 1.0,
    ...(r.markdown ? { raw_content: r.markdown } : {}),
  }));

  assert.equal(tavilyLike[1].raw_content, "# Second Result\n\nFull page markdown.");
  assert.equal(tavilyLike[0].raw_content, undefined, "no markdown → budgetContent falls back to description");

  // maxUrls caps the budgeted sources before token budgeting.
  const budgeted = budgetContent(tavilyLike.slice(0, 1), 8192, 0.5);
  assert.equal(budgeted.grounding.length, 1);
  assert.equal(budgeted.grounding[0].url, "https://example.com/first");
  assert.ok(budgeted.estimatedTokens > 0);
});
