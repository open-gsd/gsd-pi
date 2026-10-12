import test from "node:test"
import assert from "node:assert/strict"
import { applyEmbeddedTheme, getEmbeddedTheme, parseEmbeddedTheme, setEmbeddedTheme, subscribeEmbeddedTheme } from "../embedded-theme.ts"
import { getXtermOptions, getXtermTheme } from "../xterm-theme.ts"

test("theme input accepts only resolved, allowlisted presentation properties", () => {
  assert.equal(parseEmbeddedTheme({ mode: "system", variables: {} }), undefined)
  assert.equal(parseEmbeddedTheme({ mode: "dark", variables: [] }), undefined)
  assert.deepEqual(parseEmbeddedTheme({ mode: "light", variables: {
    "--background": " #fff ",
    "--primary": "rgb(10, 20, 30)",
    "--radius": "8px",
    "--foreign": "red",
    "--foreground": "var(--host-private)",
    "--card": "url(https://example.test/asset)",
    "--border": "red; color: blue",
    "--ring": false,
  } }), { mode: "light", variables: { "--background": "#fff", "--primary": "rgb(10, 20, 30)", "--radius": "8px" } })
})

test("palette overlay is ephemeral and restores preexisting inline values and priority", () => {
  const values = new Map<string, { value: string; priority: string }>([
    ["--background", { value: "#123456", priority: "important" }],
    ["--unrelated", { value: "24px", priority: "" }],
  ])
  const style = {
    getPropertyValue: (name: string) => values.get(name)?.value ?? "",
    getPropertyPriority: (name: string) => values.get(name)?.priority ?? "",
    setProperty: (name: string, value: string, priority = "") => { values.set(name, { value, priority }) },
    removeProperty: (name: string) => { values.delete(name) },
  }
  const original = new Map(values)
  const restore = applyEmbeddedTheme(style, { mode: "light", variables: { "--background": "#fff", "--foreground": "#111" } })
  assert.equal(style.getPropertyValue("--background"), "#fff")
  assert.equal(style.getPropertyValue("--foreground"), "#111")
  assert.equal(style.getPropertyValue("--unrelated"), "24px")
  restore()
  assert.deepEqual(values, original)
  // A subsequent palette omitting a property must use the standalone fallback,
  // not retain values from the previous host palette.
  const restoreNext = applyEmbeddedTheme(style, { mode: "dark", variables: { "--background": "#222" } })
  assert.equal(style.getPropertyValue("--foreground"), "")
  restoreNext()
  assert.deepEqual(values, original)
})

test("document theme state never accesses storage and subscriptions detach", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("embedded presentation touched persistent storage") } })
  let notifications = 0
  const detach = subscribeEmbeddedTheme(() => { notifications += 1 })
  try {
    const theme = { mode: "light" as const, variables: {} }
    setEmbeddedTheme(theme)
    assert.equal(getEmbeddedTheme(), theme)
    assert.equal(notifications, 1)
    detach()
    setEmbeddedTheme(undefined)
    assert.equal(getEmbeddedTheme(), undefined)
    assert.equal(notifications, 1)
  } finally {
    detach()
    setEmbeddedTheme(undefined)
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test("terminal canvas inherits host surfaces while retaining standalone palettes and ANSI colors", () => {
  for (const palette of ["classic", "vivid"] as const) {
    const standalone = getXtermTheme(false, palette)
    const original = { ...standalone }
    const host = { mode: "light" as const, variables: { "--terminal": "#fff4e0", "--terminal-foreground": "#281800", "--accent": "#eee1cc" } }
    const embedded = getXtermTheme(true, palette, host)
    assert.equal(embedded.background, "#fff4e0")
    assert.equal(embedded.foreground, "#281800")
    assert.equal(embedded.cursorAccent, "#fff4e0")
    assert.equal(embedded.cursor, "#281800")
    assert.equal(embedded.selectionBackground, "#eee1cc")
    assert.equal(embedded.blue, standalone.blue, "host resolved mode controls readable ANSI colors")
    assert.deepEqual(getXtermOptions(true, 15, palette, host).theme, embedded)
    assert.deepEqual(getXtermTheme(false, palette), original, "standalone palette must not be mutated")
    assert.deepEqual(getXtermTheme(false, palette, { mode: "light", variables: {} }), original)
  }
})
