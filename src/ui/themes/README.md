# Theme

HYPERTRADE has one look: Hyperdash. The token defaults in `../index.css`
are Hyperion (docs/design/README.md) and stay as the base; `hyperdash.css`
redefines tokens from the contract below under `:root[data-theme='hyperdash']`
and styles the structural hooks. `index.html` ships
`data-theme="hyperdash"` on `<html>` and loads its web font (Host Grotesk,
Google Fonts). There is no theme picker and no runtime theme state; charts
read token values once on mount.

Change the look by editing tokens in `hyperdash.css`, not by forking
components.

## Token contract

Everything `hyperdash.css` may override. Defaults live in `../index.css` and
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
| `--color-amber`, `--color-amber-bg`, `--color-info`, `--color-info-bg` | warning, informational; info also marks model inference (HYP claims, LLM-proposed edges) |
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
`--row-h`, `--control-sm/md/lg`, `--tap-min`. If `hyperdash.css` changes these, it
must also restate the `@media (pointer: coarse)` touch values, since its
selector outranks the default touch block.

**Segmented control** (`:root`): `--seg-track`, `--seg-border`,
`--seg-divider`, `--seg-pad`, `--seg-gap`, `--seg-radius`, `--seg-active`,
`--seg-active-text`, `--seg-active-shadow`. Hyperion's defaults are a
hairline box of divided cells; Hyperdash gets a padded well with a lifted pill
by setting track/pad/radius and clearing border and divider.

## Structural hooks

For looks that tokens alone can't express, `hyperdash.css` styles these
classes under its selector (`:root[data-theme='hyperdash'] .btn--neutral { … }`):

`.panel` `.panel-header` `.panel-title` `.panel-body` · `.btn` `.btn--ghost`
`.btn--neutral` `.btn--danger` · `.badge` `.badge--{green,red,amber,info,gray}` · `.status-dot` `.status-dot--{ok,degraded,down,unknown}`
· `.state-title`
· `.dt` (DataTable `<table>`) · `.metric` `.metric-label` `.metric-value` ·
`.app-topbar` `.app-wordmark` `.app-wordmark-dot` `.app-nav` `.app-nav-link`
(`[aria-current=page]` when active) `.app-tabbar` `.app-tab`
· `.tab-active` · `.label` · `.src-tag` · `.seg` `.seg--{sm,md}`
`.seg-item` (`[aria-checked=true]`, `[data-tone=green|red]`).

Keep the Hyperion rules that are about meaning, not looks: color is never the
only signal, projections never use green/red, text contrast ≥ 4.5:1 for body
text on its surface.
