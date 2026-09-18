/** OpenClaw supplies the SDK at runtime; it is not a workspace dependency. */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register: (api: import("./types.js").PluginApi) => void;
  }): unknown;
}

declare module "openclaw/plugin-sdk/gateway-runtime" {
  export function callGatewayFromCli(method: string, options: { timeout: string; json: boolean }, params: Record<string, unknown>,
    extra: { progress: boolean; scopes: string[] }): Promise<Record<string, any>>;
}
declare module "openclaw/plugin-sdk/agent-scope-runtime" {
  export function listAgentIds(config: Record<string, any>): string[];
  export function resolveDefaultAgentId(config: Record<string, any>): string;
}
declare module "openclaw/plugin-sdk/routing" {
  export function buildAgentMainSessionKey(input: { agentId: string; mainKey?: string }): string;
}
