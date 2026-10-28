import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CMUX_CHANNELS, type CmuxSidebarEvent, type CmuxLogEvent, type CmuxPreferencesInput, type CmuxStateInput } from "../shared/cmux-events.js";
import type { EventBus } from "@gsd/pi-coding-agent";
import {
  aggregateProgress,
  cmuxProgressRegistryDir,
  hasSessionEntry,
  listLiveEntries,
  removeSessionEntry,
  writeSessionEntry,
  type CmuxProgressMember,
} from "./progress-registry.js";

type CmuxPreferences = CmuxPreferencesInput;
type CmuxState = CmuxStateInput;
type Phase = string;
const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";
const STATUS_KEY = "gsd";
// No write-dedup caches for status or progress (issue #2926): every sync and
// cleanup unconditionally rewrites this session's status row and the
// deterministic progress fold. Any private cache can suppress a repair after
// another member interleaved a write and vanished (crash, delayed cleanup) —
// sidebar syncs are low-frequency state transitions, so the redundant local
// CLI calls are cheap next to correctness.
let progressRegistryDirOverride: string | null = null;
let cmuxPromptedThisSession = false;
let cachedCliAvailability: boolean | null = null;

export interface CmuxEnvironment {
  available: boolean;
  cliAvailable: boolean;
  socketPath: string;
  workspaceId?: string;
  surfaceId?: string;
}

export interface ResolvedCmuxConfig extends CmuxEnvironment {
  enabled: boolean;
  notifications: boolean;
  sidebar: boolean;
  splits: boolean;
  browser: boolean;
}

export interface CmuxSidebarProgress {
  value: number;
  label: string;
}

export type CmuxLogLevel = "info" | "progress" | "success" | "warning" | "error";

/**
 * `cmux new-split` prints `OK surface:<id> workspace:<id>` (current CLI) or,
 * on older builds, the bare surface id with no prefix. Without extracting the
 * id from the `OK ...` line, the caller falls back to running the agent
 * in-process while the freshly split cmux pane is left empty forever.
 */
function parseCreatedSurfaceId(stdout: string | null): string | null {
  const text = stdout?.trim() ?? "";
  if (!text || text.toLowerCase() === "ok") return null;
  const match = text.match(/surface:\S+/);
  if (match) return match[0];
  if (/\s/.test(text)) return null;
  return text;
}

export function detectCmuxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): CmuxEnvironment {
  const socketPath = env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim() || undefined;
  const surfaceId = env.CMUX_SURFACE_ID?.trim() || undefined;
  const available = Boolean(workspaceId && surfaceId && socketExists(socketPath));
  return {
    available,
    cliAvailable: cliAvailable(),
    socketPath,
    workspaceId,
    surfaceId,
  };
}

export function resolveCmuxConfig(
  preferences: CmuxPreferences | undefined,
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): ResolvedCmuxConfig {
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  const cmux = preferences?.cmux ?? {};
  const enabled = detected.available && cmux.enabled === true;
  return {
    ...detected,
    enabled,
    notifications: enabled && cmux.notifications !== false,
    sidebar: enabled && cmux.sidebar !== false,
    splits: enabled && cmux.splits === true,
    browser: enabled && cmux.browser === true,
  };
}

export function shouldPromptToEnableCmux(
  preferences: CmuxPreferences | undefined,
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): boolean {
  if (cmuxPromptedThisSession) return false;
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  if (!detected.available) return false;
  return preferences?.cmux?.enabled === undefined;
}

export function markCmuxPromptShown(): void {
  cmuxPromptedThisSession = true;
}

export function resetCmuxPromptState(): void {
  cmuxPromptedThisSession = false;
}

/** Test seam: redirect the progress registry away from the OS temp dir. */
export function setCmuxProgressRegistryDirForTests(dir: string | null): void {
  progressRegistryDirOverride = dir;
}

