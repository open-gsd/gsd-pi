import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin"
import { registerGsdUiMethods } from "./ui-methods.js"
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectEvents } from "./discovery.js";
import { ProjectSync } from "./sync.js";
import { NotificationRoutes } from "./notification-routes.js";
import { GsdPortalService } from "./portals.js";
import { registerWebTab } from "./webtab.js";
import type { PluginApi } from "./types.js";
import { GsdGatewayRequestError, requestGateway } from "./gateway-request.js";

const GATEWAY_SCOPES: Record<string, OperatorScope[]> = {
  "projects.list": ["operator.read"],
  "plugins.list": ["operator.read"],
  "projects.register": ["operator.admin"],
  "workboard.cards.list": ["operator.read"],
  // Workboard only needs operator.write for ordinary card mutations, but an
  // admin client is required to attach any discovered local project path.
  "workboard.cards.create": ["operator.admin"],
  // Updates only change status/notes, never local workspace authority.
  "workboard.cards.update": ["operator.write"],
  "portal.list": ["operator.read"],
  "portal.open": ["operator.write"],
  "portal.close": ["operator.write"],
};

type OperatorScope = NonNullable<NonNullable<Parameters<typeof callGatewayFromCli>[3]>["scopes"]>[number]

export function gatewayScopes(method: string): OperatorScope[] {
  const scopes = GATEWAY_SCOPES[method];
  if (!scopes) throw new Error(`Unsupported GSD synchronization method: ${method}`);
  return scopes;
}

// Keep runtime validation and generated authoring metadata on the same schema.
const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectSessions: {
      type: "array",
      description: "Optional per-project destinations for factual status events and heartbeat context. Otherwise follows the default agent's configured heartbeat session.",
      items: {
        type: "object", additionalProperties: false,
        properties: { projectDir: { type: "string", minLength: 1 }, sessionKey: { type: "string", minLength: 1 } },
        required: ["projectDir", "sessionKey"],
      },
    },
    webUi: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", description: "Serve the existing GSD web UI in native OpenClaw Portals (default true)." },
        packageRoot: { type: "string", minLength: 1, description: "Local GSD installation root; otherwise resolved from GSD_CLI_PATH or gsd on PATH." },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Optional loopback web host port; otherwise an available port is selected." },
      },
    },
    embeddedProjects: {
      type: "object",
      additionalProperties: false,
      properties: {
        adminOnly: { type: "boolean" },
        projects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              projectId: { type: "string", minLength: 1 },
              canonicalRoot: { type: "string", minLength: 1 },
            },
            required: ["projectId", "canonicalRoot"],
          },
        },
      },
    },
  },
};

