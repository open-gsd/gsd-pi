// Project/App: gsd-pi
// File Purpose: Central UAT mode policy for dispatch, tool presentation, and result validation.

import { hasBrowserContractPrefix } from "../shared/browser-contract.js";
import { extractUatType, UAT_TYPE_KEYWORDS } from "./files.js";
import type { UatType } from "./files.js";
import { hasBrowserRequiredText } from "./browser-evidence.js";
import { parseMcpToolName } from "./mcp-tool-name.js";

export type { UatType } from "./files.js";

export type UatVerdict = "PASS" | "FAIL" | "PARTIAL";
export type UatCheckResult = "PASS" | "FAIL" | "NEEDS-HUMAN";
export type UatCheckMode = "artifact" | "runtime" | "browser" | "human-follow-up";

export interface UatPolicyCheck {
  mode: UatCheckMode;
  result: UatCheckResult;
  nonAutomatable?: boolean;
}

export interface UatModePolicy {
  browserTools: boolean;
  partialEligible: boolean;
  passWithHumanFollowUp: boolean;
  requiredAnyModes: readonly UatCheckMode[];
}

export interface UatContentPolicy {
  declaredType: UatType;
  /** False when no parseable `UAT mode:` declaration exists and declaredType defaulted to artifact-driven. */
  modeDeclared: boolean;
  effectiveType: UatType;
  browserRequired: boolean;
  shouldDispatchByDefault: boolean;
}

export const UAT_TYPES: readonly UatType[] = UAT_TYPE_KEYWORDS;

export const UAT_MODE_POLICIES: Readonly<Record<UatType, UatModePolicy>> = {
  "artifact-driven": {
    browserTools: false,
    partialEligible: false,
    passWithHumanFollowUp: false,
    requiredAnyModes: [],
  },
  "browser-executable": {
    browserTools: true,
    partialEligible: false,
    passWithHumanFollowUp: false,
    requiredAnyModes: ["browser"],
  },
  "runtime-executable": {
    browserTools: false,
    partialEligible: false,
    passWithHumanFollowUp: false,
    requiredAnyModes: ["runtime"],
  },
  "live-runtime": {
    browserTools: true,
    partialEligible: true,
    passWithHumanFollowUp: true,
    requiredAnyModes: ["runtime", "browser"],
  },
  mixed: {
    browserTools: true,
    partialEligible: true,
    passWithHumanFollowUp: true,
    requiredAnyModes: [],
  },
  "human-experience": {
    browserTools: true,
    partialEligible: true,
    passWithHumanFollowUp: true,
    requiredAnyModes: [],
  },
};

export function isUatType(value: unknown): value is UatType {
  return typeof value === "string" && (UAT_TYPES as readonly string[]).includes(value);
}

export function getDeclaredUatType(content: string): UatType {
  return extractUatType(content) ?? "artifact-driven";
}

/** Self-contained browser UAT harnesses that manage server lifecycle internally. */
const SELF_CONTAINED_RUNTIME_UAT_COMMAND_RE =
  /\b(?:npm run test:uat|node\s+(?:--check\s+\S+\s+&&\s+)*tests\/browser\/search-uat\.mjs|npx playwright test(?:\s+\S+)?)\b/i;

export function hasSelfContainedRuntimeUatCommand(content: string): boolean {
  return SELF_CONTAINED_RUNTIME_UAT_COMMAND_RE.test(content);
}

function resolveEffectiveUatTypeFromPolicy(
  declaredType: UatType,
  browserRequired: boolean,
  content: string,
): UatType {
  let effectiveType = declaredType === "artifact-driven" && browserRequired
    ? "browser-executable"
    : declaredType;

  // M006/S01 regression: specs often declare browser-executable with localhost
  // preconditions while the Evidence section names a runtime harness such as
  // `npm run test:uat`. Interactive browser_* checks then race a fixed port
  // against the script's own ephemeral server — run the harness instead.
  if (
    effectiveType === "browser-executable" &&
    hasSelfContainedRuntimeUatCommand(content)
  ) {
    effectiveType = "runtime-executable";
  }

  return effectiveType;
}

export function classifyUatContent(content: string): UatContentPolicy {
  return classifyUatContentForRun(content);
}

/**
 * Classify UAT mode for run-uat dispatch. Supplemental context (slice summary,
 * verification excerpts) can name a self-contained harness even when the UAT
 * file only documents a separate server command such as `npm run test:server`.
 */
