import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveTypeStrippingFlag, resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { HistoryData } from "../../web/lib/remaining-command-types.ts"

const HISTORY_MAX_BUFFER = 2 * 1024 * 1024
const HISTORY_MODULE_ENV = "GSD_HISTORY_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Loads history/metrics data from the workflow database. A child process
 * imports the GSD runtime bridge, opens the project database, reads the
 * unit_metrics rows and computes the aggregation views (totals, byPhase,
 * bySlice, byModel). When the database is missing or holds no unit rows, the
 * units come from .gsd/metrics.json and the result is labelled as a projection
 * fallback. A database that is too new or not bound to this checkout fails.
 */
export async function collectHistoryData(projectCwdOverride?: string): Promise<HistoryData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/mcp-bridge.ts")
  const historyModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(historyModulePath))) {
    throw new Error(
      `history data provider not found; checked=${resolveTsLoader},${historyModulePath}`,
    )
  }
  if (moduleResolution.useCompiledJs && !existsSync(historyModulePath)) {
    throw new Error(`history data provider not found; checked=${historyModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${HISTORY_MODULE_ENV}).href);`,
    'const opened = mod.openExistingWorkflowDatabase(process.env.GSD_HISTORY_BASE);',
    'if (!opened.ok && (opened.reason === "schema-too-new" || opened.reason === "checkout-unbound")) { process.stderr.write(`project database unavailable: ${opened.reason}`); process.exit(1); }',
    'const rows = opened.ok ? mod.listUnitMetrics() : [];',
    'const ledgerUnits = rows.length === 0 ? (mod.loadLedgerFromDisk(process.env.GSD_HISTORY_BASE)?.units ?? []) : [];',
    'const fromFile = !opened.ok || ledgerUnits.length > 0;',
    'const units = fromFile ? ledgerUnits : rows;',
    'const readMetadata = fromFile ? { source: "projection", authority: "projection-fallback" } : undefined;',
    'const totals = mod.getProjectTotals(units);',
    'const byPhase = mod.aggregateByPhase(units);',
    'const bySlice = mod.aggregateBySlice(units);',
    'const byModel = mod.aggregateByModel(units);',
    'process.stdout.write(JSON.stringify({ units, totals, byPhase, bySlice, byModel, readMetadata }));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<HistoryData>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [HISTORY_MODULE_ENV]: historyModulePath,
          GSD_HISTORY_BASE: projectCwd,
        },
        maxBuffer: HISTORY_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`history data subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as HistoryData)
        } catch (parseError) {
          reject(
            new Error(
              `history data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}
