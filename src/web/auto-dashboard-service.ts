import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AutoDashboardData } from "./auto-dashboard-types.ts";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts";

const AUTO_DASHBOARD_MAX_BUFFER = 1024 * 1024;
const TEST_AUTO_DASHBOARD_MODULE_ENV = "GSD_WEB_TEST_AUTO_DASHBOARD_MODULE";
const TEST_AUTO_DASHBOARD_FALLBACK_ENV = "GSD_WEB_TEST_USE_FALLBACK_AUTO_DASHBOARD";
const AUTO_DASHBOARD_MODULE_ENV = "GSD_AUTO_DASHBOARD_MODULE";
const AUTO_DASHBOARD_BRIDGE_MODULE_ENV = "GSD_AUTO_DASHBOARD_BRIDGE_MODULE";

export interface AutoDashboardServiceOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

function fallbackAutoDashboardData(): AutoDashboardData {
  return {
    active: false,
    paused: false,
    stepMode: false,
    startTime: 0,
    elapsed: 0,
    currentUnit: null,
    completedUnits: [],
    basePath: "",
    totalCost: 0,
    totalTokens: 0,
    rtkSavings: null,
    rtkEnabled: false,
  };
}

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}

export function collectTestOnlyFallbackAutoDashboardData(): AutoDashboardData {
  return fallbackAutoDashboardData();
}

export async function collectAuthoritativeAutoDashboardData(
  packageRoot: string,
  options: AutoDashboardServiceOptions = {},
): Promise<AutoDashboardData> {
  const env = options.env ?? process.env;
  if (env[TEST_AUTO_DASHBOARD_FALLBACK_ENV] === "1") {
    return fallbackAutoDashboardData();
  }

  const checkExists = options.existsSync ?? existsSync;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);

  const testModulePath = env[TEST_AUTO_DASHBOARD_MODULE_ENV];
  const moduleResolution = testModulePath
    ? { modulePath: testModulePath, useCompiledJs: false }
    : resolveSubprocessModule(packageRoot, "resources/extensions/gsd/auto.ts", checkExists);
  const autoModulePath = moduleResolution.modulePath;

  if (!moduleResolution.useCompiledJs && (!checkExists(resolveTsLoader) || !checkExists(autoModulePath))) {
    throw new Error(`authoritative auto dashboard provider not found; checked=${resolveTsLoader},${autoModulePath}`);
  }
  if (moduleResolution.useCompiledJs && !checkExists(autoModulePath)) {
    throw new Error(`authoritative auto dashboard provider not found; checked=${autoModulePath}`);
  }
  const bridgeModulePath = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/mcp-bridge.ts",
    checkExists,
  ).modulePath;

  // The subprocess starts with fresh session state, so its own answer is
  // always inactive (#2705). The run state is read from the project database:
  // an open pause, else an active worker row whose process runs now. The run
  // state is part of the web boot payload, so a database that cannot be opened
  // reads as inactive; the reason goes to stderr unless no database exists.
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${AUTO_DASHBOARD_MODULE_ENV}).href);`,
    'const result = await mod.getAutoDashboardData();',
    'const projectCwd = process.env.GSD_WEB_PROJECT_CWD;',
    'if (projectCwd && !result.active && !result.paused) {',
    `const bridge = await import(pathToFileURL(process.env.${AUTO_DASHBOARD_BRIDGE_MODULE_ENV}).href);`,
    'const opened = bridge.openExistingWorkflowDatabase(projectCwd);',
    'if (!opened.ok && opened.reason !== "missing-database" && opened.reason !== "missing-gsd-dir") process.stderr.write(`auto dashboard: project database unavailable: ${opened.error?.message ?? opened.reason}\\n`);',
    'if (opened.ok && bridge.readStoredPausedSession()) result.paused = true;',
    'else if (opened.ok && bridge.hasLiveAutoWorkerForProject(projectCwd)) result.active = true;',
    '}',
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ");

  const prefixArgs = buildSubprocessPrefixArgs(
    packageRoot,
    moduleResolution,
    pathToFileURL(resolveTsLoader).href,
  );

  return await new Promise<AutoDashboardData>((resolveResult, reject) => {
    execFile(
      options.execPath ?? process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...env,
          [AUTO_DASHBOARD_MODULE_ENV]: autoModulePath,
          [AUTO_DASHBOARD_BRIDGE_MODULE_ENV]: bridgeModulePath,
        },
        maxBuffer: AUTO_DASHBOARD_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`authoritative auto dashboard subprocess failed: ${stderr || error.message}`));
          return;
        }
        if (stderr) process.stderr.write(stderr);

        try {
          resolveResult(JSON.parse(stdout) as AutoDashboardData);
        } catch (parseError) {
          reject(
            new Error(
              `authoritative auto dashboard subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      },
    );
  });
}
