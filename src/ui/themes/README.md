# Themes

HYPERTRADE ships four looks. The token defaults in `../index.css` are
Hyperion (DESIGN.md); every other look is a **theme**: one CSS file scoped to
`:root[data-theme='<id>']` that only redefines tokens from the contract
below. No component forks, no per-theme JSX.

| id | file | design system |
|---|---|---|
| `webring` (default) | `webring.css` | `design-systems/webring/` |
| `hyperdash` | `hyperdash.css` | `design-systems/hyperdash/` |
| `tradexyz` | `tradexyz.css` | `design-systems/tradexyz/` |
| `hyperion` | `../index.css` (the unscoped defaults) | `DESIGN.md` |

`registry.ts` lists themes (`DEFAULT_THEME` picks the default), applies
`data-theme` on `<html>`, lazy-loads each theme's web fonts, and persists an
explicit choice in `localStorage` (`hypertrade.theme`); a visitor who never
chose follows the default. `index.html` sets the default `data-theme` and
applies a stored choice with an inline script before first paint, so keep
its key and default in sync with `registry.ts`. `ThemeSwitcher` (a
`Segmented` toggle in the top bar) switches it.

## Adding a theme

1. Create `<id>.css` with a `:root[data-theme='<id>'] { … }` block.
2. `@import` it in `../index.css` next to the others.
3. Add a `ThemeDef` to `THEMES` in `registry.ts` (label, short label,
   scheme, font URLs).

## Token contract

Everything a theme may override. Defaults live in `../index.css` and
reproduce Hyperion exactly.

**Color (`@theme`, so each is also a Tailwind utility, e.g. `bg-panel`):**

| token | role |
|---|---|
| `--color-body` | page background |
| `--color-panel`, `--color-panel-alt`, `--color-elevated` | surface ladder |
| `--color-panel-header`, `--color-topbar`, `--color-input` | header strip, app bars, form fields |
| `--color-hover`, `--color-active`, `--color-selected` | interaction overlays |
| `--color-border`, `--color-border-subtle` | hairlines |
| `--color-text-primary`, `--color-text-muted`, `--color-text-secondary`, `--color-text-disabled` | text ladder (muted = readable prose, secondary = labels) |
| `--color-accent`, `--color-on-accent` | brand accent: active tab rule, wordmark dot |
| `--color-primary`, `--color-primary-hover`, `--color-on-primary` | neutral-tier (primary submit) button |
| `--color-green`, `--color-green-text`, `--color-green-bg` | up / positive |
| `--color-red`, `--color-red-text`, `--color-red-bg`, `--color-red-accent` | down / negative / danger |
| `--color-amber`, `--color-amber-bg`, `--color-info`, `--color-info-bg` | warning, informational |
| `--color-flash-up`, `--color-flash-down` | tick flash |
| `--color-scrim`, `--color-focus`, `--shadow-overlay` | modal scrim, focus ring, overlay shadow |
| `--color-scrollbar`, `--color-scrollbar-hover` | scrollbar thumb |
| `--color-src-hl` | Hyperliquid provenance tag |
| `--color-mom-neg2 … --color-mom-pos2` | sector momentum ramp (5 buckets) |
| `--color-proj-line`, `--color-proj-band`, `--color-bench-btc`, `--color-bench-usdc`, `--color-equity`, `--color-drawdown-fill`, `--color-drawdown-line` | chart series |

**Type:** `--font-sans` (UI text), `--font-mono` (numbers, tables, inputs),
`--font-display` (wordmark), `--font-control` (buttons, tabs, badges);
`--base-font-size`; the closed scale `--text-2xs … --text-xl`.
Label/control casing: `--label-case`, `--label-tracking`, `--label-weight`,
`--control-case`, `--control-tracking`, `--control-weight`.

**Shape & depth:** `--radius-panel`, `--radius-control`, `--radius-badge`
(utilities `rounded-panel/-control/-badge`), `--shadow-panel`.

**Density** (`:root`): `--gutter`, `--panel-pad`, `--cell-x`, `--cell-y`,
`--row-h`, `--control-sm/md/lg`, `--tap-min`. A theme that changes these
must also restate the `@media (pointer: coarse)` touch values, since its
selector outranks the default touch block.

**Segmented control** (`:root`): `--seg-track`, `--seg-border`,
`--seg-divider`, `--seg-pad`, `--seg-gap`, `--seg-radius`, `--seg-active`,
`--seg-active-text`, `--seg-active-shadow`. Hyperion's defaults are a
hairline box of divided cells; a theme gets a padded well with a lifted pill
by setting track/pad/radius and clearing border and divider.

## Structural hooks

For looks that tokens alone can't express, a theme may style these classes
under its own selector (`:root[data-theme='<id>'] .btn--neutral { … }`):

`.panel` `.panel-header` `.panel-title` `.panel-body` · `.btn` `.btn--ghost`
`.btn--neutral` `.btn--danger` · `.badge` `.badge--{green,red,amber,info,gray}` · `.status-dot` `.status-dot--{ok,degraded,down,unknown}`
· `.state-title`
· `.dt` (DataTable `<table>`) · `.metric` `.metric-label` `.metric-value` ·
`.app-topbar` `.app-wordmark` `.app-wordmark-dot` `.app-nav` `.app-nav-link`
(`[aria-current=page]` when active) `.app-tabbar` `.app-tab` · `.subtabs`
`.subtab` · `.tab-active` · `.label` · `.src-tag` · `.seg` `.seg--{sm,md}`
`.seg-item` (`[aria-checked=true]`, `[data-tone=green|red]`) · `.theme-switcher`.

Keep the Hyperion rules that are about meaning, not looks: color is never the
only signal, projections never use green/red, text contrast ≥ 4.5:1 for body
text on its surface.
