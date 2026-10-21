import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRequiredWorkflowToolsForUnit } from "./unit-tool-contracts.js";
import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import {
  supportsStructuredQuestions,
  usesWorkflowMcpTransport,
} from "./question-transport.js";
import {
  WORKFLOW_TOOL_SURFACE_NAMES,
  isWorkflowToolSurfaceName,
} from "./workflow-tool-surface.js";

export { supportsStructuredQuestions, usesWorkflowMcpTransport };

type WorkflowExecutorsModule = typeof import("./tools/workflow-tool-executors.js");

export interface WorkflowMcpLaunchConfig {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkflowCapabilityOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  surface?: string;
  unitType?: string;
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  baseUrl?: string;
  activeTools?: string[];
}

/** Session cwd may be a milestone worktree; MCP config and server discovery use the project root. */
export function resolveWorkflowMcpProjectRoot(sessionCwd: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(resolve(sessionCwd));
  } catch {
    resolved = resolve(sessionCwd);
  }

  return resolveWorktreeProjectRoot(resolved);
}

/** Workflow MCP tools are validated by transport compatibility, not pi tool-compat profiles. */
export function isWorkflowMcpSurfaceTool(toolName: string): boolean {
  return isWorkflowToolSurfaceName(toolName);
}

function parseLookupOutput(output: Buffer | string): string {
  return output
    .toString()
    .trim()
    .split(/\r?\n/)[0] ?? "";
}

function parseJsonEnv<T>(env: NodeJS.ProcessEnv, name: string): T | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

function lookupCommand(command: string, platform: NodeJS.Platform = process.platform): string | null {
  const lookup = platform === "win32" ? `where ${command}` : `which ${command}`;
  try {
    const resolved = parseLookupOutput(execSync(lookup, { timeout: 5_000, stdio: "pipe" }));
    return resolved || null;
  } catch {
    return null;
  }
}

const gsdPiRepoRootCache = new Map<string, string | null>();

