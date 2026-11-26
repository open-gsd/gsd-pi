// Runtime dependency checks — pure helpers used by loader.ts.
// Extracted so they can be unit-tested without spawning the full loader.

import { existsSync } from 'fs'
import { delimiter, join } from 'path'

/**
 * Minimum supported Node.js version. Kept in sync with
 * `engines.node` in package.json — see test
 * `loader MIN_NODE_VERSION matches package.json engines field`.
 */
export const MIN_NODE_VERSION = '22.19.0'
export const MIN_NODE_MAJOR = Number(MIN_NODE_VERSION.split('.')[0])

function parseNodeVersion(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error(`checkNodeVersion: cannot parse version from "${version}"`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Parse a Node version string (e.g. "22.18.1") and return whether it meets
 * the required minimum.
 *
 * Returns `{ ok: true }` when supported, or `{ ok: false, actualVersion }`
 * when below the minimum. Throws if the version string is malformed —
 * callers should treat that as a fatal precondition violation.
 */
export function checkNodeVersion(
  versionString: string,
  min: string = MIN_NODE_VERSION,
): { ok: true } | { ok: false; actualVersion: string } {
  const actual = parseNodeVersion(versionString)
  const minimum = parseNodeVersion(min)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] === minimum[index]) continue
    return actual[index] < minimum[index] ? { ok: false, actualVersion: versionString } : { ok: true }
  }
  return { ok: true }
}

/**
 * Probe whether `git` is available by invoking the supplied exec function.
 * Returns true on success, false if the exec throws (any reason). The
 * function is injected so tests can substitute a stub without spawning a
 * real subprocess.
 */
export function requireGit(
  execFn: (cmd: string, args: ReadonlyArray<string>) => unknown,
): boolean {
  try {
    execFn('git', ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Fast presence check for `git`: scan the directories on `$PATH` for a `git`
 * executable (plus Windows `.exe`/`.cmd` variants) instead of spawning
 * `git --version`. The subprocess form costs ~15ms on every startup and showed
 * up as ~5% of cold-start CPU; a filesystem `existsSync` scan is far cheaper and
 * answers the same gate ("is git installed"). Returns true if a candidate path
 * exists. `env`/`platform` are injectable so this can be unit-tested without a
 * real $PATH.
 */
export function gitAvailableOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  if (pathValue.length === 0) return false
  const dirs = pathValue.split(delimiter).filter((d) => d.length > 0)
  const names = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => `git${ext.toLowerCase()}`).concat('git')
    : ['git']
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return true
    }
  }
  return false
}
