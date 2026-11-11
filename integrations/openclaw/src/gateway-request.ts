import { callGatewayFromCli, isGatewayTransportError } from "openclaw/plugin-sdk/gateway-runtime";
import { setTimeout as delay } from "node:timers/promises";

type Request = (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;

const READ_METHODS = new Set(["projects.list", "plugins.list", "workboard.cards.list", "portal.list"]);

/** Content-free diagnostics: RPC errors can include credentials and local paths. */
export class GsdGatewayRequestError extends Error {
  constructor(method: string, category: string, readonly methodUnavailable = false) {
    super(`GSD Gateway ${method} failed (${category})`);
    this.name = "GsdGatewayRequestError";
  }
}

function category(error: unknown): string {
  if (isGatewayTransportError(error)) return `transport-${error.kind}`;
  if (error instanceof Error) {
    if (error.name === "GatewaySecretRefUnavailableError") return "secret-ref-unavailable";
    if (error.name === "GatewayCredentialsRequiredError") return "credentials-required";
    if (error.name === "GatewayClientRequestError") return "request-rejected";
  }
  return "unavailable";
}

/** Retry only reads after transient startup transport failure, never mutations. */
export async function requestGateway(
  method: string,
  params: Record<string, unknown>,
  scopes: NonNullable<NonNullable<Parameters<typeof callGatewayFromCli>[3]>["scopes"]>,
  signal: AbortSignal,
  deps: { request?: Request; retryDelayMs?: number } = {},
): Promise<Record<string, any>> {
  const request = deps.request ?? ((name, input) => callGatewayFromCli(name,
    { timeout: "10000", json: true }, input, {
      progress: false, scopes,
      // Retain an in-flight mutation's receipt through service stop. Cancelling
      // its transport would make an accepted write's outcome uncertain.
      signal: READ_METHODS.has(name) ? signal : undefined,
    }));
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await request(method, params); }
    catch (error) {
      signal.throwIfAborted();
      const retryable = isGatewayTransportError(error) && (error.kind === "timeout" ||
        (error.kind === "closed" && (error.code === undefined || error.code === 1006 || error.code === 1012)));
      if (!READ_METHODS.has(method) || !retryable || attempt >= 2) {
        const methodUnavailable = error instanceof Error &&
          (error.message === `unknown method: ${method}` || error.message === `method not found: ${method}`);
        throw new GsdGatewayRequestError(method, category(error), methodUnavailable);
      }
      await delay(deps.retryDelayMs ?? 1000, undefined, { signal });
    }
  }
}
