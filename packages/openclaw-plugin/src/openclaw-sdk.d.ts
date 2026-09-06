/**
 * Ambient declaration for the OpenClaw plugin SDK subset this plugin uses.
 *
 * OpenClaw resolves `openclaw/plugin-sdk/*` at runtime: for npm installs the
 * installer links the host package into the plugin's module graph, and for a
 * linked source checkout the host loads the TypeScript entry with its own SDK
 * alias map. The host is therefore never a build-time dependency of gsd-pi.
 * This file mirrors only the members the plugin touches; the shapes follow
 * `src/plugins/plugin-command.types.ts` and `plugin-registration.types.ts` in
 * openclaw/openclaw. Behaviour is verified against the real host by the
 * `openclaw plugins inspect --runtime` check documented in the README.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    senderIsOwner?: boolean;
    gatewayClientScopes?: string[];
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    args?: string;
    commandBody: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
    threadParentId?: string;
  }

  export interface PluginCommandResult {
    text?: string;
    continueAgent?: boolean;
    suppressReply?: boolean;
  }

  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    requiredScopes?: string[];
    agentPromptGuidance?: string[];
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }

  export interface OpenClawPluginServiceContext {
    config: unknown;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
  }

  export interface OpenClawPluginService {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  }

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registrationMode?: string;
    registerCommand(definition: OpenClawPluginCommandDefinition): void;
    registerService(service: OpenClawPluginService): void;
  }

  export interface OpenClawPluginEntry {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(entry: OpenClawPluginEntry): OpenClawPluginEntry;
}
