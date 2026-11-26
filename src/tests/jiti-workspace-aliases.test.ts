// Project/App: gsd-pi
// File Purpose: Verify @gsd/* jiti aliases fall back to dist when src is not shipped.

import test from "node:test"
import assert from "node:assert/strict"

import { getJitiWorkspaceAliases } from "../jiti-workspace-aliases.js"

// importUrl is a module file inside <root>/dist or <root>/src; resolvePackageRoot
// climbs one level to the package root, so aliases live under <root>/packages/*.
const importUrl = new URL("file:///pkg/dist/worktree-cli.js")

test("aliases resolve to source .ts entries in the monorepo layout", () => {
  const aliases = getJitiWorkspaceAliases(importUrl.href, () => true)

  assert.equal(aliases["@gsd/pi-ai"], "/pkg/packages/pi-ai/src/index.ts")
  assert.equal(aliases["@gsd/pi-ai/oauth"], "/pkg/packages/pi-ai/src/oauth.ts")
  assert.equal(aliases["@gsd/pi-ai/compat"], "/pkg/packages/pi-ai/src/compat.ts")
  assert.equal(aliases["@gsd/pi-coding-agent"], "/pkg/packages/pi-coding-agent/src/index.ts")
  assert.equal(aliases["@gsd/native/directory-sync"], "/pkg/packages/native/src/directory-sync/index.ts")
  assert.equal(aliases["@gsd/native/file-identity"], "/pkg/packages/native/src/file-identity/index.ts")
})

test("aliases fall back to compiled dist .js when src is absent (published tarball)", () => {
  // Published tarball ships only packages/<name>/dist — src/ does not exist on disk.
  const aliases = getJitiWorkspaceAliases(importUrl.href, () => false)

  assert.equal(aliases["@gsd/pi-ai"], "/pkg/packages/pi-ai/dist/index.js")
  assert.equal(aliases["@gsd/pi-ai/oauth"], "/pkg/packages/pi-ai/dist/oauth.js")
  assert.equal(aliases["@gsd/pi-ai/compat"], "/pkg/packages/pi-ai/dist/compat.js")
  assert.equal(aliases["@gsd/pi-coding-agent"], "/pkg/packages/pi-coding-agent/dist/index.js")
  assert.equal(aliases["@gsd/native/directory-sync"], "/pkg/packages/native/dist/directory-sync/index.js")
  assert.equal(aliases["@gsd/native/file-identity"], "/pkg/packages/native/dist/file-identity/index.js")
  assert.equal(aliases["@earendil-works/pi-ai"], "/pkg/packages/pi-ai/dist/index.js")
})
