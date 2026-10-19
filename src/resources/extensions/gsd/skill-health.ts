/**
 * GSD Skill Health — Dashboard, Staleness, and Heal-Skill Integration (#599)
 *
 * Aggregates skill telemetry from metrics.json to surface:
 *   - Per-skill pass/fail rates, token usage, and trends
 *   - Staleness warnings for unused skills
 *   - Declining performance flags
 *   - Heal-skill suggestions (inspired by glittercowboy's heal-skill command)
 *
 * DATA CAVEAT (#2495): metrics record which skills were AVAILABLE to each
 * unit, not SKILL.md reads — recordSkillRead is not wired across the unit
 * dispatch boundary. All per-skill counts below are availability counts and
 * are labeled as such (see availabilityBased on SkillHealthReport). Causation
 * claims about a skill (success drops, token bloat) are not emitted until
 * real read telemetry lands.
 *
 * The heal-skill concept: when an agent deviates from what a skill recommends
 * during execution, detect the drift and propose specific fixes with user
 * approval before applying. This closes the feedback loop that SkillsBench
 * research identified as critical for skill quality.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UnitMetrics, MetricsLedger } from "./metrics.js";
import { formatCost, formatTokenCount, loadLedgerFromDisk } from "./metrics.js";
import { getSkillLastUsed, detectStaleSkills } from "./skill-telemetry.js";
import { gsdHome } from "./gsd-home.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillHealthEntry {
  name: string;
  totalUses: number;
  /** Success rate: units with this skill that completed without retry */
  successRate: number;
  /** Average tokens per unit when this skill is loaded */
  avgTokens: number;
  /** Token trend over recent uses */
  tokenTrend: "stable" | "rising" | "declining";
  /** Timestamp of most recent use */
  lastUsed: number;
  /** Days since last use */
  staleDays: number;
  /** Average cost per unit when this skill is loaded */
  avgCost: number;
  /** Whether this skill is flagged for review */
  flagged: boolean;
  /** Reason for flag, if any */
  flagReason?: string;
}

export interface SkillHealthReport {
  generatedAt: string;
  totalUnitsWithSkills: number;
  skills: SkillHealthEntry[];
  staleSkills: string[];
  decliningSkills: string[];
  suggestions: SkillHealSuggestion[];
  /**
   * True when per-skill counts reflect skill AVAILABILITY (which skills were
   * attached to units), not SKILL.md reads. Always true today: recordSkillRead
   * is not yet wired across the unit dispatch boundary (#2495). Programmatic
   * consumers (web panel, visualizer) should label accordingly when this is set.
   */
  availabilityBased: boolean;
}

