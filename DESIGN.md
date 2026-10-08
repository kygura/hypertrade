# DESIGN — HYPERTRADE

Authoritative visual and interaction design brief for the HYPERTRADE app
(`app/`). Implementation follows this document exactly; a worker implementing
UI from it needs no taste of its own. Where this document and SPEC.md disagree
on visuals, this document wins; on data/API shape, SPEC.md wins.

HYPERTRADE iterates on the Hyperion Terminal design language
(`../hyperion/dashboard/DESIGN.md`): dark-only, Geist Mono everywhere, zero
border-radius, hairline borders, dense tabular data, one motion rhythm
(220ms), no spinners, a single named state vocabulary. It is NOT a new
language. What is new:

1. **Genuinely responsive.** Hyperion was a fixed desktop grid with
   `overflow: hidden` on body. HYPERTRADE must work on a phone in portrait
   and on a laptop. Section 4 is the responsive contract; every view section
   specifies both layouts.
2. **No money paths.** There is no execution, no wallet, no signing. The
   Money and Arm button tiers and the typed-word confirmation level are
   retired. The heaviest action in this product is deleting a branch.
3. **Fixed layouts.** No react-grid-layout, no draggable panels. Fixed
   responsive CSS grid per view.
4. **New data shapes** need new visual vocabulary: a sector momentum ramp, a
   mindshare heat-grid, projection-band fills, benchmark line colors, and a
   routine-staleness treatment. All tokenized in §2.

One idea is stolen from the sibling Night Desk theme (marketwatch): the
hyperliquid-jade source-attribution color, used for tagging data provenance
(HL / CoinGecko / routine). Night Desk's film-grain overlay is deliberately
NOT taken — a fixed full-viewport paint layer costs scroll performance on
mobile, and Hyperion's flat austerity is the base language.

---

## 1. Design principles

1. **Density is respect — but density adapts.** Desktop gets 24px table rows
   and 8px panel padding. Mobile gets the same information with 40px touch
   rows and column triage (§4.4), never a "mobile-lite" feature cut.
2. **The routine's words are product content.** MarketState briefings, sector
   rationales, and rotation notes render verbatim in readable `text-muted`,
   never paraphrased, never truncated without a way to expand.
3. **Staleness is always visible.** Every surface backed by committed routine
   data (`data/marketstate`, `data/sectors`) shows its `generated_at` age.
   Every surface backed by collectors shows the last collect time. A stale
   number that looks live is the failure mode this product exists to avoid.
4. **Offline is a state, not a failure.** Every API-backed surface has an
   explicit offline/error rendering. No infinite skeletons, no spinners.
5. **One state vocabulary** (§6), one confirmation vocabulary (§7), one
   motion rhythm (§8). Referenced by name everywhere.
6. **Simulations are hypotheses, not accounts.** Branch results and
   projections always carry their assumptions on-screen (start date, capital,
   rebalance rule, scenario params) and projections are visually distinct
   (info-blue, banded) from historical fact (white line).

---

## 2. Design tokens

`src/ui/index.css` is a new file. It carries Hyperion's token set verbatim
plus the HYPERTRADE additions. The full copy-pasteable foundation follows.
Differences from Hyperion's index.css are marked; everything else is
byte-identical intent.

Removed relative to Hyperion: react-grid-layout/react-resizable imports, the
custom slider (`.cs-*`), the `AnimatedDigits` keyframes are KEPT (used for
the per-view xl value), and `body { overflow: hidden }` becomes normal page
scroll (§4.1).

```css
@import 'tailwindcss';

@font-face {
  font-family: 'Geist Mono';
  src: url('../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2')
    format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@theme {
  /* ── Hyperion base palette, verbatim ─────────────────────────── */
  --color-body: #100e0a;
  --color-panel: #111111;
  --color-panel-alt: #0d0d0d;
  --color-elevated: #191613;
  --color-hover: rgba(255, 255, 255, 0.04);
  --color-border: rgba(255, 255, 255, 0.08);
  --color-border-subtle: rgba(255, 255, 255, 0.04);
  --color-text-primary: #ffffff;
  --color-text-secondary: #928d86;
  --color-text-muted: #d5d1cd;
  --color-green: #38a67c;
  --color-red: #bc263e;
  --color-red-accent: #ed3602;
  --color-amber: #ffb800;

  /* ── Hyperion additive layer, verbatim (meanings preserved) ──── */
  --color-green-text: #38a67c;
  --color-red-text: #e8677d;
  --color-info: #6ea8d8;
  --color-text-disabled: #5c5751;
  --color-active: rgba(255, 255, 255, 0.08);
  --color-selected: rgba(255, 255, 255, 0.06);
  --color-scrim: rgba(0, 0, 0, 0.55);
  --color-focus: rgba(255, 255, 255, 0.9);
  --color-green-bg: rgba(56, 166, 124, 0.12);
  --color-red-bg: rgba(188, 38, 62, 0.12);
  --color-amber-bg: rgba(255, 184, 0, 0.1);
  --color-info-bg: rgba(110, 168, 216, 0.1);
  --color-flash-up: rgba(56, 166, 124, 0.22);
  --color-flash-down: rgba(188, 38, 62, 0.22);
  --shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.6);

  /* ── HYPERTRADE additions ────────────────────────────────────── */

  /* Source attribution (stolen from Night Desk's hyperliquid jade).
     Used ONLY on 8.5-10px provenance tags: HL / CG / FRED / ROUTINE. */
  --color-src-hl: #58b89a;

  /* Sector momentum ramp — 5 diverging buckets over momentum ∈ [-1, 1].
     Cell BACKGROUNDS for the mindshare grid; text on them is always
     text-primary and every cell carries the signed number (color is never
     the sole signal). Bucket edges: -0.5, -0.15, +0.15, +0.5. */
  --color-mom-neg2: rgba(188, 38, 62, 0.45);
  --color-mom-neg1: rgba(188, 38, 62, 0.22);
  --color-mom-zero: #191613;               /* = elevated */
  --color-mom-pos1: rgba(56, 166, 124, 0.22);
  --color-mom-pos2: rgba(56, 166, 124, 0.45);

  /* Projection / benchmark chart colors (§9.3). Projections are info-blue
     so speculation never wears the green/red of realized PnL. */
  --color-proj-line: #6ea8d8;              /* median monte-carlo path */
  --color-proj-band: rgba(110, 168, 216, 0.12);  /* p10–p90 fill */
  --color-bench-btc: #ffb800;              /* HODL-BTC benchmark line */
  --color-bench-usdc: #928d86;             /* 100%-USDC benchmark line */
  --color-equity: #ffffff;                 /* the branch's own curve */
  --color-drawdown-fill: rgba(188, 38, 62, 0.18);
  --color-drawdown-line: #bc263e;

  /* ── Type scale (Hyperion §2.4, closed set, unchanged) ───────── */
  --text-2xs: 9px;
  --text-xs: 10px;
  --text-sm: 11px;
  --text-md: 12px;
  --text-base: 13px;
  --text-lg: 16px;
  --text-xl: 22px;

  --font-mono: 'Geist Mono', ui-monospace, monospace;
  --font-sans: 'Geist Mono', ui-monospace, monospace;
}

:root {
  /* Density scale — desktop values (Hyperion §2.5). */
  --gutter: 12px;
  --panel-pad: 8px;
  --cell-x: 8px;
  --cell-y: 4px;
  --row-h: 24px;          /* NEW: named so mobile can override it */
  --control-sm: 22px;
  --control-md: 26px;
  --control-lg: 32px;
  --tap-min: 24px;        /* NEW: minimum interactive target */

  color-scheme: dark;
}

/* Coarse pointers (phones, tablets): the density scale relaxes. Desktop
   numbers are the default; this single media query is the entire "touch
   mode" — components read the variables, never re-derive sizes. */
@media (pointer: coarse) {
  :root {
    --cell-y: 10px;       /* rows become ≥40px */
    --row-h: 40px;
    --control-sm: 32px;
    --control-md: 40px;
    --control-lg: 44px;
    --tap-min: 44px;
  }
}

:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

html, body, #root { min-height: 100%; margin: 0; padding: 0; }

body {
  background: var(--color-body);
  color: var(--color-text-primary);
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  /* CHANGED from Hyperion: pages scroll. overflow-x stays clipped so a
     wide table can never cause page-level horizontal scroll (§4.4). */
  overflow-x: hidden;
}

* { box-sizing: border-box; border-radius: 0 !important; }

.mono, .tabular {
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}

.label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.panel {
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel-alt);
  flex-shrink: 0;
}

.panel-title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.panel-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; }

/* Wide-content escape hatch: any table wider than its panel scrolls inside
   this wrapper, never the page (§4.4). */
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

/* Scrollbar — Hyperion verbatim */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.08); }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.16); }

button { font-family: inherit; cursor: pointer; }

input, select, textarea {
  font-family: 'Geist Mono', ui-monospace, monospace;
  background: var(--color-panel-alt);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  padding: 6px 8px;
  font-size: 12px;
  min-height: var(--control-md);
  outline: none;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--color-text-secondary);
}

.tab-active {
  border-bottom: 2px solid var(--color-red-accent);
  color: var(--color-text-primary);
}

/* Source-attribution tag (Night Desk import, restyled square) */
.src-tag {
  font-size: 9px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  border: 1px solid var(--color-border-subtle);
  padding: 1px 5px;
  white-space: nowrap;
}
.src-tag--hl { color: var(--color-src-hl); border-color: rgba(88, 184, 154, 0.25); }

/* AnimatedDigits, tick flash, pulse — Hyperion verbatim */
.digit-cell { position: relative; display: inline-block; overflow: hidden; vertical-align: baseline; line-height: 1em; }
.digit-slot { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; will-change: transform, opacity; }
@keyframes digit-enter { from { transform: translateY(-85%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes digit-exit { from { transform: translateY(0); opacity: 1; } to { transform: translateY(85%); opacity: 0; } }
.digit-in { animation: digit-enter 220ms ease-out both; }
.digit-out { animation: digit-exit 220ms ease-out both; }

@keyframes flash-up { from { background-color: var(--color-flash-up); } to { background-color: transparent; } }
@keyframes flash-down { from { background-color: var(--color-flash-down); } to { background-color: transparent; } }
.flash-up { animation: flash-up 220ms linear; }
.flash-down { animation: flash-down 220ms linear; }

@keyframes pulse-opacity { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.pulse-label { animation: pulse-opacity 1s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .digit-in, .digit-out, .flash-up, .flash-down, .pulse-label {
    animation: none !important;
  }
}
```

### 2.1 Contrast rules (inherited, binding)

- `#928d86` (`text-secondary`) is ≈4.3:1 on panel — labels, table headers,
  metadata, timestamps only. Never for values the user reasons from, error
  text, or briefing body copy. Those use `text-primary` or `text-muted`.
