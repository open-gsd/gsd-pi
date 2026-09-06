/**
 * Local aliases for the OpenClaw SDK subset declared in openclaw-sdk.d.ts.
 * Type-only imports are erased at build time, so no module in this package
 * except index.ts loads the SDK at runtime — which keeps unit tests free of
 * the host.
 */
export type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginServiceContext,
  PluginCommandContext,
  PluginCommandResult,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";

export interface PluginConfig {
  /** Path to the gsd CLI binary; defaults to `gsd` on the Gateway PATH. */
  cliPath: string;
  /** Absolute project path used when a conversation has no binding. */
  defaultProject?: string;
}

export interface ProgressRef {
  id: string;
  title: string;
}

/** Mirrors `ProgressResult` from `@opengsd/mcp-server` readers, as served by `gsd read progress --json`. */
export interface ProgressData {
  activeMilestone: ProgressRef | null;
  activeSlice: ProgressRef | null;
  activeTask: ProgressRef | null;
  phase: string;
  milestones: { total: number; done: number; active: number; pending?: number; parked?: number };
  slices: { total: number; done: number; active?: number; pending?: number };
  tasks: { total: number; done: number; pending?: number };
  requirements: { active: number; validated: number; deferred?: number; outOfScope?: number } | null;
  blockers: string[];
  nextAction: string;
}

export function readPluginConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const cliPath = typeof raw?.cliPath === "string" && raw.cliPath.trim() ? raw.cliPath.trim() : "gsd";
  const defaultProject =
    typeof raw?.defaultProject === "string" && raw.defaultProject.trim() ? raw.defaultProject.trim() : undefined;
  return { cliPath, defaultProject };
}
