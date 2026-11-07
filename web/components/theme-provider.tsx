'use client'

import * as React from 'react'
import {
  ThemeProvider as NextThemesProvider,
  useTheme as useNextTheme,
  type ThemeProviderProps,
} from 'next-themes'
import { embeddedStartup } from '@/lib/embedded-gate'
import {
  applyEmbeddedTheme,
  getEmbeddedTheme,
  getServerEmbeddedTheme,
  subscribeEmbeddedTheme,
} from '@/lib/embedded-theme'

export function useEmbeddedTheme() {
  return React.useSyncExternalStore(subscribeEmbeddedTheme, getEmbeddedTheme, getServerEmbeddedTheme)
}

/** next-themes' resolvedTheme reflects its saved selection, not forcedTheme. */
export function useTheme() {
  const theme = useNextTheme()
  return {
    ...theme,
    theme: theme.forcedTheme ?? theme.theme,
    resolvedTheme: theme.forcedTheme ?? theme.resolvedTheme,
    setTheme: theme.forcedTheme ? () => {} : theme.setTheme,
  }
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const hostTheme = useEmbeddedTheme()
  React.useEffect(() => { void embeddedStartup() }, [])
  React.useEffect(() => {
    if (hostTheme) return applyEmbeddedTheme(document.documentElement.style, hostTheme)
  }, [hostTheme])
  // forcedTheme is a presentation override. Calling setTheme here would
  // overwrite the standalone browser's persisted preference.
  return <NextThemesProvider {...props} forcedTheme={hostTheme?.mode ?? props.forcedTheme}>{children}</NextThemesProvider>
}