- Error text is `--color-red-text` (#e8677d) on `--color-red-bg`. `#bc263e`
  is fills/borders/chart-strokes only, never body text.
- Green `#38a67c` may be text at 11px+.
- Color is never the sole signal: signed numbers always print their `+`/`−`;
  momentum cells print the number; direction words accompany hue.
- The momentum ramp backgrounds (§2 tokens) all keep white text ≥ 7:1 —
  verified: worst case `rgba(56,166,124,0.45)` over `#111111` composites to
  ≈ #1f4a3a, white on it ≈ 9.8:1.

### 2.2 Type scale usage

Identical to Hyperion: 2xs chart ticks; xs labels/badges/table headers; sm
dense cells and panel titles; md inputs/buttons; base body; lg stat values;
xl exactly one per view (the view's headline number or title figure). On
mobile the scale does NOT change — density changes, type does not. 13px mono
is already at the floor of comfortable phone reading; shrinking it is
forbidden.

---

## 3. Component tiers (buttons, badges)

Button tiers are reduced to three. `money` and `arm` from Hyperion DO NOT
EXIST here — do not port them.

| Tier | Look | Used for |
|---|---|---|
| Ghost | 1px `--color-border`, `text-secondary` text, hover `text-primary` + `--color-hover` bg | Navigation, filters, cancel, retry, secondary actions |
| Neutral | `bg-elevated`, 1px border, `text-primary` | Primary submits: login, save branch, create branch, run simulation, trigger routine |
| Danger | Ghost geometry, `--color-red-text` text, `--color-red-bg` on hover | Delete branch, remove allocation row. Confirmed per §7 |

Heights come from the density variables: ghost/neutral/danger are
`var(--control-md)` tall (26px desktop, 40px touch); a view's single primary
action (e.g. RUN SIMULATION) may use `var(--control-lg)`.

Badges, StatusDot, and the state components are ported from
`hyperion/dashboard/src/components/ui/` (Badge.tsx, state.tsx) with these
changes only: DirectionChip is dropped (no positions); OfflineBlock's default
copy changes (§6); a new `MomentumBadge` is added (§11).

New badge use: **MomentumBadge** — signed momentum as `▲ +0.42` green /
`▼ −0.31` red / `— 0.05` gray for |m| < 0.15, 10px, tinted background using
the `*-bg` tokens. Glyph + sign + number always together.

---

## 4. Responsive strategy (the core new contract)

### 4.1 Breakpoints and shell behavior

Three tiers, Tailwind default breakpoints, mobile-first:

| Tier | Width | Shell |
|---|---|---|
| Mobile | < 768px | Single column, bottom tab bar (§5.2), pages scroll vertically, `--gutter` 8px |
| Mid (`md:`) | 768–1023px | Top bar (§5.1), two-column grids where a view defines them, gutter 12px |
| Desktop (`lg:`) | ≥ 1024px | Top bar, full per-view grid, content max-width 1440px centered |

Only `md:` and `lg:` prefixes may appear in layout code. No `sm:`, no `xl:`,
no arbitrary breakpoints — two switch points keep every view testable at
exactly three widths (test at 390px, 768px, 1280px).

Pages scroll normally (body `overflow-y` visible). Hyperion's fixed-viewport
grid is gone. The nav (top bar or tab bar) is `position: sticky`/`fixed`
respectively; content never hides under it (mobile pages get
`padding-bottom: calc(56px + env(safe-area-inset-bottom))`).

### 4.2 Pointer vs viewport

Two independent axes, handled by two independent mechanisms:

- **Viewport width** → layout (columns, nav placement, column dropping) via
  Tailwind `md:`/`lg:` classes.
- **Pointer coarseness** → target sizes via the `@media (pointer: coarse)`
  variable override in §2. A touch laptop at 1280px gets the desktop layout
  with 44px targets; a phone gets both mobile layout and touch targets.

Components never hard-code heights that the density variables cover. Minimum
effective target: `var(--tap-min)` (24px fine / 44px coarse). Full-width
table rows count as targets when the row is clickable.

### 4.3 The metrics strip (Overview) wrapping rule

Desktop: one row of stat cells separated by 1px borders, each cell
`minmax(140px, 1fr)`. Mobile: a 2-column grid (`grid-cols-2`), cells keep
internal layout (label over value over delta), hairline borders between.
Never a horizontal scroller — hidden metrics defeat an at-a-glance strip.
With 5–6 metrics this is 3 rows of 2 on a phone: acceptable, scannable.

### 4.4 Dense tables — column priority contract

Every table declares a **priority-ordered column list**. Rendering rule:

- Desktop (`lg:`): all columns.
- Mid (`md:`): drop priority-4+ columns.
- Mobile: drop priority-3+ columns; the row's tap action (drill-in) exposes
  everything dropped.

Implemented as `hidden md:table-cell` / `hidden lg:table-cell` on `<th>`/
`<td>` — no JS column manager. A table that must show all columns regardless
(the allocation editor) instead lives inside `.table-scroll` and scrolls
horizontally within its panel; page-level horizontal scroll is forbidden
everywhere.

Per-table drop order (P1 = never dropped):

| Table | P1 (always) | P2 (always) | P3 (md+ only) | P4 (lg only) |
|---|---|---|---|---|
| Markets universe | COIN, PRICE | 24H% | OI | FUNDING, VOLUME |
| Metrics summary rows | METRIC, VALUE | Δ (delta) | Z30 | MEAN30 |
| Branches list | NAME, RETURN% | MAX DD | VS BTC | UPDATED |
| Sector tokens (drill-in) | TOKEN, PRICE | 24H% | OI | FUNDING |
| Rotations list | FROM→TO, CONF | TRIGGER | NOTE (full) | — |
| MarketState history | DATE, HEADLINE | — | — | — |
| Lab catalogue (§10.9) | NAME (+ verdict Badge), LIVE SHARPE | WF, HOLDOUT | FIRING, HEALTH, DIR·HZN | LIVE DAYS, SAVED, ORIGIN |
| Lab runs (§10.9) | STARTED, ASSET·DIR·HZN | BEST WF SHARPE, RULES | TRIALS, STATUS | METRICS, DURATION, SOURCE |
| Lab stats by window (§10.9) | all four windows — `.table-scroll`, sticky first column | | | |

Numeric columns right-aligned, tabular-nums, always. COIN/NAME left-aligned.
Sort by clicking headers (Markets and Branches only); sorted header in
`text-primary` with `▾`/`▴`.

### 4.5 Charts

All charts are Recharts inside `<ResponsiveContainer width="100%">` with a
fixed height per breakpoint — height via a wrapper class, not JS. One
exception: the market chart (§9.4) is lightweight-charts (canvas), because
it holds tens of thousands of bars, pans/zooms and stacks panes:

| Chart | Mobile height | Desktop (`lg:`) height |
|---|---|---|
| Equity curve (+benchmarks) | 220px | 300px |
| Drawdown | 90px | 120px |
| Monte-carlo fan | 200px | 280px |
| Market chart price pane (drill-in) | 240px | 340px (+96px per perp pane) |
| Overview sparkline | 48px | 56px |
| Metric mini-series (drill) | 160px | 220px |

Mobile chart adaptations, uniform across all charts:

- X-axis: max 4 ticks mobile / 8 desktop (`interval="preserveStartEnd"`,
  `minTickGap` 48/24). Y-axis: width 44px, compact formatting (`12.4K`,
  `1.2B`) at all sizes.
- Axis ticks 9px (`2xs`), `text-secondary`.
- Tooltips: Recharts default replaced by the dark panel style (bg
  `--color-elevated`, 1px border, 11px). On touch, tooltips activate on tap
  and stay until the next tap outside — never hover-only information.
- Legends: never Recharts' built-in legend. A 10px uppercase inline legend
  row above the chart (colored 8×8 squares + labels), wrapping freely.
- `isAnimationActive={false}` on every series. No exceptions.
- Grid lines: `stroke: var(--color-border-subtle)`, dashed, horizontal only.

### 4.6 What never changes across breakpoints

Type scale, color tokens, state vocabulary, panel anatomy, 220ms motion,
zero radius. A phone user sees the same product, denser surfaces triaged —
not a different product.

---

## 5. App shell and navigation

Destinations post-login: Overview `/`, Branches `/branches`, Sectors
`/sectors`, State `/state`, Markets `/markets` — the original five — plus
the later shell entries Engine `/strategies` (grouping `/decisions` and
`/governor`), Analyst `/analyst`, Desk `/desk` and Lab `/lab` (§10.9) —
nine nav items — plus Logout. `/login` renders outside the shell entirely.

### 5.1 Desktop / mid (≥768px): TopBar, 40px, sticky

```
┌────────────────────────────────────────────────────────────────────────┐
│ HYPERTRADE ▪ │ OVERVIEW  BRANCHES  SECTORS  STATE  MARKETS  ENGINE  ANALYST  DESK  LAB │ ● DATA 12:41 │ LOGOUT │
└────────────────────────────────────────────────────────────────────────┘
```

`LAB` is the last route (research sits after the surfaces it researches);
active on `/lab` and every `/lab/*` path, including `/lab/rules/:id`.

Left → right:

1. **Wordmark** `HYPERTRADE` 11px uppercase bold + a 6×6px
   `--color-red-accent` square. Click → `/`.
2. **Routes**: 10px uppercase ghost links, 12px gap. Active route gets the
   Hyperion treatment: `text-primary` + 2px `--color-red-accent` bottom
   border (`.tab-active`).
3. **Data-freshness cluster** (right-aligned): a StatusDot + `DATA 12:41` in
   10px `text-secondary` — the most recent successful collector run time
   (from `/api/metrics/summary` metadata). Dot: green if < 30min old, amber
   30min–2h, red > 2h or fetch failed. Tooltip (`title`): per-collector last
   run. This is the shell-level staleness signal from principle 3.
4. **LOGOUT** ghost button → `POST /api/auth/logout`, redirect `/login`.

Sticky (`position: sticky; top: 0; z-index: 40`), `bg-panel-alt`, 1px bottom
border.

### 5.2 Mobile (<768px): bottom tab bar + slim top strip

Top strip (40px, sticky): wordmark left, freshness dot + LOGOUT right.
Route links move to a **bottom tab bar**:

```
┌─────────────────────────────────────────────────────────────┐
│ OVIEW BRNCH SECTR STATE MKTS  ENGIN  ASK  DESK  LAB         │  56px + safe-area
└─────────────────────────────────────────────────────────────┘
```

- `position: fixed; bottom: 0`, full width, `bg-panel-alt`, 1px top border,
  height `calc(56px + env(safe-area-inset-bottom))` with the inset as
  padding-bottom.
- Equal cells (`flex: 1`), each a flex column: a 12px glyph over a 9px
  uppercase label. Glyphs are text characters, no icon library: `◈`
  Overview, `⑂` Branches, `▦` Sectors, `☰` State, `≋` Markets, `⚙` Engine,
  `?` Analyst, `◎` Desk, `⚗` Lab.
- Active cell: `text-primary` + a 2px `--color-red-accent` top border on the
  cell (the underline idiom, flipped to the touchable edge).
  Inactive: `text-secondary`.
- Labels: `OVIEW / BRNCH / SECTR / STATE / MKTS / ENGIN / ASK / DESK / LAB`
  — 5 chars max, `letter-spacing` ≤ 0.02em on the tab bar only (the theme's
  control tracking would push a 5-char label past a 35px cell).
- Whole cell is the target (≥56px tall — over `--tap-min`).

No hamburger, no drawer. A drawer would hide the map of the product behind
a tap.

**Nine cells is the ceiling — decision and arithmetic.** LAB was added as a
ninth cell rather than merged, because its one plausible host, ENGINE,
groups the strategy console (strategies, decisions, governor); Lab is
research that feeds strategies, not a console tab, and hiding it one level
down on mobile while it is a top-bar route on desktop would make the two
shells disagree. At 320px nine cells are 35px wide; a 5-char label at 9px
Geist Mono is ≈27px, so labels fit without abbreviating further. Cells are
56px tall: the target is 35×56, above WCAG 2.5.8's 24×24 and the iOS
tab-bar norm, but below the 44px `--tap-min` horizontally — accepted for
this one surface because neighbouring cells are separated by the full cell
boundary (a mis-tap lands on a route, never on an action). A tenth
destination may not add a cell: it merges into an existing one the way
ENGINE already does, or replaces one. Rejected: a scrolling tab bar (hidden
cells defeat the map, §4.3's argument) and 4-char labels (no legibility
gain at 35px; they would rename eight settled labels).

### 5.3 Route guard

Unauthenticated (401 from any API call or missing session): redirect to
`/login`, remember the intended path, return after login.

---

## 6. State vocabulary (canonical patterns)

Ported from Hyperion §4 (component source:
`hyperion/dashboard/src/components/ui/state.tsx`) with copy adapted to this
product's backends. Referenced by name in every view section.

**SkeletonRows** (first load): 2–3 gray pulse bars of decreasing width.
Refetches update in place — skeletons never reappear after first data.
Unbounded skeletons forbidden: resolve to data, EmptyBlock, or ErrorBlock.

**EmptyBlock** (loaded, zero items): centered 11px uppercase
`text-secondary` line, optional single ghost action beneath
(e.g. `CREATE A BRANCH`).

**OfflineBlock** (API unreachable, no cached data): centered — gray
StatusDot, `API UNREACHABLE` 11px uppercase, second line 10px
`check your connection and retry`, ghost `RETRY`. Never a spinner.

**ErrorBlock** (request failed with a message): the verbatim server string,
12px `--color-red-text` on `--color-red-bg`, left-aligned, ghost `RETRY`,
`role="alert"`, adjacent to the thing that failed.

**StaleBanner** (NEW — replaces Hyperion's socket StaleChip; this app has no
sockets): full-width strip at panel top, `--color-amber-bg`, amber 10px
uppercase text, shown when routine data age exceeds its threshold:
`briefing 26h old — generated 2026-08-29 09:12 UTC`. Thresholds:
marketstate/sectors > 24h; collector observations > 2h. Content below is NOT
dimmed (old routine data is still the real latest data, unlike a dead
socket's frozen numbers).

**AgeStamp** (NEW, companion pattern): every routine-backed panel header
carries, right-aligned, `10px text-secondary`: `GEN 4H AGO`. Under the
threshold it is quiet gray; over it, amber (and the StaleBanner appears).
Exact timestamp in the `title` tooltip.

---

## 7. Confirmation vocabulary

Two levels only. No typed-word confirmations exist in this product.

**Level 1 — plain action** (reversible or additive): save/create branch, run
simulation, login, trigger routine, edit allocations. Single click, inline
verbatim ErrorBlock on failure.

**Level 2 — destructive confirm**: delete branch, remove a branch's scenario.
A confirmation dialog: scrim (`--color-scrim`) + centered panel
(`--shadow-overlay`, max-width 360px), title `DELETE BRANCH`, body names the
object — `Delete "60/40 ETH-stables"? Its simulation history goes with it.`
Confirm is Danger tier labeled with verb + object (`DELETE BRANCH`), cancel
is ghost and receives initial focus. Dialog stays open on failure showing the
verbatim error; closes only on success or cancel. On mobile the dialog is a
bottom sheet: full-width, pinned to the bottom edge, same content.

**Trigger-routine special case** (Level 1 with consequence copy): the button
in `/state` shows, beneath it in 10px `text-secondary`:
`requests a cloud routine run — results land on the next deploy`. After a
successful POST the button disables for 60s and reads `REQUESTED 12:41`.
Not a Level 2 — it costs a routine run, not data.

---

## 8. Interaction and motion

Hyperion §8 carried over whole, minus grid-drag and sockets:

- **One rhythm**: 220ms. Digit animation, tick flash (Markets live prices),
  fades. Nothing longer than 250ms.
- **AnimatedDigits**: only on the per-view xl value. Tables never.
- **Tick flash**: `/markets` live mid updates only; coalesce to ≤ 2
  flashes/sec/cell.
- **Hover**: `--color-hover` bg, 100ms background-color transition only.
  Pressed: `--color-active`. On touch, hover styles must not stick: gate
  hover rules behind `@media (hover: hover)`.
- **The one indeterminate indicator**: the 1Hz `.pulse-label` opacity pulse
  (skeleton bars; a button label while its request is in flight, e.g.
  `RUNNING…`). No spinners exist.
- **Forbidden**: spring/bounce easing, scale/translate on hover,
  layout-shifting animation, shimmer, animated gradients, chart data
  animation, badge pulsing, parallax.
- **`prefers-reduced-motion`**: flashes and digit swaps become instant; the
  pulse becomes a static `…` suffix. One global media query.
- **Keyboard**: `Esc` closes topmost dialog; dialogs trap and restore focus;
  table rows focusable (`tabindex=0`), Enter activates the row's drill-in.
  No command palette in v1 — five routes and a tab bar do not need one.

---

## 9. Chart specifications (shared, Recharts)

### 9.1 Equity curve vs benchmarks (branch detail; sparkline variant on Overview)

`ComposedChart` over daily points `{ ts, equity, btcHodl, usdc }`:

- Branch equity: `Line`, `--color-equity` (white), strokeWidth 1.5, no dots.
- HODL-BTC benchmark: `Line`, `--color-bench-btc`, strokeWidth 1, no dots.
- 100%-USDC benchmark: `Line`, `--color-bench-usdc`, strokeWidth 1,
  `strokeDasharray="4 3"`.
- Y-axis: USD compact. Legend row above (§4.5): `— BRANCH  — HODL BTC  ┄ USDC`.
- If a `scenario` exists, the projection (§9.3) renders on the SAME chart,
  continuing to the right of the last historical point, separated by a 1px
  dashed vertical reference line labeled `TODAY` (10px, text-secondary).

### 9.2 Drawdown

`AreaChart`, values ≤ 0 (percent from peak): area fill
`--color-drawdown-fill`, line `--color-drawdown-line` 1px, Y-axis 0 at top.
Max drawdown point marked with a single `ReferenceDot` (2px red square) and
the value printed in the panel header: `MAX DD −34.2%`.

### 9.3 Monte-carlo fan (projection)

Rendered as the forward section of §9.1's chart (and standalone on mobile if
the combined chart gets cramped — it does not; keep combined). Series from
`{ ts, p10, p50, p90 }`:

- Band: `Area` between p10 and p90, fill `--color-proj-band`, no stroke.
- Median: `Line` p50, `--color-proj-line`, strokeWidth 1.5,
  `strokeDasharray="6 3"` — dashed because it is not a fact.
- Terminal values printed at the right edge as a small readout block (not
  chart labels): `P90 $18.4K / P50 $13.1K / P10 $9.2K` — 11px, info-toned.
- The scenario's assumptions render as text directly under the chart (§10.4).
  A projection without visible assumptions is forbidden (principle 6).

### 9.4 Market chart (markets drill-in)

`MarketChart` — TradingView lightweight-charts v5, the one non-Recharts
chart (§4.5). One time axis, stacked panes:

- **Price**: candles, up `--color-green` / down `--color-red`, no borders;
  volume histogram overlaid on the bottom 18% at 35% opacity (toggle `VOL`).
  `LOG` toggles a logarithmic price scale.
- **Funding APR** (`FUND`): histogram of the bar's mean hourly funding × 8760,
  green ≥ 0 / red < 0 at 60% opacity, zero line.
- **Open interest** (`OI`): `--color-info` 1px line, USD compact.
- **Premium** (`PREM`, off by default): `--color-amber` 1px line in bp, zero line.

Timeframe chips `1m 5m 15m 1H 4H 1D 1W 1M` (minutes lowercase so `1m` and
`1M` never read alike — the theme's control case is overridden on these
labels only). Pane toggles are a `.seg` group of checkbox chips, persisted
per browser. A 10px legend row above the canvas reads the hovered bar (or
the last): time (UTC), OHLC, Δ vs previous close, V, FUND, OI, PREM, and
`SRC` when the bar isn't Hyperliquid's. Where history switches venue, an
`arrowUp` marker names the newer venue (`BINANCE`, `HL`), and a footnote row
states the stitched range (`BITSTAMP 2011-09-13 → BINANCE 2017-08-17 → HL
2023-05-12`), funding/OI coverage and `scroll left for more` / `full history`.

Paging: the first page is the latest 1500 bars (180 in view); panning
within 150 bars of the left edge requests the previous page, and the view
holds still while it lands (`loading history…` pulse top-left). The newest
bar streams over Hyperliquid's websocket; after a socket drop the latest
300 bars are refetched. Colors come from the theme tokens and the chart is
rebuilt on theme change.

### 9.5 Metric series (metric drill / overview strip tap)

Single `Line`, white, 1px, with the 30-day mean as a
`--color-bench-usdc` dashed reference line. Header shows latest value (lg),
delta, z30.

---

## 10. Views

Route map: `/login`, `/` (Overview), `/branches`, `/branches/:id`,
`/sectors`, `/state`, `/markets`, `/markets/:coin`, `/analyst`, and the
lab family `/lab/{search,runs,catalogue,pulse}`, `/lab/runs/:runId`,
`/lab/rules/:id` (§10.9). Every view gets: purpose, mobile layout,
desktop layout, components with data fields, states, interactions.

### 10.1 `/login`

Purpose: password gate. Renders without the shell.

All widths: a single centered panel, max-width 320px, vertically centered
(`min-height: 100dvh` flex). Content:

```
┌──────────────────────────────┐
│  HYPERTRADE ▪                │   wordmark, 16px (the view's xl-equivalent)
│                              │
│  PASSWORD                    │   .label
│  [••••••••••••••]            │   input type=password, autofocus, full width
│  ┌ error block (verbatim) ┐  │   ErrorBlock on 401: server's message
│  [        ENTER        ]     │   Neutral tier, full width, control-lg
└──────────────────────────────┘
```

- Submit on Enter. In flight: button label `ENTERING…` with pulse, disabled.
- 401 → ErrorBlock above the button with the verbatim server message; input
  keeps its value, gets focus.
- Success → redirect to the remembered path or `/`.
- States: only idle/in-flight/error — no skeletons here.

### 10.2 `/` — Overview

Purpose: 30-second morning read — where is the market, what does the routine
think, how are my branches doing. Everything links deeper; nothing is edited
here.

Desktop (`lg:`, 12-col grid, gutter 12px):

```
┌ METRICS STRIP ──────────────────────────────────────────── 12 ┐
│ TOTAL OI      FUND SKEW    FEAR/GREED   BTC DOM    STABLES    │
│ $4.21B        +0.0031      72 GREED     54.2%      $168B      │
│ +2.1% ▲ z1.2  −0.0004 ▼    +4 ▲         −0.3% ▼    +0.8% ▲    │
├ MARKETSTATE ───────────────────── 7 ┬ SECTOR HEAT ────────── 5 ┤
│ RISK APPETITE ROTATES OUT OF…       │ AI INFRA      ▲ +0.62   │
│ (headline, 16px lg, text-primary)   │ RWA           ▲ +0.31   │
│ tldr paragraph in text-muted…       │ MEMES         ▼ −0.44   │
│ GEN 4H AGO          READ BRIEFING → │ L2S           — 0.08    │
├ BRANCHES ──────────────────────── 7 ┼─────────────────────────┤
│ 60/40 ETH   +18.2% ▲   ▁▂▃▅▆▅▇     │ (top 6 by mindshare,    │
│ SOL MAX     −4.1% ▼    ▇▆▅▃▂▃▂     │  MomentumBadge each,    │
│ (top 3 by updated_at)  ALL →       │  ALL SECTORS →)         │
└─────────────────────────────────────┴─────────────────────────┘
```

Mobile: single column, order — metrics strip (2-col grid per §4.3),
MarketState card, Sector heat card, Branches card. Bottom tab bar.

Components and data:

- **MetricsStrip** — from `GET /api/metrics/summary`. Five cells (series:
  `hl.total_oi_usd`, `hl.funding_skew`, `fng.value`, `cg.btc_dominance`,
  `llama.stablecoin_cap_usd`). Each **MetricStat** cell: label (xs,
  secondary), value (lg, primary, compact-formatted), third line (xs): signed
  delta with glyph + z30 as `z1.2` when |z| ≥ 1 (amber when |z| ≥ 2 — an
  unusual reading is worth an eyebrow). Cell tap → `/markets` is wrong —
  metric cells are NOT links in v1 (no metric-detail route in spec). Fear/
  greed prints its word (`72 GREED`).
- **MarketStateCard** — from `GET /api/marketstate`: `headline` (lg 16px —
  the view's xl-equivalent; only Overview element allowed above `base`),
  `tldr` (base, `text-muted`, clamp to 4 lines with CSS `line-clamp`),
  AgeStamp in header, ghost `READ BRIEFING →` → `/state`. StaleBanner when
  > 24h.
- **SectorHeatCard** — from `GET /api/sectors`: top 6 sectors by
  `mindshare_score`, each row: label (sm, primary) + MomentumBadge.
  Row tap → `/sectors` (whole list, not per-sector deep link — the drill-in
  lives there). Ghost `ALL SECTORS →`.
- **BranchesCard** — from `GET /api/branches` (+ cached results): top 3 by
  `updated_at`. Row: name (sm), total return signed/colored, 90-day equity
  **Sparkline** (§4.5, white 1px line, no axes). Tap → `/branches/:id`.
  Ghost `ALL →`.

States: MetricsStrip — SkeletonRows / ErrorBlock / StaleBanner (> 2h);
MarketStateCard — SkeletonRows / EmptyBlock (`no briefing yet — trigger the
routine from STATE`) / StaleBanner; SectorHeatCard — same pattern;
BranchesCard — SkeletonRows / EmptyBlock (`no branches yet` + ghost
`CREATE A BRANCH` → `/branches`).

### 10.3 `/branches` — list + create

Purpose: portfolio strategies at a glance; entry point to the editor.

Desktop: one full-width panel. Header: `BRANCHES` + right-aligned Neutral
`NEW BRANCH`. Body: table per §4.4 (NAME, RETURN%, MAX DD, VS BTC, UPDATED).

- RETURN%: total return over the branch's period, signed, colored.
- MAX DD: signed negative, red text when < −20%.
- VS BTC: branch return minus HODL-BTC return, signed/colored — the one
  number that says whether the strategy beat doing nothing.
- Row tap → `/branches/:id`.

Mobile: same table with P3+ columns dropped (NAME, RETURN%, MAX DD). NEW
BRANCH becomes a full-width Neutral button above the table.

`NEW BRANCH` creates immediately via `POST /api/branches` with a default
config (name `UNTITLED`, 100% USDC, startDate = 1y ago, $10,000, rebalance
none) and navigates to the editor — no creation modal; the editor is the
creation flow.

States: SkeletonRows / EmptyBlock (`no branches yet` + `NEW BRANCH`) /
ErrorBlock.

### 10.4 `/branches/:id` — editor + results

Purpose: edit an allocation strategy, see what it would have done, and what
it might do. The densest view; its mobile order is tuned so results follow
the edit.

Desktop (`lg:`, 12-col):

```
┌ CONFIG ─────────── 4 ┬ EQUITY VS BENCHMARKS ─────────────── 8 ┐
│ NAME [60/40 ETH…  ]  │  $13,412            (xl, AnimatedDigits)│
│ DESCRIPTION [     ]  │  +34.1% ▲ · CAGR 22.4% · vs BTC +6.2% ▲ │
│ START  [2024-01-01]  │  ┌ legend: — BRANCH — HODL BTC ┄ USDC ┐ │
│ CAPITAL [$10,000  ]  │  │   equity chart §9.1, 300px         │ │
│ ── ALLOCATIONS ────  │  │   …forward fan §9.3 after TODAY    │ │
│ COIN    WEIGHT%      │  └────────────────────────────────────┘ │
│ ETH     [60 ]    ✕   │  scenario assumptions line (§9.3)       │
│ USDC    [40 ]    ✕   ├ DRAWDOWN ──────────────────────────── 8 ┤
│ [+ ADD COIN]  Σ100%  │  chart §9.2, 120px    MAX DD −18.4%     │
│ ── REBALANCE ──────  ├ STATS ─────────────────────────────── 8 ┤
│ (none|month|week|5%) │  CAGR 22.4%  MAXDD −18.4%  FINAL $13.4K │
│ ── SCENARIO ───────  │  VS BTC +6.2%  VS USDC +34.1%           │
│ [+ ADD PROJECTION]   │  COMPUTED 2026-08-30 09:14              │
│ ────────────────────  │                                         │
│ [ RUN SIMULATION ]   │                                         │
│ [SAVE]     [DELETE]  │                                         │
└──────────────────────┴─────────────────────────────────────────┘
```

Mobile order (single column): equity header numbers → equity chart → config
panel → drawdown → stats. WHY: on a phone you check a branch far more often
than you edit it; results lead.

Components:

- **BranchConfigPanel**: name/description/startDate (`<input type="date">`)/
  capital inputs. **AllocationEditor**: table rows COIN (uppercase text
  input, 6ch), WEIGHT% (numeric input, 5ch), Danger `✕` per row; `+ ADD
  COIN` ghost; footer sum `Σ 100%` — green when 100, `--color-red-text`
  `Σ 87% — must equal 100` otherwise, RUN disabled while invalid.
  **RebalanceSelect**: 4 ghost chips in a row (`NONE / MONTHLY / WEEKLY /
  5% BAND`), active chip selected-style. **ScenarioEditor** (collapsed
  behind `+ ADD PROJECTION` when config has no scenario): horizonDays
  (numeric), paths (numeric, default 200), per-allocated-coin rows of
  `annualReturnPct` / `annualVolPct` inputs; Danger `REMOVE PROJECTION`
  (Level 2 confirm).
- **RUN SIMULATION**: Neutral, `--control-lg`, full width of the config
  column. In flight: `RUNNING…` pulse, charts keep previous results at 70%
  opacity until new data lands (no skeleton flash on re-run). Errors:
  verbatim ErrorBlock under the button.
- **SAVE** (Neutral) persists config (`PUT /api/branches/:id`); dirty state
  = amber dot in the CONFIG panel header. **DELETE** (Danger, Level 2).
- **EquityPanel**: header carries final equity (xl, AnimatedDigits — the
  view's single xl), then a stat line (md): total return signed, CAGR,
  vs BTC signed. Chart §9.1 + §9.3. Below the chart, the assumptions line
  (10px, `text-secondary`):
  `PROJECTION 180D · 200 PATHS · ETH +40%/70% VOL · GBM` — always visible
  when a fan is drawn.
- **DrawdownPanel** §9.2. **StatsPanel**: label/value grid (2 cols mobile,
  4 desktop) + `COMPUTED <ts>` stamp (xs, secondary).

States: config — SkeletonRows on load, ErrorBlock; results — EmptyBlock
(`not simulated yet — RUN SIMULATION`) when no cached result, SkeletonRows
only on first-ever run, ErrorBlock with verbatim sim errors (e.g. missing
candles for a coin: the server's message names the coin).

### 10.5 `/sectors` — mindshare map + rotations + drill-in

Purpose: see where the routine thinks mindshare sits and where it is
rotating, with quantitative enrichment per sector.

**Decision: heat-grid, not treemap.** Two shapes were considered. A treemap
(Recharts has one) encodes mindshare as exact area — but the taxonomy is
emergent (the routine may emit 5 sectors or 18, with long labels), mindshare
is an LLM-estimated score where 2-significant-figure area precision is false
precision, and on a 390px screen treemap tiles below ~15% share become
unlabelable slivers. A tiered heat-grid keeps every sector labeled and
tappable at every size, degrades predictably with any N, and needs no chart
library. The grid encodes mindshare as cell size *tier* + printed score;
momentum as background ramp + MomentumBadge.

**MindshareGrid** spec: CSS grid, 4 columns desktop / 2 columns mobile,
`grid-auto-flow: dense`. Sectors sorted by `mindshare_score` desc, sized by
tier:

| Tier | Condition | Span (lg) | Span (mobile) |
|---|---|---|---|
| Large | score ≥ 0.25 | 2×2 | 2×1 |
| Medium | 0.10 ≤ score < 0.25 | 2×1 | 1×1 |
| Small | score < 0.10 | 1×1 | 1×1 |

Grid row height 72px desktop / 64px mobile, 2px gap (gap is `--color-body`
showing through — reads as engraved seams). Cell anatomy: background from
the momentum ramp (§2 buckets); top-left sector label (sm, uppercase,
primary, wraps to 2 lines, ellipsis after); bottom-left mindshare as
`MS 0.31` (xs, secondary); bottom-right MomentumBadge. Whole cell tappable →
drill-in. Selected cell: 2px inset `--color-focus` outline… no — selected
cell gets the standard 2px left inset border `--color-red-accent` +
`--color-selected` overlay (the Hyperion selection idiom).

Layout desktop (`lg:`): grid 12-col — MINDSHARE panel 8, ROTATIONS panel 4;
DRILL-IN panel full-width 12 below, rendered only when a sector is selected.
Mobile: mindshare grid, then drill-in (auto-scrolled into view on select),
then rotations.

- **MindsharePanel** header: `MINDSHARE` + AgeStamp (`GEN 6H AGO`) + src-tag
  `ROUTINE`. StaleBanner > 24h.
- **RotationsPanel** — `rotations[]`: each row (§4.4 drop order):
  `MEMES → AI INFRA` (sm, primary, the arrow in secondary), confidence as
  `CONF 0.7` xs badge (gray < 0.5, default otherwise), trigger text (xs,
  secondary, one line), note (muted, md+ only, 2-line clamp). EmptyBlock:
  `no rotations flagged`.
- **SectorDrillPanel** (on select) — header: sector label + MomentumBadge +
  ghost `CLOSE ✕`. Body: `rationale` verbatim (base, `text-muted`);
  `sources[]` as src-tags; then the enriched token table (from
  `GET /api/sectors` enrichment): TOKEN, PRICE, 24H%, OI, FUNDING per §4.4
  drop order, src-tag `HL` in the section label. Token row tap →
  `/markets` drill-in for that coin. Tokens without HL listings render
  PRICE/OI/FUNDING as `—` (secondary) — absence shown, not hidden.

States: SkeletonRows / EmptyBlock (`no sector data yet — trigger the routine
from STATE`) / ErrorBlock / StaleBanner + AgeStamp.

### 10.6 `/state` — MarketState briefing

Purpose: the full routine briefing, its history, and the trigger. This is
the product's reading surface — the one place generous whitespace wins:
content column max-width 760px centered (Hyperion settings-page precedent),
16px vertical spacing between panels.

Layout (all breakpoints — single column; desktop just centers it):

```
┌ header row ──────────────────────────────────────────────────┐
│ MARKETSTATE      GEN 4H AGO · 2026-08-30 09:12 UTC           │
│ [◂ 2026-08-29 ▸]  history stepper     [ TRIGGER ROUTINE ]    │
├ HEADLINE ────────────────────────────────────────────────────┤
│ Risk appetite rotates out of majors…    (xl 22px, primary —  │
│                                          the view's xl)      │
│ tldr paragraph, base 13px text-muted, full text              │
├ THESIS ──────────────────────────────────────────────────────┤
│ OBSERVE   what the data shows…            (three subsections,│
│ INFER     what it likely means…            xs uppercase      │
│ FORECAST  what may happen next…            labels, body in   │
│ disclaimer (xs, text-secondary, italic-free, verbatim)       │
├ DOMAINS ─────────────────────────────────────────────────────┤
│ ┌ LIQUIDITY ──────────┐ ┌ DERIVATIVES ────────┐  2-col md+,  │
│ │ summary text_muted  │ │ …                   │  1-col mobile│
│ │ M2 ▲ EXPANDING      │ │ OI ▼ $4.2B          │              │
│ │ RRP — FLAT          │ │ FUND ▲ +0.003       │              │
│ └─────────────────────┘ └─────────────────────┘              │
├ RISKS ───────────────────────────────────────────────────────┤
│ ▪ each risk string verbatim, base, text-muted, red square    │
│   bullet (6px, --color-red)                                  │
└──────────────────────────────────────────────────────────────┘
```

Components:

- **HistoryStepper**: `◂` / `▸` ghost buttons around a date `<select>`
  listing all dated files (build-time `import.meta.glob` of
  `data/marketstate/*.json`). Viewing a non-latest date: an info-toned
  banner (`--color-info-bg`) at the top — `viewing 2026-08-12 — not the
  latest briefing` with a ghost `LATEST` button. The whole page renders the
  selected snapshot.
- **TriggerRoutineButton**: Neutral tier, `--control-lg`. Consequence copy
  and post-request behavior per §7. If `ROUTINE_WEBHOOK_URL` is unset the
  server says so; render that verbatim as an info block (not an error — it
  is configuration state).
- **ThesisBlock**: the three Observe/Infer/Forecast sections, each an xs
  uppercase label (`text-secondary`) followed by body text (`text-muted`,
  base). Disclaimer verbatim beneath in xs `text-secondary`.
- **DomainCard** per `domains[]` entry: panel with domain name as title,
  `summary` in muted base, then **SignalRow** per signal: label (xs,
  uppercase, secondary) + value (sm, primary, tabular) + direction glyph
  `▲`/`▼`/`—` colored green/red/gray. Direction word is in the glyph +
  value sign; the label carries the semantics.
- **RisksList**: verbatim strings, one per row, 6px red square bullets.

States: SkeletonRows on load; EmptyBlock when `data/marketstate/` has no
files (`no briefing yet` + the trigger button); StaleBanner + AgeStamp per
§6; ErrorBlock for API failures. History browsing is build-time data — no
network states beyond initial load.

### 10.7 `/markets` — Hyperliquid universe + candle drill-in

Purpose: the raw market surface. Live-ish (short-cache pass-through), the
only view with tick flash.

Desktop: full-width panel, table per §4.4 (COIN, PRICE, 24H%, OI, FUNDING,
VOLUME), sortable headers, default sort OI desc. Header: `MARKETS` +
src-tag `HL` + result count (`142 PERPS`, xs secondary) + a filter input
(ghost-styled, placeholder `FILTER`, filters by coin substring, right-
aligned, 160px).

- PRICE: tabular, tick-flash on refetch delta (poll `GET /api/hl/markets`
  every 15s; flash cells whose value changed, §8 coalescing).
- 24H%: signed, colored, glyph.
- FUNDING: signed, colored; |funding| ≥ 0.1%/8h renders amber (crowded
  trade flag).
- Row tap → drill-in.

**Drill-in** — route `/markets/:coin?tf=4h`. Desktop AND mobile: a full view
(not an overlay — back button friendly, linkable; `tf` omitted = 1D):

```
┌ ← MARKETS ───────────────────────────────────────────────────┐
│ ETH  $3,512.40 (xl, AnimatedDigits) +2.1% ▲  LIVE  AT OI CAP  25x MAX │
│ ORACLE | FUNDING 1H | NEXT FUNDING | OPEN INTEREST | OI 7D |   │
│ 24H VOLUME | IMPACT SPREAD | MID            (MetricStat grid)  │
├ CHART ── [1m 5m 15m 1H 4H 1D 1W 1M] [VOL FUND OI PREM LOG] ───┤
│ legend row · price+volume / funding APR / OI / premium panes  │
│ footnote: sources · funding since · OI snapshots since        │
├ FUNDING ─────────────────────────────────────────────────────┤
│ venue | predicted | APR | next    ||  AVG 24H | AVG 7D | AVG 30D │
└──────────────────────────────────────────────────────────────┘
```

Grid: 8 columns lg, 4 sm, 2 mobile. `LIVE` shows while the websocket feed is
up (mark/oracle/funding/OI update in place); without it, AgeStamp on the
60s poll. Funding panel: HL/Binance/Bybit predicted rates from
`predictedFundings`, annualized per venue interval, with countdowns.

Data: `GET /api/perp/:coin` (60s poll) + websocket `activeAssetCtx`;
`GET /api/candles/:coin?tf&before&limit` (pages backfill on miss — first
load of an uncached coin may take seconds: SkeletonRows in the chart area
with a `backfilling candles…` pulse label under it, still no spinner) +
websocket `candle`.

Mobile table: COIN, PRICE, 24H% only (§4.4); everything else in the
drill-in. Filter input goes full-width above the table.

States: SkeletonRows / ErrorBlock / EmptyBlock (filter matches nothing:
`no coins match`) / StaleBanner if the snapshot is > 5min old (short-cache
surface, tight threshold).

### 10.8 `/analyst` — read-only analyst (phase 2)

```
┌ ANALYST ──────── [● ANTHROPIC · Opus 5.5 FRONTIER] [low|MED|high…] [WEB SEARCH] [CLEAR] ┐ ┌ PROMPTS ─────────┐
│                                         ┌ question (elevated bubble, right) ┐     │ │ BRIEFING …       │
│ ● DEEPSEEK · deepseek-v4-pro · HIGH   THINKING…                                     │ │ MARKETS …        │
│ ▸ REASONING · 412 chars   (open while it streams, collapses once the answer starts) │ │ SECTORS / ENGINE │
│ TOOLS · 2  [get_hl_markets] [web web_search]   (chips; click to expand inputs)      │ ├ PROVIDERS 3/9 ───┤
│ answer — markdown: headings, lists, tables (signed cells green/red), code          │ │ ● Anthropic web  │
│ SOURCES 1. title · host                                                             │ │ ● DeepSeek …     │
│ 12.8k in · 612 out · 1 tool round · 3.4s · stop      COPY  ASK AGAIN               │ │ ○ OpenAI set …   │
├─────────────────────────────────────────────────────────────────────────────────────┤ ├ TOOLS · 9 ▸ ─────┤
│ [ textarea, autosizes to 200px                                ] [ASK | STOP]        │ │ disclaimer       │
└ Enter to send · Shift+Enter for a new line ─────────────────────────────────────────┘ └──────────────────┘
```

Two columns from `lg:` (thread `minmax(0,1fr)`, rail 300px sticky); the
thread panel fills the viewport height and its composer is sticky at the
panel's bottom. Empty thread: an "Ask the analyst" intro and the prompt
library as cards. Each answer is labelled with the provider/model/effort that
wrote it; a phase label (`WAITING`/`THINKING`/`RUNNING TOOLS`/`WRITING`)
pulses while it streams. Reasoning is shown only when the model exposes it
(Anthropic summaries, `reasoning_content` from DeepSeek/Kimi/Qwen).

The model pill (`ModelSelector`) lists configured providers first, then a
`NOT CONFIGURED · n` group whose header names the env var to set; the
effort control offers only the levels the selected model takes (DeepSeek and
Kimi: low/high/max). The rail's PROVIDERS list doubles as setup status and a
quick provider switch.

Data: `GET /api/analyst/status`, `GET /api/analyst/models`,
`POST /api/analyst/query` (SSE). The session persists per browser
(`localStorage`, last 30 turns); the last 10 answered turns go back as
context.

States: SkeletonRows while the status probe runs; OfflineBlock
`ANALYST NOT CONFIGURED` (naming the provider key vars) on 503; OfflineBlock
`ANALYST UNREACHABLE` on 502 or no network; a per-turn verbatim ErrorBlock
for timeouts, refusals and provider errors. No spinners: pulse labels only.
Mobile: the seventh tab-bar cell (`ASK`, glyph `?`); single column with the
rail below the thread, and the composer sticks above the tab bar.

### 10.9 `/lab` — heuristic research

Purpose: LAB.md's research loop as a page — search a metric universe for
one- or two-condition rules, read them with their out-of-sample numbers
beside the in-sample ones, keep the good ones, and see which are firing
today. Everything renders from the lab tool results (`src/server/lab/
types.ts`): `SearchResult`, `RuleEvaluation`, `PerfStats`, `Sensitivity`,
`CatalogueEntry`, `CatalogueHealth`, `MarketPulse`. Nothing here trades;
the heaviest action is removing a catalogued rule.

**Three honesty rules, binding on every surface in this view.**

1. **Holdout sits next to in-sample, always.** Wherever a Sharpe or return
   is printed for a rule, the holdout value is printed in the same row at
   the same size. No card, table or header may show in-sample or
   walk-forward alone. When holdout Sharpe has the opposite sign to
   walk-forward, or is below half of it, an amber Badge `HOLDOUT GAP`
   accompanies the pair — the overfit flag.
2. **The rank key is named.** Results and catalogue headers carry the
   `.label` line `RANKED BY WALK-FORWARD SHARPE` (or `RETURN` when that was
   the objective). Holdout never sorts anything; a sort control over holdout
   does not exist.
3. **Disclaimer + data age on every result surface.** Footer line, 10px
   `text-secondary`: `historical research, not advice · net of 10 bps
   slippage · data to 2026-10-07`. The `data to` date is an AgeStamp
   (threshold 2 days → amber; StaleBanner on the panel when > 2 days).

#### Sub-navigation and URLs

Path-based, like the ENGINE console (`/strategies`, `/decisions`,
`/governor` under one shell entry), not query tabs — each tab is a
bookmarkable page and the browser back button steps between them:

| Path | Tab | Content |
|---|---|---|
| `/lab` | — | redirects to `/lab/search` |
| `/lab/search` | SEARCH | form + results of the current/last run in this browser; after a reload with no last run, the newest stored run (`lab_list_runs` limit 1 → `lab_get_run`) |
| `/lab/runs` | RUNS | recent runs list |
| `/lab/runs/:runId` | SEARCH | the Search tab with that run's config in the form and its results below; header stamp `RUN 7f3a · 2026-10-08 09:12 UTC` |
| `/lab/catalogue` | CATALOGUE | saved rules, health, live stats |
| `/lab/pulse` | PULSE | Market Pulse board |
| `/lab/rules/:id` | (drill) | rule detail; `?run=<runId>` when the rule is not catalogued; `?from=catalogue\|results\|pulse` sets the back link |

**LabTabs**: one `Segmented` (`size: 'md'`) directly under the shell:
`SEARCH · RUNS · CATALOGUE · PULSE`, in workflow order (search → its
history → what you kept → what it says today). Default `SEARCH`: the page
exists to run searches; the glanceable Pulse is one tap away and also has
an Overview tile. Mobile: four segments fit 320px with `short` labels
`SRCH · RUNS · CTLG · PULSE`; the tab row is `position: sticky; top: 40px`
under the top strip. The catalogue segment carries a count suffix
(`CATALOGUE · 7`) at md+; the Pulse segment carries a 6px dot, green if any
rule fires, gray otherwise (number + word remain inside the tab).

Rule detail is a **full view route** (the markets-drill pattern, §10.7),
not the sectors inline panel: it is tall (chart, drawdown, two tables, a
grid), must be linkable from MCP/CLI output, and must be back-button
friendly. Header: ghost `← RESULTS` / `← CATALOGUE` / `← PULSE` per
`?from`.

#### SEARCH tab

Desktop (`lg:`, 12-col grid, gutter 12px). The form column is
`position: sticky; top: 92px` (40px bar + 52px tab row) so RUN and the
filters stay in reach while scrolling cards:

```
┌ SEARCH ──────────────── 4 ┬ RESULTS ────────────────────────────────── 8 ┐
│ ASSET  [BTC   ] (datalist)│ RUN 7f3a · BTC LONG 14D · 2019-03-01→2026-10-07 │
│ DIRECTION [LONG | SHORT]  │ 312 FEATURES · 40/40 TRIALS · 23.4 s · GEN 2M AGO│
│ METRICS  [6 METRICS   ▾]  │ RANKED BY WALK-FORWARD SHARPE                   │
│  ▪ MVRV ✕ ▪ funding ✕ …   │ ┌ warnings strip (amber, verbatim) when any ┐   │
│ HORIZON [7D|14D|30D|60D|…]│ [ALL|PAIRS|SINGLE] [IS|WF|HO] MIN SHARPE [1.0]   │
│ OBJECTIVE [SHARPE|RETURN] │ MAX DD [−30%] MIN HIT [50%]        12 OF 18 RULES│
│ EFFORT [20|40|100|200]    ├──────────────────────────────────────────────────┤
│  ~10 s · ~25 s · ~60 s    │ #1 z(90) MVRV < −1.12 AND funding ≥ 0.03% ●FIRING│
│ ▸ ADVANCED                │    LONG BTC · 14D · PAIR · CM HT           [SAVE]│
│ ───────────────────────── │  WF SHARPE +1.42 │ HOLDOUT +0.97 │ HIT 61% │ …   │
│ [      RUN SEARCH       ] │ #2 …                                             │
│ historical research, not  ├ FEATURE IMPORTANCE ──────────────────────────────┤
│ advice                    │ cm:CapMVRVCur z(90) ████████████ 0.31            │
└───────────────────────────┴──────────────────────────────────────────────────┘
```

Mobile: single column — **LabSearchForm**, then results. After a run lands
the form collapses to **SearchSummaryBar** (40px, sticky under the tab row,
`bg-panel-alt`): `BTC · LONG · 14D · 6 METRICS · 40 TRIALS` + ghost `EDIT`
(re-expands the form); results scroll into view once (`scrollIntoView`,
never again on refetch).

**LabSearchForm** (Easy mode, top → bottom; every field has a visible
`.label`):

- `ASSET`: uppercase text input, 8ch, `<datalist>` of the HL universe
  (`GET /api/hl/markets`) — free text allowed (the engine validates).
- `DIRECTION`: `Segmented` `LONG | SHORT`, `tone` green/red; the word is the
  signal, the tint is decoration.
- `METRICS`: **MetricPicker** trigger — a ghost-styled field reading
  `6 METRICS ▾` (`0 METRICS` in `text-secondary` when empty; `40/40` amber
  at the cap). Selected metrics render below as removable chips (xs, name +
  `SrcTag` provider + `✕`, chip height `--control-sm`). The picker opens
  as a popover under the field at md+ (360px wide, max-height 420px,
  `--shadow-overlay`) and as a bottom sheet on mobile (full width, 80dvh,
  focus-trapped, `role="dialog"`, title `METRICS`). Inside: search input
  (autofocus, filters by name/id/description), then groups
  `PROVIDER · CATEGORY · n` (`.label` rows, collapsible, counts of visible
  metrics), then one checkbox row per metric (`--row-h`): name (sm,
  primary), `SrcTag` (`ht`/`cm`/`fng`/`llama`), units (xs, secondary),
  `LAG 1D` (xs) when `lagDays > 0`. Metrics whose `assets[]` excludes the
  typed asset are hidden; a footer line counts them (`3 hidden — not
  available for SOL`). A provider reported unreachable by
  `lab_list_providers` gets a gray StatusDot + `UNREACHABLE` in its group
  header; its metrics stay selectable (the engine warns, never fails).
  At 40 selected, unchecked rows disable. `Esc` closes; selection applies
  live (no OK button).
- `HORIZON`: `Segmented` `7D | 14D | 30D | 60D | …`; `…` reveals a numeric
  input (1–180). Default 14D.
- `OBJECTIVE`: `Segmented` `SHARPE | RETURN`.
- `EFFORT`: `Segmented` `20 | 40 | 100 | 200` (trials) with a 10px
  `text-secondary` hint under it from the last known duration per trial
  (`~10 s · ~25 s · ~60 s · ~2 min`; on Vercel the 200 label adds `capped at
  50 s`, since the deadline will truncate it — say so before, not after).
- `▸ ADVANCED` disclosure (collapsed by default, state remembered per
  browser): `TRANSFORMS` 7 checkbox chips (`raw z rsi ma roc vol pctile`,
  min 1); `WINDOWS` text input `7, 30, 90` (2–365, max 6, validated on
  blur); `LABEL QUANTILE` 0.05–0.5; `FOLDS` 2–6; `MIN SUPPORT` ≥ 5;
  `SLIPPAGE BPS` 0–200; `TOP K` 1–50; `FROM` / `TO` date inputs; `SEED`.
  `customZones` and `price` are not exposed in v1 (CLI/MCP only). An
  amber dot on the `ADVANCED` label when any value differs from default.
- Validation: inline 11px `--color-red-text` under the field (`pick at
  least one metric`, `windows: 400 is above 365`); RUN disabled while any
  field is invalid or asset/metrics are empty — never a dialog.
- `RUN SEARCH`: Neutral, `--control-lg`, full width (the view's primary
  action). Disclaimer line beneath (10px, secondary).

**Busy state** (a search takes 5–50 s; the API is one POST with no
progress stream, so nothing pretends to know progress): RUN reads
`SEARCHING…` with `.pulse-label`, disabled; under it a tabular 11px
elapsed counter `12 s · 40 trials over ~300 features` (elapsed, not
percent — a progress bar would be a lie). Ghost `STOP WAITING` aborts the
fetch client-side; its hint reads `the run still finishes and lands in
RUNS`. Previous results stay at 70% opacity until the new ones land
(§10.4 precedent); no skeleton flash on re-run. The form is read-only while
searching (inputs `disabled`, not hidden).

**ResultsHeader**: run id (first 4 chars, `title` = full), config summary,
`dataRange.from → to`, `HOLDOUT FROM 2025-04-12` (info-toned), feature
count, `trialsRun/trials` (amber + Badge `PARTIAL` when `trialsRun <
trials`), `durationMs` as seconds, AgeStamp of the run, then the rank-key
label. When the run reports it, `N≈312` follows the trials: the deflated
Sharpe's N (`effectiveTrials`, else `variantsScored`), `title` explaining
DSR; absent on older runs. `warnings[]` render in **LabWarnings** directly below: full-width
strip, `--color-amber-bg`, one row per warning, 6px amber square bullet,
verbatim text 11px `text-primary` (sentences, so not the uppercase
StaleBanner idiom).

**ResultsFilters** (one row, wraps on mobile into two): `Segmented`
`ALL | PAIRS | SINGLE` (by `conditions.length`); `Segmented` `IS | WF | HO`
— the **stats window**, which chooses where HIT, MAX DD, TRADES/YR and the
filters read from (default `WF`; the two Sharpe cells on every card ignore
it — rule 1); numeric inputs `MIN SHARPE`, `MAX DD`, `MIN HIT` (blank =
off, applied client-side to the chosen window). Right-aligned count
`12 OF 18 RULES` (xs secondary). Filters persist per browser.

**SignalCard** (one per `RuleEvaluation`, single column, full width; a
`<article>` with `tabindex=0`, Enter → drill):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ #1  z(90) MVRV < −1.12  AND  funding ≥ 0.03%              ● FIRING  [SAVE]│
│     LONG BTC · 14D · PAIR · CM HT · PRECISION 0.71                       │
│ WF SHARPE  HOLDOUT  HIT   MAX DD   TR/YR  SUPPORT  STAB                  │
│ +1.42      +0.97    61%   −18.4%   6.2    212      0.83 STABLE           │
└──────────────────────────────────────────────────────────────────────────┘
```

- Row 1: rank `#1` (xs, secondary) · **RuleText** (lg 16px, primary — the
  hero; wraps to 2 lines on mobile, never truncates) · **FiringBadge**
  (`● FIRING` green Badge when `firingNow`, `○ FLAT` gray otherwise; the
  dot is a text glyph) · ghost `SAVE` (→ drill's save form, pre-focused;
  reads `SAVED ✓`, disabled, when the id is already catalogued).
- Row 2 (xs, secondary): direction (word, green/red text), asset, horizon,
  `PAIR`/`SINGLE`, `SrcTag` per distinct provider in the conditions,
  `PRECISION 0.71`.
- Stat row: 8 mini cells (label xs secondary over value sm primary,
  tabular; `grid-cols-8` lg, `grid-cols-4` mobile → 2 rows), `DSR` third. `WF SHARPE`
  (value at base 13px — the rank key is one step louder) and `HOLDOUT`
  are always adjacent and always both present; `—` when `walkForward`/
  `holdout` is null, with `title` `not enough history`. `HOLDOUT GAP`
  Badge appears after the holdout cell per rule 1. Signed values print
  their sign; Sharpe/return green ≥ 0, red < 0; MAX DD red text below
  −20%. `STAB` prints `0.83` + word: `STABLE` ≥ 0.75, `SOFT` 0.5–0.75
  (amber), `FRAGILE` < 0.5 (red) — absent (`—`) until sensitivity is known.
- **Robustness elements** (shared by SignalCard, RuleDrillHeader,
  WindowStatsTable, CatalogueTable): `DSR` — `deflatedSharpe`, 2 decimals,
  beside WF/HOLDOUT, green ≥ 0.95 (the save bar), amber < 0.5, `—` when
  absent; `title` `probability the walk-forward Sharpe beats what the best
  of N effective trials would reach by luck`. **Verdict Badge** — the
  server's `verdict.level`, never computed client-side: `ROBUST` green,
  `CANDIDATE` amber, `FRAGILE` red, `WEAK` gray, `FAILS HOLDOUT` red;
  `reasons` in the `title`; nothing renders without a verdict. On the card
  it leads row 2. **`untested`** — a window with `PerfStats.untested`
  prints the word `untested` (secondary) instead of `0.00` wherever its
  Sharpe would be, and never raises `HOLDOUT GAP`.
- Hover `--color-hover`; selected (the drill you came back from)
  `--color-selected` + 2px left `--color-red-accent` inset.

**RuleText** formats `rule.conditions` in our language, not the wire text:
metric display name from the catalogue (`MVRV`, `funding`, `F&G`),
transform as `z(90)`, `rsi(14)`, `ma(30)` (ma_ratio), `roc(7)`, `vol(30)`,
`pct(90)`, raw with no prefix; thresholds formatted by `units` (funding
fraction → `0.03%`, USD compact, else 3 significant figures); `≥` and `<`
as typeset glyphs; `AND` in `text-secondary`. The wire `text` lives in the
`title` tooltip and in the drill's `RAW` line so nothing is hidden.

**FeatureImportanceList** (own panel under the cards; desktop right
column, mobile after the cards): top 10 of `featureImportance`, each row
feature (sm, formatted by RuleText rules) + a CSS bar (height 8px, width
`score / max`, fill `--color-selected`, 1px right edge `--color-info`) +
score (xs, tabular). No chart library; color is not the signal, the number
is.

States (search tab): providers/metrics loading → SkeletonRows inside the
picker, RUN disabled; metrics fetch failed → ErrorBlock inside the picker
with `RETRY`; offline → OfflineBlock replaces the tab body; results never
run → EmptyBlock `no results yet — run a search`; search failed → verbatim
ErrorBlock under RUN (`400` with `field` also outlines that input in
`--color-red`); zero rules → EmptyBlock `no rule survived — try more
metrics, a longer horizon or a lower min support`; partial →
`PARTIAL` Badge + LabWarnings; stale → AgeStamp/StaleBanner on `data to`.
On completion one `aria-live="polite"` status line announces
`18 rules · 40 of 40 trials` (the only live region in the view besides
ErrorBlocks).

#### Rule detail `/lab/rules/:id`

Resolution: catalogue entry by id → else `?run=` → `lab_get_run` and find
the rule → else EmptyBlock `rule not found — it was never saved and its run
is unknown` + ghost `SEARCH`. Then `lab_evaluate_rule` (with equity) and
`lab_sensitivity` refresh the numbers; the grid shows SkeletonRows with a
`computing sensitivity…` pulse while the second call runs.

Desktop (`lg:`, 12-col):

```
┌ ← RESULTS ─────────────────────────────────────────────────────────────────┐
│ z(90) MVRV < −1.12 AND funding ≥ 0.03%   (lg 16px)    ● FIRING  LONG BTC 14D│
│ +1.42 (xl, WF SHARPE)   HOLDOUT +0.97   HIT 61%   MAX DD −18.4%   STAB 0.83 │
│ RAW cm:CapMVRVCur|z|90 < -1.12 AND ht:funding|raw|0 >= 0.0003  (xs, secondary)│
├ EQUITY VS HOLD BTC ───────────────────────────── 8 ┬ LATEST VS THRESHOLDS ── 4 ┤
│ legend: — RULE  — HOLD BTC  ▒ HOLDOUT  ┆ SAVED       │ AS OF 2026-10-07        │
│ chart 300px, holdout region shaded from holdoutFrom │ z(90) MVRV −1.31 < −1.12 ✓│
├ DRAWDOWN ────────── MAX DD −18.4% ─────────────── 8 ┤ funding 0.021% ≥ 0.03% ✗ │
│ chart 120px                                         ├ SAVE TO CATALOGUE ──────┤
├ STATS BY WINDOW ──────────────────────────────── 8 ┤ NAME [MVRV deep value  ] │
│          IN-SAMPLE  WALK-FWD  HOLDOUT  LIVE         │ NOTE [                 ] │
│ SHARPE   +1.88      +1.42     +0.97    +0.41        │ [ SAVE TO CATALOGUE ]    │
│ RETURN   +212%      +96%      +31%     +4.2%        ├ SENSITIVITY · 0.83 STABLE┤
│ MAX DD   −14.1%     −18.4%    −22.0%   −6.1%        │ grid (below on mobile)   │
│ HIT      66%        61%       58%      50%          │                          │
│ TR/YR … EXPOSURE … DAYS … RANGE …  HOLD BTC rows    │                          │
└─────────────────────────────────────────────────────┴──────────────────────────┘
```

Mobile order: header → latest values → equity → drawdown → stats table →
sensitivity → save form (the decision follows the evidence).

- **RuleDrillHeader**: RuleText at lg; the walk-forward Sharpe is the
  view's single xl (`AnimatedDigits` on refresh); holdout at base right
  beside it with the gap Badge if due, then `DSR`; the verdict Badge
  before FiringBadge, its `reasons` listed (xs secondary) above `RAW`;
  FiringBadge; direction/asset/horizon
  words; the `RAW` wire text. Catalogued rules add Badge `IN CATALOGUE ·
  SAVED 2026-08-01` and Danger `REMOVE` (Level 2, below).
- **RuleEquityChart** (§9.1 variant): strategy `--color-equity` 1.5px;
  benchmark (`HOLD BTC`, or `SHORT BTC` for short rules) `--color-bench-
  btc` 1px; Y-axis growth multiple (`1.84×`) on a **log scale** (`LOG` at
  the legend's right; non-positive points are gaps); a `ReferenceArea` from
  `dataRange.holdoutFrom` to the end filled `--color-info-bg` with a 10px
  `HOLDOUT` label at its top-left — the one region the search never saw;
  for catalogued rules a 1px dashed vertical reference at `savedAt`
  labeled `SAVED` (the §9.1 `TODAY` idiom). Heights per §4.5 (220/300).
  Legend row above per §4.5.
- **DrawdownChart** §9.2, strategy only; `MAX DD` in the header.
- **WindowStatsTable**: rows TOTAL RETURN, CAGR, SHARPE, MAX DD, HIT RATE,
  TRADES, TRADES/YR, EXPOSURE, DAYS, RANGE (`from → to`, xs); columns
  `IN-SAMPLE · WALK-FWD · HOLDOUT · LIVE`, then two benchmark rows (`HOLD
  BTC SHARPE`, `HOLD BTC RETURN`, in-sample and holdout only — `—`
  elsewhere). `LIVE` is `—` with `title` `not catalogued` for unsaved rules
  and `n/a — 12 live days` under 30 days. This table must keep all four
  windows at every width (rule 1), so it is the §4.4 escape hatch: inside
  `.table-scroll`, first column sticky (`position: sticky; left: 0;
  bg-panel`), numeric columns 72px. Walk-forward header carries `RANK KEY`
  in xs beneath it. Under SHARPE (`untested` per window when due): `DSR`
  (walk-forward column only) and `WF FOLDS` — `walkForwardFolds` as a
  bar sparkline (decoration, green up / red down) + the signed values +
  `not ranked` (xs), spanning from the walk-forward column; each row only
  when the field is present. The drill keeps the search's (or save-time)
  walk-forward, folds, DSR and verdict over the fresh evaluation's N = 1
  values.
- **LatestValuesRow**: one row per condition — feature (RuleText style),
  latest value (sm, tabular, primary), operator, threshold, and `✓` green /
  `✗` gray with the word `MET`/`NOT MET` in `title` and visually-hidden
  text. `AS OF <latest.date>` AgeStamp (2-day threshold). A null value
  prints `—` + `no data` and the row is gray.
- **SensitivityGrid**: per condition, two labelled rows. `THRESHOLD`:
  cells `q−0.10 · q−0.05 · BASE · q+0.05 · q+0.10`; `WINDOW`: one cell per
  swapped window in the config (`w7 · w30 · w90`, base marked). Cell
  content: Sharpe (sm, tabular, signed) over total return (xs). Background
  by `sharpe / base.sharpe`: < 0 → `--color-mom-neg2`; 0–0.5 →
  `--color-mom-neg1`; 0.5–1 → `--color-mom-zero`; ≥ 1 → `--color-mom-pos1`
  (never `pos2`: beating the base is noise, not merit). Base cell gets the
  2px `--color-red-accent` left inset. Panel header prints `STABILITY 0.83
  STABLE` with the SignalCard `STAB` word/tone. A `<table>` with row/column
  headers; each cell `aria-label` `threshold −0.10 quantile: sharpe +1.21`.
  Mobile: cells are 1fr of the panel width (5 across ≈ 70px at 390px).
- **SaveToCatalogueForm** (inline panel, not a dialog): `NAME` input
  (default: RuleText truncated to 40ch), `NOTE` textarea (3 rows), Neutral
  `SAVE TO CATALOGUE` (Level 1; in flight `SAVING…` pulse), verbatim
  ErrorBlock on failure. On success the panel becomes the `IN CATALOGUE`
  stamp + ghost `OPEN CATALOGUE →`; the SEARCH tab's card shows `SAVED ✓`.
- **REMOVE** (catalogued only): Danger, Level 2 ConfirmDialog — title
  `REMOVE RULE`, body `Remove "MVRV deep value"? Its live record since
  2026-08-01 stops here; the rule can be saved again from run 7f3a.`,
  confirm `REMOVE RULE`, cancel focused. On success navigate to
  `/lab/catalogue`.

States: SkeletonRows per panel on first load; ErrorBlock per panel
(sensitivity failing does not blank the chart); EmptyBlock for a missing
rule; AgeStamp/StaleBanner on `latest.date` and `dataRange.to`.

#### CATALOGUE tab

**CatalogueHealthStrip** above the table (from `lab_catalogue_health`):
three counters as ghost toggles — `DECAYED 1 · OVERLAPS 2 · GAPS 3` —
amber text when > 0, gray `0` otherwise. Toggling one expands a list
below: decayed → `name · live 94d · live +0.08 vs holdout +0.97` with a
`DECAYED` amber Badge; overlaps → `name A ↔ name B · J 0.72`; gaps →
`ETH SHORT — no active rule` + ghost `SEARCH →` that opens `/lab/search`
with asset/direction prefilled. Health is computed on request; its
AgeStamp sits in the strip's right edge.

**CatalogueTable** (`DataTable`, row tap → `/lab/rules/:id?from=
catalogue`), §4.4 drop order:

| P1 (always) | P2 (always) | P3 (md+) | P4 (lg) |
|---|---|---|---|
| NAME (verdict Badge beside it, rule text as a 10px second line; cell max 112px mobile, 48ch md+), LIVE SHARPE | WF, HOLDOUT (at save) | FIRING, HEALTH, DIR·HZN | LIVE DAYS, SAVED, ORIGIN |

`LIVE SHARPE` is the column that answers "is it still working": signed,
colored, `—` + `title` `n live days` under 30. `HOLDOUT` and `WF` are the
numbers at save time, printed as a pair (rule 1). `HEALTH` cell: Badges
`DECAYED` (amber), `OVERLAP` (gray, `title` names the partner), or `—`.
`ORIGIN`: `user`/`agent`/`seed` as gray Badge — rules an MCP agent saved
are marked so. Default sort LIVE SHARPE desc; sortable headers. Per-row
Danger `REMOVE` at lg only (mobile removes from the drill). Header:
`CATALOGUE · 7` + `RANKED BY LIVE SHARPE` label (a different rank key than
search — said aloud) + disclaimer footer.

States: SkeletonRows; EmptyBlock `no saved rules — search, then SAVE one`
+ ghost `SEARCH`; ErrorBlock; health failing → the strip shows an
ErrorBlock, the table still renders; StaleBanner on live `to` > 2 days.

#### PULSE tab

**PulseBoard** (from `lab_market_pulse`): header `MARKET PULSE` + AgeStamp
on `asOf` + `LabWarnings` when any. One **PulseAssetRow** per asset,
sorted by |lean| desc:

```
│ BTC   ◀━━━━━━━┿━━━━━━━▶  LEAN +0.33   LONG 2/3 · SHORT 0/2        ▸ │
│   ▸ expanded: ● MVRV deep value   LONG   z(90) MVRV < −1.12 AND …    │
│               ○ Funding squeeze   SHORT  pct(30) funding ≥ 0.9       │
```

- **LeanBar**: 120px × 8px (full width on mobile, max 200px), 1px
  `--color-border` center tick; fill grows from the center, right
  `--color-green` for lean > 0, left `--color-red` for lean < 0, width
  `|lean| × 50%`. The number `LEAN +0.33` (sm, signed, colored) always
  prints beside it; 0 prints `LEAN 0.00` gray.
- Counts `LONG 2/3 · SHORT 0/2` (xs; active over total, `text-primary`
  numerator when active > 0).
- Chevron toggles the rule list (rows at `--row-h`): FiringBadge dot,
  name (sm), direction word (green/red), RuleText (xs, secondary, one
  line, ellipsis). Row tap → `/lab/rules/:id?from=pulse`.
- Mobile: asset + LeanBar on line 1, counts + chevron on line 2.

States: SkeletonRows; EmptyBlock `no catalogued rules — nothing to
pulse` + ghost `SEARCH`; ErrorBlock; StaleBanner when `asOf` > 2 days.

**PulseTile** (Overview `/`, optional, describe-only): a card under SECTOR
HEAT in the 5-col column (mobile: after Sector heat) — header `LAB PULSE`
+ AgeStamp; up to 4 assets, each `BTC` + 80px LeanBar + `+0.33`; footer
ghost `LAB →` to `/lab/pulse`. EmptyBlock `no rules catalogued` when
empty. Not rendered at all if `lab_market_pulse` is unreachable (Overview
stays a 30-second read; no error noise from an optional tile).

#### RUNS tab

**RunsTable** (`DataTable`, `lab_list_runs`, newest first, row tap →
`/lab/runs/:runId`): P1 `STARTED` (relative + `title` ISO), `ASSET·DIR·HZN`;
P2 `BEST WF SHARPE` (signed), `RULES`; P3 `TRIALS` (`31/40` amber when
partial), `STATUS` Badge (`OK` gray, `PARTIAL` amber, `FAILED` red,
`RUNNING` pulse); P4 `METRICS n`, `DURATION`, `SOURCE` (`ui`/`mcp`/`cli`
gray Badge). States: SkeletonRows; EmptyBlock `no runs yet`; ErrorBlock.
A failed run opens with its verbatim error in the results area and the
config loaded for correction.

#### Keyboard and a11y (view-specific, on top of §12)

- `LabTabs` is the §15 `Segmented` radiogroup (arrows move, Enter not
  needed). Tab order on SEARCH: form fields → RUN → filters → cards →
  importance list.
- `SignalCard` `tabindex=0`, Enter/Space → drill; the card's `SAVE` is its
  own stop. Cards are an `<ol>` so the rank is announced.
- MetricPicker: `Esc` closes and restores focus to the trigger; the
  bottom sheet traps focus; checkbox rows are real `<input type=
  checkbox>` with the metric name as label; group headers are buttons
  with `aria-expanded`.
- Tables are real `<table>`s; the sticky first column keeps its `<th
  scope="row">`. Sensitivity cells carry `aria-label`s (above).
- Color never alone: direction words, `✓/✗` with hidden text, Badge words
  on every tinted cell, printed numbers in every ramp cell.
- `prefers-reduced-motion`: the elapsed counter still ticks (it is
  content), the pulse becomes `…`.

---

## 11. Component inventory

Every reusable component the UI workers build, under `src/ui/components/`.
Ported components keep their Hyperion source semantics (files:
`hyperion/dashboard/src/components/ui/*.tsx`) with only the changes noted.

**Primitives (port from Hyperion, adjust as noted)**

| Component | Props | Notes |
|---|---|---|
| `Panel`, `PanelHeader`, `PanelBody` | as Hyperion | verbatim port |
| `Button` | `tier: 'ghost'\|'neutral'\|'danger'`, native button props | tiers per §3; money/arm removed; heights from density vars |
| `Badge` | `tone: 'green'\|'red'\|'amber'\|'info'\|'gray'`, `variant?: 'solid'\|'outline'` | verbatim port |
| `StatusDot` | `status: 'ok'\|'degraded'\|'down'\|'unknown'` | verbatim port |
| `SkeletonRows` | `rows?`, `colSpan?` | verbatim port |
| `EmptyBlock` | `label`, `action?: {label, onClick}` | verbatim port |
| `OfflineBlock` | `title?`, `message?` | default copy → `API UNREACHABLE` |
| `ErrorBlock` | `message`, `onRetry?` | verbatim port |
| `AnimatedDigits` | `value: string` | port from Hyperion |

**New shared components**

| Component | Props | Spec |
|---|---|---|
| `AppShell` | `children` | TopBar ≥768 / TopStrip + BottomTabBar <768 (§5); freshness cluster; route guard redirect |
| `StaleBanner` | `generatedAt: string`, `thresholdHours: number`, `noun: string` | §6; renders nothing under threshold |
| `AgeStamp` | `generatedAt: string`, `thresholdHours: number` | §6; xs, gray→amber; `title` = full timestamp |
| `SrcTag` | `source: 'hl'\|'cg'\|'fred'\|'routine'\|'ht'\|'cm'\|'fng'\|'llama'` | §2 `.src-tag`; `hl` gets jade; the four lab providers (§10.9) render gray like `cg` |
| `LabWarnings` | `warnings: string[]` | §10.9; amber-bg strip, one verbatim 11px `text-primary` row per warning with a 6px amber square; renders nothing when empty |
| `LeanBar` | `lean: number` (−1..1), `width?: number` | §10.9 Pulse; bipolar fill from a center tick, green right / red left, always paired with the printed signed number by its caller |
| `RuleText` | `rule: Rule`, `metrics: MetricDef[]`, `size?: 'xs'\|'sm'\|'lg'` | §10.9; conditions typeset in our language (`z(90) MVRV < −1.12 AND funding ≥ 0.03%`); wire text in `title` |
| `FiringBadge` | `firing: boolean` | §10.9; `● FIRING` green / `○ FLAT` gray Badge, glyph + word |
| `ConfirmDialog` | `title`, `body`, `confirmLabel`, `onConfirm`, `onCancel`, `error?` | §7 Level 2; centered lg / bottom sheet mobile; focus trap; stays open on error |
| `DataTable` | `columns: {key, label, priority: 1\|2\|3\|4, align, render}[]`, `rows`, `onRowClick?`, `sortable?` | §4.4 priority hiding via `hidden md:table-cell`/`hidden lg:table-cell`; row height `var(--row-h)`; focusable rows |
| `MetricStat` | `label`, `value`, `delta?`, `z30?`, `unit?` | §10.2 cell |
| `MomentumBadge` | `momentum: number` | §3; bucket thresholds ±0.15/±0.5 |
| `Sparkline` | `points: number[]`, `height?` | §4.5; white 1px, no axes, no tooltip |
| `LegendRow` | `items: {swatch: string, label: string, dashed?: boolean}[]` | §4.5 chart legend |
| `ChartTooltip` | Recharts tooltip props | dark panel style, tap-to-pin on touch |

**Chart components** (each wraps ResponsiveContainer + breakpoint height)

| Component | Props | Spec |
|---|---|---|
| `EquityChart` | `history: {ts, equity, btcHodl, usdc}[]`, `projection?: {ts, p10, p50, p90}[]` | §9.1 + §9.3, TODAY divider |
| `DrawdownChart` | `points: {ts, ddPct}[]`, `maxDd: number` | §9.2 |
| `MarketChart` | `coin`, `tf`, `onTfChange` (fetches its own pages) | §9.4, lightweight-charts |
| `MetricSeriesChart` | `points: {ts, value}[]`, `mean30?: number` | §9.5 |
| `RuleEquityChart` | `equity: {t, strategy, benchmark}[]`, `holdoutFrom: string`, `savedAt?: string`, `benchmarkLabel: string` | §10.9 rule drill; §9.1 geometry, growth-multiple axis, holdout `ReferenceArea` in `--color-info-bg`, dashed `SAVED` reference |

**View-scoped components** (built per §10, live next to their route)

`LoginForm`; `MetricsStrip`; `MarketStateCard`; `SectorHeatCard`;
`BranchesCard`; `BranchConfigPanel` (containing `AllocationEditor`,
`RebalanceSelect`, `ScenarioEditor`); `StatsPanel`; `MindshareGrid` (+
`SectorCell`); `RotationsPanel`; `SectorDrillPanel`; `ThesisBlock`;
`DomainCard` (+ `SignalRow`); `RisksList`; `HistoryStepper`;
`TriggerRoutineButton`; `MarketsTable`; `MarketDrillHeader`.

Lab (§10.9, under `src/ui/components/lab/`): `LabTabs`; `LabSearchForm`
(+ `MetricPicker`, `AdvancedDisclosure`, `SearchSummaryBar`);
`ResultsHeader`; `ResultsFilters`; `SignalCard`; `FeatureImportanceList`;
`RuleDrill` (+ `RuleDrillHeader`, `WindowStatsTable`, `SensitivityGrid`,
`LatestValuesRow`, `SaveToCatalogueForm`); `CatalogueHealthStrip`;
`CatalogueTable`; `PulseBoard` (+ `PulseAssetRow`); `PulseTile` (Overview,
optional); `RunsTable`.

---

## 12. Accessibility floor

Non-negotiable, verified before done:

1. **Focus visibility**: the §2 global ring on every interactive element;
   never `outline: none` without it.
2. **Hit targets**: `var(--tap-min)` effective minimum — 24px fine pointer,
   44px coarse. Tab bar cells, table rows, chips all comply via the density
   variables.
3. **Color never the sole signal**: signs, glyphs, and printed numbers
   accompany every green/red/momentum hue (§2.1, §3, §10.5).
4. **Contrast**: §2.1 rules. `text-secondary` never carries values, errors,
   or briefing copy.
5. **Live regions**: ErrorBlocks `role="alert"`; the freshness cluster and
   tick-flashing price cells are explicitly NOT live regions.
6. **Reduced motion**: §8, one global query.
7. **Forms**: visible `.label` on every input; dialogs `role="dialog"
   aria-modal="true"` with labeled titles; the bottom tab bar is a `<nav>`
   with `aria-current="page"` on the active link.
8. **Zoom**: layouts must survive 200% browser zoom (the mobile layout IS
   the 200%-zoom desktop layout — test it that way).

---

## 13. State → view matrix

| Surface | Loading | Empty | Error | Stale |
|---|---|---|---|---|
| Metrics strip | SkeletonRows | — | ErrorBlock | StaleBanner > 2h + shell dot |
| MarketState card / view | SkeletonRows | EmptyBlock (`no briefing yet`) | ErrorBlock | StaleBanner > 24h + AgeStamp |
| Sector grid / drill | SkeletonRows | EmptyBlock (`no sector data yet`) | ErrorBlock | StaleBanner > 24h + AgeStamp |
| Branches list | SkeletonRows | EmptyBlock + `NEW BRANCH` | ErrorBlock | — |
| Branch results | SkeletonRows (first run) | EmptyBlock (`not simulated yet`) | verbatim ErrorBlock | `COMPUTED <ts>` stamp |
| Markets table | SkeletonRows | EmptyBlock (filter miss) | ErrorBlock | StaleBanner > 5min |
| Market chart | SkeletonRows + `backfilling candles…` | EmptyBlock (`no candle data`) | ErrorBlock / OfflineBlock | footnote `sync: <error>` (amber) |
| Perp header | SkeletonRows | — | ErrorBlock | `LIVE` badge, else AgeStamp > 5min |
| Login | — | — | ErrorBlock (verbatim 401) | — |
| Lab search form | SkeletonRows in MetricPicker, RUN disabled | — | ErrorBlock in picker; verbatim ErrorBlock under RUN (field outlined) | — |
| Lab results | `SEARCHING…` pulse + elapsed counter, previous results at 70% | EmptyBlock (`no results yet` / `no rule survived`) | ErrorBlock / OfflineBlock | AgeStamp `data to` > 2d + StaleBanner; `PARTIAL` Badge + LabWarnings |
| Rule drill | SkeletonRows per panel, `computing sensitivity…` pulse | EmptyBlock (`rule not found`) | ErrorBlock per panel | AgeStamp on `latest.date` and `data to` |
| Catalogue | SkeletonRows | EmptyBlock (`no saved rules`) + `SEARCH` | ErrorBlock (health strip fails independently) | StaleBanner live `to` > 2d; `DECAYED` Badges |
| Market Pulse / tile | SkeletonRows | EmptyBlock (`no catalogued rules`) | ErrorBlock (tile: not rendered) | StaleBanner `asOf` > 2d + LabWarnings |
| Runs | SkeletonRows | EmptyBlock (`no runs yet`) | ErrorBlock | `PARTIAL`/`FAILED` Badges |

Every cell above is one of the §6 named patterns — no bespoke states.

---

## 14. Deliberate departures from Hyperion (summary)

1. Body scrolls; the fixed-viewport grid and react-grid-layout are gone.
2. Money/Arm button tiers and Level-3 typed confirmations removed — no
   execution paths exist. Danger tier added for branch deletion.
3. StaleChip (socket seconds-counter) replaced by StaleBanner + AgeStamp
   (routine/collector data ages in hours, not seconds).
4. No command palette, no chat drawer, no bottom ticker — five routes, a
   tab bar, and a freshness dot carry the shell.
5. Density scale becomes CSS variables with a `pointer: coarse` override —
   the single mechanism that makes every ported component touch-safe.
6. DirectionChip dropped; MomentumBadge added.
7. New tokens: momentum ramp (5), projection/benchmark colors (7),
   `--color-src-hl`. All documented in §2; nothing existing changed value
   or meaning.

---

## 15. Themes

Hyperdash is the default look; Hyperion, as specified above, stays the
reference for meaning (state vocabulary, confirmation levels, motion,
responsive contract) and remains selectable. Every look is a theme that
overrides tokens only, never behavior. The top bar's segmented toggle
switches between them. The
token contract, the structural hook classes a theme may style, and the steps
to add one live in `src/ui/themes/README.md`.

| Theme | Source design system |
|---|---|
| Hyperdash (default) | `design-systems/hyperdash/DESIGN.md` |
| Trade[XYZ] | `design-systems/tradexyz/DESIGN.md` |
| Hyperion | this document |

One-of-N choices (timeframes, modes, enums, on/off) use the `Segmented`
component, never ad-hoc button rows.

Under any theme the binding rules still hold: color is never the only
signal (§2.1), projections never wear green/red (§1.6), and every
API-backed surface keeps its §6 states.
