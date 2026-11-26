import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./bundled-resource-path.js";

export type FileExists = (path: string) => boolean;

/**
 * jiti alias map for @gsd/* workspace packages (CJS require cannot load ESM file:// URLs).
 *
 * In the monorepo the canonical entry points are raw TypeScript under `packages/<name>/src/`,
 * which jiti loads directly. The published tarball ships only the compiled `packages/<name>/dist/`
 * (see each package's `files` field) — `src/` is absent. Resolve each alias to the `src/*.ts`
 * entry when present, otherwise fall back to the compiled `dist/*.js`, so the merge CLI loads in
 * both layouts instead of crashing with MODULE_NOT_FOUND on the missing source path.
 */
export function getJitiWorkspaceAliases(
  importUrl: string,
  fileExists: FileExists = existsSync,
): Record<string, string> {
  const root = resolvePackageRoot(importUrl);
  // Prefer the source `.ts` entry (monorepo); fall back to the compiled `.js` (published tarball).
  const pkg = (dir: string, ...segments: string[]) => {
    const srcEntry = join(root, "packages", dir, "src", ...segments);
    if (fileExists(srcEntry)) return srcEntry;
    const distSegments = segments.map((s) => s.replace(/\.ts$/, ".js"));
    return join(root, "packages", dir, "dist", ...distSegments);
  };

  const piAi = pkg("pi-ai", "index.ts");
  const piAiOauth = pkg("pi-ai", "oauth.ts");
  const piAiCompat = pkg("pi-ai", "compat.ts");
  const piAgentCore = pkg("pi-agent-core", "index.ts");
  const piTui = pkg("pi-tui", "index.ts");
  const piCodingAgent = pkg("pi-coding-agent", "index.ts");
  const native = pkg("native", "index.ts");
  const nativeDirectorySync = pkg("native", "directory-sync", "index.ts");
  const nativeFileIdentity = pkg("native", "file-identity", "index.ts");

  const aliases: Record<string, string> = {
    "@gsd/pi-ai": piAi,
    "@gsd/pi-ai/oauth": piAiOauth,
    "@gsd/pi-ai/compat": piAiCompat,
    "@gsd/pi-agent-core": piAgentCore,
    "@gsd/pi-tui": piTui,
    "@gsd/pi-coding-agent": piCodingAgent,
    "@gsd/native/directory-sync": nativeDirectorySync,
    "@gsd/native/file-identity": nativeFileIdentity,
    "@gsd/native": native,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/oauth": piAiOauth,
    "@earendil-works/pi-ai/compat": piAiCompat,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-tui": piTui,
    "@earendil-works/pi-coding-agent": piCodingAgent,
  };

  return aliases;
}
