/**
 * Actionable remediation hints when auto-mode pauses on provider/model errors.
 * Render with formatGuidance from the Guidance module.
 */

import type { Guidance } from "./guidance.js";

export interface ProviderErrorGuidanceInput {
  errorMsg: string;
  provider?: string;
  modelId?: string;
  unitType?: string;
  /** Display path to the preferences file the user should edit */
  preferencesPath?: string;
  hasConfiguredFallbacks?: boolean;
}

export type ProviderErrorGuidance = Guidance;

/** Map auto unit types to the `models:` key in PREFERENCES.md. */
export function unitTypeToPrefsPhaseKey(unitType: string | undefined): string | undefined {
  if (!unitType) return undefined;

  switch (unitType) {
    case "research-milestone":
    case "research-slice":
    case "research-project":
      return "research";
    case "plan-milestone":
    case "plan-slice":
    case "refine-slice":
    case "replan-slice":
      return "planning";
    case "discuss-milestone":
    case "discuss-slice":
    case "discuss-project":
    case "discuss-requirements":
    case "workflow-preferences":
    case "research-decision":
      return "discuss";
    case "execute-task":
    case "execute-task-simple":
    case "reactive-execute":
      return "execution";
    case "complete-slice":
    case "complete-milestone":
    case "validate-milestone":
    case "run-uat":
      return "completion";
    default:
      return undefined;
  }
}

function defaultAlternateModel(provider: string | undefined, modelId: string | undefined): string | undefined {
  if (!provider || !modelId) return undefined;
  if (provider === "google-antigravity" && /gemini-3(?:\.1)?-pro-(?:high|low)/i.test(modelId)) {
    return `${provider}/gemini-3-flash`;
  }
  return undefined;
}

function isGeminiCliDeprecatedError(errorMsg: string): boolean {
  return (
    /IneligibleTierError/i.test(errorMsg)
    || /UNSUPPORTED_CLIENT/i.test(errorMsg)
    || /no longer supported for Gemini Code Assist for individuals/i.test(errorMsg)
    || /migrate to the Antigravity suite/i.test(errorMsg)
  );
}

function resolveGeminiCliDeprecationGuidance(input: ProviderErrorGuidanceInput): ProviderErrorGuidance {
  const { provider, modelId, unitType } = input;
  const modelLabel =
    provider && modelId ? `${provider}/${modelId}` : modelId ?? provider ?? "google-gemini-cli";
  const unitSuffix = unitType ? ` during ${unitType}` : "";

  return {
    summary:
      `Provider error on ${modelLabel}${unitSuffix}. ` +
      "Google no longer supports Gemini CLI for individual-tier users — migrate to Antigravity CLI.",
    steps: [
      "Install Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash",
      "Run `agy` in a terminal and complete authentication.",
      "In GSD, run `/login` and select Antigravity, or restart GSD to auto-migrate when `agy` is on PATH.",
      "Run /gsd next to resume the paused unit.",
    ],
  };
}

/**
 * Build concrete next steps for a provider/model rejection pause.
 */
export function resolveProviderErrorGuidance(input: ProviderErrorGuidanceInput): ProviderErrorGuidance {
  const {
    errorMsg,
    provider,
    modelId,
    unitType,
    preferencesPath,
    hasConfiguredFallbacks,
  } = input;

  if (isGeminiCliDeprecatedError(errorMsg)) {
    return resolveGeminiCliDeprecationGuidance(input);
  }

  const modelLabel =
    provider && modelId ? `${provider}/${modelId}` : modelId ?? provider ?? "current model";
  const phaseKey = unitTypeToPrefsPhaseKey(unitType);
  const prefsFile = preferencesPath ?? ".gsd/PREFERENCES.md";
  const alternate = defaultAlternateModel(provider, modelId);

  let likelyCause = "The provider rejected the request payload for this model.";
  if (/invalid argument/i.test(errorMsg)) {
    likelyCause =
      "The provider rejected the request as an invalid argument — often a model/config mismatch rather than auth or rate limits.";
  }
  if (/unknown name ["']const["']/i.test(errorMsg)) {
    likelyCause =
      "Cloud Code Assist rejected a tool schema (JSON Schema `const` in enum fields). This usually happens with Claude models on Antigravity/Gemini CLI; update gsd-pi or switch the phase model to a Gemini variant.";
  }
  if (/unknown name ["']patternProperties["']/i.test(errorMsg)) {
    likelyCause =
      "Cloud Code Assist rejected a tool schema (JSON Schema `patternProperties`, often from Type.Record fields). Update gsd-pi to the latest build or switch the phase model to a Gemini variant.";
  }
  if (/input_schema: JSON schema is invalid/i.test(errorMsg)) {
    likelyCause =
      "Cloud Code Assist rejected a tool schema when translating to Claude's input_schema (unsupported nested anyOf/oneOf/allOf or other JSON Schema keywords). Update gsd-pi or switch the phase model to a Gemini variant.";
  }
  if (alternate && /gemini-3(?:\.1)?-pro-(?:high|low)/i.test(modelId ?? "")) {
    likelyCause +=
      " Antigravity Gemini 3.1 Pro High/Low frequently hits this when thinking is disabled.";
  }

  const unitSuffix = unitType ? ` during ${unitType}` : "";
  const summary = `Provider error on ${modelLabel}${unitSuffix}. ${likelyCause}`;

  const steps: string[] = [];

  if (phaseKey && alternate) {
    steps.push(
      `Edit ${prefsFile} and set models.${phaseKey} to ${alternate} (or another model that works in this project).`,
    );
  } else if (phaseKey) {
    steps.push(
      `Edit ${prefsFile} and change models.${phaseKey} to a different provider/model for this phase.`,
    );
  } else {
    steps.push(`Edit ${prefsFile} and update the model for this workflow phase.`);
  }

  if (!hasConfiguredFallbacks && phaseKey) {
    steps.push(
      `Optional: add fallbacks under models.${phaseKey} so GSD can switch automatically on the next failure.`,
    );
  }

  steps.push("Run /gsd next to resume the paused unit.");

  return { summary, steps };
}

