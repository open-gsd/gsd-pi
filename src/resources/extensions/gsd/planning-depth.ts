// gsd-pi / Deep planning mode — Helper to set planning_depth in .gsd/PREFERENCES.md.
//
// Persists the user's deep-mode opt-in across sessions. Reads the existing
// preferences file (if any), sets/updates planning_depth (plus the uat_dispatch
// default in deep mode), and writes the file back. Edits the existing
// frontmatter through the yaml Document API so user comments and untouched
// keys survive the write (#2832).

import { existsSync, readFileSync } from "node:fs";
import { Document, parseDocument, isMap } from "yaml";
import { atomicWriteSync } from "./atomic-write.js";
import { clearGSDPreferencesCache, getProjectGSDPreferencesPath } from "./preferences.js";
import { logWarning } from "./workflow-logger.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Set planning_depth in the project's .gsd/PREFERENCES.md.
 * Creates the file if it does not exist. Preserves existing frontmatter
 * keys, comments, and body content. Intended to be called when the user
 * opts into (or out of) deep mode via `/gsd new-project --deep` or similar.
 */
export function setPlanningDepth(
  basePath: string,
  depth: "light" | "deep",
): void {
  mutateProjectPreferences(basePath, (doc) => {
    doc.set("planning_depth", depth);
    if (depth === "deep" && doc.get("uat_dispatch") === undefined) {
      doc.set("uat_dispatch", true);
    }
  });
}

export function ensureWorkflowPreferencesCaptured(basePath: string): void {
  mutateProjectPreferences(basePath, (doc) => {
    doc.set("planning_depth", "deep");
    if (doc.get("uat_dispatch") === undefined) {
      doc.set("uat_dispatch", true);
    }
  });
}

/**
 * Apply `mutate` to the project's PREFERENCES.md frontmatter and persist it.
 * When the file has parseable YAML frontmatter, mutation goes through the
 * yaml Document so comments and untouched keys are preserved. Otherwise the
 * original content is kept as body and a fresh frontmatter block is prepended.
 */
function mutateProjectPreferences(
  basePath: string,
  mutate: (doc: Document) => void,
): void {
  const path = getProjectGSDPreferencesPath(basePath);
  const { doc, body, content } = readProjectPreferencesParts(path);

  let target = doc ?? new Document();
  let bodyOut = body;
  try {
    mutate(target);
    // Round-trip before writing: yaml resolves aliases lazily, so a document
    // with an unresolved alias parses without errors but fails to serialize.
    // Fall back to the fresh-frontmatter path instead of throwing past the
    // caller (the caller only expects the file to gain its defaults).
    target.toString();
  } catch (err) {
    // Unwritable document (e.g. unresolved alias) — don't lose user content.
    // Treat the whole file as a legacy non-frontmatter document and preserve
    // it via the body path; the mutation then applies to fresh frontmatter.
    logWarning("guided", `PREFERENCES.md frontmatter cannot be edited in place — preserving body and rewriting frontmatter: ${err instanceof Error ? err.message : String(err)}`);
    target = new Document();
    mutate(target);
    bodyOut = content ?? "";
  }

  writeFrontmatterDocument(path, target, bodyOut);
}

function readProjectPreferencesParts(path: string): {
  doc: Document | null;
  body: string;
  content: string | null;
} {
  if (!existsSync(path)) {
    return { doc: null, body: "", content: null };
  }
  const content = readFileSync(path, "utf-8");
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    // No frontmatter delimiters — preserve existing content as body.
    return { doc: null, body: content, content };
  }
  const doc = parseDocument(match[1]);
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    // Invalid YAML — don't lose user content. Treat the whole file as a
    // legacy non-frontmatter document and preserve it via the body path.
    // The depth setter then prepends a fresh frontmatter block.
    logWarning("guided", `PREFERENCES.md frontmatter has invalid YAML — preserving body and rewriting frontmatter: ${doc.errors[0]?.message ?? "frontmatter is not a mapping"}`);
    return { doc: null, body: content, content };
  }
  return { doc, body: match[2], content };
}

function writeFrontmatterDocument(
  path: string,
  doc: Document,
  body: string,
): void {
  // Document#toString emits a trailing newline. Strip if present so we control framing.
  const yamlBlock = doc.toString().replace(/\n$/, "");
  const newContent = body
    ? `---\n${yamlBlock}\n---\n\n${body.replace(/^\n+/, "")}`
    : `---\n${yamlBlock}\n---\n`;

  atomicWriteSync(path, newContent, "utf-8");
  clearGSDPreferencesCache();
}
