# Hyperdash design system, adapted for HYPERTRADE

Extracted 2026-09-30 from **hyperdash.com**. The live site sets `data-theme="covert"` on `<html>`. Sources:

- `assets/globals-CE-9bAlf.css` (Tailwind v4 build, 440 KB): the full palette, the per-theme blocks (`covert`, `stealth`, `tactical`, `radar`, `overcast`, `dune`), the `hd-*` component classes and the font-faces.
- `tradingview-custom-covert.css`: chart chrome values.
- Class-frequency analysis of the rendered homepage DOM.
- 21 screenshots (1600×1000 desktop, 360×800 mobile).

HYPERTRADE files:

- Theme file: `src/ui/themes/hyperdash.css`
- Raw tokens: `tokens.json` (W3C format)
- Theme id: `hyperdash`, scheme `dark`
- Web font: `https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@300..700&display=swap`. It substitutes for BDO Grotesk, which is free from VJ-Type/uncut.wtf but is not served by Google Fonts. Geist Mono is already bundled.

> Hyperion, HYPERTRADE's default theme, is historically derived from the older Hyperdash `dark` theme. It shares the warm gray ramp: #100e0a, #191613, #928d86, #d5d1cd, plus #38a67c and #bc263e. This theme therefore targets what Hyperdash looks like **today**:
> - a lifted base (#141210)
> - brighter PnL foregrounds (#5cc09b / #d44b62)
> - an orange `#fd4612` filled primary
> - 4px corners
> - a grotesk for text and numbers
> - Geist Mono reserved for UPPERCASE UI
> - looser density

---

## 1. Page inventory

| # | URL visited | Page type | Layout |
|---|---|---|---|
| 1 | `/` | Trading terminal | Workspace tabs strip ("1 STARTER 2 NEWS +"). Main area: chart widget (asset selector, stat strip, TradingView candles + volume) \| orderbook column (~300px) \| order-entry rail (~300px). Bottom dock tabs: Positions / Open Orders / TWAP / History / **Top Traders** / Cohorts / Position Changes, holding a wide table. Ticker footer bar. |
| 2 | `/markets` | Markets hub | Container max ≈1480px with 36px margins. H1 30px + lead 16px. 12-col split: featured-asset card (stat strip 7 cols → line chart → 8-cell period-return strip) \| right rail "Create watchlist" (asset rows with icon, name/ticker, price, Δ%). Below: TradFi / Crypto 24h **treemap heatmaps**, then a "Global indices" list with sparklines. |
| 3 | `/markets/trending-assets` | Market section | Breadcrumb, H1 24px + lead. Stat strip (4) + % line chart \| right rail "Cohort bias" (6 cohort rows with sentiment pill and long/short split bar). "15 Trending assets" grid of 5-col asset cards (ticker, name, icon, sparkline area). Search / sort / grid-list toggle. |
| 4 | `/markets/commodities` | Market section (2nd sample) | Identical template to #3. |
| 5 | `/asset/BTC` | Asset detail | Breadcrumb. Hero: 64px icon, name, 20px price, Δ line. Main column: stat strip (7) → chart → period strip (8). Right rail 340px: promo card (orange-15 fill), "Cohort bias" list, "Overview" key/value list. Below: "Key Trades" with two tables (Biggest PNLs Winners/Losers segmented, Biggest open positions Long/Short), FAQ accordion (2-col), "Explore more markets" pill chips (icon + ticker + Δ% + ▲/▼). Footer disclaimer. |
| 6 | `/asset/HYPE` | Asset detail (2nd sample) | Same template, full page captured. |
| 7 | `/explore/cohorts` | Explore index | Left sidebar 288px: DISCOVER / TRACK groups, nav items with icon + title + subtitle + sentiment pill, active item gets a raised fill. Main: "All-Time PNL" and "Account Size" sections, each a 4-col grid of cohort cards (icon, name, range, sentiment pill, wallet count, sparkline with a vertical "now" marker, long/short split bar with $ values). |
| 8 | `/explore/cohorts/whale` | Cohort detail | Sidebar + main. Header card (name + sentiment pill). Two meter bars: Unrealized PnL (in profit / in loss) and Notional (long / short). Split row: "Whale Positioning" area chart (% long, 24H/7D/30D toggle, red/green hatched fill) \| **treemap** of assets by UPnL. Tab strip WALLETS 804 / MARKETS 297 → wallets table. |
| 9 | `/explore/cohorts/rekt` | Cohort detail (2nd) | Same. |
| 10 | `/explore/cohorts/apex` (mobile 360) | Cohort detail, mobile | Hamburger + wordmark + search/lang/CTA. Sidebar hidden. Stacked: header card → meters → chart → treemap → tabs. |
| 11 | `/explore/leaderboard` | Leaderboard | H1 24px + lead. Filter row: category text-tabs (Overall/Equities/…), period segmented (24H/7D/30D/YTD/All Time), $/% toggle, filter icon, search. Chip dropdowns (All assets ⌄, Account Value ⌄ …). **Podium**: 3 cards with rank medallion (gold/silver/bronze laurel), PnL, Acc. value, hatched area chart. Then ranked table. |
| 12 | `/explore/tagged` | Known traders | Sidebar + full-width table: avatar + name + X/track/copy/snoop icons, equity + inline sparkline, PnL (30D), traded-asset icon stack, copy score (number + 10-segment meter), Copytrade (green) / Countertrade (rose) button. |
| 13 | `/explore/global` | All traders | Same as #12 with a chip-dropdown filter bar. |
| 14 | `/copytrading` | Copytrade marketplace | Hero H1 24px with an orange accent phrase + floating preview cards. Category text-tabs + sort select + $/% + grid/list. Chip filters. 4-col trader cards: header (avatar, address, asset icons, age), ROI 30D + equity + area chart, green-tinted footer with score meter + "Copytrade" button. |
| 15 | `/address/0x9c70…89d9` | Trader profile | Breadcrumb bar. Left rail 280px: identity card (avatar, address, copy, share), Track/Snoop buttons, affiliate promo (orange-15), copytrading score card (green-15 tint) with Copytrade button, then key/value sections (ACCOUNT VALUE 22px, ACCOUNT EQUITY, OVERVIEW, ANALYSIS, PERFORMANCE 30D). Centre: 2×2 metric cards (Performance with win/loss square strip, Leverage with yellow meter, Margin Usage meter, Direction Bias split meter). PnL chart with PERPS/COMBINED/CALENDAR tabs + PNL/VALUE + period. Bottom tab strip POSITIONS 3 / BALANCES / … / PERFORMANCE → positions table. Right rail 320px: "Recent Activity" feed with LIVE dot. |
| 16 | `/address/0xa91a…42e5` | Trader profile (2nd, full page) | Same. Shows the negative variant: rose-tinted score card with a "Countertrade" button. |
| 17 | `/learn` | Blog index | Different shell: top bar with TRADE/EXPLORE/LEARN, theme toggle and a "Start Trading" CTA. Hero: 56px article title + mono uppercase date/byline (tracking 0.2em) + "READ MORE ↗". Sections of 4-col illustrated cards. |
| 18 | `/learn/what-is-open-interest…` | Article | Breadcrumb, 56px title, full-bleed hero image, prose column. |
| 19 | `/rfq` | Marketing landing | Centered 1440 container, 40px H1, orange CTA, device mock. |
| 20 | `/does-not-exist` | 404 | Centred: mono "404" (tracking 0.2em), wordmark, "Page Not Found" 24px, orange "Return Home". |
| 21 | `/markets` (mobile 360) | Markets, mobile | Single column. Stat strip scrolls horizontally inside its card. Period strip scrolls. |

Discovered but not opened:

- `/explore/copytraders` (sidebar "Copytrading")
- `/leaderboard` (top nav, same as #11)
- `/copytrade` (the same page as `/copytrading`)
- Further `/markets/<section>` routes: ai-infrastructure, recently-listed, fx-majors, magnificent-seven, top-traders-long, korea-market-pulse, profitable-assets, largest-open-positions, global-indices. All use the #3 template.
- `/?chart1=<asset>` and `/?snoop=<addr>` (terminal deep links)
- About 90 `/learn/<slug>` articles (#18 template)

**Global chrome, all app pages:**

- 54px top bar on `base` with a 4% bottom hairline:
  - wordmark `HYPERDASH▮` (orange rectangle)
  - Geist Mono uppercase nav at 12px/500: TRADE, EXPLORE, COPYTRADE, LEADERBOARD, plus an "RFQ NEW" outlined pill
  - right side: search field "Search… ⌘K", language icon button, orange "Get started"
- 30px footer ticker: "● Connected" status, then asset chips with price and ▲.
- Every chart carries a centred `HYPERDASH▮` watermark at about 8% white.

### Hyperdash → HYPERTRADE page mapping

| HYPERTRADE page | Closest Hyperdash page | Adaptation |
|---|---|---|
| **Overview** | Terminal `/` + cohort index | Top row: MetricStat strip styled like the asset stat strip (mono caps label over a 14–16px grotesk value). 12-col grid: MARKETSTATE + BRANCHES + ENGINE panels on the left (8 cols), SECTOR HEAT (MindshareGrid treemap) on the right (4 cols), mirroring the cohort detail split. Panels use 4px corners with 40px headers. |
| **Markets** | `/markets` watchlist rail + `/explore/global` table | DataTable in a panel. Sticky 10px sans caps header on the panel fill. 32px rows with 4% hairlines. Asset cell = icon + ticker + name. Δ% coloured with a ▲/▼ glyph. |
| **MarketDrill** | `/asset/<SYM>` | Breadcrumb → hero (name, price, Δ) → stat strip (MetricStat row) → CandleChart panel → period-return strip (8 equal cells, mono caps label over a coloured %). Right rail for context (cohort-bias style list = sector/momentum). |
| **Branches** | `/explore/global`, `/explore/tagged` | Table with an inline Sparkline column after equity, PnL coloured, row hover = surface-hover. |
| **BranchDetail** | `/address/<0x>` | 12-col: left rail (3 cols) with key/value sections under mono caps headings; centre (9 cols) 2×2 metric cards (Performance, Leverage meter, Margin usage meter, Direction split meter) → EquityChart panel with PERPS-style sub-tabs → positions table. ConfirmDialog stays a panel over the scrim. |
| **Sectors** | Cohort detail treemap + cohort index cards | MindshareGrid = Hyperdash treemap. Cells fill with the heatmap ramp (`--color-mom-*`), white text: icon + name 13px, signed value + sentiment word 12px. RotationsPanel = the "Cohort bias" list pattern (row: name + pill + split bar). |
| **State** | `/learn` article + asset "Overview" rail | 22px headline in grotesk. Briefing prose in `text-muted`. RISKS panel as a key/value list with mono caps keys. |
| **Strategies / Decisions / Governor** | `/explore/leaderboard` + address tab strip | EngineTabs = Hyperdash `hd-tabs-nav-trigger` (12px mono caps, orange 2px rule). Tables use the leaderboard row spec. Governor gauges use the Hyperdash meter bars. |
| **StrategyDetail / DecisionDetail** | Address profile | Same left-rail + centre composition as BranchDetail. ProbBar/NoulBar = the 3px rounded split bar. ScoreRubric = the copy-score segmented meter. |
| **Analyst** | Terminal side panel / Learn prose | Chat transcript in grotesk 12–13px `text-muted`, speaker labels in mono caps, input = `hd-input` (36px, input-surface, 4px). |
| **Login** | 404 page | Centred panel: wordmark with orange rectangle, mono caps label, 36px input, full-width orange primary. |

---

## 2. Foundations

### 2.1 Color

**Neutral ramp** (warm sand-grey, "gray"):

| step | hex | role (covert) |
|---|---|---|
| 1 / 1b / 1c / 2 | #f7f6f5 / #f3f2f1 / #efedec / #e5e3e1 | light themes |
| 3 | **#d5d1cd** | `fg-secondary`: prose, hover text |
| 4 / 5 | #c7c2b9 / #b8b0a4 | quaternary button fg |
| 7 | **#928d86** | `fg-tertiary`: labels, headers, inactive nav |
| 8 | #827d76 | |
| 9 | #726e68 | `fg-quaternary`: hints (3.6:1, not for body) |
| 10–12 | #524f4a / #42403c / #33312f | TV scrollbar, pressed |
| 13 | **#262422** | `bg-tooltip`, `surface-hover`, dividers in TV |
| 13b | **#1d1a18** | `raised` |
| 14 | **#191613** | `subtle`: panels |
| 15 | **#141210** | `base`: page (covert) |
| 16 | #100e0a | `base` in the legacy "dark" theme (= Hyperion body) |

**Alpha overlays:**

- White alphas are used for all hairlines and inputs: 1=2%, 2=4%, 3=6%, 4=8%, 5=12%, 6=16%, 7=24%, 8=32%, 9=40%, 10=48%, 12=64%.
- Black alphas are used for shadows and scrims, up to 13 = 72%.

**Semantic mapping (covert):**

| role | token | value |
|---|---|---|
| page | base | #141210 |
| panel/card | subtle | #191613 |
| raised/chip | raised | #1d1a18 |
| tooltip/hover | bg-tooltip / surface-hover | #262422 |
| input fill | input-surface | white 4% (≈#1d1b1a on subtle) |
| border-subtle / border / border-strong | white 4% / 8% / 16% | |
| text | primary / secondary / tertiary / quaternary / disabled | #fff / #d5d1cd / #928d86 / #726e68 / white 24% |
| accent | btn-primary-bg / fg-accent / border-accent | #fd4612 / #ed3602 / #ed3602 |
| up | fg-green | #5cc09b (8.1:1 on subtle) |
| down | fg-red | #d44b62 (4.3:1 on subtle, so HYPERTRADE uses rose-6 #da6479 at 5.2:1 for red text) |
| warn | fg-yellow | #ffd230 |
| info | fg-blue | #5897d7; cobalt #63b0cc for alternative series |
| snoop | purple | #8258d7 / bg #290f54 |
| chart up/down | chart-green / chart-red | #38a67c / #bc263e |
| heatmap | green 10→14, rose 10→14 | #318d6a…#153328 / #a02236…#391017 |
| tinted fills | fill-green-strong / fill-red-strong | #153328 / #391017 |
| rank | gold / silver / bronze | #ffd700 / #c0c0c0 / #cd7f32 |

**Brand orange ramp:** #fff3ef, #ffdad0, #fec1b0, #fea890, #fe9071, #fd7751, #fd5e32 (hover), **#fd4612** (primary), **#ed3602** (text/link), #cd2e02, #ae2702, #8e2001, #6e1901 (disabled), #4f1201, #2f0b00 (promo fill), #100400.

Full green, rose, yellow, blue, cobalt, teal and purple 16-step ramps are in `tokens.json`.

**Chart series in use:**

- PnL area: `chart-green` above zero / `chart-red` below zero, with a diagonal-hatch fill at about 30% under the line.
- Price line: #5cc09b when up, #d44b62 when down.
- Volume bars: chart-green / chart-red at about 70%.
- Last-price label: a solid chip in the series colour with white text.
- Dotted price line in the series colour.
- Candles: vertical gradient bodies, `linear-gradient(180deg,#72c0a2,#38a67c 34%,#38a67c 72%,#43ab84)` and the red analogue.

**Other rules:**

- Other semantic colours: warn/leverage = yellow, informational = blue/cobalt.
- Treemap cells use heatmap green 11–13 and rose 11–13.
- Color is never the only signal. Hyperdash pairs sentiment colour with a word and an arrow ("Bullish ↗", "Bearish ↘"). Price changes carry ▲/▼ and a sign.

### 2.2 Typography

| family | use | weights shipped |
|---|---|---|
| **BDO Grotesk** (`--font-family-hd-sans`, also `hd-numbers`) | all sentence-case UI, headings, **all numbers** (tabular via `tabular-nums`) | 300–900 (`font-display: optional`) |
| **Geist Mono** (`hd-mono`) | UPPERCASE UI only: top nav, tab triggers, stat labels, section eyebrows, mini tags, activity sub-lines | 500 only |
| PP Editorial / PP Supply / Suisse / GT America | marketing pages only | – |

**Rule of thumb:** if it is uppercase, it is Geist Mono 11–12px/500 with slightly negative tracking (−0.01 to −0.02em). Otherwise it is BDO Grotesk.

**Size scale (px, by DOM frequency):**

| px | use | frequency |
|---|---|---|
| 7–8 | icon captions | 28× |
| 9 | eyebrow caps, semibold, 0.08em | 48× |
| 10 | table header | 11× |
| 11 | table cells, mono labels | 139× |
| **12** | body, nav, tabs, buttons, inputs | 164× |
| 13 | panel titles "Performance", "Cohort bias" (medium) | 10× |
| 14 | asset names in lists, hero name | – |
| 16 | lead text | – |
| 18 | `text-lg` | – |
| 20 | hero price | – |
| 22 | account value, PnL figures | – |
| 24 | explore H1 | – |
| 30 | markets H1 | – |
| 40 / 56 | marketing and learn heroes | – |

- Line heights: mono 1.27 (14px on 11px), controls 1.33, table 1.4, body 1.5. Fixed 11 / 13 / 14 / 16px leadings are used in dense rows.
- Weights: 400 for values and body, **500 for almost all UI** (349×), 600 for eyebrows and emphasised numbers (157×), 700 for the wordmark.
- Tracking:
  - sans values +0.01em, table cells +0.02em
  - table headers −0.01em
  - mono labels −0.02em
  - eyebrow caps +0.08em
  - learn hero date/byline +0.2em
- Numbers use grotesk tabular figures. Signs are always explicit (`+$78,116.26`, `-0.73%`). Units are abbreviated with 1–2 decimals (`$1.45B`, `$13.18M`, `$2.8K`). Leverage uses `4.21×` (real multiplication sign).

### 2.3 Spacing

The base unit is 4px (Tailwind `--spacing: .25rem`).

- Most common gaps: 6px (596×), then 4px, 8px, 12px.
- Horizontal padding: 12px (px-3) and 10px (px-2.5). Vertical padding: 6px (py-1.5).
- Panel inner padding is 12px. Page margins are 8–12px in the terminal and explore shell, 36px on markets pages.
- The inter-panel gap is 8px in the terminal and profile, 12–16px in marketing grids.
- Sidebar is 288px; right rails are 300–340px.

### 2.4 Radii

| px | use |
|---|---|
| 1 | meter segments |
| 2 | tags, badges, sentiment pills, mini inputs |
| **4** | panels, buttons, inputs, icon buttons: the default |
| **6** | segmented tabs (`hd-tabs-tertiary`) |
| **8** | cards: trader cards, cohort cards, asset cards |
| full | avatars, dots, 3px split bars, sliders |

### 2.5 Borders, shadows, elevation

**Elevation** comes from fill steps (base → subtle → raised → tooltip) plus hairlines, never drop shadows:

- Panels: `1px solid white/4%` + `shadow-elevate-panel: 0 0 0 1px black/8%`.
- Secondary cards: border white/8% plus a matching outline.
- Tertiary cards: border white/16% on raised.

**Skeuomorphic controls:**

- Primary button: `box-shadow: 0 0 0 1px black/16%` + an inner 1px gradient border from white 32% (top) to white 4% (bottom).
- Chips: `0 0 0 1px shadow-elevate-element, inset 0 1px 0 white/4%, inset 0 -1px 0 black/16%`.

**Other surfaces:**

- Interactive cards on hover: `0 0 10px #3535394d` + border `#353539`.
- Modal: subtle fill over a black/72% scrim, which fades in over 1000ms. Content scales from 0.95 to 1.
- Focus: `outline: 1px solid border-strong; outline-offset: -1px`. The focus ring colour is transparent. HYPERTRADE keeps a more visible white/64% ring.

### 2.6 Motion

| duration | use |
|---|---|
| 150ms | default: buttons, inputs, hovers |
| 200ms | cards, nav colour |
| 300ms | tab indicator slide, meter bar widths, `fade-in` |
| 1000ms | backdrop |

- Easings:
  - `cubic-bezier(.4,0,.2,1)` is the standard.
  - `(.4,.36,0,1)` is used for tab indicators.
  - `(.32,.72,0,1)` is used for drawers.
  - `(.645,.045,.355,1)` is used for column resize.
- Press feedback is `scale(.98)`.
- Skeleton: `animate-pulse` (2s) on `surface-active` (white 6%) bars with rounded corners.
- Live data: row flash with `fill-accent-subtle` fading out (`news-row-flash`), a `spark-ping` LIVE dot, and a marquee ticker.
- Everything respects `prefers-reduced-motion`.

### 2.7 Iconography

- Outline icons, 16px (tabs) and 14px (inline), 1.25–1.5px stroke (Lucide-like).
- Row actions show 3 muted icons after an address: track (crosshair), copy, snoop (glasses).
- Market icons are 16–24px circular logos. Cohort icons are custom glyphs (crown, diamond, money-bag, ghost, flame, skull; octopus, whale, shark, fish, minnow).
- Directional glyphs ↗ ↘ ▲ ▼ always accompany sentiment and change.
- The wordmark square is a solid orange rectangle about 0.55×0.8em.

### 2.8 Breakpoints & responsive

- Tailwind defaults apply: 640 / 768 / 1024 / 1280 / 1536.
- A custom `mobile:` variant equals `min-width: 900px` and marks the desktop shell. Extra points are 720 / 840 / 960.
- Below 900px:
  - the top nav collapses to a hamburger drawer
  - the explore sidebar disappears
  - panels stack
  - stat strips and period strips scroll horizontally inside their card (never the page)
  - tables keep a sticky first column
- Touch: `@media(hover:hover)` guards all hover styles. HYPERTRADE's `pointer: coarse` block covers the same need.

---

## 3. Component inventory

| Hyperdash component | Spec | HYPERTRADE mapping |
|---|---|---|
| **Top bar** | 54px, `base`, bottom hairline 4%. Wordmark 15px/700 + orange rect. Nav: `hd-header-nav-link` Geist Mono 12px/500 caps, `px-2.5 py-[18px]`; inactive tertiary → hover secondary → active **white, no underline**. Right: 32px search (raised fill, 4px, ⌘K kbd), 32px icon button, orange CTA. | `AppShell` `.app-topbar`, `.app-wordmark(-dot)`, `.app-nav-link[aria-current]`. Themed, nav moved beside the wordmark. |
| **Workspace / dock tabs** | Text tabs, 12px sans medium, active = raised pill fill, "+" add. | `EngineTabs` could adopt this. It currently uses nav-trigger style. |
| **Tab strip (`hd-tabs-nav-trigger`)** | Geist Mono 12px/500 caps, `padding:12px 0`, `margin-right:12px`, tertiary → secondary → primary. Active has a 2px `#fd4612` indicator sliding over 300ms `(.4,.36,0,1)`. Optional count pill (`804` in a green-tint badge). | `.subtabs` / `.subtab` + `.tab-active`. Themed. |
| **Segmented control (`hd-tabs-tertiary`)** | Wrapper: black 12% fill, 2px pad, 6px radius. Items: 28px, Geist Mono 12px caps, tertiary. Selected: white 4% fill + `shadow-elevate-element` + top-lit 0.5px gradient border. Examples: 24H/7D/30D, $/%, Long/Short (sans), Winners/Losers. | No shared component. See Gaps. |
| **Buttons** | *Primary*: `#fd4612`, white 12px/500 sans, 4px, skeu border; hover `#fd5e32`; press scale .98; disabled `#6e1901` with white 16% text. *Secondary* (`hd-btn-secondary`): raised fill, border-strong, text secondary → primary. *Quaternary chip*: raised/gray-13b fill + elevate shadow, 12px sans; used for dropdown chips "All assets ⌄". *Ghost*: black 2% fill, transparent border, hover border white 8%. *Green* (Copytrade): `green-13` fill, `green-2` text. *Red* (Countertrade): `rose-13` fill, `rose-2` text. *Icon*: square, raised, border-strong. *Text*: mono medium, tertiary → primary. | `Button` tiers. **neutral** = primary orange (darkened to #d93102 / hover #e03302 for 4.5:1). **ghost** = secondary (raised + 12% hairline). **danger** = Countertrade rose fill. |
| **Inputs** | `hd-input`: 36px (32px in trade forms), input-surface fill, 1px white 8% border → hover 12% → focus 16%, 4px radius, grotesk 12px, placeholder tertiary, 20px leading icon, trailing ⌘K kbd (`hd-kbd-btn` mono 12px). | Global `input/select/textarea` in `index.css` + theme font. |
| **Dropdown / select** | Chip button with a chevron. Popover on gray-13b, 4px radius, items 12px sans, hover #262422, active #33312f, dividers #262422. | Native `select` (ThemeSwitcher) uses `--color-input`. |
| **Tables** | Header (`hd-table-header`): grotesk 10px/500 caps, tracking −0.01em, tertiary, sticky on `subtle`, `py-1.5 px-2.5` (first/last 12px), sort chevron pair (up/down ⇅), hover fill surface-hover, draggable columns. Rows: 32px (wallet tables) to 39px (global/tagged), hairline white 4%, hover `surface-hover`. Cells (`hd-table-cell-sans`): 11–12px grotesk tabular, +0.02em, primary for numbers, PnL in fg-green/red. Address cell: 20px avatar square + truncated `0x9c70…89d9` + 3 action icons. Numbers right-aligned. | `DataTable` `.dt`. Themed: sans caps header, 32px rows, 10px cell padding, 12px edge padding. Sort glyph stays ▾/▴ (see Gaps). |
| **Stat strip / stat tile** | Label: Geist Mono 11px caps tertiary. Value: grotesk 14px/500 primary, or coloured when it is a change. Cells in a row with 12px padding and no dividers. Hero variant: mono caps label over a 22px value. | `MetricStat` `.metric-label` / `.metric-value`. |
| **Period-return strip** | 8 equal cells separated by hairlines. Mono caps label (1 DAY…MAX) over a coloured signed %. Selected cell = raised fill. | Not a component. Can be composed from `MetricStat`. |
| **Metric card** | Panel with a 13px/500 title, 22px coloured value + unit, 3px meter bar, 12px caption "`$12.3K Free` • 71.09% from Liquidation". | `Panel` + `MetricStat`. Meter is a Gap. |
| **Meter / split bar** | 3px (h-[3px]) full-radius track. Long/short split = green \| red segments with a 1px gap. Utilisation = single fill on a 20%-alpha track. Leverage = yellow. Labels at both ends in 11px mono caps with `▪` separators. | `strategy/ProbBar`, `NoulBar`. Currently local styling. |
| **Segmented score meter** | Copy score: 10 × 2px vertical ticks at 13px tall, filled in score colour (green ≥70, yellow 40–69, rose <40), unfilled `fg-tertiary/25`. Number 12px/600 in the same colour, "/100" tertiary. Win/loss strip: 7px squares, 2px gap. | `strategy/ScoreRubric`. |
| **Badges / pills** | *Sentiment*: sans 11px, 1px 4px padding, 2px radius, tinted fill (fg-colour ≈15%) + arrow glyph. *Leverage tag* "50×": mono 10px/600, rose text on rose tint. *Direction* "LONG": mono 9px caps green on green tint. *Count* "3": mono 11px on green 14%. *NEW*: orange outline pill. | `Badge` tones (`.badge--*`) and `MomentumBadge`. Themed: 2px radius, 14% tints. |
| **PnL colouring** | Positive `+$…` fg-green; negative `-$…` fg-red; neutral primary. Percentages share the colour. Background tints only for pills and heat cells. | `text-green` / `text-red-text` tokens. |
| **Charts: line/area** | Lightweight-charts. Axis labels 11px grotesk tertiary on the right. No grid lines (or very faint). Crosshair dotted. Last price as a solid coloured tag. Time axis 11px bottom. Area fill = diagonal hatch in chart colour, with a zero baseline splitting green/red. Tooltip gray-13 fill, border-subtle. Watermark. | `charts/EquityChart`, `FanChart`, `Sparkline`: colours via tokens. Hatch fill is a Gap. |
| **Charts: candles** | TradingView: gradient bodies, 1px wicks, volume sub-pane 20% height, toolbar mono 12px tertiary. Popups #1D1A18, hover #262422, dividers #262422. | `CandleChart`. Up/down come from `--color-green/red`. |
| **Treemap heatmap** | Tiles on heatmap green/rose steps with 2px gutters and 4px radius. Top-left: 16px icon + ticker 13px/500. Below: value + sentiment 12px, white text. Neutral tiles on gray-13. | `sectors/MindshareGrid` via `--color-mom-*`. |
| **Sparkline** | 1.25px line in green/red by net direction, optional hatched area, no axes; 60×18 in tables, full-bleed in cards. | `Sparkline` (uses `--color-equity`, see Gaps for direction colouring). |
| **Cards** | `hd-card-*`: subtle fill, 8px radius (grid cards) or 4px (panels), border white 4–8%. Interactive: hover border #353539 + glow. Trader card footer tinted green-15/rose-15 by score. | `Panel`. |
| **Sidebar nav (explore)** | Section eyebrow mono 12px caps. Item: 16px icon, title 13px/500 primary, subtitle 12px tertiary, optional pill on the right. Active item: raised fill + 4px radius + 4px margin. Nested items indented with a 1px guide line. | None (HYPERTRADE has no sidebar). |
| **Key/value list** | Mono 11px caps tertiary key on the left, grotesk 13px primary value on the right, 30px rows, section heading mono 11px caps primary with a hairline above. | Used ad hoc in BranchDetail and State. `.label` themed mono. |
| **Activity feed** | Row: 20px icon, title 12px/500 primary ("$385.89K SP500 Short Closed"), mono 11px caps timestamp on the right, mono sub-line "50 SP500 @ $7,717.8 • -$1.52K" with a coloured PnL. Header has a "● LIVE" green dot. | `strategy/IntentRow` / DecisionView lists. |
| **Modal / dialog** | `hd-modal`: subtle fill, 8px radius, scrim black 72% (backdrop fades over 1s), content scales in 0.95→1 over 200ms. | `ConfirmDialog` (`.panel` over `--color-scrim`). |
| **Toast / promo card** | Promo: `orange-15` fill (#2f0b00), 1px orange-14 border, 16px/500 title, 12px secondary body, full-width primary button. Toasts are not observed. | None. |
| **Tooltip** | gray-13 #262422 fill, 4px radius, 12px text, border-subtle. | Chart tooltips use `--color-elevated`/`--color-panel`. |
| **Pagination** | Not used. Tables virtualise and scroll inside panels (thin 8px scrollbar, white 20% thumb). | `.table-scroll`. Scrollbar themed. |
| **Empty / loading** | Skeleton = pulsing white 6% bars (rounded 4px, varying widths). Empty = centred 12px tertiary text. | `state.tsx` SkeletonRows (bg-elevated + pulse), EmptyBlock, OfflineBlock, ErrorBlock. |
| **Address chip / avatar** | 20–40px square avatar with a 4px radius, person glyph on raised; truncated address `0x9c70…89d9` (6+4), copy icon. | None. Branch IDs render as text. |
| **Status dot** | 6px green dot + "Connected" (green 12px) in the footer; "● LIVE" in green. | `StatusDot` (square in Hyperion). Could be round; see Gaps. |
| **Provenance tag** | "TX" mono 11px tertiary tag next to activity rows. | `SrcTag` (`.src-tag`). Themed mono, 2px radius, teal HL. |
| **Accordion (FAQ)** | 2-col grid of 52px rows, 16px/400 question, "+" at the right, hairlines. | None. |
| **Chips row (explore markets)** | 32px full-radius chips: icon + ticker 14px + coloured Δ% + ▲/▼, raised fill. | None. |

### Mapping to HYPERTRADE components (summary)

- `Button` **ghost** is a raised chip with a 12% hairline, text-muted, hover #262422. **neutral** is the orange skeu primary. **danger** is the Countertrade rose fill.
- `Badge` uses 2px corners and 14% tints. Uppercase strings render in Geist Mono (Hyperdash "LONG"/"50×" tags). `MomentumBadge` is the same.
- `Panel` has 4px corners, a subtle fill, a 4% hairline and a dark ring. The header is 40px with a mono caps white title.
- `DataTable` gets a sans caps 10px header, 32px rows and grotesk tabular cells.
- `MetricStat` puts a mono caps label over a grotesk value.
- For `Sparkline`, `CandleChart`, `EquityChart` and `FanChart`, colours come from tokens: up #5cc09b, down #d44b62, projection blue #5897d7, BTC benchmark #efbb00.
- `ConfirmDialog` is a panel over black/72%.
- `state.tsx` blocks keep their Hyperion shapes. Error rows pick up the rose tint.
- `SrcTag` becomes a mono tag.
- `AppShell` gets a 54px bar with left-aligned mono nav.
- `EngineTabs` becomes a nav-trigger strip with an orange rule.
- `strategy/*` and `sectors/*` inherit the ramps.

---

## 4. Gaps: what the token contract and hooks can't express yet

1. **Segmented control.** Hyperdash's 24H/7D/30D and $/% toggles are pill groups: a black-12% well with 2px padding, 6px radius and a selected item lifted with shadow plus a gradient top-border. HYPERTRADE builds these ad hoc per page, with no class to hook.
   *Proposal:* add a `Segmented` component with `.seg` / `.seg-item[aria-pressed]` hooks and a `--radius-segment` token.
2. **Sentence-case titles.** Hyperdash panel titles ("Performance", "Cohort bias") and buttons ("Get started") are sentence case in the grotesk. HYPERTRADE hard-codes uppercase strings ("MARKETS", "RETRY"), so CSS cannot recover sentence case. The theme renders them in Geist Mono caps, which matches Hyperdash's mono-caps convention (address-page section heads).
   *Proposal:* store titles and button labels in sentence case and uppercase them via `--label-case` / `--control-case` in the themes that want caps.
3. **Hatched area fills.** PnL and positioning charts fill under the line with diagonal hatching in the series colour, split at zero into green and red.
   *Proposal:* tokens `--chart-area-pattern: hatch|solid` and `--color-chart-area-up/down`, with a shared `<defs><pattern>` in `charts/`.
4. **Meter / split bar.** The 3px full-radius long/short bar with a 1px gap is Hyperdash's most-repeated data primitive. `ProbBar` and `NoulBar` style their own.
   *Proposal:* a `Meter` component with `.meter`, `.meter-seg--up/--down/--warn` hooks and a `--meter-h` token.
5. **Sparkline direction colour.** Hyperdash colours sparklines by net change (green/red). `Sparkline` always uses `--color-equity`.
   *Proposal:* a `tone` prop plus `--color-spark-up/down`, falling back to up/down.
6. **Chart chrome tokens.** Axis tick size (11px), tooltip fill (#262422), grid (none) and watermark are hard-coded in each chart component.
   *Proposal:* `--chart-tick-size`, `--color-chart-grid`, `--color-chart-tooltip`, and an optional `--chart-watermark` string.
7. **Separate up/down for text vs fills.** Hyperdash uses fg-green #5cc09b for text but chart-green #38a67c (gradient bodies) for candles. The contract's `--color-green` serves both text (`text-green`) and candle fills. The theme picks the fg value. `--color-green-text` exists but the components use `text-green`.
   *Proposal:* use `text-green-text` everywhere for text. Add `--color-candle-up/down` (and optional gradient tokens).
8. **Round status dot.** Hyperdash status dots are circles. `StatusDot` is square with no hook class.
   *Proposal:* add `.status-dot` and a `--radius-dot` token.
9. **Card vs panel radius.** Hyperdash uses 4px for panels and 8px for grid cards (cohort/trader/asset cards). The contract has a single `--radius-panel`.
   *Proposal:* add `--radius-card` for card grids.
10. **Button variants.** Hyperdash has green "Copytrade" and rose "Countertrade" fills plus an icon-button. HYPERTRADE has no execution paths, so only danger maps.
    *Proposal, if needed:* a `positive` tier with `--color-positive-fill/-fg`.
11. **Metric label size.** `MetricStat` pins the label at `!text-[10px]`, which is layered `!important`, so no theme can override it. Hyperdash uses 11px.
    *Proposal:* drive it from `var(--metric-label-size, 10px)`.
12. **Sort indicator.** Hyperdash shows a two-arrow ⇅ chevron on every sortable header, highlighting the active direction. DataTable prints ▾/▴ only on the active column.
    *Proposal:* render an icon span `.dt-sort[data-dir]` for themes to restyle.
13. **Page gap.** Page grids hard-code `gap-3` (12px). Hyperdash's dense views use 8px.
    *Proposal:* `gap-[var(--gutter)]` so density tokens drive it.
14. **Fonts.** BDO Grotesk is free (VJ-Type) but not on Google Fonts. Self-hosting it would need `@font-face` plus files under `src/assets/fonts/`, outside this theme's remit. Until then the stack falls back to Host Grotesk. Geist Mono is bundled; Hyperdash only ships its 500 weight.
