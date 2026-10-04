export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Flow {
  flowId: string;
  controllerId?: string;
  ownerKey: string;
  revision: number;
  status: string;
  goal: string;
  currentStep?: string;
  stateJson?: Json;
  cancelRequestedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

export interface FlowWrite {
  flowId: string;
  expectedRevision: number;
  currentStep?: string;
  stateJson?: Json;
  waitJson?: Json;
  blockedSummary?: string | null;
}

export interface Flows {
  list(): Flow[];
  get(id: string): Flow | undefined;
  createManaged(input: { controllerId: string; goal: string; stateJson: Json; notifyPolicy: "silent" }): Flow;
  setWaiting(input: FlowWrite): { applied: boolean; flow?: Flow; code?: string };
  finish(input: FlowWrite): { applied: boolean; flow?: Flow; code?: string };
}

export interface Progress {
  source?: "database" | "markdown";
  phase: string;
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  blockers: string[];
  nextAction: string;
  tasks: { total: number; done: number };
}

export interface Card {
  id: string;
  status: string;
  notes?: string;
  updatedAt: number;
  metadata?: { archivedAt?: number; automation?: { idempotencyKey?: string; tenant?: string } };
}

/** Narrow public host contracts; OpenClaw supplies their implementation. */
export interface PluginApi {
  config: Record<string, any>;
  logger: { warn(message: string): void };
  runtime: {
    agent: {
      resolveAgentWorkspaceDir(config: Record<string, any>, agentId: string): string;
      session: {
        listSessionEntries(input: { agentId: string }): { sessionKey: string; entry: { sessionRoot?: string; cwd?: string } }[];
        getSessionEntry(input: { sessionKey: string; agentId?: string }): { sessionRoot?: string; cwd?: string } | undefined;
      };
    };
    tasks: { managedFlows: { bindSession(input: { sessionKey: string }): Flows } };
    system: {
      enqueueSystemEvent(text: string, options: { sessionKey: string; contextKey: string; replace: boolean }): boolean;
      requestHeartbeat(options: { source: "other"; intent: "event"; reason: string; sessionKey: string; agentId: string }): void;
    };
  };
  registerService(service: {
    id: string;
    reload: { configPrefixes: readonly string[] };
    start(context: ServiceContext): void | Promise<void>;
    stop(): void | Promise<void>;
  }): void;
  on(name: "after_tool_call", handler: (event: { toolName: string; params: Record<string, unknown> }, context: { sessionKey?: string }) => void): void;
  on(name: "heartbeat_prompt_contribution", handler: (event: { sessionKey?: string }) => { appendContext: string } | undefined): void;
}

export interface ServiceContext {
  config: Record<string, any>;
  gatewayEvents?: { onSessionsChanged(listener: (event: { sessionKey: string; agentId?: string }) => void): () => void };
  serviceHealth?: { reportFailure(error: unknown): void; clearFailure(): void };
}