export function isCmuxCliAvailable(): boolean {
  if (cachedCliAvailability !== null) return cachedCliAvailability;
  try {
    execFileSync("cmux", ["--help"], { stdio: "ignore", timeout: 1000 });
    cachedCliAvailability = true;
  } catch {
    cachedCliAvailability = false;
  }
  return cachedCliAvailability;
}

export function supportsOsc777Notifications(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  return termProgram === "ghostty" || termProgram === "wezterm" || termProgram === "iterm.app";
}

export function emitOsc777Notification(title: string, body: string): void {
  if (!supportsOsc777Notifications()) return;
  const safeTitle = normalizeNotificationText(title).replace(/;/g, ",");
  const safeBody = normalizeNotificationText(body).replace(/;/g, ",");
  process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
}

export function buildCmuxStatusLabel(state: CmuxState): string {
  const parts: string[] = [];
  if (state.activeMilestone) parts.push(state.activeMilestone.id);
  if (state.activeSlice) parts.push(state.activeSlice.id);
  if (state.activeTask) {
    const prev = parts.pop();
    parts.push(prev ? `${prev}/${state.activeTask.id}` : state.activeTask.id);
  }
  if (parts.length === 0) return state.phase;
  return `${parts.join(" ")} · ${state.phase}`;
}

export function buildCmuxProgress(state: CmuxState): CmuxSidebarProgress | null {
  const progress = state.progress;
  if (!progress) return null;

  const choose = (done: number, total: number, label: string): CmuxSidebarProgress | null => {
    if (total <= 0) return null;
    return { value: Math.max(0, Math.min(1, done / total)), label: `${done}/${total} ${label}` };
  };

  return choose(progress.tasks?.done ?? 0, progress.tasks?.total ?? 0, "tasks")
    ?? choose(progress.slices?.done ?? 0, progress.slices?.total ?? 0, "slices")
    ?? choose(progress.milestones.done, progress.milestones.total, "milestones");
}

function phaseVisuals(phase: Phase): { icon: string; color: string } {
  switch (phase) {
    case "blocked":
      return { icon: "triangle-alert", color: "#ef4444" };
    case "paused":
      return { icon: "pause", color: "#f59e0b" };
    case "complete":
      // Authoritative completion (the state machine reaches `complete` only
      // after the closeout gate passes) keeps the green check.
      return { icon: "check", color: "#22c55e" };
    case "completing-milestone":
      // Finalization is still running (issue #2926): it must not share the
      // authoritative-completed check visuals — distinct icon and color, and
      // the phase string in the label already reads differently.
      return { icon: "settings", color: "#eab308" };
    case "planning":
    case "researching":
    case "replanning-slice":
      return { icon: "compass", color: "#3b82f6" };
    case "validating-milestone":
    case "verifying":
      return { icon: "shield-check", color: "#06b6d4" };
    default:
      return { icon: "rocket", color: "#4ade80" };
  }
}

/**
 * Per-session status key (issue #2926): the cmux surface id is the existing
 * per-session identity, so each session owns `gsd:<surfaceId>` and cannot
 * clobber another session's row. Sessions without a surface id keep the
 * historical shared `gsd` key (the sidebar requires a surface id anyway, so
 * this only matters for non-cmux fallbacks).
 */
function statusKeyFor(config: ResolvedCmuxConfig): string {
  return config.surfaceId ? `${STATUS_KEY}:${config.surfaceId}` : STATUS_KEY;
}

function progressRegistryDirFor(config: ResolvedCmuxConfig): string {
  return cmuxProgressRegistryDir(config.workspaceId, progressRegistryDirOverride ?? undefined);
}

export class CmuxClient {
  private readonly config: ResolvedCmuxConfig;
  /** This session's own status key — see statusKeyFor (issue #2926). */
  private readonly statusKey: string;

  constructor(config: ResolvedCmuxConfig) {
    this.config = config;
    this.statusKey = statusKeyFor(config);
  }

  static fromPreferences(preferences: CmuxPreferences | undefined): CmuxClient {
    return new CmuxClient(resolveCmuxConfig(preferences));
  }

