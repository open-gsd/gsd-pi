/**
 * Plugin registration, kept free of the OpenClaw runtime import so it can be
 * unit-tested with a stub `api`. `index.ts` is the only module that imports
 * the SDK.
 */

import { join } from "node:path";
import { BindStore } from "./binding.js";
import { createGsdCommand, type ServiceState } from "./commands.js";
import { GsdCli } from "./gsd-cli.js";
import { readPluginConfig, type OpenClawPluginApi } from "./types.js";

export const PLUGIN_ID = "open-gsd-openclaw";
export const PLUGIN_NAME = "Open GSD";
export const PLUGIN_DESCRIPTION =
  "GSD Pi structured delivery engine: /gsd commands, supervised headless runs, and chat notifications";

export const BINDINGS_FILE = "bindings.json";

export function register(api: OpenClawPluginApi): void {
  const config = readPluginConfig(api.pluginConfig);
  let service: ServiceState | null = null;

  api.registerCommand(
    createGsdCommand({
      config,
      logger: api.logger,
      getService: () => service,
    }),
  );

  api.registerService({
    id: PLUGIN_ID,
    start(ctx) {
      // ctx.stateDir is the OpenClaw state root; plugin-owned files live under
      // plugin-state/<id>, the same layout the reference plugins use.
      const stateDir = join(ctx.stateDir, "plugin-state", PLUGIN_ID);
      service = {
        bindStore: new BindStore(join(stateDir, BINDINGS_FILE)),
        cli: new GsdCli(config.cliPath),
      };
      ctx.logger.info(`open-gsd-openclaw ready (gsd: ${config.cliPath}, state: ${stateDir})`);
    },
    stop() {
      service = null;
    },
  });
}
