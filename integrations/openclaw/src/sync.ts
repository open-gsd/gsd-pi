import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Card, Flow, Flows, Json, Progress } from "./types.js";

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
  flows: Flows;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  notify(key: string, text: string): void;
}

/** Project a GSD workflow into host records. This never launches or retries work. */
export class ProjectSync {
  private pending = new Map<string, { projectDir: string; force: boolean }>();
  private running?: Promise<void>;
  private abort = new AbortController();
  private lastInputs = new Map<string, string>();
  private failures = new Set<string>();

  constructor(private host: SyncHost, private env: NodeJS.ProcessEnv, private onError: (error: unknown) => void,
    private onHealthy: () => void = () => {}) {}

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
        // Ignore duplicate OS events and zero-length WAL files created by readers.
        let inputs;
        let progress;
        try {
          inputs = await inputVersion(stateDir);
          if (!force && this.lastInputs.get(stateDir) === inputs) continue;
          if (await realpath(join(projectDir, ".gsd")) !== await realpath(stateDir)) throw new Error("GSD state location changed");
          const databaseExpected = this.host.flows.list().some((f) => f.controllerId === CONTROLLER &&
            state(f).key === projectKey(stateDir) && state(f).stateSource === "database");
          progress = await readProgress(projectDir, this.env, this.abort.signal, databaseExpected);
        }
        catch (error) {
          if (!this.abort.signal.aborted) await this.markUnavailable(projectDir, stateDir);
          throw error;
        }
        if (this.abort.signal.aborted) return;
        await this.reconcile(projectDir, stateDir, progress);
        this.lastInputs.set(stateDir, inputs);
        this.failures.delete(stateDir);
        if (!this.failures.size) this.onHealthy();
      } catch (error) {
        if (!this.abort.signal.aborted) {
          this.failures.add(stateDir);
          this.onError(error);
        }
      }
    }
  }

  async reconcile(projectDir: string, stateDir: string, progress: Progress): Promise<void> {
    const key = projectKey(stateDir);
    const flows = this.host.flows;
    let flow: Flow | undefined = flows.list().filter((f) => f.controllerId === CONTROLLER && state(f).key === key)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // A native cancellation is sticky. It cancels this observation flow, not
    // GSD's external process (there is deliberately no fictitious child task).
    if (flow?.cancelRequestedAt || flow?.status === "cancelled") return;
    const previous = flow && state(flow);
    let projectId = previous?.projectDir === projectDir && typeof previous.projectId === "string" ? previous.projectId : undefined;
    if (!projectId) {
      const project = await this.host.request("projects.register", { path: projectDir });
      if (typeof project.id !== "string" || !project.id) throw new Error("Invalid OpenClaw project registration response");
      projectId = project.id;
    }
    if (this.abort.signal.aborted) return;
    const status = progress.blockers.length || progress.phase === "blocked" ? "blocked" : progress.phase === "complete" ? "done" :
      ["execute", "executing", "execution", "verifying", "verification", "summarizing"].includes(progress.phase) ? "running" : "todo";
    const snapshot = {
      key, projectDir, stateDir, projectId, stateSource: progress.source ?? "unknown", phase: progress.phase,
      milestone: progress.activeMilestone?.id ?? null,
      slice: progress.activeSlice?.id ?? null,
      task: progress.activeTask?.id ?? null,
      status,
      tasks: progress.tasks ? `${progress.tasks.done}/${progress.tasks.total}` : null,
      blockers: progress.blockers.slice(0, 8).map((b) => b.slice(0, 500)),
      nextAction: (progress.nextAction ?? "").slice(0, 1000),
    };
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(snapshot);
    if (flow?.endedAt && changed && status !== "done") flow = undefined;
    if (!flow) flow = flows.createManaged({
      controllerId: CONTROLLER, goal: `GSD: ${basename(projectDir)}`, stateJson: snapshot, notifyPolicy: "silent",
    });
    if (changed || flow.status === "queued") {
      // Re-read after awaited host I/O; cancellation or another controller wins.
      const current = flows.get(flow.flowId);
      if (!current || current.cancelRequestedAt || current.endedAt) return;
      const input = { flowId: current.flowId, expectedRevision: current.revision, stateJson: snapshot };
      const result = status === "done" ? flows.finish(input) : flows.setWaiting({
        ...input, currentStep: [snapshot.phase, snapshot.milestone, snapshot.slice, snapshot.task].filter(Boolean).join(" / "),
        waitJson: { kind: "external-event", source: "gsd", projectId },
        blockedSummary: snapshot.blockers.join("\n") || null,
      });
      if (!result.applied || !result.flow) throw new Error(`GSD TaskFlow update refused: ${result.code}`);
      flow = result.flow;
    }
    if (this.abort.signal.aborted) return;
    if (changed && (!previous || previous.status !== status || JSON.stringify(previous.blockers) !== JSON.stringify(snapshot.blockers))) {
      this.host.notify(key, JSON.stringify({ source: "GSD workflow status", flowId: flow.flowId, ...snapshot }));
    }
    await this.syncCard(key, flow, snapshot, projectDir);
  }

  private async syncCard(key: string, flow: Flow, snapshot: Record<string, Json>, projectDir: string): Promise<void> {
    let cards: Card[];
    try { cards = (await this.host.request("workboard.cards.list", {})).cards; }
    catch (error) {
      // Workboard is an optional bundled plugin. Permission/storage failures
      // must remain visible; only a genuinely unavailable method is optional.
      if (/unknown method|method not found/i.test(String(error))) return;
      throw error;
    }
    if (this.abort.signal.aborted || this.host.flows.get(flow.flowId)?.cancelRequestedAt) return;
    let card = cards.find((c) => c.metadata?.automation?.tenant === CONTROLLER && c.metadata.automation.idempotencyKey === key);
    if (card?.metadata?.archivedAt) return;
    const notes = `Automatically synchronized GSD workflow (execution liveness is not inferred).\nTaskFlow: ${flow.flowId}\nProject: ${projectDir}\n${JSON.stringify(snapshot, null, 2)}`;
    if (!card) {
      card = (await this.host.request("workboard.cards.create", {
        title: flow.goal, status: snapshot.status, notes,
        tenant: CONTROLLER, idempotencyKey: key,
        workspace: { kind: "dir", path: projectDir }, labels: ["gsd"],
      })).card;
    }
    if (!this.abort.signal.aborted && card && (card.notes !== notes || card.status !== snapshot.status)) {
      await this.host.request("workboard.cards.update", {
        id: card.id, expectedUpdatedAt: card.updatedAt, patch: { status: snapshot.status, notes },
      });
    }
  }

  async markUnavailable(projectDir: string, stateDir: string): Promise<void> {
    const key = projectKey(stateDir);
    const flow = this.host.flows.list().find((f) => f.controllerId === CONTROLLER && state(f).key === key && !f.endedAt && !f.cancelRequestedAt);
    if (!flow) return;
    const snapshot = { ...state(flow), status: "blocked", unavailable: true };
    if (state(flow).unavailable !== true) {
      const result = this.host.flows.setWaiting({
        flowId: flow.flowId, expectedRevision: flow.revision, stateJson: snapshot,
        currentStep: "GSD state unavailable", blockedSummary: "GSD state could not be read; previous progress is retained.",
        waitJson: { kind: "external-event", source: "gsd" },
      });
      if (!result.applied) throw new Error(`GSD TaskFlow update refused: ${result.code}`);
      this.host.notify(key, JSON.stringify({ source: "GSD workflow status", flowId: flow.flowId, projectDir, unavailable: true }));
    }
    await this.syncCard(key, flow, snapshot, projectDir);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    await this.running;
  }
}

export function state(flow: Flow): Record<string, Json> {
  return flow.stateJson && typeof flow.stateJson === "object" && !Array.isArray(flow.stateJson) ? flow.stateJson : {};
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