  getConfig(): ResolvedCmuxConfig {
    return this.config;
  }

  private canRun(): boolean {
    return this.config.available && this.config.cliAvailable;
  }

  private appendWorkspace(args: string[]): string[] {
    return this.config.workspaceId ? [...args, "--workspace", this.config.workspaceId] : args;
  }

  private appendSurface(args: string[], surfaceId?: string): string[] {
    return surfaceId ? [...args, "--surface", surfaceId] : args;
  }

  private runSync(args: string[]): string | null {
    if (!this.canRun()) return null;
    try {
      return execFileSync("cmux", args, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      return null;
    }
  }

  private async runAsync(args: string[]): Promise<string | null> {
    if (!this.canRun()) return null;
    return new Promise<string | null>((resolve) => {
      const child = spawn("cmux", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (result: string | null) => {
        if (!settled) { settled = true; resolve(result); }
      };
      const timer = setTimeout(() => { child.kill(); done(null); }, 5000);
      child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 ? Buffer.concat(chunks).toString("utf-8") : null);
      });
      child.on("error", () => { clearTimeout(timer); done(null); });
    });
  }

  getCapabilities(): unknown | null {
    const stdout = this.runSync(["capabilities", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }

  identify(): unknown | null {
    const stdout = this.runSync(["identify", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }

  setStatus(label: string, phase: Phase): void {
    if (!this.config.sidebar) return;
    const visuals = phaseVisuals(phase);
    this.runSync(this.appendWorkspace([
      "set-status",
      this.statusKey,
      label,
      "--icon",
      visuals.icon,
      "--color",
      visuals.color,
    ]));
  }

  clearStatus(): void {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace(["clear-status", this.statusKey]));
  }

  /** Clear an arbitrary session's status row — used to reap crashed sessions (issue #2926). */
  clearStatusFor(key: string): void {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace(["clear-status", key]));
  }

  setProgress(progress: CmuxSidebarProgress | null): void {
    if (!this.config.sidebar) return;
    if (!progress) {
      this.runSync(this.appendWorkspace(["clear-progress"]));
      return;
    }
    this.runSync(this.appendWorkspace([
      "set-progress",
      progress.value.toFixed(3),
      "--label",
      progress.label,
    ]));
  }

  log(message: string, level: CmuxLogLevel = "info", source = "gsd"): void {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace([
      "log",
      "--level",
      level,
      "--source",
      source,
      "--",
      message,
    ]));
  }

  notify(title: string, body: string, subtitle?: string): boolean {
    if (!this.config.notifications) return false;
    const args = ["notify", "--title", title, "--body", body];
    if (subtitle) args.push("--subtitle", subtitle);
    return this.runSync(args) !== null;
  }

  async listSurfaceIds(): Promise<string[]> {
    const stdout = await this.runAsync(this.appendWorkspace(["list-pane-surfaces", "--json", "--id-format", "both"]));
    const parsed = stdout ? parseJson(stdout) : null;
    return extractSurfaceIds(parsed);
  }

  async createSplit(direction: "right" | "down" | "left" | "up"): Promise<string | null> {
    return this.createSplitFrom(this.config.surfaceId, direction);
  }

  async createSplitFrom(
    sourceSurfaceId: string | undefined,
    direction: "right" | "down" | "left" | "up",
  ): Promise<string | null> {
    if (!this.config.splits) return null;
    const before = new Set(await this.listSurfaceIds());
    const args = ["new-split", direction];
    const scopedArgs = this.appendSurface(this.appendWorkspace(args), sourceSurfaceId);
    const created = parseCreatedSurfaceId(await this.runAsync(scopedArgs));
    if (created) return created;
    const after = await this.listSurfaceIds();
    for (const id of after) {
      if (!before.has(id)) return id;
    }
    return null;
  }

  /**
   * Create a grid of surfaces for parallel agent execution.
   *
   * Layout strategy (gsd stays in the original surface):
   *   1 agent:  [gsd | A]
   *   2 agents: [gsd | A]
   *             [    | B]
   *   3 agents: [gsd | A]
   *             [ C  | B]
   *   4 agents: [gsd | A]
   *             [ C  | B]  (D splits from B downward)
   *             [    | D]
   *
   * Returns surface IDs in order, or empty array on failure.
   */
  async createGridLayout(count: number): Promise<string[]> {
    if (!this.config.splits || count <= 0) return [];
    const surfaces: string[] = [];

    // First split: create right column from the gsd surface
    const rightCol = await this.createSplitFrom(this.config.surfaceId, "right");
    if (!rightCol) return [];
    surfaces.push(rightCol);
    if (count === 1) return surfaces;

    // Second split: split right column down → bottom-right
    const bottomRight = await this.createSplitFrom(rightCol, "down");
    if (!bottomRight) return surfaces;
    surfaces.push(bottomRight);
    if (count === 2) return surfaces;

    // Third split: split gsd surface down → bottom-left
    const bottomLeft = await this.createSplitFrom(this.config.surfaceId, "down");
    if (!bottomLeft) return surfaces;
    surfaces.push(bottomLeft);
    if (count === 3) return surfaces;

    // Fourth+: split subsequent surfaces down from the last created
    let lastSurface = bottomRight;
    for (let i = 3; i < count; i++) {
      const next = await this.createSplitFrom(lastSurface, "down");
      if (!next) break;
      surfaces.push(next);
      lastSurface = next;
    }

    return surfaces;
  }

  async sendSurface(surfaceId: string, text: string): Promise<boolean> {
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    const stdout = await this.runAsync(["send", "--surface", surfaceId, payload]);
    return stdout !== null;
  }

  // Send Ctrl-C (ETX) to a surface to interrupt the running command.
  async sendInterrupt(surfaceId: string): Promise<boolean> {
    const stdout = await this.runAsync(["send", "--surface", surfaceId, "\x03"]);
    return stdout !== null;
  }
}

