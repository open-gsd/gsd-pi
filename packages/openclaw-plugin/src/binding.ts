/**
 * Conversation → project binding.
 *
 * Keyed by the conversation route (channel, account, conversation, thread)
 * rather than the session key: native slash commands run under a per-user
 * `…:slash:<userId>` session while typed commands use the chat session, and
 * the route is the only identity stable across both.
 *
 * Persisted as a JSON file under the plugin's service state directory because
 * OpenClaw's keyed stores are reserved for bundled plugins and session
 * extensions have no plugin-side write path.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isGsdProject } from "./gsd-cli.js";
import type { PluginCommandContext } from "./types.js";

export interface Route {
  channel: string;
  accountId?: string;
  conversationId: string;
  threadId?: string;
}

export function routeFromCommandContext(ctx: Pick<PluginCommandContext, "channel" | "accountId" | "to" | "from" | "sessionKey" | "messageThreadId">): Route | null {
  const conversationId = ctx.to?.trim() || ctx.from?.trim() || ctx.sessionKey?.trim();
  if (!ctx.channel || !conversationId) return null;
  const threadId =
    ctx.messageThreadId === undefined || ctx.messageThreadId === null || ctx.messageThreadId === ""
      ? undefined
      : String(ctx.messageThreadId);
  return {
    channel: ctx.channel,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    conversationId,
    ...(threadId ? { threadId } : {}),
  };
}

export function routeKey(route: Route): string {
  return [route.channel, route.accountId ?? "", route.conversationId, route.threadId ?? ""].join("|");
}

export class BindStore {
  private readonly bindings = new Map<string, string>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(key: string): string | undefined {
    return this.bindings.get(key);
  }

  set(key: string, projectDir: string): void {
    this.bindings.set(key, projectDir);
    this.save();
  }

  delete(key: string): boolean {
    const existed = this.bindings.delete(key);
    if (existed) this.save();
    return existed;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { bindings?: Record<string, unknown> };
      for (const [key, value] of Object.entries(parsed.bindings ?? {})) {
        if (typeof value === "string") this.bindings.set(key, value);
      }
    } catch {
      // A corrupt file is treated as empty; the next save rewrites it.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, bindings: Object.fromEntries(this.bindings) }, null, 2));
    renameSync(tmp, this.filePath);
  }
}

export type ProjectResolution = { ok: true; dir: string; source: "explicit" | "bind" | "default" } | { ok: false; error: string };

/** Validate a user-supplied project path: absolute, existing, and a GSD project. */
export function validateProjectPath(raw: string): ProjectResolution {
  if (!isAbsolute(raw)) {
    return { ok: false, error: `Project path must be absolute: \`${raw}\`` };
  }
  const dir = resolve(raw);
  if (!isGsdProject(dir)) {
    return { ok: false, error: `\`${dir}\` is not a GSD project. Choose a directory containing \`.gsd/\`.` };
  }
  return { ok: true, dir, source: "explicit" };
}

export const NO_PROJECT_MESSAGE =
  "No GSD project bound. Use `/gsd bind <absolute path>` or set `plugins.entries.open-gsd-openclaw.config.defaultProject`.";

/**
 * Resolution order: explicit argument → conversation binding → configured
 * default → fail closed. No cwd or workspace sniffing.
 */
export function resolveProject(input: { explicit?: string; bound?: string; defaultProject?: string }): ProjectResolution {
  if (input.explicit) return validateProjectPath(input.explicit);
  for (const [source, candidate] of [
    ["bind", input.bound],
    ["default", input.defaultProject],
  ] as const) {
    if (!candidate) continue;
    const checked = validateProjectPath(candidate);
    if (checked.ok) return { ok: true, dir: checked.dir, source };
    return { ok: false, error: `${checked.error} (from ${source === "bind" ? "/gsd bind" : "defaultProject"})` };
  }
  return { ok: false, error: NO_PROJECT_MESSAGE };
}
