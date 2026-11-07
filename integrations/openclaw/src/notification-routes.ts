import { listAgentIds, resolveAgentConfig, resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isAbsolute, resolve } from "node:path";

export interface NotificationTarget { agentId: string; sessionKey: string }

/** Operator-selected project routes; no model, delivery policy, or scheduler mutation. */
export class NotificationRoutes {
  private projects = new Map<string, NotificationTarget>();
  private fallback: NotificationTarget;

  constructor(cfg: Record<string, any>) {
    const agentId = resolveSessionAgentIdStrict({ config: cfg, agentId: cfg.agents?.defaults?.systemAgent?.agentId });
    const agents = new Set(listAgentIds(cfg));
    if (!agents.has(agentId)) throw new Error("Invalid GSD notification owner");
    const target = (key: string): NotificationTarget => {
      if (key === "main") return { agentId, sessionKey: buildAgentMainSessionKey({ agentId, mainKey: cfg.session?.mainKey }) };
      const parsed = parseAgentSessionKey(key);
      if (!parsed || !agents.has(parsed.agentId)) throw new Error("Invalid GSD notification session");
      return { agentId: parsed.agentId, sessionKey: `agent:${parsed.agentId}:${parsed.rest}` };
    };
    const heartbeat = resolveAgentConfig(cfg, agentId)?.heartbeat;
    this.fallback = target(heartbeat?.session?.trim() || "main");
    const bindings = cfg.plugins?.entries?.["open-gsd-openclaw"]?.config?.projectSessions ?? [];
    if (!Array.isArray(bindings)) throw new Error("Invalid GSD project notification routes");
    for (const binding of bindings) {
      if (typeof binding?.projectDir !== "string" || !isAbsolute(binding.projectDir) ||
          typeof binding?.sessionKey !== "string" || !binding.sessionKey.trim()) {
        throw new Error("Invalid GSD project notification route");
      }
      const path = resolve(binding.projectDir);
      if (this.projects.has(path)) throw new Error("Duplicate GSD project notification route");
      this.projects.set(path, target(binding.sessionKey.trim()));
    }
  }

  forProject(projectDir: unknown): NotificationTarget {
    return typeof projectDir === "string" ? this.projects.get(resolve(projectDir)) ?? this.fallback : this.fallback;
  }
}
