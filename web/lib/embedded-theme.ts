/** Per-document host presentation only. Never reads or writes GSD preferences. */
export interface EmbeddedTheme {
  mode: "light" | "dark"
  variables: Readonly<Record<string, string>>
}

const COLOR_VARIABLES = new Set([
  "--background", "--foreground", "--card", "--card-foreground",
  "--popover", "--popover-foreground", "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
  "--border", "--input", "--ring", "--sidebar", "--sidebar-foreground",
  "--sidebar-primary", "--sidebar-primary-foreground", "--sidebar-accent",
  "--sidebar-accent-foreground", "--sidebar-border", "--sidebar-ring",
  "--success", "--warning", "--info", "--terminal", "--terminal-foreground",
  "--code-line-number",
])

export function parseEmbeddedTheme(value: unknown): EmbeddedTheme | undefined {
  if (!value || typeof value !== "object") return undefined
  const theme = value as { mode?: unknown; variables?: unknown }
  if (theme.mode !== "light" && theme.mode !== "dark") return undefined
  if (!theme.variables || typeof theme.variables !== "object" || Array.isArray(theme.variables)) return undefined
  const variables: Record<string, string> = {}
  for (const [name, entry] of Object.entries(theme.variables)) {
    if (!COLOR_VARIABLES.has(name) && name !== "--radius") continue
    // Only resolved CSS values cross the origin boundary, never stylesheets,
    // arbitrary property names, URLs, or references to host-only variables.
    if (typeof entry !== "string" || !entry.trim() || entry.length > 256 || /[;{}@]|url\s*\(|var\s*\(/i.test(entry)) continue
    variables[name] = entry.trim()
  }
  return { mode: theme.mode, variables }
}

let currentTheme: EmbeddedTheme | undefined
const listeners = new Set<() => void>()

export const getEmbeddedTheme = (): EmbeddedTheme | undefined => currentTheme
export const getServerEmbeddedTheme = (): undefined => undefined
export const subscribeEmbeddedTheme = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setEmbeddedTheme(theme: EmbeddedTheme | undefined): void {
  currentTheme = theme
  for (const listener of [...listeners]) listener()
}

interface InlineStyle {
  getPropertyValue(name: string): string
  getPropertyPriority(name: string): string
  setProperty(name: string, value: string, priority?: string): void
  removeProperty(name: string): void
}

/** Return a disposer that restores only the properties this overlay owns. */
export function applyEmbeddedTheme(style: InlineStyle, theme: EmbeddedTheme): () => void {
  const previous = new Map<string, { value: string; priority: string }>()
  for (const [name, value] of Object.entries(theme.variables)) {
    previous.set(name, { value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) })
    style.setProperty(name, value)
  }
  return () => {
    for (const [name, entry] of previous) {
      if (entry.value) style.setProperty(name, entry.value, entry.priority)
      else style.removeProperty(name)
    }
  }
}
