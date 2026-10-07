// Project/App: gsd-pi
// File Purpose: The one writer for ~/.gsd/PREFERENCES.md frontmatter in the
// web app. Both the experimental-flags route and the remote-questions route
// read and write that file; they previously carried two copies of the
// frontmatter code and wrote with plain writeFileSync (a crash mid-write
// could truncate the operator's preferences). Writes here go through a
// temp file plus rename in the same directory, which is atomic on POSIX.

import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { join, dirname } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export function getGlobalPreferencesPath(): string {
  return join(homedir(), ".gsd", "PREFERENCES.md")
}

export interface ParsedPreferencesFile {
  data: Record<string, unknown>
  body: string
  hasFrontmatter: boolean
}

export function parsePreferencesFrontmatter(content: string): ParsedPreferencesFile {
  const startMarker = content.startsWith("---\r\n") ? "---\r\n" : "---\n"
  if (!content.startsWith(startMarker)) {
    return { data: {}, body: content, hasFrontmatter: false }
  }
  const searchStart = startMarker.length
  const endIdx = content.indexOf("\n---", searchStart)
  if (endIdx === -1) {
    return { data: {}, body: content, hasFrontmatter: false }
  }
  const block = content.slice(searchStart, endIdx)
  const afterFrontmatter = content.slice(endIdx + 4) // skip \n---

  try {
    const parsed = parseYaml(block.replace(/\r/g, ""))
    const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
    return { data, body: afterFrontmatter, hasFrontmatter: true }
  } catch {
    return { data: {}, body: content, hasFrontmatter: false }
  }
}

export function serializePreferencesFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlStr = stringifyYaml(data, { lineWidth: 0 }).trimEnd()
  return `---\n${yamlStr}\n---${body}`
}

export function readGlobalPreferencesFile(): ParsedPreferencesFile {
  const path = getGlobalPreferencesPath()
  if (!existsSync(path)) return { data: {}, body: "\n", hasFrontmatter: false }
  return parsePreferencesFrontmatter(readFileSync(path, "utf-8"))
}

/** Atomic write: temp file in the target directory, then rename over the target. */
export function writeGlobalPreferencesFile(data: Record<string, unknown>, body: string): void {
  const path = getGlobalPreferencesPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const content = serializePreferencesFrontmatter(data, body)
  const tempPath = join(dir, `.PREFERENCES.md.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tempPath, content, "utf-8")
    renameSync(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // best-effort temp cleanup; the original error matters more
    }
    throw error
  }
}
