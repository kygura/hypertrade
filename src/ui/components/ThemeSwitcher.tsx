import { THEMES, useTheme } from '../themes/registry'
import { Segmented } from './Segmented'

// ThemeSwitcher — segmented toggle in the top bar. Full theme names from md
// up, short codes in the mobile strip. The choice persists per browser
// (themes/registry.ts).

const OPTIONS = THEMES.map((t) => ({ value: t.id, label: t.label, short: t.short }))

export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme()
  return <Segmented label="theme" options={OPTIONS} value={theme} onChange={setTheme} className="theme-switcher" />
}