export function classifyUatContentForRun(content: string, supplementalContext = ""): UatContentPolicy {
  const parsedType = extractUatType(content);
  const declaredType = parsedType ?? "artifact-driven";
  const browserRequired = hasBrowserRequiredText(content);
  const combinedForHarness = supplementalContext.trim()
    ? `${content}\n\n${supplementalContext}`
    : content;
  const effectiveType = resolveEffectiveUatTypeFromPolicy(
    declaredType,
    browserRequired,
    combinedForHarness,
  );

  return {
    declaredType,
    modeDeclared: parsedType !== undefined,
    effectiveType,
    browserRequired,
    shouldDispatchByDefault: effectiveType !== "artifact-driven" || browserRequired,
  };
}

export function escalatesArtifactUatToBrowser(policy: UatContentPolicy): boolean {
  return policy.declaredType === "artifact-driven" && policy.browserRequired;
}

export function shouldEscalateArtifactUatToBrowser(content: string): boolean {
  return escalatesArtifactUatToBrowser(classifyUatContent(content));
}

export function resolveEffectiveUatType(content: string): UatType {
  return classifyUatContent(content).effectiveType;
}

export function shouldDispatchUatForContent(
  content: string,
  prefs: { uat_dispatch?: boolean } | undefined,
): boolean {
  return !!prefs?.uat_dispatch || classifyUatContent(content).shouldDispatchByDefault;
}

export function uatTypeIncludesBrowser(uatType: string | undefined): boolean {
  return isUatType(uatType) && UAT_MODE_POLICIES[uatType].browserTools;
}

export function isUatBrowserToolName(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  const canonicalName = parsed?.toolName ?? toolName;
  if (hasBrowserContractPrefix(canonicalName)) return true;
  return parsed?.toolName === "*" && parsed.serverName.toLowerCase().includes("browser");
}

export function hasUatBrowserToolSurface(activeTools: readonly string[] | undefined): boolean {
  return Array.isArray(activeTools) && activeTools.some(isUatBrowserToolName);
}

export function resolveUatBrowserToolSurface(options: {
  activeTools: readonly string[] | undefined;
  registeredTools?: readonly string[] | undefined;
}): readonly string[] | undefined {
  const surfaces = [options.activeTools, options.registeredTools].filter(Array.isArray);
  if (surfaces.length === 0) return undefined;
  return [...new Set(surfaces.flat())];
}

export function getUatBrowserToolSupportError(options: {
  uatType: UatType;
  activeTools: readonly string[] | undefined;
  registeredTools?: readonly string[] | undefined;
  milestoneId: string;
  sliceId: string;
}): string | null {
  if (!uatTypeIncludesBrowser(options.uatType)) return null;
  const toolSurface = resolveUatBrowserToolSurface(options);
  if (!toolSurface) return null;
  if (hasUatBrowserToolSurface(toolSurface)) return null;

  return `Cannot dispatch browser-backed run-uat for ${options.milestoneId}/${options.sliceId}: UAT mode "${options.uatType}" requires browser tools, but the run-uat tool surface has none. Enable browser tools or change the UAT to a runtime-executable Playwright command, then rerun /gsd auto.`;
}

export function isPartialEligibleUatType(uatType: UatType | undefined): boolean {
  return !!uatType && UAT_MODE_POLICIES[uatType].partialEligible;
}

function modeList(modes: readonly UatCheckMode[]): string {
  if (modes.length === 1) return modes[0]!;
  return modes.slice(0, -1).join(", ") + " or " + modes[modes.length - 1]!;
}

export function validateUatModePolicy(params: {
  uatType: UatType;
  verdict: UatVerdict;
  checks: readonly UatPolicyCheck[];
}): string | null {
  const policy = UAT_MODE_POLICIES[params.uatType];
  const modes = new Set(params.checks.map((check) => check.mode));
  const hasHuman = params.checks.some((check) => check.result === "NEEDS-HUMAN");

  if (params.uatType === "artifact-driven" && hasHuman && params.verdict === "PASS") {
    return "artifact-driven UAT cannot PASS with human-only checks";
  }

  if (
    hasHuman &&
    params.verdict === "PASS" &&
    !policy.passWithHumanFollowUp &&
    !params.checks.every((check) => check.result !== "NEEDS-HUMAN" || check.nonAutomatable === true)
  ) {
    return "NEEDS-HUMAN checks can only coexist with PASS for human-experience, mixed, live-runtime, or explicitly non-automatable checks";
  }

  if (
    policy.requiredAnyModes.length > 0 &&
    !policy.requiredAnyModes.some((mode) => modes.has(mode))
  ) {
    return `${params.uatType} UAT requires ${modeList(policy.requiredAnyModes)} evidence`;
  }

  return null;
}
