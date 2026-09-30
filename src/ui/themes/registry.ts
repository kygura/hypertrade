import { useCallback, useSyncExternalStore } from 'react'

// Theme registry. A theme is a CSS file under src/ui/themes/ that scopes
// token overrides to :root[data-theme='<id>'] (contract: README.md). This
// module owns which theme is active: it writes data-theme on <html>, loads
// the theme's web fonts on first use, and persists the choice per browser.
// index.html applies the stored (or default) data-theme before first paint;
// keep its inline script's key and default in sync with this file.

export interface ThemeDef {
  id: ThemeId
  label: string
  /** Compact label for the mobile top strip. */
  short: string
  /** Drives the browser's color-scheme (form controls, scrollbars). */
  scheme: 'dark' | 'light'
  /** Stylesheet URLs (e.g. Google Fonts) injected the first time the theme is applied. */
  fonts?: string[]
}

export type ThemeId = 'hyperion' | 'hyperdash' | 'tradexyz'

export const THEMES: readonly ThemeDef[] = [
  {
    id: 'hyperdash',
    label: 'HYPERDASH',
    short: 'HD',
    scheme: 'dark',
    // BDO Grotesk (Hyperdash's face) isn't on Google Fonts; Host Grotesk
    // stands in, and the theme's stack still prefers BDO if installed.
    fonts: ['https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@300..700&display=swap'],
  },
  {
    id: 'tradexyz',
    label: 'TRADE[XYZ]',
    short: 'XYZ',
    scheme: 'dark',
    fonts: [
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=Hanken+Grotesk:wght@300;400;500&display=swap',
    ],
  },
  // The token defaults in index.css (DESIGN.md); no theme file.
  { id: 'hyperion', label: 'HYPERION', short: 'HYP', scheme: 'dark' },
]

export const DEFAULT_THEME: ThemeId = 'hyperdash'
const STORAGE_KEY = 'hypertrade.theme'

function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v)
}

function readStored(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isThemeId(v) ? v : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

const loadedFonts = new Set<string>()

function loadFonts(def: ThemeDef) {
  for (const href of def.fonts ?? []) {
    if (loadedFonts.has(href)) continue
    loadedFonts.add(href)
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
}

let current: ThemeId = DEFAULT_THEME
const listeners = new Set<() => void>()

export function themeDef(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}

/** Apply a theme. `persist` is false for the startup pass so a visitor who
 *  never chose keeps following DEFAULT_THEME if it changes. */
export function applyTheme(id: ThemeId, persist = true) {
  const def = themeDef(id)
  current = def.id
  const root = document.documentElement
  // Hyperion is the unscoped token defaults, so its attribute matches no
  // theme file; setting it anyway keeps "which theme" inspectable.
  root.setAttribute('data-theme', def.id)
  root.style.colorScheme = def.scheme
  loadFonts(def)
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, def.id)
    } catch {
      // private mode / blocked storage: the theme still applies for this visit
    }
  }
  listeners.forEach((l) => l())
}

/** Call once before first render: syncs the store with the stored choice
 *  (or the default) and loads its fonts. */
export function initTheme() {
  applyTheme(readStored(), false)
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, () => current, () => DEFAULT_THEME)
  const set = useCallback((id: ThemeId) => applyTheme(id), [])
  return [theme, set]
}
