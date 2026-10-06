import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { UndoInfo, UndoResult } from "../../web/lib/remaining-command-types.ts"

const UNDO_MAX_BUFFER = 2 * 1024 * 1024
const UNDO_MODULE_ENV = "GSD_UNDO_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Runs one export of the gsd undo module in a child process and returns its
 * JSON result. Web undo uses the same DB-backed path as /gsd undo: the last
 * completed unit comes from the unit_dispatches ledger and is reopened through
 * its reopen Domain Operation. The child process is needed because the undo
 * module uses .ts imports that need the resolve-ts.mjs loader.
 */
async function runUndoModule<T>(
  exportName: "describeLastCompletedUnit" | "undoLastCompletedUnit",
  projectCwdOverride?: string,
): Promise<T> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const undoResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/undo.ts")
  const undoModulePath = undoResolution.modulePath

  if (!undoResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(undoModulePath))) {
    throw new Error(`undo service modules not found; checked=${resolveTsLoader},${undoModulePath}`)
  }
  if (undoResolution.useCompiledJs && !existsSync(undoModulePath)) {
    throw new Error(`undo service modules not found; checked=${undoModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const undoMod = await import(pathToFileURL(process.env.${UNDO_MODULE_ENV}).href);`,
    `const result = await undoMod.${exportName}(process.env.GSD_UNDO_BASE);`,
    'process.stdout.write(JSON.stringify(result));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, undoResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<T>((resolveResult, reject) => {
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
          [UNDO_MODULE_ENV]: undoModulePath,
          GSD_UNDO_BASE: projectCwd,
        },
        maxBuffer: UNDO_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`undo subprocess failed: ${stderr || error.message}`))
          return
        }

        try {
          resolveResult(JSON.parse(stdout) as T)
        } catch (parseError) {
          reject(
            new Error(
              `undo subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}

/** Collects the last completed unit from the DB for display in the undo panel. */
export async function collectUndoInfo(projectCwdOverride?: string): Promise<UndoInfo> {
  return await runUndoModule<UndoInfo>("describeLastCompletedUnit", projectCwdOverride)
}

/** Reopens the last completed unit in the DB, the same path as /gsd undo --force. */
export async function executeUndo(projectCwdOverride?: string): Promise<UndoResult> {
  return await runUndoModule<UndoResult>("undoLastCompletedUnit", projectCwdOverride)
}