const gsdPluginEntry = definePluginEntry({
  id: "open-gsd-openclaw",
  name: "Open GSD",
  description: "GSD web UI in native Portals, MCP tools, and automatic project and Workboard synchronization",
  configSchema: buildJsonPluginConfigSchema(configSchema),
  register(api: PluginApi) {
    // gsd.ui.* embedded-frame methods: individually registered, profile
    // required, native project catalog, with optional narrowing project policy.
    // Cached modules can register into multiple registries. Each registration
    // owns the policy its handlers capture and the subscriptions its service stops.
    const embeddedProjectsConfig: import("./ui-methods.js").EmbeddedProjectsConfig = { projects: [] }
    const gsdUiHandles = registerGsdUiMethods(api as unknown as import("./ui-methods.js").UiMethodApi, () => portal?.webPort, embeddedProjectsConfig)
    let portal: GsdPortalService | undefined;
    let portalRequests: AbortController | undefined;
    registerWebTab(api, () => portal?.webPort);
    api.registerService({
      id: "gsd-web-portal",
      reload: { configPrefixes: ["mcp.servers.gsd", "plugins.entries.open-gsd-openclaw"] },
      start(context) {
        const reportFailure = (error: unknown) => {
          const detail = error instanceof GsdGatewayRequestError ? `: ${error.message}` : "";
          context.serviceHealth?.reportFailure(new Error(`GSD web portal unavailable${detail}`));
          api.logger.warn(`GSD web portal unavailable${detail}; check the GSD web host installation and Gateway portal access.`);
        };
        // Policy is REPLACED on every start/reload - including explicit
        // empty removal, so withdrawn projects lose their grants.
        const embeddedConfig = context.config.plugins?.entries?.["open-gsd-openclaw"]?.config as { embeddedProjects?: unknown } | undefined
        const source = embeddedConfig?.embeddedProjects as { adminOnly?: unknown; projects?: unknown } | undefined
        if (source && typeof source === "object") {
          embeddedProjectsConfig.adminOnly = source.adminOnly !== false
          embeddedProjectsConfig.projects = Array.isArray(source.projects)
            ? source.projects.filter((p): p is { projectId: string; canonicalRoot: string } =>
                typeof (p as { projectId?: unknown })?.projectId === "string" &&
                typeof (p as { canonicalRoot?: unknown })?.canonicalRoot === "string")
            : undefined
        } else {
          embeddedProjectsConfig.adminOnly = true
          embeddedProjectsConfig.projects = undefined
        }
        const requests = new AbortController();
        portalRequests = requests;
        portal = new GsdPortalService({
          config: context.config.plugins?.entries?.["open-gsd-openclaw"]?.config?.webUi,
          env: { ...process.env, ...context.config.mcp?.servers?.gsd?.env },
          request: (method, params) => requestGateway(method, params, gatewayScopes(method), requests.signal),
          onError: reportFailure,
        });
        void portal.start().then(() => {
          context.serviceHealth?.clearFailure();
        }, reportFailure);
      },
      async stop() {
        // Release every live gsd.ui subscription before the host goes down.
        gsdUiHandles.disposeAll()
        await portal?.stop();
        // Portal cleanup reconciles its owned mutation before request admission ends.
        portalRequests?.abort();
        portalRequests = undefined;
        portal = undefined;
      },
    });
    let events: ProjectEvents | undefined;
    let sync: ProjectSync | undefined;
    let notificationRoutes: NotificationRoutes | undefined;
    let unsubscribe: (() => void) | undefined;
    let syncRequests: AbortController | undefined;
    api.registerService({
      id: "gsd-project-sync",
      reload: { configPrefixes: ["agents", "session", "mcp.servers.gsd", "plugins.entries.open-gsd-openclaw", "plugins.entries.workboard", "plugins.allow", "plugins.deny", "plugins.enabled"] },
      start(context) {
        const cfg = context.config;
        const routes = new NotificationRoutes(cfg);
        notificationRoutes = routes;
        const env = { ...process.env, ...cfg.mcp?.servers?.gsd?.env };
        const fail = (error: unknown) => {
          const detail = error instanceof GsdGatewayRequestError ? `: ${error.message}` : "";
          context.serviceHealth?.reportFailure(new Error(`GSD project synchronization failed${detail}`));
          // CLI errors can contain provider output. Detailed project state is
          // available through GSD; don't copy subprocess stderr into host logs.
          api.logger.warn(`GSD project synchronization failed${detail}; check GSD state and Gateway access.`);
        };
        const requests = new AbortController();
        syncRequests = requests;
        sync = new ProjectSync({
          // Public authenticated Gateway client. The in-process runtime gateway
          // facade is reserved for bundled/official plugins, not external ones.
          request: (method, params) => requestGateway(method, params, gatewayScopes(method), requests.signal),
          notify: (key, text, projectDir) => {
            const { sessionKey, agentId } = routes.forProject(projectDir);
            if (api.runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey: key, replace: true })) {
              api.runtime.system.requestHeartbeat({ source: "other", intent: "event", reason: "gsd-project-changed", sessionKey, agentId });
            }
          },
        }, env, fail, () => context.serviceHealth?.clearFailure());
        const instance = sync;
        events = new ProjectEvents(join(env.GSD_STATE_DIR || env.GSD_HOME || join(homedir(), ".gsd"), "projects"),
          (project, stateDir, force) => instance.enqueue(project, stateDir, force), fail);
        const discovery = events;
        discovery.start();
        for (const id of listAgentIds(cfg)) {
          void discovery.add(api.runtime.agent.resolveAgentWorkspaceDir(cfg, id)).catch(fail);
          for (const { entry } of api.runtime.agent.session.listSessionEntries({ agentId: id, readOnly: true })) {
            const path = entry.sessionRoot ?? entry.spawnedCwd;
            if (path) void discovery.add(path).catch(fail);
          }
        }
        // Recover legacy local paths and durable source provenance from the
        // optional native board; absent Workboard leaves only memory state.
        void instance.restore().then((paths) => {
          for (const path of paths) void discovery.add(path).catch(fail);
        }).catch(fail);
        unsubscribe = context.gatewayEvents?.onSessionsChanged((event) => {
          const entry = api.runtime.agent.session.getSessionEntry(event);
          const path = entry?.sessionRoot ?? entry?.spawnedCwd;
          if (path) void discovery.add(path).catch(fail);
        });
      },
      async stop() {
        unsubscribe?.();
        unsubscribe = undefined;
        syncRequests?.abort();
        syncRequests = undefined;
        await events?.stop();
        await sync?.stop();
        events = undefined;
        sync = undefined;
        notificationRoutes = undefined;
      },
    });
    api.on("after_tool_call", (event) => {
      // Discovery only: a tool name/result is never authority to declare success
      // or launch work. The actual GSD read contract supplies all progress.
      if (!event.toolName.includes("gsd")) return;
      const path = event.params.projectDir;
      if (typeof path === "string") void events?.add(path).catch(() => {});
    });
    api.on("heartbeat_prompt_contribution", (event) => {
      if (!sync || !notificationRoutes) return;
      const current = sync.snapshots().filter((snapshot) => snapshot.status !== "done" &&
        notificationRoutes!.forProject(snapshot.projectDir).sessionKey === event.sessionKey);
      if (!current.length) return;
      return { appendContext: JSON.stringify({ source: "GSD workflow records (project data)", projects: current.slice(0, 12).map((snapshot) => {
        return { projectDir: snapshot.projectDir, phase: snapshot.phase,
          milestone: snapshot.milestone, slice: snapshot.slice, task: snapshot.task,
          status: snapshot.status, tasks: snapshot.tasks, unavailable: snapshot.unavailable,
          blockerCount: Array.isArray(snapshot.blockers) ? snapshot.blockers.length : undefined };
      }), additionalProjects: Math.max(0, current.length - 12) }) };
    });
  },
});


// Static authoring metadata for the supported plugins builder: same shape
// defineToolPlugin publishes, attached to our feature-rich entry. The builder
// reads this symbol (public via Symbol.for) plus package.json openclaw.controlUi.
Object.defineProperty(gsdPluginEntry, toolPluginMetadataSymbol, {
  value: {
    id: "open-gsd-openclaw",
    name: "Open GSD",
    description: "GSD web UI in native Portals, MCP tools, and automatic project and Workboard synchronization",
    activation: { onStartup: true },
    configSchema,
    tools: [],
  },
  enumerable: false,
})

export default gsdPluginEntry
