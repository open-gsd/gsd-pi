// Project/App: gsd-pi
// File Purpose: Derive slice-scoped keywords for decision and knowledge queries.

export const STOPWORDS = new Set(["of", "the", "and", "a", "for", "+", "-", "to", "in", "on", "with", "is", "as", "by"]);

const GENERIC_WORDS = new Set([
  "setup", "integration", "implementation", "testing", "test", "tests",
  "config", "configuration", "init", "initial", "basic", "core",
  "main", "primary", "final", "complete", "finish", "end",
  "start", "begin", "first", "last", "update", "updates",
  "fix", "fixes", "add", "adds", "remove", "removes",
  "create", "creates", "build", "builds", "deploy", "deployment",
  "refactor", "refactoring", "cleanup", "polish", "review",
  "hardening", "validation", "verification", "optimization",
  "improvement", "enhancement", "infrastructure",
]);

const UNIT_ID_PATTERN = /^[smt]\d+$/i;

/**
 * Derive a scope keyword from slice title and optional description.
 * Returns the most specific noun (first non-generic keyword) for decision scoping.
 */
export function deriveSliceScope(sliceTitle: string, sliceDescription?: string): string | undefined {
  const combinedText = sliceDescription
    ? `${sliceTitle} ${sliceDescription}`
    : sliceTitle;

  const words = combinedText
    .split(/[\s&+,;:|/\\()-]+/)
    .map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((word) => word.length >= 2);

  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (GENERIC_WORDS.has(word)) continue;
    if (UNIT_ID_PATTERN.test(word)) continue;
    if (word.length < 3) continue;
    return word;
  }

  return undefined;
}
