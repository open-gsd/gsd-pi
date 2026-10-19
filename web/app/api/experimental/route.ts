import { readGlobalPreferencesFile, writeGlobalPreferencesFile } from "../../../lib/gsd-preferences-file"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" } as const

// ─── GET — read current experimental flags ───────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const { data } = readGlobalPreferencesFile()
    const exp = typeof data.experimental === "object" && data.experimental !== null
      ? (data.experimental as Record<string, unknown>)
      : {}
    return Response.json({ rtk: exp.rtk === true }, { headers: NO_STORE })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500, headers: NO_STORE })
  }
}

// ─── PATCH — toggle an experimental flag ────────────────────────────────────
//
// Body: { flag: "rtk", enabled: boolean }

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>
    const { flag, enabled } = body

    const KNOWN_FLAGS = new Set(["rtk"])
    if (typeof flag !== "string" || !KNOWN_FLAGS.has(flag)) {
      return Response.json(
        { error: `Unknown experimental flag "${flag}". Known flags: ${[...KNOWN_FLAGS].join(", ")}` },
        { status: 400, headers: NO_STORE },
      )
    }
    if (typeof enabled !== "boolean") {
      return Response.json(
        { error: "enabled must be a boolean" },
        { status: 400, headers: NO_STORE },
      )
    }

    const { data, body: mdBody } = readGlobalPreferencesFile()

    // Merge into experimental block
    const existing = typeof data.experimental === "object" && data.experimental !== null
      ? { ...(data.experimental as Record<string, unknown>) }
      : {}
    existing[flag] = enabled
    data.experimental = existing

    writeGlobalPreferencesFile(data, mdBody)

    return Response.json({ [flag]: enabled }, { headers: NO_STORE })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: `Failed to update experimental flag: ${message}` },
      { status: 500, headers: NO_STORE },
    )
  }
}
