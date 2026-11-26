#!/usr/bin/env node
/**
 * Trim deleted-by-seam exports from packages/pi-coding-agent/src/index.ts.
 * Operates on the current vendored index (not git HEAD) so pin bumps keep
 * the new upstream surface while dropping host-owned modules.
 */
'use strict'

const { readFileSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const INDEX = join(ROOT, 'packages/pi-coding-agent/src/index.ts')

if (!existsSync(INDEX)) {
  process.stderr.write('trim-pi-coding-agent-index: missing index.ts\n')
  process.exit(1)
}

let src = readFileSync(INDEX, 'utf8')

const dropBlocks = [
  /\/\/ CLI[\s\S]*?from "\.\/cli\/args\.(?:js|ts)";\n/,
  /\/\/ Core session management[\s\S]*?from "\.\/core\/agent-session\.(?:js|ts)";\n/,
  /\/\/ Compaction[\s\S]*?from "\.\/core\/compaction\/index\.(?:js|ts)";\n/,
  /\/\/ SDK for programmatic usage[\s\S]*?from "\.\/core\/sdk\.(?:js|ts)";\n/,
  /\/\/ Main entry point[\s\S]*?from "\.\/main\.(?:js|ts)";\n/,
  /\/\/ Run modes for programmatic SDK usage[\s\S]*?from "\.\/modes\/index\.(?:js|ts)";\n/,
  /\/\/ RPC JSONL utilities[\s\S]*?from "\.\/modes\/rpc\/jsonl\.(?:js|ts)";\n/,
  /\/\/ UI components for extensions[\s\S]*?from "\.\/modes\/interactive\/components\/index\.(?:js|ts)";\n/,
]

for (const re of dropBlocks) {
  src = src.replace(re, '')
}

// Keep config path helpers even if the CLI block that used to re-export them is gone.
if (!/export \{[^}]*getAgentDir/.test(src)) {
  src = `// Config paths\nexport { getAgentDir, VERSION, APP_NAME } from "./config.js";\n` + src
}

src = src.replace(/from "\.\/modes\/interactive\/theme\/theme\.(?:js|ts)"/g, 'from "./theme/theme.js"')
src = src.replace(/from "\.\/cli\/args\.(?:js|ts)"/g, 'from "@gsd/agent-modes"')
src = src.replace(/from "\.\/modes\/index\.(?:js|ts)"/g, 'from "@gsd/agent-modes"')

writeFileSync(INDEX, src)
process.stderr.write('trim-pi-coding-agent-index: wrote trimmed index.ts\n')