/**
 * Write the deterministic fold over the live members to the shared slot.
 * Every session writes the same fold over the same registry state, so
 * concurrent refreshes converge and there is no owner whose idleness could
 * freeze a stale bar (issue #2926, ADR-051). The write is unconditional:
 * another member may have interleaved a different value (then crashed or
 * cleaned up), and this session cannot read the slot back to detect that.
 */
function writeProgressFold(client: CmuxClient, config: ResolvedCmuxConfig, entries: Record<string, CmuxProgressMember>): void {
  const sums = aggregateProgress(entries);
  const progress = sums ? buildCmuxProgress({ phase: "", progress: sums }) : null;
  client.setProgress(progress);
}

/**
 * Shared progress slot coordination (issue #2926, ADR-051): cmux exposes one
 * workspace-scoped slot, so members coordinate over a per-session-entry
 * registry and each session only mutates its own entry. Every sync rewrites
 * the deterministic fold, so a member's update is visible without waiting on
 * any peer, a crashed member is reclaimed by pid liveness (not a timeout), and
 * no private cache can suppress a repair. A reaped (crashed) member's orphaned
 * status row is cleared by the survivor that prunes it — the dead pid proves
 * that identity is gone.
 */
function syncOwnedProgress(client: CmuxClient, config: ResolvedCmuxConfig, state: CmuxState): void {
  if (!config.cliAvailable) return;
  const registryDir = progressRegistryDirFor(config);
  const selfKey = statusKeyFor(config);
  const self: CmuxProgressMember = {
    pid: process.pid,
    progress: state.progress ?? null,
    updatedAt: new Date().toISOString(),
  };

  const { live: entries, reapedKeys } = listLiveEntries(registryDir);
  for (const reapedKey of reapedKeys) {
    if (reapedKey !== selfKey) client.clearStatusFor(reapedKey);
  }
  writeSessionEntry(registryDir, selfKey, self);
  entries[selfKey] = self;

  writeProgressFold(client, config, entries);
}