function findGsdPiRepoRoot(startPath: string): string | null {
  let current: string;
  try {
    current = realpathSync(resolve(startPath));
  } catch {
    current = resolve(startPath);
  }

  const cacheKey = current;
  if (gsdPiRepoRootCache.has(cacheKey)) {
    return gsdPiRepoRootCache.get(cacheKey) ?? null;
  }

  while (true) {
    const distCli = resolve(current, "packages", "mcp-server", "dist", "cli.js");
    if (existsSync(distCli)) {
      gsdPiRepoRootCache.set(cacheKey, current);
      return current;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  gsdPiRepoRootCache.set(cacheKey, null);
  return null;
}

function findWorkflowCliFromAncestorPath(startPath: string): string | null {
  const repoRoot = findGsdPiRepoRoot(startPath);
  if (!repoRoot) return null;
  return resolve(repoRoot, "packages", "mcp-server", "dist", "cli.js");
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getBundledWorkflowMcpCliPath(env: NodeJS.ProcessEnv): string | null {
  const envAnchors = [
    env.GSD_BIN_PATH?.trim(),
    env.GSD_CLI_PATH?.trim(),
    env.GSD_WORKFLOW_PATH?.trim(),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const anchor of envAnchors) {
    const candidate = findWorkflowCliFromAncestorPath(anchor);
    if (candidate) return candidate;
  }

  const repoRoot = findGsdPiRepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (repoRoot) {
    const fromRepo = firstExistingPath([
      resolve(repoRoot, "packages", "mcp-server", "dist", "cli.js"),
      resolve(repoRoot, "packages", "mcp-server", "src", "cli.ts"),
    ]);
    if (fromRepo) return fromRepo;
  }

  return firstExistingPath([
    resolve(fileURLToPath(new URL("../../../../packages/mcp-server/dist/cli.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../../packages/mcp-server/dist/cli.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../packages/mcp-server/src/cli.ts", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../../packages/mcp-server/src/cli.ts", import.meta.url))),
  ]);
}

export function getBundledWorkflowExecutorModulePath(): string | null {
  const repoRoot = findGsdPiRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    ...(repoRoot
      ? [
          resolve(repoRoot, "src", "resources", "extensions", "gsd", "tools", "workflow-tool-executors.ts"),
          resolve(repoRoot, "dist", "resources", "extensions", "gsd", "tools", "workflow-tool-executors.js"),
        ]
      : []),
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js", import.meta.url))),
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.ts", import.meta.url))),
  ];

  return firstExistingPath(candidates);
}

function workflowExecutorModuleImportUrl(modulePath: string): string {
  if (modulePath.startsWith("file:")) return modulePath;
  return pathToFileURL(resolve(modulePath)).href;
}

function isWorkflowExecutorsModule(value: unknown): value is WorkflowExecutorsModule {
  if (!value || typeof value !== "object") return false;
  const module = value as WorkflowExecutorsModule;
  return typeof module.executeSummarySave === "function"
    && typeof module.executeSkipSlice === "function";
}

/** Load workflow-tool-executors for in-process tools and MCP bridge env wiring. */
export async function importWorkflowExecutorsModule(): Promise<WorkflowExecutorsModule> {
  const attempts: string[] = [];
  const candidates: string[] = [];
  const explicit = process.env.GSD_WORKFLOW_EXECUTORS_MODULE?.trim();
  if (explicit) candidates.push(explicit);
  const bundled = getBundledWorkflowExecutorModulePath();
  if (bundled) candidates.push(bundled);
  candidates.push(
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.js", import.meta.url))),
    resolve(fileURLToPath(new URL("./tools/workflow-tool-executors.ts", import.meta.url))),
  );

  for (const candidate of [...new Set(candidates)]) {
    try {
      const loaded = await import(workflowExecutorModuleImportUrl(candidate));
      if (isWorkflowExecutorsModule(loaded)) return loaded;
      attempts.push(`${candidate} (module shape mismatch)`);
    } catch (err) {
      attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  throw new Error(
    "Unable to load GSD workflow-tool-executors module. " +
    "Run from a GSD checkout, set GSD_WORKFLOW_EXECUTORS_MODULE, or run /gsd mcp init. " +
    `Attempts: ${attempts.join("; ")}`,
  );
}

function getBundledWorkflowWriteGateModulePath(): string | null {
  const repoRoot = findGsdPiRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    ...(repoRoot
      ? [
          resolve(repoRoot, "src", "resources", "extensions", "gsd", "bootstrap", "write-gate.ts"),
          resolve(repoRoot, "dist", "resources", "extensions", "gsd", "bootstrap", "write-gate.js"),
        ]
      : []),
    resolve(fileURLToPath(new URL("./bootstrap/write-gate.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../dist/resources/extensions/gsd/bootstrap/write-gate.js", import.meta.url))),
    resolve(fileURLToPath(new URL("./bootstrap/write-gate.ts", import.meta.url))),
  ];

  return firstExistingPath(candidates);
}

function getResolveTsHookPath(): string | null {
  const repoRoot = findGsdPiRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const sourceRepoRoot = repoRoot && basename(repoRoot) === "dist-test" ? dirname(repoRoot) : repoRoot;
  return firstExistingPath([
    ...(sourceRepoRoot
      ? [resolve(sourceRepoRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")]
      : []),
    ...(repoRoot && repoRoot !== sourceRepoRoot
      ? [resolve(repoRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")]
      : []),
    resolve(fileURLToPath(new URL("./tests/resolve-ts.mjs", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../src/resources/extensions/gsd/tests/resolve-ts.mjs", import.meta.url))),
  ]);
}

function mergeNodeOptions(existing: string | undefined, additions: string[]): string | undefined {
  const tokens = (existing ?? "").split(/\s+/).map((value) => value.trim()).filter(Boolean);
  for (const addition of additions) {
    if (!tokens.includes(addition)) {
      tokens.push(addition);
    }
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function buildWorkflowLaunchEnv(
  projectRoot: string,
  gsdCliPath: string | undefined,
  explicitEnv?: Record<string, string>,
  workflowCliPath?: string,
): Record<string, string> {
  const executorModulePath = getBundledWorkflowExecutorModulePath();
  const writeGateModulePath = getBundledWorkflowWriteGateModulePath();
  const resolveTsHookPath = getResolveTsHookPath();
  const wantsSourceTs =
    Boolean(resolveTsHookPath) &&
    (
      (workflowCliPath?.endsWith(".ts") ?? false) ||
      (executorModulePath?.endsWith(".ts") ?? false) ||
      (writeGateModulePath?.endsWith(".ts") ?? false)
    );
  const nodeOptions = wantsSourceTs
    ? mergeNodeOptions(explicitEnv?.NODE_OPTIONS, [
        "--experimental-strip-types",
        `--import=${pathToFileURL(resolveTsHookPath!).href}`,
      ])
    : explicitEnv?.NODE_OPTIONS;

  return {
    ...(explicitEnv ?? {}),
    ...(gsdCliPath ? { GSD_CLI_PATH: gsdCliPath, GSD_BIN_PATH: gsdCliPath } : {}),
    ...(executorModulePath ? { GSD_WORKFLOW_EXECUTORS_MODULE: executorModulePath } : {}),
    ...(writeGateModulePath ? { GSD_WORKFLOW_WRITE_GATE_MODULE: writeGateModulePath } : {}),
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    GSD_PERSIST_WRITE_GATE_STATE: "1",
    GSD_WORKFLOW_PROJECT_ROOT: projectRoot,
  };
}

export function detectWorkflowMcpLaunchConfig(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkflowMcpLaunchConfig | null {
  const name = env.GSD_WORKFLOW_MCP_NAME?.trim() || "gsd-workflow";
  const explicitCommand = env.GSD_WORKFLOW_MCP_COMMAND?.trim();
  const explicitArgs = parseJsonEnv<unknown>(env, "GSD_WORKFLOW_MCP_ARGS");
  const explicitEnv = parseJsonEnv<Record<string, string>>(env, "GSD_WORKFLOW_MCP_ENV");
  const explicitCwd = env.GSD_WORKFLOW_MCP_CWD?.trim();
  const gsdCliPath =
    explicitEnv?.GSD_CLI_PATH?.trim()
    || explicitEnv?.GSD_BIN_PATH?.trim()
    || env.GSD_CLI_PATH?.trim()
    || env.GSD_BIN_PATH?.trim();
  const workflowProjectRoot =
    explicitEnv?.GSD_WORKFLOW_PROJECT_ROOT?.trim() ||
    env.GSD_WORKFLOW_PROJECT_ROOT?.trim() ||
    env.GSD_PROJECT_ROOT?.trim() ||
    explicitCwd ||
    projectRoot;
  const resolvedWorkflowProjectRoot = resolve(workflowProjectRoot);

  if (explicitCommand) {
    const launchEnv = buildWorkflowLaunchEnv(resolve(workflowProjectRoot), gsdCliPath, explicitEnv);
    return {
      name,
      command: explicitCommand,
      args: Array.isArray(explicitArgs) && explicitArgs.length > 0 ? explicitArgs.map(String) : undefined,
      cwd: explicitCwd || undefined,
      env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
    };
  }

  const distCli = resolve(resolvedWorkflowProjectRoot, "packages", "mcp-server", "dist", "cli.js");
  if (existsSync(distCli)) {
    return {
      name,
      command: process.execPath,
      args: [distCli],
      cwd: resolvedWorkflowProjectRoot,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath, undefined, distCli),
    };
  }

  const bundledCli = getBundledWorkflowMcpCliPath(env);
  if (bundledCli) {
    return {
      name,
      command: process.execPath,
      args: [bundledCli],
      cwd: resolvedWorkflowProjectRoot,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath, undefined, bundledCli),
    };
  }

  const binPath = lookupCommand("gsd-mcp-server");
  if (binPath) {
    return {
      name,
      command: binPath,
      env: buildWorkflowLaunchEnv(resolvedWorkflowProjectRoot, gsdCliPath),
    };
  }

  return null;
}

export function buildWorkflowMcpServers(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, Record<string, unknown>> | undefined {
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, env);
  if (!launch) return undefined;

  return {
    [launch.name]: {
      command: launch.command,
      ...(launch.args && launch.args.length > 0 ? { args: launch.args } : {}),
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
    },
  };
}

export function getRequiredWorkflowToolsForGuidedUnit(unitType: string): string[] {
  return getRequiredWorkflowToolsForUnit(unitType);
}

export function getRequiredWorkflowToolsForAutoUnit(unitType: string): string[] {
  return getRequiredWorkflowToolsForUnit(unitType);
}

function hasRequiredTool(requiredTool: string, activeTools: string[]): boolean {
  return activeTools.some((toolName) => {
    if (toolName === requiredTool) return true;
    return mcpToolMatchesBaseName(toolName, requiredTool);
  });
}

export function getWorkflowTransportSupportError(
  provider: string | undefined,
  requiredTools: string[],
  options: WorkflowCapabilityOptions = {},
): string | null {
  if (!provider || requiredTools.length === 0) return null;
  if (!usesWorkflowMcpTransport(options.authMode, options.baseUrl)) return null;

  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, env);
  const surface = options.surface ?? "workflow dispatch";
  const unitLabel = options.unitType ? ` for ${options.unitType}` : "";
  const providerLabel = `"${provider}"`;

  if (!launch) {
    return `Provider ${providerLabel} cannot run ${surface}${unitLabel}: the GSD workflow MCP server is not configured or discoverable. Detected Claude Code model but no workflow MCP. Please run /gsd mcp init . from your project root. You can also configure GSD_WORKFLOW_MCP_COMMAND, build packages/mcp-server/dist/cli.js, or install gsd-mcp-server on PATH.`;
  }

  const uniqueRequired = [...new Set(requiredTools)];
  const missing = (options.activeTools && options.activeTools.length > 0)
    ? uniqueRequired.filter((tool) => !isWorkflowToolSurfaceName(tool) && !hasRequiredTool(tool, options.activeTools!))
    : uniqueRequired.filter((tool) => !isWorkflowToolSurfaceName(tool));
  if (missing.length === 0) return null;

  if (options.activeTools && options.activeTools.length > 0) {
    return `Provider ${providerLabel} cannot run ${surface}${unitLabel}: this unit requires ${missing.join(", ")}, but the active runtime toolset currently exposes only ${options.activeTools.slice().sort().join(", ")}.`;
  }

  return `Provider ${providerLabel} cannot run ${surface}${unitLabel}: this unit requires ${missing.join(", ")}, but the workflow MCP transport currently exposes only ${[...WORKFLOW_TOOL_SURFACE_NAMES].sort().join(", ")}.`;
}
