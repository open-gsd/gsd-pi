import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  type EnsureProjectWorkflowMcpConfigResult,
  ensureProjectWorkflowMcpConfig,
} from "./mcp-project-config.js";
import { warmWorkflowMcpProbeInBackground } from "./workflow-mcp-readiness-cache.js";
import { usesWorkflowMcpTransport } from "./workflow-mcp.js";

interface WorkflowMcpAutoPrepContext {
  model?: { provider?: string; baseUrl?: string };
  modelRegistry?: {
    getProviderAuthMode?: (provider: string) => string;
    isProviderRequestReady?: (provider: string) => boolean;
  };
  ui?: Pick<ExtensionContext["ui"], "notify">;
}

interface WorkflowMcpAutoPrepModel {
  provider?: string;
  baseUrl?: string;
}

function withModelOverride(
  ctx: WorkflowMcpAutoPrepContext,
  modelOverride: WorkflowMcpAutoPrepModel | null | undefined,
): WorkflowMcpAutoPrepContext {
  if (!modelOverride) return ctx;

  const provider = modelOverride.provider ?? ctx.model?.provider;
  return {
    model: {
      provider,
      baseUrl: modelOverride.baseUrl
        ?? (provider === ctx.model?.provider ? ctx.model?.baseUrl : undefined),
    },
    modelRegistry: ctx.modelRegistry,
    ui: ctx.ui,
  };
}

function getAuthModeSafe(
  ctx: WorkflowMcpAutoPrepContext,
  provider: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  const getAuthMode = ctx.modelRegistry?.getProviderAuthMode;
  if (typeof getAuthMode !== "function") return undefined;
  try {
    return getAuthMode(provider);
  } catch {
    return undefined;
  }
}

export function shouldAutoPrepareWorkflowMcp(ctx: WorkflowMcpAutoPrepContext): boolean {
  const provider = ctx.model?.provider;
  const baseUrl = ctx.model?.baseUrl;
  const authMode = getAuthModeSafe(ctx, provider);

  if (provider !== "claude-code") return false;
  if (authMode === undefined) return true;
  return usesWorkflowMcpTransport(authMode as any, baseUrl) || authMode === "externalCli";
}

export function prepareWorkflowMcpForProject(
  ctx: WorkflowMcpAutoPrepContext,
  projectRoot: string,
  modelOverride?: WorkflowMcpAutoPrepModel | null,
): EnsureProjectWorkflowMcpConfigResult | null {
  const prepCtx = withModelOverride(ctx, modelOverride);
  if (!shouldAutoPrepareWorkflowMcp(prepCtx)) return null;

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    if (result.status !== "unchanged") {
      prepCtx.ui?.notify?.(`GSD MCP Server Prepared at ${result.configPath}`, "info");
    }
    warmWorkflowMcpProbeInBackground(projectRoot);
    return result;
  } catch (err) {
    prepCtx.ui?.notify?.(
      `Claude Code MCP prep failed: ${err instanceof Error ? err.message : String(err)}. Detected Claude Code model but no workflow MCP. Please run /gsd mcp init . from your project root.`,
      "warning",
    );
    return null;
  }
}
