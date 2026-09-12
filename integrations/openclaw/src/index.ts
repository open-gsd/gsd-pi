import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectEvents } from "./discovery.js";
import { CONTROLLER, ProjectSync, state } from "./sync.js";
import type { Flows, PluginApi } from "./types.js";

const GATEWAY_SCOPES: Record<string, string[]> = {
  "projects.list": ["operator.read"],
  "projects.register": ["operator.admin"],
  "workboard.cards.list": ["operator.read"],
  // Workboard only needs operator.write for ordinary card mutations, but an
  // admin client is required to attach any discovered local project path.
  "workboard.cards.create": ["operator.admin"],
  "workboard.cards.update": ["operator.admin"],
};

export function gatewayScopes(method: string): string[] {
  const scopes = GATEWAY_SCOPES[method];
  if (!scopes) throw new Error(`Unsupported GSD synchronization method: ${method}`);
  return scopes;
}

export default definePluginEntry({
  id: "open-gsd-openclaw",
  name: "Open GSD",
  description: "GSD Pi over MCP with automatic native project, TaskFlow, and Workboard synchronization",
  register(api: PluginApi) {
    let events: ProjectEvents | undefined;
    let sync: ProjectSync | undefined;
    let flows: Flows | undefined;
    let ownerKey: string | undefined;
    let unsubscribe: (() => void) | undefined;
    api.registerService({
      id: "gsd-project-sync",
      reload: { configPrefixes: ["agents", "session", "mcp.servers.gsd", "plugins.entries.workboard"] },
      start(context) {
        const cfg = context.config;
        const agentId = resolveDefaultAgentId(cfg);
        ownerKey = buildAgentMainSessionKey({ agentId, mainKey: cfg.session?.mainKey });
        flows = api.runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
        const sessionKey = ownerKey;
        const env = { ...process.env, ...cfg.mcp?.servers?.gsd?.env };
        const fail = (_error: unknown) => {
          context.serviceHealth?.reportFailure(new Error("GSD project synchronization failed"));
          // CLI errors can contain provider output. Detailed project state is
          // available through GSD; don't copy subprocess stderr into host logs.
          api.logger.warn("GSD project synchronization failed; check GSD state and Gateway access.");
        };
        sync = new ProjectSync({
          flows,
          // Public authenticated Gateway client. The in-process runtime gateway
          // facade is reserved for bundled/official plugins, not external ones.
          request: (method, params) => callGatewayFromCli(method, { timeout: "10000", json: true }, params,
            { progress: false, scopes: gatewayScopes(method) }),
          notify: (key, text) => {
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
          for (const { entry } of api.runtime.agent.session.listSessionEntries({ agentId: id })) {
            const path = entry.sessionRoot ?? entry.cwd;
            if (path) void discovery.add(path).catch(fail);
          }
        }
        // Reload tracked paths as well, including legacy local .gsd directories.
        for (const flow of flows.list()) {
          const path = state(flow).projectDir;
          if (flow.controllerId === CONTROLLER && typeof path === "string") void discovery.add(path).catch(fail);
        }
        unsubscribe = context.gatewayEvents?.onSessionsChanged((event) => {
          const entry = api.runtime.agent.session.getSessionEntry(event);
          const path = entry?.sessionRoot ?? entry?.cwd;
          if (path) void discovery.add(path).catch(fail);
        });
      },
      async stop() {
        unsubscribe?.();
        unsubscribe = undefined;
        await events?.stop();
        await sync?.stop();
        events = undefined;
        sync = undefined;
        flows = undefined;
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
      if (!flows || event.sessionKey !== ownerKey) return;
      const current = flows.list().filter((f) => f.controllerId === CONTROLLER && !f.endedAt && !f.cancelRequestedAt);
      if (!current.length) return;
      return { appendContext: JSON.stringify({ source: "GSD workflow records (project data)", projects: current.slice(0, 12).map((f) => {
        const snapshot = state(f);
        return { flowId: f.flowId, projectDir: snapshot.projectDir, phase: snapshot.phase,
          milestone: snapshot.milestone, slice: snapshot.slice, task: snapshot.task,
          status: snapshot.status, tasks: snapshot.tasks, unavailable: snapshot.unavailable,
          blockerCount: Array.isArray(snapshot.blockers) ? snapshot.blockers.length : undefined };
      }), additionalProjects: Math.max(0, current.length - 12) }) };
    });
  },
});