export interface SkillHealSuggestion {
  skillName: string;
  trigger: "declining_success" | "rising_tokens" | "high_retry_rate" | "stale";
  message: string;
  severity: "info" | "warning" | "critical";
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default staleness threshold in days */
const DEFAULT_STALE_DAYS = 60;

/** Success rate below this triggers a flag */
const SUCCESS_RATE_THRESHOLD = 0.70;

/** Token increase percentage that triggers a "rising" flag */
const TOKEN_RISE_THRESHOLD = 0.20;

/** Minimum uses before trend analysis kicks in */
const MIN_USES_FOR_TREND = 5;

/** Window size for trend comparison (compare last N to previous N) */
const TREND_WINDOW = 5;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a full skill health report from metrics data.
 */
export function generateSkillHealthReport(basePath: string, staleDays?: number): SkillHealthReport {
  const ledger = loadLedgerFromDisk(basePath);
  const unitsWithSkills = (ledger?.units ?? []).filter(u => u.skills && u.skills.length > 0);
  const threshold = staleDays ?? DEFAULT_STALE_DAYS;

  const skillMap = aggregateBySkill(unitsWithSkills);
  const skills = Array.from(skillMap.values()).sort((a, b) => b.totalUses - a.totalUses);
  const staleSkills = detectStaleSkills(unitsWithSkills, threshold);
  const decliningSkills = skills.filter(s => s.flagged).map(s => s.name);
  const suggestions = generateSuggestions(skills, staleSkills);

  return {
    generatedAt: new Date().toISOString(),
    totalUnitsWithSkills: unitsWithSkills.length,
    skills,
    staleSkills,
    decliningSkills,
    suggestions,
    availabilityBased: true,
  };
}

/**
 * Format a skill health report for terminal display.
 */
export function formatSkillHealthReport(report: SkillHealthReport): string {
  const lines: string[] = [];

  lines.push("Skill Health Report");
  lines.push("═".repeat(60));
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Units with skill data: ${report.totalUnitsWithSkills}`);
  lines.push("");

  if (report.skills.length === 0) {
    lines.push("No skill telemetry data yet. Run auto-mode to start collecting.");
    lines.push("Skill availability is recorded per-unit in metrics.json.");
    return lines.join("\n");
  }

  // Main table — labeled for what the data actually is: each row counts the
  // units the skill was AVAILABLE to, not SKILL.md reads (#2495).
  lines.push("Skill                    Units  Unit Success%  Avg Unit Tokens  Trend     Last Available");
  lines.push("─".repeat(94));

  for (const s of report.skills) {
    const name = s.name.padEnd(24).slice(0, 24);
    const uses = String(s.totalUses).padStart(5);
    const success = `${Math.round(s.successRate * 100)}%`.padStart(13);
    const tokens = formatTokenCount(s.avgTokens).padStart(15);
    const trend = s.tokenTrend.padEnd(10);
    const lastUsed = s.staleDays === 0 ? "today" :
      s.staleDays === 1 ? "1 day ago" :
      `${s.staleDays} days ago`;
    const flag = s.flagged ? " ⚠" : "";
    lines.push(`${name}${uses}${success}${tokens}  ${trend}${lastUsed}${flag}`);
  }

  lines.push("");
  lines.push("Note: unit counts reflect skills AVAILABLE to each unit, not SKILL.md reads");
  lines.push("(per-skill read telemetry is a follow-up — #2495).");

  // Stale skills
  if (report.staleSkills.length > 0) {
    lines.push("");
    lines.push("Stale Skills (not available for 60+ days):");
    for (const name of report.staleSkills) {
      lines.push(`  ⏸  ${name}`);
    }
  }

  // Flagged skills
  if (report.decliningSkills.length > 0) {
    lines.push("");
    lines.push("Flagged Skills (flagged for review):");
    for (const name of report.decliningSkills) {
      const entry = report.skills.find(s => s.name === name);
      if (entry?.flagReason) {
        lines.push(`  ⚠  ${name}: ${entry.flagReason}`);
      }
    }
  }

  // Suggestions
  if (report.suggestions.length > 0) {
    lines.push("");
    lines.push("Heal Suggestions:");
    for (const sug of report.suggestions) {
      const icon = sug.severity === "critical" ? "🔴" : sug.severity === "warning" ? "🟡" : "🔵";
      lines.push(`  ${icon} ${sug.skillName}: ${sug.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a detailed health view for a single skill.
 */
export function formatSkillDetail(basePath: string, skillName: string): string {
  const ledger = loadLedgerFromDisk(basePath);
  const units = (ledger?.units ?? []).filter(u => u.skills?.includes(skillName));
  const lines: string[] = [];

  lines.push(`Skill Detail: ${skillName}`);
  lines.push("═".repeat(50));

  if (units.length === 0) {
    lines.push("No availability data recorded for this skill.");
    return lines.join("\n");
  }

  const totalTokens = units.reduce((s, u) => s + u.tokens.total, 0);
  const totalCost = units.reduce((s, u) => s + u.cost, 0);
  const avgTokens = Math.round(totalTokens / units.length);
  const avgCost = totalCost / units.length;

  // Labeled for what the data is: units the skill was available to, not reads (#2495).
  lines.push(`Units with skill available: ${units.length}`);
  lines.push(`Total unit tokens: ${formatTokenCount(totalTokens)}`);
  lines.push(`Total unit cost: ${formatCost(totalCost)}`);
  lines.push(`Avg unit tokens: ${formatTokenCount(avgTokens)}`);
  lines.push(`Avg unit cost: ${formatCost(avgCost)}`);
  lines.push("");
  lines.push("Note: counts reflect units where the skill was available, not SKILL.md reads (#2495).");

  // Recent units
  lines.push("Recent units:");
  const recent = units.slice(-10).reverse();
  for (const u of recent) {
    const date = new Date(u.finishedAt).toISOString().slice(0, 10);
    lines.push(`  ${date}  ${u.id.padEnd(20)}  ${formatTokenCount(u.tokens.total).padStart(8)} tokens  ${formatCost(u.cost)}`);
  }

  // Check for SKILL.md existence across GSD bundled, ecosystem, and Claude directories.
  const candidatePaths = [
    join(gsdHome(), "agent", "skills", skillName, "SKILL.md"),
    join(homedir(), ".agents", "skills", skillName, "SKILL.md"),
    join(homedir(), ".claude", "skills", skillName, "SKILL.md"),
  ];
  const skillPath = candidatePaths.find(p => existsSync(p));
  if (skillPath) {
    const stat = statSync(skillPath);
    lines.push("");
    lines.push(`SKILL.md: ${skillPath}`);
    lines.push(`Last modified: ${stat.mtime.toISOString().slice(0, 10)}`);
  }

  return lines.join("\n");
}

/**
 * Build the heal-skill prompt for a post-unit hook.
 * This is the GSD-integrated version of glittercowboy's heal-skill concept.
 *
 * The prompt instructs the agent to:
 * 1. Detect which skill was loaded during the completed unit
 * 2. Analyze whether the agent deviated from the skill's instructions
 * 3. If deviations found, propose specific fixes (not auto-apply)
 * 4. Write suggestions to a review queue for human approval
 */
export function buildHealSkillPrompt(unitId: string): string {
  return `## Skill Heal Analysis

Analyze the just-completed unit (${unitId}) for skill drift.

### Steps

1. **Identify loaded skill**: Check which SKILL.md file was read during this unit.
   If no skill was loaded, write "No skill loaded — skipping heal analysis" and stop.

2. **Read the skill**: Load the SKILL.md that was used.

3. **Compare execution to skill guidance**: Review what the agent actually did vs what
   the skill recommended. Look for:
   - API patterns the skill recommended that the agent did differently
   - Error handling approaches the skill specified but the agent bypassed
   - Conventions the skill documented that the agent ignored
   - Outdated instructions in the skill that caused errors or retries

4. **Assess drift severity**:
   - **None**: Agent followed skill correctly → write "No drift detected" to the summary and stop
   - **Minor**: Agent found a better approach but skill isn't wrong → capture it with \`capture_thought\` (category \`pattern\`); do not edit KNOWLEDGE.md
   - **Significant**: Skill has outdated or incorrect guidance → propose fix

5. **If significant drift found**, write a heal suggestion to \`.gsd/skill-review-queue.md\`:

\`\`\`markdown
### {skill-name} (flagged {date})
- **Unit:** ${unitId}
- **Issue:** {1-2 sentence description}
- **Root cause:** {outdated API / incorrect pattern / missing context}
- **Proposed fix:**
  - File: SKILL.md
  - Section: {section name}
  - Current: {quote the incorrect text}
  - Suggested: {the corrected text}
- **Action:** [ ] Reviewed [ ] Updated [ ] Dismissed
\`\`\`

**Important:** Do NOT modify the skill directly. Write the suggestion to the review queue.
The SkillsBench research shows that human-curated skills outperform auto-generated ones by +16.2pp.
The human review step is what makes this valuable.`;
}

/**
 * Compute stale skills that should be added to avoid_skills.
 * Returns only skills not already in the avoid list.
 */
export function computeStaleAvoidList(
  basePath: string,
  currentAvoidList: string[],
  staleDays?: number,
): string[] {
  const ledger = loadLedgerFromDisk(basePath);
  if (!ledger) return [];
  const units = ledger.units.filter(u => u.skills && u.skills.length > 0);
  const stale = detectStaleSkills(units, staleDays ?? DEFAULT_STALE_DAYS);
  const avoidSet = new Set(currentAvoidList);

  return stale.filter(s => !avoidSet.has(s));
}

// ─── Internals ────────────────────────────────────────────────────────────────

function aggregateBySkill(units: UnitMetrics[]): Map<string, SkillHealthEntry> {
  const map = new Map<string, { uses: UnitMetrics[] }>();

  for (const u of units) {
    if (!u.skills) continue;
    for (const skill of u.skills) {
      let entry = map.get(skill);
      if (!entry) {
        entry = { uses: [] };
        map.set(skill, entry);
      }
      entry.uses.push(u);
    }
  }

  const result = new Map<string, SkillHealthEntry>();
  const now = Date.now();

  for (const [name, { uses }] of map) {
    const totalTokens = uses.reduce((s, u) => s + u.tokens.total, 0);
    const totalCost = uses.reduce((s, u) => s + u.cost, 0);
    const avgTokens = Math.round(totalTokens / uses.length);
    const avgCost = totalCost / uses.length;

    // Success rate: units that didn't have excessive retries (proxy: low tool call count relative to messages)
    // Without direct retry tracking, use a heuristic: success if toolCalls < assistantMessages * 20
    const successCount = uses.filter(u => u.toolCalls < u.assistantMessages * 20).length;
    const successRate = uses.length > 0 ? successCount / uses.length : 1;

    // Token trend
    const tokenTrend = computeTokenTrend(uses);

    // Last used
    const lastUsed = Math.max(...uses.map(u => u.finishedAt));
    const staleDays = Math.floor((now - lastUsed) / (24 * 60 * 60 * 1000));

    // Flag conditions
    let flagged = false;
    let flagReason: string | undefined;

    if (uses.length >= MIN_USES_FOR_TREND) {
      if (successRate < SUCCESS_RATE_THRESHOLD) {
        flagged = true;
        flagReason = `Success rate ${Math.round(successRate * 100)}% (below ${Math.round(SUCCESS_RATE_THRESHOLD * 100)}% threshold)`;
      } else if (tokenTrend === "rising") {
        flagged = true;
        flagReason = `Token usage trending upward (${Math.round(TOKEN_RISE_THRESHOLD * 100)}%+ increase)`;
      }
    }

    result.set(name, {
      name,
      totalUses: uses.length,
      successRate,
      avgTokens,
      tokenTrend,
      lastUsed,
      staleDays,
      avgCost,
      flagged,
      flagReason,
    });
  }

  return result;
}

function computeTokenTrend(uses: UnitMetrics[]): "stable" | "rising" | "declining" {
  if (uses.length < MIN_USES_FOR_TREND * 2) return "stable";

  // Sort by start time
  const sorted = [...uses].sort((a, b) => a.startedAt - b.startedAt);
  const window = Math.min(TREND_WINDOW, Math.floor(sorted.length / 2));

  const recent = sorted.slice(-window);
  const previous = sorted.slice(-window * 2, -window);

  const recentAvg = recent.reduce((s, u) => s + u.tokens.total, 0) / recent.length;
  const previousAvg = previous.reduce((s, u) => s + u.tokens.total, 0) / previous.length;

  if (previousAvg === 0) return "stable";

  const change = (recentAvg - previousAvg) / previousAvg;

  if (change > TOKEN_RISE_THRESHOLD) return "rising";
  if (change < -TOKEN_RISE_THRESHOLD) return "declining";
  return "stable";
}

function generateSuggestions(_skills: SkillHealthEntry[], staleSkills: string[]): SkillHealSuggestion[] {
  const suggestions: SkillHealSuggestion[] = [];

  // NOTE (#2495): the declining_success and rising_tokens suggestions are
  // deliberately not emitted. Metrics record skill AVAILABILITY per unit
  // (recordSkillRead is not wired across the unit dispatch boundary), so
  // unit-derived success rates and token trends say nothing about the skill
  // itself — asserting "inefficient execution patterns" or a success drop on
  // this data is fiction and polluted the heal queue. They return when real
  // per-skill read telemetry lands (recordSkillRead wiring follow-up).

  for (const name of staleSkills) {
    suggestions.push({
      skillName: name,
      trigger: "stale",
      message: `Not available in recent units (${DEFAULT_STALE_DAYS}+ days). Consider archiving or updating.`,
      severity: "info",
    });
  }

  return suggestions;
}
