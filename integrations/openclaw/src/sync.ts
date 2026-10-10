import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Card, Json, Progress } from "./types.js";

const exec = promisify(execFile);
export const CONTROLLER = "open-gsd-openclaw.projects";

export function projectKey(stateDir: string): string {
  return `gsd:${createHash("sha256").update(stateDir).digest("hex").slice(0, 32)}`;
}

export async function readProgress(projectDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal, databaseExpected = false): Promise<Progress> {
  const command = env.GSD_CLI_PATH || "gsd";
  // Snapshot refuses an unreadable DB; progress alone can fall back to stale
  // Markdown on an unopenable database. Keep that fallback for legacy projects.
  let kind = databaseExpected ? "snapshot" : "progress";
  try { await stat(join(projectDir, ".gsd", "gsd.db")); kind = "snapshot"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const argv = ["read", kind, "--json", "--project", projectDir];
  const { stdout } = await exec(/\.[cm]?js$/.test(command) ? process.execPath : command,
    /\.[cm]?js$/.test(command) ? [command, ...argv] : argv,
    { env, signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  const data = envelope.data;
  const p = kind === "snapshot" && data ? { ...data.current, tasks: data.progress?.tasks,
    blockers: data.blockers?.map((b: { description?: string }) => b.description) } : data;
  if (envelope.integration_version !== 1 || envelope.kind !== kind ||
      !p || typeof p.phase !== "string" || !p.phase || p.phase === "unknown" ||
      typeof p.nextAction !== "string" || !Array.isArray(p.blockers) ||
      !p.blockers.every((b: unknown) => typeof b === "string") ||
      ![p.activeMilestone, p.activeSlice, p.activeTask].every((ref) => ref === null ||
        (typeof ref?.id === "string" && ref.id.length <= 200)) ||
      !Number.isSafeInteger(p.tasks?.total) || !Number.isSafeInteger(p.tasks?.done) ||
      p.tasks.done < 0 || p.tasks.total < p.tasks.done) {
    throw new Error("Invalid GSD progress response");
  }
  return { ...p, source: kind === "snapshot" ? "database" : "markdown" };
}

export interface SyncHost {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  notify(key: string, text: string): void;
}

const STATE_START = "<!-- gsd-state:start -->";
const STATE_END = "<!-- gsd-state:end -->";
export type Snapshot = Record<string, Json>;

/** Read only this plugin's bounded, durable Workboard observation. */
export function state(card: Card): Snapshot {
  if (card.metadata?.automation?.tenant !== CONTROLLER) return {};
  const notes = card.notes ?? "";
  const start = notes.indexOf(STATE_START);
  const end = notes.indexOf(STATE_END, start + STATE_START.length);
  // Earlier integration cards already carried this same snapshot after their
  // TaskFlow label. Reading those notes migrates no host database or old flow.
  const json = start >= 0 && end > start ? notes.slice(start + STATE_START.length, end)
    : notes.includes("Automatically synchronized GSD workflow") ? notes.slice(notes.indexOf("\n{") + 1) : "";
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) &&
      value.key === card.metadata?.automation?.idempotencyKey ? value : {};
  } catch { return {}; }
}

function notesWithState(notes: string | undefined, snapshot: Snapshot): string {
  const block = `${STATE_START}\n${JSON.stringify(snapshot, null, 2)}\n${STATE_END}`;
  const existing = notes ?? "";
  const start = existing.indexOf(STATE_START);
  const end = existing.indexOf(STATE_END, start + STATE_START.length);
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + STATE_END.length);
  return `${existing ? existing + "\n\n" : "Automatically synchronized GSD workflow (execution liveness is not inferred).\n"}${block}`;
}

/** Workboard is the durable record; without it observations are memory-only.
 * Neither path creates an execution, task ledger, scheduler, or recovery loop.
 */
export class ProjectSync {
  private pending = new Map<string, { projectDir: string; force: boolean }>();
  private running?: Promise<void>;
  private abort = new AbortController();
  private lastInputs = new Map<string, string>();
  private failures = new Set<string>();
  private observations = new Map<string, Snapshot>();
  private boardAvailability?: Promise<boolean>;

  constructor(private host: SyncHost, private env: NodeJS.ProcessEnv, private onError: (error: unknown) => void,
    private onHealthy: () => void = () => {}) {}

