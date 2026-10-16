import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFirecrawlResult,
  mapFreshnessToFirecrawl,
  type FirecrawlSearchResponse,
} from "../firecrawl.ts";

describe("search-the-web firecrawl", () => {
  test("normalizes a data.web result into the shared result shape", () => {
    assert.deepEqual(
      normalizeFirecrawlResult({
        title: "ML Research Paper",
        url: "https://arxiv.org/abs/2024.12345",
        description: "Latest advances in machine learning",
        markdown: "# ML Research Paper",
      }),
      {
        title: "ML Research Paper",
        url: "https://arxiv.org/abs/2024.12345",
        description: "Latest advances in machine learning",
      },
    );
  });

  test("fills empty titles and descriptions instead of dropping results", () => {
    assert.deepEqual(
      normalizeFirecrawlResult({ title: "", url: "https://example.com", description: "" }),
      { title: "(untitled)", url: "https://example.com", description: "" },
    );
  });

  test("maps Brave freshness values to Firecrawl tbs ranges", () => {
    assert.equal(mapFreshnessToFirecrawl("pd"), "qdr:d");
    assert.equal(mapFreshnessToFirecrawl("pw"), "qdr:w");
    assert.equal(mapFreshnessToFirecrawl("pm"), "qdr:m");
    assert.equal(mapFreshnessToFirecrawl("py"), "qdr:y");
  });

  test("returns null for missing or unrecognized freshness", () => {
    assert.equal(mapFreshnessToFirecrawl(null), null);
    assert.equal(mapFreshnessToFirecrawl("bogus"), null);
  });

  test("reads results from the v2 search response envelope", () => {
    const response: FirecrawlSearchResponse = {
      success: true,
      data: {
        web: [
          {
            title: "Result",
            url: "https://example.com",
            description: "desc",
          },
        ],
      },
    };
    const normalized = (response.data.web ?? []).map(normalizeFirecrawlResult);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].url, "https://example.com");
    assert.equal((response.data.web ?? []).length, 1);
  });

  test("tolerates a missing web array", () => {
    const response: FirecrawlSearchResponse = { success: true, data: {} };
    assert.deepEqual((response.data.web ?? []).map(normalizeFirecrawlResult), []);
  });
});
