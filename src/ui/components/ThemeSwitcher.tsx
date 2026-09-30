import { THEMES, useTheme, type ThemeId } from '../themes/registry'

// ThemeSwitcher — native select in the top bar. Native keeps it keyboard-
// and screen-reader-correct on every platform for free; the choice persists
// per browser (themes/registry.ts).
export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme()
  return (
    <label className="flex items-center">
      <span className="sr-only">theme</span>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeId)}
        className="theme-switcher !min-h-0 h-[var(--control-sm)] !py-0 !px-1.5 !text-[10px] font-control tracking-[var(--control-tracking)] text-text-secondary"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  )
}
