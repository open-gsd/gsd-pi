import { isAbsolute } from "node:path"
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime"

export interface NativeProject {
  projectId: string
  canonicalRoot: string
  name: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Only paths the caller's native project catalog actually exposes are usable.
 * An explicit plugin allowlist cannot restore scope-redacted paths.
 * Registry roots are already canonicalized by OpenClaw.
 */
export function nativeProjectsFromPayload(payload: unknown): NativeProject[] {
  if (!object(payload) || !Array.isArray(payload.projects)) throw new Error("Invalid OpenClaw project catalog")
  const projects = new Map<string, NativeProject>()
  const add = (id: unknown, name: unknown, path: unknown) => {
    if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
        typeof path !== "string" || !isAbsolute(path) || projects.has(path)) return
    projects.set(path, { projectId: id, canonicalRoot: path, name })
  }
  // OpenClaw includes synthetic workspace records alongside registrations.
  // Preserve the registered identity/name when both refer to one checkout,
  // regardless of the catalog's display-name ordering.
  const workspace = (project: unknown) => object(project) &&
    (project.source === "workspace" || (typeof project.id === "string" && project.id.startsWith("workspace:")))
  const ordered = [...payload.projects].sort((a, b) => Number(workspace(a)) - Number(workspace(b)))
  for (const project of ordered) {
    if (object(project)) add(project.id, project.displayName, project.repoRoot)
  }
  return [...projects.values()]
}

export const nativeProjectRegistry = {
  async list(): Promise<NativeProject[]> {
    // Retain the authenticated client/profile/scopes. Never use owner CLI auth.
    const response = await dispatchGatewayMethod("projects.list", {}, { timeoutMs: 10_000 })
    if (!response.ok) throw response.error ?? new Error("OpenClaw project catalog unavailable")
    return nativeProjectsFromPayload(response.payload)
  },
}