  snapshots(): Snapshot[] { return [...this.observations.values()]; }

  private async cards(): Promise<Card[] | undefined> {
    // Use the host's effective activation decision, not our own interpretation
    // of allow/deny/default-enabled settings. Cache per service generation;
    // changes to Workboard or plugin policy restart this service.
    this.boardAvailability ??= this.host.request("plugins.list", {}).then((result) => {
      if (!Array.isArray(result.plugins)) throw new Error("Invalid plugin catalog");
      const board = result.plugins.find((plugin: { id?: string }) => plugin?.id === "workboard");
      if (!board || board.installed === false || board.enabled === false) return false;
      if (board.installed !== true || board.enabled !== true) throw new Error("Invalid Workboard availability");
      return true;
    }).catch((error) => { this.boardAvailability = undefined; throw error; });
    if (!await this.boardAvailability) return undefined;
    try {
      const result = await this.host.request("workboard.cards.list", {});
      if (!Array.isArray(result.cards)) throw new Error("Invalid Workboard card list");
      return result.cards.filter((card: Card) => card.metadata?.automation?.tenant === CONTROLLER);
    } catch (error) {
      if (/unknown method|method not found/i.test(String(error))) return undefined;
      throw error;
    }
  }

  /** Restore durable facts and legacy paths before their next filesystem event. */
  async restore(): Promise<string[]> {
    const cards = await this.cards();
    if (this.abort.signal.aborted || !cards) return [];
    const paths: string[] = [];
    for (const card of cards) {
      const snapshot = state(card);
      if (typeof snapshot.key !== "string") continue;
      if (card.metadata?.archivedAt) { this.observations.delete(snapshot.key); continue; }
      if (!this.observations.has(snapshot.key)) this.observations.set(snapshot.key, snapshot);
      if (typeof snapshot.projectDir === "string") paths.push(snapshot.projectDir);
    }
    return paths;
  }

  private async previous(key: string): Promise<{ card?: Card; snapshot?: Snapshot; boardAvailable: boolean }> {
    const cards = await this.cards();
    const card = cards?.find((entry) => entry.metadata?.automation?.idempotencyKey === key);
    const persisted = card ? state(card) : undefined;
    return { card, snapshot: persisted?.key === key ? persisted : this.observations.get(key), boardAvailable: !!cards };
  }

