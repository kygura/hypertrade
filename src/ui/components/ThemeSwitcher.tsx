import { THEMES, useTheme } from '../themes/registry'
import { Button } from './Button'
import { Segmented } from './Segmented'

// ThemeSwitcher — segmented toggle in the top bar. Full theme names from xl
// up, short codes below (the 1024 top bar holds nine nav cells + this +
// LOGOUT only with the short codes). The choice persists per browser
// (themes/registry.ts).

const OPTIONS = THEMES.map((t) => ({
  value: t.id,
  title: t.label,
  label: (
    <>
      <span className="xl:hidden">{t.short}</span>
      <span className="hidden xl:inline">{t.label}</span>
    </>
  ),
}))

export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme()
  return <Segmented label="theme" options={OPTIONS} value={theme} onChange={setTheme} className="theme-switcher" />
}

// ThemeCycle — the phone top strip's theme control: one button showing the
// current short code; a tap moves to the next theme. The three-segment toggle
// (138px at touch sizes) does not fit beside the wordmark, ASK and LOGOUT
// under 412px.
export function ThemeCycle() {
  const [theme, setTheme] = useTheme()
  const i = Math.max(0, THEMES.findIndex((t) => t.id === theme))
  const cur = THEMES[i]!
  const next = THEMES[(i + 1) % THEMES.length]!
  return (
    <Button
      tier="ghost"
      className="theme-cycle"
      onClick={() => setTheme(next.id)}
      aria-label={`theme ${cur.label}, switch to ${next.label}`}
      title={`theme: ${cur.label} (tap for ${next.label})`}
    >
      {cur.short}
    </Button>
  )
}
