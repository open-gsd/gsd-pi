/**
 * `/gsd` command router.
 *
 * Authorization is delegated to the host: `requiredScopes: ["operator.write"]`
 * is satisfied by Gateway clients holding that scope and, on chat surfaces, by
 * command owners (`commands.ownerAllowFrom` / channel owner rules). The plugin
 * adds no allowlist of its own.
 */

import { BindStore, NO_PROJECT_MESSAGE, resolveProject, routeFromCommandContext, routeKey, validateProjectPath } from "./binding.js";
import { GsdCli } from "./gsd-cli.js";
import { formatSnapshot } from "./snapshot.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext, PluginCommandResult, PluginConfig, PluginLogger } from "./types.js";

export interface ServiceState {
  bindStore: BindStore;
  cli: GsdCli;
}

export interface CommandDeps {
  config: PluginConfig;
  logger: PluginLogger;
  getService: () => ServiceState | null;
}

export const HELP_TEXT = [
  "**GSD commands**",
  "- `/gsd status [path]` — project snapshot",
  "- `/gsd bind <absolute path>` — bind this conversation to a GSD project",
  "- `/gsd unbind` — remove the binding",
  "- `/gsd help` — this list",
].join("\n");

const SERVICE_NOT_READY = "The Open GSD plugin service has not started yet. Retry after the Gateway finishes starting.";

/** Split command arguments on whitespace, honouring double and single quotes. */
export function tokenize(raw: string | undefined): string[] {
  if (!raw) return [];
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of raw.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

export function createGsdCommand(deps: CommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "gsd",
    description: "GSD Pi: project status and conversation binding. Usage: /gsd help",
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: ["operator.write"],
    agentPromptGuidance: [
      "Use /gsd status to read the bound GSD project's milestone, slice, task, and blockers before advising on delivery work.",
    ],
    handler: (ctx) => handleGsdCommand(deps, ctx),
  };
}

export async function handleGsdCommand(deps: CommandDeps, ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const [sub = "help", ...rest] = tokenize(ctx.args);
  switch (sub.toLowerCase()) {
    case "status":
      return status(deps, ctx, rest[0]);
    case "bind":
      return bind(deps, ctx, rest[0]);
    case "unbind":
      return unbind(deps, ctx);
    case "help":
      return { text: HELP_TEXT };
    default:
      return { text: `Unknown subcommand \`${sub}\`.\n${HELP_TEXT}` };
  }
}

function boundProject(deps: CommandDeps, ctx: PluginCommandContext): string | undefined {
  const service = deps.getService();
  const route = routeFromCommandContext(ctx);
  if (!service || !route) return undefined;
  return service.bindStore.get(routeKey(route));
}

async function status(deps: CommandDeps, ctx: PluginCommandContext, explicit: string | undefined): Promise<PluginCommandResult> {
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const resolved = resolveProject({ explicit, bound: boundProject(deps, ctx), defaultProject: deps.config.defaultProject });
  if (!resolved.ok) return { text: resolved.error };
  try {
    const progress = await service.cli.readProgress(resolved.dir);
    return { text: formatSnapshot(progress, [`Project: \`${resolved.dir}\``]) };
  } catch (error) {
    deps.logger.warn(`/gsd status failed for ${resolved.dir}: ${errorMessage(error)}`);
    return { text: `GSD status unavailable: ${errorMessage(error)}` };
  }
}

async function bind(deps: CommandDeps, ctx: PluginCommandContext, rawPath: string | undefined): Promise<PluginCommandResult> {
  if (!rawPath) return { text: "Usage: `/gsd bind <absolute path>`" };
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const route = routeFromCommandContext(ctx);
  if (!route) return { text: "This conversation has no stable route to bind; use `defaultProject` in the plugin config instead." };
  const checked = validateProjectPath(rawPath);
  if (!checked.ok) return { text: checked.error };
  service.bindStore.set(routeKey(route), checked.dir);
  return { text: `Bound this conversation to \`${checked.dir}\`` };
}

async function unbind(deps: CommandDeps, ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const route = routeFromCommandContext(ctx);
  if (!route) return { text: "This conversation has no binding." };
  const removed = service.bindStore.delete(routeKey(route));
  return { text: removed ? "Binding removed." : `This conversation has no binding. ${NO_PROJECT_MESSAGE}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
