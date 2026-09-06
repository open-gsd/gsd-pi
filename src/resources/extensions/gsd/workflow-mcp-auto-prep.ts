import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  type EnsureProjectWorkflowMcpConfigResult,
  ensureProjectWorkflowMcpConfig,
} from "./mcp-project-config.js";
import { warmWorkflowMcpProbeInBackground } from "./workflow-mcp-readiness-cache.js";

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

// Provider is irrelevant here: project .mcp.json is also useful for direct
// `claude` CLI usage. The .gsd directory gate below avoids dirtying non-GSD repos.
export function shouldAutoPrepareWorkflowMcp(_ctx: WorkflowMcpAutoPrepContext): boolean {
  return true;
}

export function prepareWorkflowMcpForProject(
  ctx: WorkflowMcpAutoPrepContext,
  projectRoot: string,
  _modelOverride?: WorkflowMcpAutoPrepModel | null,
): EnsureProjectWorkflowMcpConfigResult | null {
  if (!shouldAutoPrepareWorkflowMcp(ctx)) return null;

  if (!existsSync(join(projectRoot, ".gsd"))) return null;

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    if (result.status !== "unchanged") {
      ctx.ui?.notify?.(`GSD MCP Server Prepared at ${result.configPath}`, "info");
    }
    warmWorkflowMcpProbeInBackground(projectRoot);
    return result;
  } catch (err) {
    ctx.ui?.notify?.(
      `Claude Code MCP prep failed: ${err instanceof Error ? err.message : String(err)}. Please run /gsd mcp init . from your project root.`,
      "warning",
    );
    return null;
  }
}
