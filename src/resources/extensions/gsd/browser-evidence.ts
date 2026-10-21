// Project/App: gsd-pi
// File Purpose: Shared browser-observable UAT requirement and evidence detection.

import { BROWSER_EVIDENCE_SIGNAL_TOOL_NAMES } from "../shared/browser-contract.js";

// Alternation fragment over the contract's evidence-signal names, e.g.
// `browser_(?:assert|batch|...)`. The names are `browser_`-prefixed
// identifiers (pinned by tests/browser-contract.test.ts), so no escaping is
// needed.
const BROWSER_TOOL_SIGNAL = `browser_(?:${
  BROWSER_EVIDENCE_SIGNAL_TOOL_NAMES.map((name) => name.slice("browser_".length)).join("|")
})`;

// `snapshot` stays a bare browser signal: hasBrowserRequiredText scans physical
// lines, so requiring nearby context broke wrapped ("Take a rendered page\nsnapshot")
// and labeled ("Browser: take a snapshot") UAT lines, plus vocabulary like
// "accessibility snapshot". Instead, drop the match when the snapshot is
// database/backup work (#2081, #766 follow-up): a DB-CLI verb immediately follows
// ("snapshot create", "snapshot restore-check"), or a database-ish word shares the
// clause ("database snapshot", "purge / snapshot / export"). Clause-bounded like
// NEGATED_BROWSER_CLAUSE_RE.
const DB_SNAPSHOT_TERMS = String.raw`(?:databases?|db|backups?|export)`;
const DB_SNAPSHOT_VERB = String.raw`(?:create|restore|export|purge|import|prune|verify)`;

export const BROWSER_REQUIREMENT_RE = new RegExp(
  String.raw`\b(?:file://|localhost|playwright|chrome|screenshot|${BROWSER_TOOL_SIGNAL})\b` +
    String.raw`|(?<!\b${DB_SNAPSHOT_TERMS}\b[^.;:!?]{0,60})\bsnapshot\b(?!\s+(?:${DB_SNAPSHOT_VERB})\b)(?![^.;:!?]{0,60}\b${DB_SNAPSHOT_TERMS}\b)` +
    String.raw`|\bin\s+(?:the\s+)?browser\b` +
    String.raw`|\b(?:open|launch|navigate|load|visit|serve|start)\b.{0,80}\b(?:browser|page|localhost|file://)\b|\bbrowser\s+(?:check|session|test|uat|tool|automation|interaction|flow)\b`,
  "i",
);
export const NO_BROWSER_EVIDENCE_RE = /\b(?:no|without|not|wasn'?t|isn'?t)\s+(?:automated\s+)?(?:live\s+)?browser(?:\s+(?:session|test|uat))?|\bno\s+automated\s+browser\b|\bnot\s+conducted\b/i;
export const BROWSER_RUNTIME_RE = new RegExp(
  String.raw`\b(?:browser|playwright|chrome|camoufox|${BROWSER_TOOL_SIGNAL}|screenshot|snapshot|file://|localhost)\b`,
  "i",
);
export const BROWSER_ACTION_RE = /\b(?:open(?:ed)?|navigate(?:d)?|click(?:ed)?|type(?:d)?|reload(?:ed)?|capture(?:d)?|screenshot|snapshot)\b/i;
export const BROWSER_ASSERTION_RE = /\b(?:assert(?:ed|ion)?|observed|confirmed|verified|expected|visible|text|count|label|strikethrough|localstorage|screenshot|snapshot|passed)\b/i;
const NON_REQUIREMENT_BROWSER_HEADING_RE = /^(?:not\s+proven|not\s+covered|out\s+of\s+scope|deferred|follow-?ups?|known\s+limitations|notes\s+for\s+tester)\b/i;
const NON_REQUIREMENT_BROWSER_LINE_RE = /\b(?:deferred|not\s+proven|not\s+covered|out\s+of\s+scope|future\s+slice|follow-?up|no\s+(?:live\s+)?browser|without\s+(?:a\s+)?browser|not\s+(?:a\s+)?browser)\b/i;
// The negations above only fire when the negator sits directly beside "browser".
// A negated *list* — "no runtime behavior, server, UI, or browser interaction is
// involved" — separates them, so the line fell through and matched
// `browser interaction` as a requirement. That escalated a slice whose UAT said
// browsers were irrelevant into one demanding browser verification. Bounded to a
// single clause so a genuine requirement in the next sentence still counts.
const NEGATED_BROWSER_CLAUSE_RE = /\b(?:no|without|not)\b[^.;:!?]{0,60}\bbrowser\b/i;

