import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveBridgeRuntimeConfig } from "./bridge-service.ts"
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.ts"
import type { KnowledgeEntry, KnowledgeData } from "../../web/lib/knowledge-captures-types.ts"

const KNOWLEDGE_MAX_BUFFER = 2 * 1024 * 1024
const KNOWLEDGE_MODULE_ENV = "GSD_KNOWLEDGE_MODULE"

function resolveTsLoaderPath(packageRoot: string): string {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs")
}

/**
 * Reads project knowledge from the workflow database, not from the file on
 * disk. A child process imports the GSD runtime bridge (Turbopack cannot
 * resolve its .js-extension imports), opens the project database, and writes
 * the KNOWLEDGE.md content built from it. An unavailable database fails.
 */
export async function collectKnowledgeData(projectCwdOverride?: string): Promise<KnowledgeData> {
  const config = resolveBridgeRuntimeConfig(undefined, projectCwdOverride)
  const { packageRoot, projectCwd } = config

  const filePath = join(projectCwd, ".gsd", "KNOWLEDGE.md")
  const markdown = await readKnowledgeMarkdownFromDb(packageRoot, projectCwd)

  return {
    entries: parseKnowledgeFile(markdown),
    filePath,
    lastModified: existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null,
  }
}

async function readKnowledgeMarkdownFromDb(packageRoot: string, projectCwd: string): Promise<string> {
  const resolveTsLoader = resolveTsLoaderPath(packageRoot)
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/mcp-bridge.ts")
  const bridgeModulePath = moduleResolution.modulePath

  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(bridgeModulePath))) {
    throw new Error(`knowledge data provider not found; checked=${resolveTsLoader},${bridgeModulePath}`)
  }
  if (moduleResolution.useCompiledJs && !existsSync(bridgeModulePath)) {
    throw new Error(`knowledge data provider not found; checked=${bridgeModulePath}`)
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${KNOWLEDGE_MODULE_ENV}).href);`,
    'const opened = mod.openExistingWorkflowDatabase(process.env.GSD_KNOWLEDGE_BASE);',
    'if (!opened.ok) { process.stderr.write(`project database unavailable: ${opened.reason}`); process.exit(1); }',
    'process.stdout.write(JSON.stringify({ markdown: mod.readKnowledgeMarkdown(process.env.GSD_KNOWLEDGE_BASE) }));',
  ].join(" ")

  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href)

  return await new Promise<string>((resolveResult, reject) => {
    execFile(
      process.execPath,
      [...prefixArgs, "--eval", script],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [KNOWLEDGE_MODULE_ENV]: bridgeModulePath,
          GSD_KNOWLEDGE_BASE: projectCwd,
        },
        maxBuffer: KNOWLEDGE_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`knowledge data subprocess failed: ${stderr || error.message}`))
          return
        }
        try {
          resolveResult(String((JSON.parse(stdout) as { markdown: unknown }).markdown ?? ""))
        } catch (parseError) {
          reject(
            new Error(
              `knowledge data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          )
        }
      },
    )
  })
}

/**
 * Parse KNOWLEDGE.md content into KnowledgeEntry array.
 *
 * Handles two formats:
 * 1. **Freeform**: `## Title` followed by prose paragraphs
 * 2. **Table**: `## Title` followed by a markdown table with rows matching
 *    `| K001 |`, `| P001 |`, or `| L001 |` patterns
 */
function parseKnowledgeFile(content: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = []
  let freeformCounter = 0

  // Split on ## headings, keeping the heading text
  const sections = content.split(/^## /m)

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    // Skip the top-level heading section (# Knowledge Base, # Project Knowledge, etc.)
    if (/^#\s+/m.test(trimmed) && !trimmed.includes("\n## ")) {
      // This is content before the first ## heading — skip if it's just the H1
      const firstLine = trimmed.split("\n")[0]?.trim() ?? ""
      if (firstLine.startsWith("# ")) continue
    }

    // Extract heading (first line) and body (rest)
    const newlineIndex = trimmed.indexOf("\n")
    if (newlineIndex === -1) {
      // Heading-only section with no body — skip
      continue
    }

    const title = trimmed.slice(0, newlineIndex).trim()
    const body = trimmed.slice(newlineIndex + 1).trim()

    if (!title || !body) continue

    // Check for table rows with K/P/L prefixed IDs
    const tableRowRegex = /^\|\s*([KPL]\d{3})\s*\|(.+)\|/gm
    const tableMatches: Array<{ id: string; rest: string }> = []
    let match: RegExpExecArray | null

    while ((match = tableRowRegex.exec(body)) !== null) {
      tableMatches.push({ id: match[1], rest: match[2] })
    }

    if (tableMatches.length > 0) {
      // Table format: parse each row as a structured entry
      for (const row of tableMatches) {
        const prefix = row.id.charAt(0)
        const type: KnowledgeEntry["type"] =
          prefix === "K" ? "rule" : prefix === "P" ? "pattern" : "lesson"

        // Extract columns from the rest of the row
        const columns = row.rest
          .split("|")
          .map((col) => col.trim())
          .filter(Boolean)

        entries.push({
          id: row.id,
          title: columns[0] ?? title,
          content: columns.slice(1).join(" — ") || title,
          type,
        })
      }
    } else {
      // Freeform format: entire section is one entry
      freeformCounter++
      entries.push({
        id: `freeform-${freeformCounter}`,
        title,
        content: body,
        type: "freeform",
      })
    }
  }

  return entries
}
