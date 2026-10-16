import { THEMES, useTheme } from '../themes/registry'
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
