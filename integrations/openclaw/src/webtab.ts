import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import type { PluginApi } from "./types.js";

/** The gateway route (and Next basePath) under which the GSD web host is published. */
export const GSD_WEB_BASE_PATH = "/plugins/open-gsd-openclaw/web";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHop(headers: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) filtered[name] = value;
  }
  return filtered;
}

export type WebTabTarget = { port?: number };

/**
 * Reverse-proxies the Control UI tab route to the loopback GSD web host. The path is
 * forwarded untouched: the host is built with GSD_WEB_BASE_PATH as its Next basePath,
 * so asset URLs and API calls arrive already prefixed.
 */
export function createWebTabHandler(getTarget: () => WebTabTarget | undefined) {
  return (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    new Promise<void>((resolve) => {
      const target = getTarget();
      if (!target?.port) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("GSD web host is starting; retry shortly.");
        return resolve();
      }
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: target.port,
          path: req.url ?? "/",
          method: req.method,
          headers: withoutHopByHop(req.headers) as Record<string, string>,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, withoutHopByHop(up.headers) as Record<string, string>);
          up.pipe(res);
          up.on("end", () => resolve());
        },
      );
      upstream.on("error", () => {
        if (res.headersSent) {
          res.destroy();
          return resolve();
        }
        res.statusCode = 502;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("GSD web host is unavailable.");
        resolve();
      });
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    });
}

/**
 * Registers the dedicated Control UI tab for the GSD web UI, the same mechanism the
 * toolfactory and vutoolkit plugins use: one gateway-authenticated prefix route on the
 * main gateway origin (so it works through the HTTPS dashboard ingress, unlike portal
 * listenPorts) plus one tab descriptor for the dashboard sidebar.
 */
export function registerWebTab(api: PluginApi, getPort: () => number | undefined): void {
  const extensible = api as PluginApi & {
    registerHttpRoute?: (params: {
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      auth: string;
      match: string;
      replaceExisting?: boolean;
    }) => void;
    registerControlUiDescriptor?: (descriptor: Record<string, unknown>) => void;
    session?: { controls?: { registerControlUiDescriptor?: (descriptor: Record<string, unknown>) => void } };
  };
  if (typeof extensible.registerHttpRoute !== "function") {
    api.logger.warn("GSD web tab unavailable: this Gateway does not expose plugin HTTP routes.");
    return;
  }
  extensible.registerHttpRoute({
    path: GSD_WEB_BASE_PATH,
    // Gateway session auth: the operator's dashboard session is the credential.
    auth: "gateway",
    match: "prefix",
    handler: createWebTabHandler(() => {
      const port = getPort();
      return port ? { port } : undefined;
    }),
    replaceExisting: true,
  });
  const descriptor = {
    id: "open-gsd-openclaw-web",
    surface: "tab",
    label: "GSD",
    description: "GSD web workspace",
    path: `${GSD_WEB_BASE_PATH}/`,
  };
  const registerDescriptor =
    extensible.session?.controls?.registerControlUiDescriptor ?? extensible.registerControlUiDescriptor;
  if (typeof registerDescriptor === "function") {
    registerDescriptor.call(extensible.session?.controls ?? extensible, descriptor);
  } else {
    api.logger.warn("GSD web tab route registered without a Control UI descriptor; the sidebar tab will not appear.");
  }
}