export function compactTextParts(parts: Array<string | string[] | null | undefined>): string {
  return parts.flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

export function hasBrowserRequiredText(text: string): boolean {
  let inNonRequirementSection = false;
  let nonRequirementDepth = 0;
  for (const line of text.split(/\r?\n/)) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const depth = headingMatch[1]!.length;
      const title = headingMatch[2] ?? "";
      // Only update section context when at the same or higher level than the
      // heading that opened the non-requirement zone. A sub-heading deeper than
      // the opening heading must not escape or re-enter the zone on its own.
      if (!inNonRequirementSection || depth <= nonRequirementDepth) {
        inNonRequirementSection = NON_REQUIREMENT_BROWSER_HEADING_RE.test(title);
        nonRequirementDepth = inNonRequirementSection ? depth : 0;
      }
      // Check the heading title itself — section state is already updated, so
      // we correctly skip headings that opened a non-requirement zone.
      if (!inNonRequirementSection && BROWSER_REQUIREMENT_RE.test(title)) return true;
      continue;
    }
    if (
      inNonRequirementSection ||
      NON_REQUIREMENT_BROWSER_LINE_RE.test(line) ||
      NEGATED_BROWSER_CLAUSE_RE.test(line)
    ) continue;
    if (BROWSER_REQUIREMENT_RE.test(line)) return true;
  }
  return false;
}

export function hasBrowserEvidenceText(text: string): boolean {
  if (!text.trim()) return false;
  return text.split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .some((chunk) => !NO_BROWSER_EVIDENCE_RE.test(chunk) &&
      BROWSER_RUNTIME_RE.test(chunk) &&
      BROWSER_ACTION_RE.test(chunk) &&
      BROWSER_ASSERTION_RE.test(chunk));
}

function markdownTableCells(line: string): string[] {
  if (!line.trimStart().startsWith("|")) return [];
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function hasPassedStructuredBrowserUatEvidenceText(text: string): boolean {
  if (!/\bverdict:\s*PASS\b/i.test(text)) return false;
  return text.split(/\r?\n/).some((line) => {
    const cells = markdownTableCells(line);
    if (cells.length < 4) return false;
    const [, mode, result, evidence] = cells;
    return /^browser$/i.test(mode ?? "") && /^PASS$/i.test(result ?? "") &&
      /(?:^|<br>)\s*browser:/i.test(evidence ?? "");
  });
}

function evidenceSucceeded(record: Record<string, unknown>): boolean {
  if (record.ok === true) return true;
  const status = String(record.status ?? record.result ?? "").toLowerCase();
  return status === "success" || status === "pass" || status === "passed";
}

function evidenceFailed(record: Record<string, unknown>): boolean {
  if (record.ok === false) return true;
  const status = String(record.status ?? record.result ?? "").toLowerCase();
  return status === "error" || status === "fail" || status === "failed";
}

export function browserTimelineHasNavigateAndAssert(value: unknown): boolean {
  let navigated = false;
  let asserted = false;

  const visit = (candidate: unknown, parentFailed = false, parentSucceeded = false): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, parentFailed, parentSucceeded);
      return;
    }
    const record = candidate as Record<string, unknown>;
    const failed = parentFailed || evidenceFailed(record);
    const action = String(record.action ?? record.tool ?? "").toLowerCase();
    const succeeded = parentSucceeded || evidenceSucceeded(record);
    if (!failed && succeeded) {
      if (action === "navigate" || action === "browser_navigate") navigated = true;
      if (action === "assert" || action === "browser_assert") asserted = true;
    }
    const batchSucceeded = parentSucceeded || (!failed && succeeded && action === "browser_batch");
    for (const child of Object.values(record)) visit(child, failed, batchSucceeded);
  };

  visit(value);
  return navigated && asserted;
}
