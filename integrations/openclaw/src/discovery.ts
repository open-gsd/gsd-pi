import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** Discover GSD's existing registry and host-selected checkouts. No scan or timer. */
export class ProjectEvents {
  private watchers = new Map<string, FSWatcher>();
  private roots = new Map<string, string>();
  private stopped = false;
  private scan?: Promise<void>;
  private rescan = false;

  constructor(
    private registry: string,
    private onProject: (projectDir: string, stateDir: string, force?: boolean) => void,
    private onError: (error: unknown) => void,
  ) {}

  start(): void { this.refresh(); }

  refresh(): void {
    if (this.stopped) return;
    this.rescan = true;
    if (this.scan) return;
    this.scan = (async () => {
      while (this.rescan && !this.stopped) {
        this.rescan = false;
        await this.scanRegistry();
      }
    })().catch(this.onError).finally(() => { this.scan = undefined; });
  }

  private async watchDirectory(path: string, changed: (name: string) => void, recursive = false): Promise<void> {
    if (this.stopped || this.watchers.has(path)) return;
    try {
      const watcher = watch(path, { recursive }, (_event, filename) => {
        if (!this.stopped) changed(filename?.toString() ?? "");
      });
      watcher.on("error", (error) => {
        watcher.close();
        this.watchers.delete(path);
        this.onError(error);
      });
      this.watchers.set(path, watcher);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async scanRegistry(): Promise<void> {
    // Watch existing ancestors too: the first GSD project may create the registry
    // after the Gateway starts. Atomic directory replacement also invalidates it.
    let child = this.registry;
    for (let parent = dirname(child); parent !== child; parent = dirname(child)) {
      const expected = basename(child);
      await this.watchDirectory(parent, (name) => {
        if (!name || name === expected) {
          this.invalidate(join(parent, expected));
          this.refresh();
        }
      });
      try { await stat(parent); break; } catch { child = parent; }
    }
    await this.watchDirectory(this.registry, (name) => {
      const path = join(this.registry, name);
      this.invalidate(path);
      this.refresh();
    });
    let entries;
    try { entries = await readdir(this.registry, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateDir = join(this.registry, entry.name);
      await this.watchDirectory(stateDir, (name) => this.stateChanged(stateDir, name));
      try {
        const meta = JSON.parse(await readFile(join(stateDir, "repo-meta.json"), "utf8"));
        if (meta.version !== 1 || typeof meta.gitRoot !== "string" || !isAbsolute(meta.gitRoot)) continue;
        // Stale or edited metadata must not associate another repository's state.
        if (await realpath(join(meta.gitRoot, ".gsd")) !== await realpath(stateDir)) continue;
        await this.add(meta.gitRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) this.onError(error);
      }
    }
  }

  async add(path: string): Promise<void> {
    if (this.stopped || !isAbsolute(path)) return;
    let projectDir;
    try { projectDir = await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Observe later initialization or replacement of .gsd in a bound checkout.
    await this.watchDirectory(projectDir, (name) => {
      if (!name || name === ".gsd") {
        this.invalidate(join(projectDir, ".gsd"));
        void this.add(projectDir).catch(this.onError);
      }
    });
    let stateDir;
    try { stateDir = await realpath(join(projectDir, ".gsd")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.roots.set(stateDir, projectDir);
    await this.watchDirectory(stateDir, (name) => this.stateChanged(stateDir, name));
    await this.watchMilestones(projectDir, stateDir);
    if (!this.stopped) this.onProject(projectDir, stateDir);
  }

  private stateChanged(stateDir: string, name: string): void {
    if (!name || name === "repo-meta.json") this.refresh();
    const project = this.roots.get(stateDir);
    if (!project) return;
    if (!name || name === "milestones") {
      this.watchers.get(join(stateDir, "milestones"))?.close();
      this.watchers.delete(join(stateDir, "milestones"));
      void this.watchMilestones(project, stateDir).catch(this.onError);
    }
    if (relevant(name) || name === "milestones") this.onProject(project, stateDir, !name.startsWith("gsd.db"));
  }

  private watchMilestones(project: string, stateDir: string): Promise<void> {
    return this.watchDirectory(join(stateDir, "milestones"), (name) => {
      if (!name || name.endsWith(".md")) this.onProject(project, stateDir, true);
    }, true);
  }

  private invalidate(path: string): void {
    for (const [key, watcher] of this.watchers) {
      if (key === path || key.startsWith(path + sep)) {
        watcher.close();
        this.watchers.delete(key);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.scan;
  }
}

function relevant(name: string): boolean {
  // SQLite's SHM is reader bookkeeping. Opening a read command can change it;
  // feeding that back into another read would create a self-triggered loop.
  return !name || name === "gsd.db" || name === "gsd.db-wal" || name.endsWith(".md") || name === "QUEUE-ORDER.json";
}
