import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { GSD_WEB_BASE_PATH } from "./webtab.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface GsdPortalConfig {
  enabled?: boolean;
  packageRoot?: string;
  port?: number;
}

export interface WebLaunch {
  packageRoot: string;
  kind: "packaged-standalone" | "source-dev";
  entry: string;
  cwd: string;
}

interface PortalDependencies {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  reservePort: (requested?: number) => Promise<number>;
  probe: (url: string, signal: AbortSignal) => Promise<boolean>;
  terminate: (child: ChildProcess) => Promise<void>;
  readyTimeoutMs: number;
  pollMs: number;
}

export interface GsdPortalOptions {
  config?: GsdPortalConfig;
  env?: NodeJS.ProcessEnv;
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;
  onError?: (error: Error) => void;
  /** Dependency injection keeps lifecycle tests independent of a live Gateway. */
  deps?: Partial<PortalDependencies>;
}

interface PortalRun {
  abort: AbortController;
  startup?: Promise<void>;
  cleanup?: Promise<void>;
  child?: ChildProcess;
  portalId?: string;
  ready: boolean;
  stopping: boolean;
}

const LOOPBACK = "127.0.0.1";
const PACKAGE_NAMES = new Set(["@opengsd/gsd-pi", "gsd-pi"]);

function packageAt(path: string): boolean {
  try {
    return PACKAGE_NAMES.has(JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name);
  } catch { return false; }
}

function findCli(env: NodeJS.ProcessEnv): string | undefined {
  const command = env.GSD_CLI_PATH || "gsd";
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? realpathSync(command) : undefined;
  }
  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? ["", ".cmd", ".exe"] : [""]) {
      const candidate = join(directory, command + suffix);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  return undefined;
}

export function resolveWebLaunch(config: GsdPortalConfig, env: NodeJS.ProcessEnv): WebLaunch {
  let packageRoot: string | undefined;
  if (config.packageRoot) {
    try { packageRoot = realpathSync(resolve(config.packageRoot)); } catch { /* diagnosed below */ }
    if (!packageRoot || !packageAt(packageRoot)) throw new Error("GSD portal packageRoot must identify an installed GSD package.");
  } else {
    const cli = findCli(env);
    let directory = cli ? dirname(cli) : undefined;
    while (directory) {
      if (packageAt(directory)) { packageRoot = directory; break; }
      const parent = dirname(directory);
      directory = parent === directory ? undefined : parent;
    }
  }
  if (!packageRoot) throw new Error("GSD portal cannot locate GSD; configure webUi.packageRoot or GSD_CLI_PATH.");

  const standalone = join(packageRoot, "dist", "web", "standalone", "server.js");
  if (existsSync(standalone)) return { packageRoot, kind: "packaged-standalone", entry: standalone, cwd: dirname(standalone) };
  const source = join(packageRoot, "web", "node_modules", "next", "dist", "bin", "next");
  if (existsSync(source) && existsSync(join(packageRoot, "web", "package.json"))) {
    return { packageRoot, kind: "source-dev", entry: source, cwd: join(packageRoot, "web") };
  }
  throw new Error("GSD portal web host is missing; install a GSD package with its web build or build the source web host.");
}