export function syncCmuxSidebar(preferences: CmuxPreferences | undefined, state: CmuxState): void {
  const client = CmuxClient.fromPreferences(preferences);
  const config = client.getConfig();
  if (!config.sidebar) return;

  // Status: this session's own key, rewritten on every sync — a sync never
  // touches another session's row and cannot leave a cleared row missing
  // (issue #2926).
  client.setStatus(buildCmuxStatusLabel(state), state.phase);

  syncOwnedProgress(client, config, state);
}

/**
 * Release this session's membership (issue #2926, ADR-051): only its own
 * status key and registry entry. The removal is fenced against the recorded
 * pid, so a same-key replacement that registered before this process cleaned
 * up is never removed. After removing itself, the departing session refreshes
 * the slot with the fold over the remaining members (or clears it when none
 * remain), so a departure never leaves the bar stale or erases another
 * session's live state.
 */
function clearOwnedProgress(client: CmuxClient, config: ResolvedCmuxConfig): void {
  if (!config.cliAvailable) return;
  const registryDir = progressRegistryDirFor(config);
  const selfKey = statusKeyFor(config);
  if (!hasSessionEntry(registryDir, selfKey)) {
    // Never a member (or already removed): the slot is not ours to touch.
    return;
  }
  if (!removeSessionEntry(registryDir, selfKey, process.pid)) {
    // The entry belongs to a same-key replacement — not ours anymore.
    return;
  }
  // If this departure's listing prunes dead/corrupt entries, reap their
  // orphaned status rows too — when the last member leaves, no later sync
  // exists to discover them.
  const { live: survivors, reapedKeys } = listLiveEntries(registryDir);
  for (const reapedKey of reapedKeys) {
    if (reapedKey !== selfKey) client.clearStatusFor(reapedKey);
  }
  writeProgressFold(client, config, survivors);
}

export function clearCmuxSidebar(preferences: CmuxPreferences | undefined): void {
  const config = resolveCmuxConfig(preferences);
  if (!config.available || !config.cliAvailable) return;
  const client = new CmuxClient({ ...config, enabled: true, sidebar: true });

  // Only this session's row — one session's cleanup cannot erase another
  // session's live status (issue #2926).
  client.clearStatus();

  clearOwnedProgress(client, config);
}

export function logCmuxEvent(
  preferences: CmuxPreferences | undefined,
  message: string,
  level: CmuxLogLevel = "info",
): void {
  CmuxClient.fromPreferences(preferences).log(message, level);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeNotificationText(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractSurfaceIds(value: unknown): string[] {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === "string") {
        // Current `cmux list-pane-surfaces --json` nests surfaces under
        // surfaces[].ref as "surface:<n>" (e.g. {"ref":"surface:1000040003"}),
        // not a top-level "surface_id"/"surface" key. Without matching `ref`,
        // every created surface id resolves to undefined and the caller falls
        // back to running the agent in-process, leaving the pane empty.
        if (
          key === "surface_id"
          || key === "surface"
          || (key === "id" && child.includes("surface"))
          || (key === "ref" && child.startsWith("surface:"))
        ) {
          found.add(child);
        }
      }
      visit(child);
    }
  };

  visit(value);
  return Array.from(found);
}

/**
 * Wire event subscriptions so cmux reacts to gsd events.
 * Called by the gsd extension during registration, passing pi.events.
 */
export function initCmuxEventListeners(events: EventBus): void {
  events.on(CMUX_CHANNELS.SIDEBAR, (data) => {
    const event = data as CmuxSidebarEvent;
    if (event.action === "sync" && event.state) {
      syncCmuxSidebar(event.preferences as CmuxPreferences | undefined, event.state as CmuxState);
    }
    if (event.action === "clear") {
      clearCmuxSidebar(event.preferences as CmuxPreferences | undefined);
    }
  });

  events.on(CMUX_CHANNELS.LOG, (data) => {
    const event = data as CmuxLogEvent;
    logCmuxEvent(event.preferences as CmuxPreferences | undefined, event.message, event.level);
  });
}