  enqueue(projectDir: string, stateDir: string, force = false): void {
    if (this.abort.signal.aborted) return;
    this.pending.set(stateDir, { projectDir, force: force || this.pending.get(stateDir)?.force === true });
    if (this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
  }

  private async drain(): Promise<void> {
    while (this.pending.size && !this.abort.signal.aborted) {
      const [stateDir, { projectDir, force }] = this.pending.entries().next().value!;
      this.pending.delete(stateDir);
      try {
        let inputs;
        let progress;
        try {
          inputs = await inputVersion(stateDir);
          if (!force && this.lastInputs.get(stateDir) === inputs) continue;
          if (await realpath(join(projectDir, ".gsd")) !== await realpath(stateDir)) throw new Error("GSD state location changed");
          const previous = await this.previous(projectKey(stateDir));
          if (previous.card?.metadata?.archivedAt) { this.observations.delete(projectKey(stateDir)); continue; }
          progress = await readProgress(projectDir, this.env, this.abort.signal, previous.snapshot?.stateSource === "database");
        } catch (error) {
          if (!this.abort.signal.aborted) await this.markUnavailable(projectDir, stateDir);
          throw error;
        }
        if (this.abort.signal.aborted) return;
        await this.reconcile(projectDir, stateDir, progress);
        this.lastInputs.set(stateDir, inputs);
        this.failures.delete(stateDir);
        if (!this.failures.size) this.onHealthy();
      } catch (error) {
        if (!this.abort.signal.aborted) { this.failures.add(stateDir); this.onError(error); }
      }
    }
  }

  async reconcile(projectDir: string, stateDir: string, progress: Progress): Promise<void> {
    const key = projectKey(stateDir);
    const { card, snapshot: previous, boardAvailable } = await this.previous(key);
    if (this.abort.signal.aborted) return;
    if (card?.metadata?.archivedAt) { this.observations.delete(key); return; }
    let projectId = previous?.projectDir === projectDir && typeof previous.projectId === "string" ? previous.projectId : undefined;
    if (!projectId) {
      const project = await this.host.request("projects.register", { path: projectDir });
      if (typeof project.id !== "string" || !project.id) throw new Error("Invalid OpenClaw project registration response");
      projectId = project.id;
    }
    if (this.abort.signal.aborted) return;
    const status = progress.blockers.length || progress.phase === "blocked" ? "blocked" : progress.phase === "complete" ? "done" :
      ["execute", "executing", "execution", "verifying", "verification", "summarizing"].includes(progress.phase) ? "running" : "todo";
    const snapshot: Snapshot = {
      key, projectDir, stateDir, projectId, stateSource: progress.source ?? "unknown", phase: progress.phase,
      milestone: progress.activeMilestone?.id ?? null, slice: progress.activeSlice?.id ?? null, task: progress.activeTask?.id ?? null,
      status, tasks: `${progress.tasks.done}/${progress.tasks.total}`,
      blockers: progress.blockers.slice(0, 8).map((b) => b.slice(0, 500)), nextAction: progress.nextAction.slice(0, 1000),
    };
    await this.publish(key, snapshot, previous, card, boardAvailable);
  }

  private async publish(key: string, snapshot: Snapshot, previous: Snapshot | undefined, card: Card | undefined, boardAvailable: boolean): Promise<void> {
    if (this.abort.signal.aborted) return;
    let persisted = card;
    if (boardAvailable) {
      if (!persisted) {
        const result = await this.host.request("workboard.cards.create", {
          title: `GSD: ${basename(String(snapshot.projectDir))}`, status: snapshot.status, notes: notesWithState(undefined, snapshot),
          tenant: CONTROLLER, idempotencyKey: key, workspace: { kind: "dir", path: snapshot.projectDir }, labels: ["gsd"],
        });
        persisted = result.card;
        if (this.abort.signal.aborted) return;
      }
      if (!persisted || typeof persisted.id !== "string" || persisted.metadata?.automation?.tenant !== CONTROLLER ||
          persisted.metadata?.automation?.idempotencyKey !== key) throw new Error("Invalid Workboard card response");
      if (persisted.metadata?.archivedAt) { this.observations.delete(key); return; }
      const notes = notesWithState(persisted.notes, snapshot);
      if (persisted.notes !== notes || persisted.status !== snapshot.status) {
        const result = await this.host.request("workboard.cards.update", {
          id: persisted.id, expectedUpdatedAt: persisted.updatedAt, patch: { status: snapshot.status, notes },
        });
        persisted = result.card;
        if (!persisted || persisted.status !== snapshot.status || persisted.notes !== notes) throw new Error("Workboard update was not applied");
      }
    }
    if (this.abort.signal.aborted) return;
    // Only accepted Workboard writes (or a successful memory-only observation)
    // become heartbeat facts or notifications. Conflicts never claim completion.
    this.observations.set(key, snapshot);
    if (!previous || previous.status !== snapshot.status || previous.unavailable !== snapshot.unavailable ||
        JSON.stringify(previous.blockers) !== JSON.stringify(snapshot.blockers)) {
      this.host.notify(key, JSON.stringify({ source: "GSD workflow status", ...(persisted ? { cardId: persisted.id } : {}), ...snapshot }));
    }
  }

  async markUnavailable(projectDir: string, stateDir: string): Promise<void> {
    const key = projectKey(stateDir);
    const { card, snapshot: previous, boardAvailable } = await this.previous(key);
    if (this.abort.signal.aborted) return;
    if (card?.metadata?.archivedAt) { this.observations.delete(key); return; }
    if (!previous) return;
    await this.publish(key, { ...previous, projectDir, status: "blocked", unavailable: true }, previous, card, boardAvailable);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    await this.running;
    this.observations.clear();
  }
}

async function inputVersion(stateDir: string): Promise<string> {
  await stat(stateDir);
  return (await Promise.all(["gsd.db", "gsd.db-wal", "STATE.md", "QUEUE-ORDER.json"].map(async (name) => {
    try {
      const s = await stat(join(stateDir, name), { bigint: true });
      return s.size ? `${name}:${s.size}:${s.mtimeNs}` : "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }))).join("|");
}