async function reservePort(requested?: number): Promise<number> {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
    throw new Error("GSD portal port must be an integer between 1 and 65535.");
  }
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(requested ?? 0, LOOPBACK, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close(() => reject(new Error("GSD portal could not reserve a loopback port.")));
        return;
      }
      socket.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function probe(url: string, signal: AbortSignal): Promise<boolean> {
  // The host is built with the tab route as its Next basePath, so root paths 404.
  const response = await fetch(`${url}${GSD_WEB_BASE_PATH}/api/boot`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); return false; }
  const boot = await response.json() as Record<string, unknown>;
  // No project means no RPC bridge, session creation, or workflow execution.
  return boot.project === null && boot.bridge === null && boot.workspace === null;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" && child.pid) {
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      try { process.kill(-pid, signal); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    if (!signalGroup("SIGTERM")) return;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!signalGroup(0)) return;
      await delay(50);
    }
    signalGroup("SIGKILL");
  } else {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + 3_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One plugin-owned project-picker host, published through native Portals. */
export class GsdPortalService {
  private run?: PortalRun;
  private readonly deps: PortalDependencies;
  private currentPort?: number;

  /** Loopback port of the running GSD web host; undefined while stopped. */
  get webPort(): number | undefined {
    return this.currentPort;
  }

  constructor(private readonly options: GsdPortalOptions) {
    this.deps = { spawn, reservePort, probe, terminate, readyTimeoutMs: 180_000, pollMs: 250, ...options.deps };
  }

  start(): Promise<void> {
    if (this.options.config?.enabled === false) return Promise.resolve();
    if (this.run) return this.run.startup!;
    const run: PortalRun = { abort: new AbortController(), ready: false, stopping: false };
    this.run = run;
    run.startup = this.launch(run).catch(async (error) => {
      const cancelled = run.stopping;
      const failure = run.abort.signal.aborted ? run.abort.signal.reason : error;
      run.abort.abort();
      await this.cleanup(run);
      if (this.run === run) this.run = undefined;
      if (!cancelled) throw failure;
    });
    return run.startup;
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.stopping = true;
    this.currentPort = undefined;
    run.abort.abort();
    await run.startup?.catch(() => {});
    await this.cleanup(run);
    if (this.run === run) this.run = undefined;
  }

  private async launch(run: PortalRun): Promise<void> {
    const config = this.options.config ?? {};
    const env = { ...(this.options.env ?? process.env) };
    const launch = resolveWebLaunch(config, env);
    const port = await this.deps.reservePort(config.port);
    this.currentPort = port;
    run.abort.signal.throwIfAborted();
    const listed = await this.options.request("portal.list", {});
    if (!Array.isArray(listed.portals)) throw new Error("GSD portal could not verify existing native portals.");
    const portals = listed.portals;
    if (portals.some((portal) => portal.port === port || portal.id === `p${port}`)) {
      throw new Error("GSD portal target port already belongs to another portal.");
    }
    run.abort.signal.throwIfAborted();
    const openedAt = Date.now();
    // The proxy forwards the full request path and the portal URL carries this path,
    // matching the basePath the web host was built with.
    const registration = { port, title: "GSD", description: "GSD native web workspace", path: GSD_WEB_BASE_PATH };
    let portal: Record<string, any>;
    try {
      portal = await this.options.request("portal.open", registration);
    } catch {
      // An RPC timeout does not prove the mutation failed. Reconcile once using
      // the previously unused port and the Gateway's creation metadata.
      const uncertain = () => this.options.onError?.(new Error("GSD native portal registration outcome is unverified; inspect native Portals before retrying."));
      try {
        const current = await this.options.request("portal.list", {});
        if (!Array.isArray(current.portals)) uncertain();
        else {
          const candidate = current.portals.find((item: Record<string, any>) => item.id === `p${port}`);
          if (candidate && candidate.port === port && candidate.title === registration.title && candidate.description === registration.description
            && typeof candidate.createdAtMs === "number" && candidate.createdAtMs >= openedAt) run.portalId = candidate.id;
          else if (candidate) uncertain();
        }
      } catch { uncertain(); }
      throw new Error("GSD native portal registration failed.");
    }
    // Remember ownership before validating the response or observing cancellation.
    run.portalId = `p${port}`;
    if (portal.id !== run.portalId || typeof portal.publicUrl !== "string") throw new Error("GSD portal returned an invalid registration.");
    const publicUrl = new URL(portal.publicUrl);
    if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      throw new Error("GSD portal did not provide a token-free public URL.");
    }
    run.abort.signal.throwIfAborted();
    // Auth belongs to the native portal. Never propagate launch tokens or a
    // default project/session directory into the shared project-picker host.
    for (const name of ["GSD_WEB_AUTH_TOKEN", "GSD_WEB_PROJECT_CWD", "GSD_WEB_PROJECT_SESSIONS_DIR", "GSD_WEB_ALLOWED_ORIGINS", "GSD_WEB_ALLOW_UNAUTHENTICATED_LAN"]) delete env[name];
    Object.assign(env, {
      HOSTNAME: LOOPBACK, PORT: String(port), GSD_WEB_HOST: LOOPBACK, GSD_WEB_PORT: String(port),
      GSD_WEB_PACKAGE_ROOT: launch.packageRoot, GSD_WEB_HOST_KIND: launch.kind,
      GSD_WEB_NO_AUTH: "1", GSD_WEB_DAEMON_MODE: "1", PUBLIC_URL: portal.publicUrl,
      GSD_WEB_BASE_PATH,
      NODE_ENV: launch.kind === "source-dev" ? "development" : "production",
    });
    if (launch.kind === "source-dev") env.NEXT_PUBLIC_GSD_DEV = "1";
    else delete env.NEXT_PUBLIC_GSD_DEV;
    const args = launch.kind === "source-dev"
      ? [launch.entry, "dev", "--webpack", "--hostname", LOOPBACK, "--port", String(port)] : [launch.entry];
    const child = this.deps.spawn(process.execPath, args, {
      cwd: launch.cwd, env, detached: process.platform !== "win32", stdio: "ignore", windowsHide: true,
    });
    run.child = child;
    const childStopped = new Promise<never>((_resolve, reject) => {
      const stopped = () => {
        const error = new Error("GSD portal web host exited or failed to start.");
        reject(error);
        if (run.ready && !run.abort.signal.aborted) {
          run.abort.abort();
          const reportFailure = () => {
            if (this.run === run) this.run = undefined;
            this.options.onError?.(error);
          };
          void this.cleanup(run).then(reportFailure, reportFailure);
        }
      };
      child.once("error", stopped);
      child.once("exit", stopped);
    });
    const timeout = setTimeout(() => run.abort.abort(new Error("GSD portal web host readiness timed out.")), this.deps.readyTimeoutMs);
    try {
      await Promise.race([this.waitReady(`http://${LOOPBACK}:${port}`, run.abort.signal), childStopped]);
      run.ready = true;
    } finally { clearTimeout(timeout); }
  }

  private async waitReady(url: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { if (await abortable(this.deps.probe(url, signal), signal)) return; } catch {
        signal.throwIfAborted();
      }
      await delay(this.deps.pollMs, undefined, { signal });
    }
    signal.throwIfAborted();
  }

  private cleanup(run: PortalRun): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async () => {
      // Stop the owned child even if Gateway has already closed its portals.
      try { if (run.child) await this.deps.terminate(run.child); } finally {
        if (run.portalId) {
          try { await this.options.request("portal.close", { id: run.portalId }); } catch {
            // Gateway teardown closes all portals before plugin service.stop.
            // Report uncertainty without copying potentially secret-bearing RPC errors.
            this.options.onError?.(new Error("GSD web host stopped, but native portal closure could not be verified."));
          }
        }
      }
    })();
    return run.cleanup;
  }
}
