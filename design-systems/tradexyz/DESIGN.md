# Trade[XYZ] — design system (extracted) and HYPERTRADE adaptation

Source: **trade.xyz** (marketing + legal) and **app.trade.xyz** (the trading app),
crawled 2026-09-30 through Firecrawl (rawHtml, compiled CSS bundles, screenshots at
1600×1000, 1440×900 and a 360×800 mobile viewport). Every hex value below comes from
the compiled stylesheets unless marked *sampled* (read from screenshot pixels).

Raw tokens: [`tokens.json`](./tokens.json). Theme: [`src/ui/themes/tradexyz.css`](../../src/ui/themes/tradexyz.css).

> **Correction to the initial branding probe.** Firecrawl's `branding` pass reported a
> *light* landing page set in "Times New Roman". Both are wrong. The landing page is a
> full-bleed video over navy `#24344b`; the headline face is **Britti Sans** (a commercial
> `.otf`) that failed to load for the probe, hence the serif fallback. The trading app is
> **dark** (`theme-color: #0e141b`). The theme therefore ships as a **dark** theme
> (`scheme: 'dark'`).

---

## 1. Page inventory

Crawl notes. The app is geo-fenced: every app page renders under a full-width rose
banner (`#9e1d40`, *sampled*): "Trade.xyz is not available from this connection…". The
banner sits above the header and doesn't change the page layout. The marketing
homepage returns no `links` because it is a client-rendered Next.js page. Routes were
found in app rawHtml (`href=`), in `firecrawl_search site:trade.xyz` and by probing.

| # | URL | Page type | Layout |
|---|---|---|---|
| 1 | `trade.xyz/` | Marketing landing | Full-viewport (100dvh, no scroll) video hero on `#24344b`. Logo top-left (116×24 mobile, 154×32 desktop), `TRADEXYZ ©2025` Geist Mono uppercase top-right, centred Britti headline "Trade anything, anytime." (54→140px fluid), split CTA "TRADE NOW" (navy slab + 60px gold arrow tile), and a Geist Mono uppercase tagline bottom-left. |
| 2 | `trade.xyz/terms` | Legal document | Navy `#24344b` scroll page with the same header. 800px column (`padding: 8rem 2rem 3rem`). Britti title 32→54px centred. Body in Geist Mono 14→16px/1.8 cream. h2 Britti 24→28px, h3 Geist Mono 600 18→20px. Gold links. "Important" callout: gold/10 fill with a 3px gold left rule. |
| 3 | `trade.xyz/privacyPolicy` | Legal document | Same template as #2. |
| 4 | `trade.xyz/does-not-exist` | 404 (marketing) | Next.js default 404: system-ui, `404 \| This page could not be found.`, white/black by `prefers-color-scheme`. Unstyled. |
| 5 | `app.trade.xyz/trade` → `/?market=SPCX&chart=candles` | Trade terminal (equity perp) | See §1.1. |
| 6 | `app.trade.xyz/?market=GOLD` | Trade terminal (commodity), 2nd sample | Same template. Symbol tile is a gold square. Leverage chip reads `25x`. Orderbook tick is `0.1`. |
| 7 | `app.trade.xyz/?market=XYZ100` @1440 | Trade terminal (index), 3rd sample | Same template at 1440px. The chart area shows the loading state: an animated `[XYZ]` logo spinner centred on the empty pane. |
| 8 | `app.trade.xyz/?market=NVDA` mobile 360 | Trade terminal, mobile | Symbol card with a chevron (market switcher), a horizontally scrolling stat strip, tabs Chart / Order Book / Trades, and a full-width chart. A fixed bottom tab bar holds Events · Markets · Trade · Account · Portfolio (icon + label; the active cell is a raised slate tile). |
| 9 | `app.trade.xyz/events` | Events (prediction-market) feed | Centred 900px column. Search input with category tabs (All/Finance/Sports/Crypto/Others; the active tab gets a gold underline and gold text). A chip rail of topics with counts. "Featured" and "Events" sections list event rows: a slate card (title, "Ends in …", reference price, 24h volume) plus two outcome buttons (emerald "Above 15¢", rose "Below 85¢"). Multi-outcome groups show one row per outcome and a "5 more outcomes" expander. There is no ticker or stat strip. |
| 10 | `app.trade.xyz/?market=anthropic-ipo&view=simplified` | Event detail ("simplified" outcome view) | Minimal header: `← Events` pill left, centred wordmark, `Terminal ↗` + `Connect wallet` right. Two columns: 768px content (category eyebrow, 22px title, meta, 1D/All tabs, probability line chart with gold Yes line and grey No line, full-width Yes/No slabs, Summary/Details tabs, Positions/Open Orders/Trades tabs, "People are trading") and a 460.8px sticky trade card (Yes/No segmented, Buy/Sell and Market/Limit text toggles, inputs, off-white primary CTA). |
| 11 | `app.trade.xyz/portfolio` | Portfolio | Title "Portfolio". Row 1 is three cards: a stacked pair (14 Day Volume; Fees Taker/Maker), a key-value card with Accounts/Period dropdowns (PNL, Volume, Total Equity with an indented breakdown), and a PNL chart card with a Chart ▾ selector. Row 2 is the full-width account tab-table (Balances, Positions, Events, Open Orders, TWAP, Trade/Funding/Order/Interest History, Account Activity) with checkbox filters on the right. |
| 12 | `app.trade.xyz/earn` | Earn & Borrow (lending markets) | Title with subtitle. Three KPI cards (Health Factor, Total Supplied, Total Borrowed). "Supply" section: search input, Supplied/All segmented control, and a zebra table (Asset, LTV, Supply APY in green, Oracle Price, …, Supply/Withdraw row buttons). "Borrow" section follows the same pattern with APY in rose. |
| 13 | `app.trade.xyz/discovery-bounds` | Data table page ("Bounds") | Title "Active discovery bounds" with a `(12)` count, subtitle and "Learn more" link. Search input plus an Internal/All segmented control (active = gold text on gold/10). A full-width table: index number, asset icon + ticker + leverage chip, category, session, prices, bound %, triggers (`--` when unavailable), resets. Footnote and a CSV download link. |
| 14 | `app.trade.xyz/changelog` | Changelog | Centred ~770px column. 24px title. Date column (Plex, slate-400) and entries (14px) separated by hairlines. Some entries embed screenshots in rounded 10px frames with a caption such as "option + tab". |
| 15 | `app.trade.xyz/support` | Gate / auth card | A centred 340px card on the app background: wordmark header strip (slate-900), body copy centred in slate-100, full-width slate-100 "Connect Wallet" button. **This is the closest analogue to HYPERTRADE Login.** |
| 16 | `app.trade.xyz/this-page-does-not-exist` | 404 (app) | Redirects to the default market (`/?market=SPCX`). There is no 404 screen. |
| 17 | `docs.trade.xyz/` | Docs (GitBook) | GitBook dark theme with the gold accent and a `[XYZ] docs` wordmark. Left nav (uppercase section heads), article column, "Was this helpful?" rail. Gold Support button and gold links. |
| 18 | `docs.trade.xyz/perpetuals/markets` | Docs article | Same GitBook template. |

Also discovered but not separately rendered: `/?market=<outcome-id>&view=simplified` (every event row links to one; same template as #10), `/?market=BRENTOIL|CL|UNITREE|BOT` (same template as #5), `/earn` (Earn & Borrow), and the external status page `hyperliquid.statuspage.io`. The app has no dedicated markets-list, leaderboard, referrals, vaults or points route. `markets` in the mobile tab bar opens the market switcher on `/`. **18 URLs visited, 10 distinct page types.**

### 1.1 Trade terminal anatomy (1600px)

```
┌ header 48px: trade[XYZ] · Trade Events Portfolio Earn Bounds · ticker marquee ·  [X] 👻 [Connect Wallet] ⚙ ┐
├──────────── chart column (flex 1) ─────────────┬ orderbook 320px ┬ order entry 300px ┤
│ market header card: icon, SYMBOL-USDC, xyz/20x │ Order Book│Trades│ Long │ Short      │
│  chips, Mark · Oracle · 24h Change · 24h Vol · │ tick ▾   USDC ▾  │ Market Limit Pro▾  │
│  Open Interest · Funding/Countdown · Resources │ Price Size Total │ 20x ⚙  Isolated ▾  │
│ TradingView (toolbar left, 1h, Indicators, TZ) │ 11 asks (rose)   │ Current Position   │
│  candles + volume sub-pane                     │ [ 0.01 0.007% ]  │ Limit Price  MID   │
│                                                │ 11 bids (emerald)│ Amount  ⇄          │
├────────────────────────────────────────────────┴──────────────────┤ Reduce Only · TIF  │
│ account tabs: Balances Positions Events Open Orders TWAP …   ☐ ☐ │ TP/SL              │
│ table (empty: "Connect wallet to view balances")                  │ [Connect Wallet]   │
│                                                                   │ Order Value / Fees │
│                                                                   ├ Total Equity card ─┤
└───────────────────────────────────────────────────────────────────┴────────────────────┘
footer 26px: ● Mainnet ● WebSockets ● Wallet Disconnected · e4514 · Ctrl+/ Shortcuts · Changelog Support Docs Terms Privacy
```

Panels are separate rounded-lg cards with an 8px gap on the glowing screen background. The chart and orderbook share one card, divided by a slate-850 vertical rule. The orderbook is resizable: the drag handle turns its left border white-100.

### 1.2 Mapping to HYPERTRADE pages

| Trade[XYZ] page type | HYPERTRADE page | Adaptation |
|---|---|---|
| Trade terminal (#5–8) | **MarketDrill** (`/markets/:coin`) | Reproduce the market header card: 20px symbol + `xyz`-style gray chips + a stat strip (Mark → last, Oracle → mark, 24h change coloured, 24h volume, OI, funding) as `MetricStat`s in one row with no dividers. `CandleChart` fills the left 8/12 in a panel, and a stats/funding panel takes the right 4/12 where the orderbook sits. On mobile, stack header → chart → stats (the app's mobile order). |
| Market switcher / ticker marquee (header) | **Markets** (`/markets`) | The app has no markets page. Its universe lives in the dropdown and in the `[TICKER] +x.xx% ▲` marquee. Markets keeps its DataTable, now zebra-striped. Show tickers in the numeric face and colour 24h% with green/red text and a ▲/▼ glyph (the app pairs colour with a triangle, so colour is never the sole signal). A ticker marquee would be a new component (see Gaps). |
| Portfolio (#11) | **Overview** (`/`) | Overview's metrics strip maps to the Portfolio KPI cards, the MarketState headline to the key-value card, and sector heat plus recent branches to the chart card and tab-table. Keep the 12-col grid with an 8px gutter and rounded cards. |
| Earn & Borrow (#12) | **Branches** (`/branches`) | Title plus subtitle, a KPI card row (count, best return, worst DD), then a search + segmented control (All/Simulated) above the zebra DataTable. Row actions become small ghost buttons at the row end (Supply/Withdraw style). |
| Portfolio chart card + key-value card | **BranchDetail** | Results column: an equity card with period dropdown (Portfolio "Chart ▾ / Period ▾" header controls), drawdown card, and a stats card as an indented key-value list (Portfolio "Total Equity" breakdown). The editor column follows the order-entry panel: stacked 32px inputs with inline unit suffix, segmented controls for enums, full-width neutral submit. |
| Events feed (#9) | **Sectors** (`/sectors`) | The events chip rail (topic + count) is the natural sector filter. MindshareGrid cells use the momentum washes. Rotations follow the "Featured" list styling: slate card rows. |
| Event detail simplified (#10) | **State** (`/state`) | This is a reading surface: 768px column, category eyebrow, 22px display title, meta line, one chart, Summary/Details tabs. Map the thesis blocks to the Summary tab body (16px/1.6, text-muted) and domain cards to slate cards. |
| Bounds table (#13) | **Strategies** (`/strategies`) | Title with `(n)` count, subtitle, search + Internal/All style segmented control (Enabled/All), and an indexed zebra table with the ticker+chip cell pattern for strategy id + venue. |
| Account tab-table (Trade History / Order History) | **Decisions** (`/decisions`) | Filter by strategy through the tab-table's right-side filter checkboxes/select. Verdict badges become the `badge-buy`/`badge-sell` pills. |
| Trade confirmation / order form | **DecisionDetail** | The intent record goes in a card. Approve/Reject become the Long/Short-coloured full-width pair (emerald/rose tint) inside ConfirmDialog. |
| Order-entry panel | **StrategyDetail** | The param form is the order form: label-left/value-right inputs with unit suffix, the `TIF GTC ▾` inline select pattern for enums, and the checkbox rows (Reduce Only) for booleans. DRY RUN result renders as a card beneath. |
| Status footer + Earn KPI cards | **Governor** | Mode chips as a segmented control. Limits as KPI cards. The kill switch is the one rose-filled danger slab. Venues use the footer's status-dot + label idiom (`● Mainnet`). |
| Docs (#17) | **Analyst** (`/analyst`) | Chat transcript in a 768px article column with gold links. The model selector is a header dropdown. |
| Support gate (#15) | **Login** | This is a 1:1 match. A 340px centred card on the glowing screen, wordmark in the header strip, a centred muted line, then the password input and a full-width neutral button. |

---

## 2. Foundations — colour

### 2.1 App palette (dark; `@layer theme` of the app bundle)

| Token | Hex | Role |
|---|---|---|
| `brand-screen` | `#0e141b` | Page background, `<meta theme-color>` |
| `brand-slate-950` | `#11151b` | Cards/panels, TradingView pane, table header, footer (`/90`) |
| `brand-slate-900` | `#151b23` | Inputs, card header strip, chart toolbar hover |
| `brand-slate-850` | ≈`#1a2028` | Orderbook column divider (interpolated) |
| `brand-slate-800` | `#1e252e` | **`--color-border`**, segmented track, selected row, Total-Equity card fill |
| `brand-slate-700` | `#2b3541` | Active segment, chips (`xyz`, `20x`), hover fill |
| `brand-slate-600` | `#35414f` | Hover borders, menu hover `/50`, background glow |
| `brand-slate-500` | `#535e69` | Placeholder, dashed tooltip underline |
| `brand-slate-400` | `#68717b` | Labels, column headers, inactive tabs (3.7:1: labels only) |
| `brand-slate-300` | `#868d95` | Tertiary text, focus-within input border |
| `brand-slate-200` | `#aeb3b9` | Button hover `/85`, outcome "No" line |
| `brand-slate-100` | `#cccfd3` | Secondary text, **primary button fill** |
| `brand-white-100` | `#efece7` | **Primary text** (warm off-white), event CTA fill |
| `brand-yellow-400` | `#ffce55` | **Accent**: active nav, `[XYZ]` brackets, focus ring, spread brackets |
| `brand-yellow-500` | `#f9bd29` | Hover gold, links, `::selection` |
| `brand-green-300` | `#5ee9b5` | Status dot (Mainnet/WebSockets), positive pill text |
| `brand-green-400` | `#00d492` | **Long / up text**, Yes buttons |
| `brand-green-500` | `#00bc7d` | Bid depth `/10`, buy badge `/25`, candles, glow |
| `brand-red-400` | `#ff637e` | **Short / down text & fills**, asks, No buttons, sell badge |
| flash-red | `#ff2056` | `flash-ask` keyframe |
| `brand-dusk-400` | `#96b0b9` | Muted blue-grey (marketing icon tile) |
| amber-500 | `#f99c00` | Warning / chart-5 |

Surface recipes:

- **App background** (`.app-background`): radial emerald `#00bc7d14` from the top-left (36rem), slate `#35414f33` from the top-right (42rem), an emerald ellipse at 100% 67%, all over `linear-gradient(#0e141b → #0a1016)`.
- **Zebra rows**: `odd:bg-slate-800/30`, hover `slate-700/40`, selected `slate-800`.
- **Scrim**: `bg-black/50`. **Menus**: slate-950 with a slate-800 border.

Contrast on the panel `#11151b`: white-100 15.5:1, slate-100 11.7:1, slate-300 5.5:1, slate-400 3.7:1, green-400 9.4:1, red-400 6.4:1, yellow-400 12.4:1.

### 2.2 Marketing palette

| Token | Hex | Role |
|---|---|---|
| navy | `#31445f` | TRADE NOW slab, wiper |
| ink | `#24344b` | Legal page bg, video fallback bg, text on gold |
| gold | `#f9bd29` | Arrow tile, highlights, links, `::selection` |
| cream | `#f4e9d5` | All marketing text |
| dusk | `#96b0b9` | Alternate icon tile |

### 2.3 Semantic

| Meaning | App value | HYPERTRADE token |
|---|---|---|
| up / long / positive text | `#00d492` | `--color-green-text` |
| up fill (candles, depth, bars) | `#00bc7d` | `--color-green` |
| down / short / negative | `#ff637e` | `--color-red`, `--color-red-text` |
| tint backgrounds | `/10` of the above | `--color-green-bg`, `--color-red-bg` |
| destructive emphasis | `#ff2056` | `--color-red-accent` |
| warning | `#f99c00` | `--color-amber` |
| info / neutral | `#96b0b9` | `--color-info` |
| tick flash | green-500 / `#ff2056` at 20% over 500ms | `--color-flash-up/down` |

**PnL colouring**: the sign travels with the number (`+3.1900 / +2.15%`). Ticker changes add ▲/▼ triangles in the same colour. Zero and `--` stay in white-100. APY columns colour the positive yield green (supply) and the cost rose (borrow).

### 2.4 Chart series

- **TradingView**: pane and platform background `#11151b`; toolbar hover `#151b23`; active `#cccfd3` → hover `#ffce55`. Candles are emerald/rose. The last-price tag is a filled emerald (or rose) chip. Volume bars use candle colours at reduced alpha. The legend is O/H/L/C in the candle colour.
- **Outcome chart**: the lead line is `#ffce55` (Yes) and the second line slate-200 (No). End-of-line dots have value labels. The grid is dashed horizontal only (`#2b3541`-ish). Axis labels are 11px slate-400. The y-axis shows 0% / 50% / 100%.
- **shadcn chart ramp (dark)**: `#f05100 #00bb7f #f99c00 #fcbb00 #ff2357`.

---

## 3. Foundations — typography

### 3.1 Families (from `@font-face` in the bundles)

| Role | App | Marketing | HYPERTRADE token → face shipped |
|---|---|---|---|
| UI text | **Inter** 400/500/600/700 (`--default-font-family`) | — | `--font-sans` → Inter (Google Fonts, real face) |
| Numbers / `font-mono` | **IBM Plex Sans** 400–700 (Tailwind `font-mono` is remapped to it) with `tabular-nums` | — | `--font-mono` → IBM Plex Sans (Google Fonts, real face) |
| Display / brand | **brittSans** (Britti Sans Regular `.otf`, 400 only) | **Britti** (same file) | `--font-display` → **Hanken Grotesk** 400/500 (closest free grotesque; Britti Sans is commercial and not on Google Fonts) |
| Brand mono | Geist Mono (loaded, rarely used) | **Geist Mono** (tagline, trademark, CTAs, legal body) | `--font-control` → Geist Mono (bundled locally) |

### 3.2 Google Fonts stylesheet for `registry.ts`

```
https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=Hanken+Grotesk:wght@300;400;500&display=swap
```

### 3.3 Scale (app)

| Step | Size / line-height | Usage |
|---|---|---|
| 8–10px | — | Chart axis ticks, tiny chips |
| xs | 12 / 16 | Labels, column headers, footer, stat labels (`text-xs lg:text-sm`) |
| 13px | — | Dense cells |
| sm | 14 / 20 | **Body**, nav, tabs, table cells, inputs, buttons |
| base | 16 / 24 | Card values (`Total Equity $0.00`: 16px semibold) |
| lg | 18 / 28 | Page titles (Portfolio, Earn & Borrow), weight 500 |
| xl | 20 / 28 | Market symbol `SPCX-USDC` |
| 22px | — | Event detail title |
| 2xl | 24 / 32 | Changelog title |
| 5xl | 48 / 1 | — |

Marketing uses fluid clamps between a 375px and a 1920px viewport: hero 54→140 (lh 1, −0.02em), legal title 32→54, h2 24→28, body 14→16 (Geist Mono, lh 1.8).

### 3.4 Rules

- **Casing.** The app uses sentence/title case everywhere (nav, tabs, labels, buttons: "Connect Wallet", "Reduce Only"). Marketing uses UPPERCASE Geist Mono for the tagline, trademark and CTAs.
- **Tracking.** The app uses `0` almost everywhere; `tracking-wider/widest` appear only in tiny caps. Display type tracks −0.02em.
- **Weight.** Body text is 400. Active tabs, buttons and card titles are 500. Card values and CTAs are 600.
- **Numerals.** Always `tabular-nums` in the numeric face. Prices carry `$` in the orderbook. Big numbers are abbreviated in lower case: `57.73m USDC`, `$1b`, `$165k`. Missing values render as `--` (a double hyphen, tracked apart).
- **Tooltip terms.** Labels with an explanation get a dashed underline (`underline decoration-dashed underline-offset-2`, slate-500/300).

---

## 4. Foundations — space, shape, depth, motion

- **Spacing**: 4px base (`--spacing: .25rem`). Panel gap 8px, card padding 12px, page gutter 16px, nav gap 20px. Table cells `px-2`. Stat strip items are 16–24px apart.
- **Control heights**: chip 16, segment 28 (`h-7`), button/track 32 (`h-8`), large button 36 (`h-9`). Tab strip 38. Table header row 28.5, table row 30.5, orderbook row 18.
- **Radii** (`--radius: .625rem`): cards `lg` 10px; inputs/segment tracks `md` 8px; buttons/segments/tabs `sm` 6px; chips 4px; depth bars `xs` 2px (right side only); dots `full`. Marketing buttons and tiles are 10px.
- **Borders**: 1px `#1e252e` on every card. Dividers use `slate-800/60`. Outline buttons use `#ffffff26`.
- **Elevation**: cards `shadow-sm` (0 1px 3px / 0 1px 2px −1px, 10% black). Chips and menus use `shadow-lg`. Modals use `shadow-2xl` or HeroUI large dark (`0 0 30px #00000012, 0 30px 60px #00000042, inset 0 0 1px #ffffff26`). Depth otherwise comes from the slate ladder, not shadows.
- **Blur**: sticky headers use `backdrop-blur-lg` (16px) with a fade mask. The theme gives the top bar a 12px blur.
- **Motion**: default `150ms cubic-bezier(.4,0,.2,1)`; tab indicators and segments slide over `200ms ease-out`; orderbook `flash-bid/ask` runs 500ms (0 → 20% tint + inset glow → 0); the ticker marquee loops over 70s linear; skeletons use `pulse 2s`. Marketing buttons cross-fade background and colour over `.5s`, and the CTA arrow tile has a navy "wiper" that slides on hover.
- **Breakpoints**: Tailwind defaults (640/768/1024/1280/1536). At **768** the desktop header and status footer appear and the mobile bottom tab bar hides. At `2xl` the stat strip gap grows from 16 to 24px.
- **Iconography**: lucide-style 16px line icons (`size-4`, 1.5–2px stroke) in slate-300 that turn white-100 on hover. Market icons are 24–32px rounded-square logos. Triangles ▲/▼ mark ticker direction. The status footer uses 8px round dots.

---

## 5. Component inventory

| Component | Spec |
|---|---|
| **Header / top bar** | Transparent over the screen, no border, ~48px, `px-3`. Left: `trade[XYZ]` logo, then nav `gap-5` Inter 14px white-100; the active item is `text-brand-yellow-400` with no underline. Centre: the ticker marquee `[NVDA] +0.17% ▲` (brackets and ticker in the numeric face, slate-400; change in green/red), 70s loop. Right: gold `[X]` glyph, 32px icon buttons (`size-8 rounded-sm`, slate-300 → slate-800 bg on hover), the "Connect Wallet" neutral button `h-8 text-xs`, and a settings cog. |
| **Status footer** | 26px, `bg-slate-950/90`, top border slate-800, 12px slate-400. Status dots `size-2 rounded-full` (green-300 ok, red-400 down) with labels. Centre: a `Ctrl+/` kbd chip and "Shortcuts". Right: text links that turn slate-100 on hover. |
| **Mobile bottom bar** | 5 cells (icon above a 12px label). The active cell sits on a slate-800 rounded tile with white text. |
| **Market header card** | 32px icon tile, 20px symbol, chips `xyz` / `20x` (slate-700, 11px, rounded 4px, `px-1`), a 12px slate-400 company line. Stats: label 12px slate-400 (dashed underline when it has a tooltip) over a 14px Plex value. |
| **Content tabs** (Order Book / Trades, Balances …) | 38px strip, 14px text. Inactive slate-400 (hover slate-100), active white. The indicator is a 2px **white** bottom border that slides over 200ms. |
| **Category tabs** (Events) | Same geometry, but the active tab is gold with a gold underline. |
| **Segmented control** (Market / Limit / Pro, Supplied / All) | Track `bg-slate-800 rounded-sm p-0.5 h-8`. Segments `h-7 rounded-sm text-sm font-medium`: inactive slate-400, active `bg-slate-700 text-white-100`. The gold variant (Internal / All) is active text gold on `yellow-400/10`. |
| **Side toggle** (Long / Short) | Full-width tabs. Active Long: `bg-green-400/10 text-green-400` with a 2px green bottom rule. Active Short uses the rose equivalent. Inactive slate-400. |
| **Buttons** | Base: `rounded-sm text-sm font-medium h-9 px-4` (`h-8 text-xs` small), disabled `opacity-50`, transitions on all properties. **Primary**: `bg-slate-100 text-slate-900`, hover `slate-200/85`. **Outline**: 1px `#ffffff26`, `bg-input/30`, hover slate-700. **Ghost**: transparent, hover slate-700. **Event CTA**: `bg-white-100 text-slate-950`, 48px. **Outcome**: Yes `#00d492` fill + dark text (or the `/25` tint with green text), No = rose tint `#863a4b`-ish with rose text. **Marketing primary**: navy `#31445f` slab with cream Geist Mono 600 caps, joined to a 60px gold arrow tile (radius 10). Share buttons are gold→cream. |
| **Inputs** | `bg-slate-900 border-slate-800 rounded-md`, 14px. The label sits inside on the left in slate-400 and the value is right-aligned in white-100 with a unit suffix (`USD`, `SPCX`) and an inline chip (`MID`). Focus-within turns the border slate-300. Placeholder slate-500. |
| **Dropdown / select** | Trigger `h-7 rounded-sm px-3 text-sm` with a chevron; hover `slate-700/50`. Menu: slate-950 panel, slate-800 border, `shadow-lg`, items hover slate-600/50. |
| **Checkbox** | 16px, `rounded-[4px]`, border input, checked = primary fill. Label 14px white-100. |
| **Tables** | `text-sm`. Header `h-[28.5px] text-xs font-normal slate-400 bg-slate-950`, sticky, sortable headers with a chevron. Rows `h-[30.5px]` zebra `slate-800/30`, hover `slate-700/40`, no row borders. Cells `px-2`. Numbers go right or left per column. The empty state is centred slate-400 text ("Connect wallet to view balances") with generous vertical padding (`py-15`). |
| **Orderbook** | 18px rows, 3-column grid (Price / Size / Total), Plex. Asks in rose, bids in emerald; right-anchored depth bars at `/10` with `rounded-r-xs`. The spread row reads `[ 0.01 0.007% ]` with gold brackets. Price/level flash animates for 500ms. |
| **Stat / KPI card** | `rounded-lg border slate-800 bg-slate-950 p-3/4`. Label 14px slate-300, value 16–18px. The Total-Equity card sits on a slate-800 fill with a green `0.00%` pill (`bg-green-300/20 text-green-300 rounded px-1 text-xs`). |
| **Key-value list** | Label left (14px slate-400) and value right (white-100 Plex). Indented children use a left rule (`border-l slate-800 pl-4`). |
| **Badges / pills** | `badge-buy`: green-500 @25% bg with green-500 text; `badge-sell` is the rose equivalent. Chips are slate-700 with slate-100 text. Count chips (`81`) are slate-400 12px next to the label. |
| **Cards (event rows)** | `bg-slate-800`-ish rounded-lg rows 68px tall. The outcome fill bar is a lighter slate proportional to probability. Paired outcome buttons are 156px wide. |
| **Charts** | TradingView (see §2.4). The Recharts-style PNL chart has plain axes and slate-400 11px ticks, the value label pinned on the right, and a flat line. |
| **Modals / dialogs** | Radix/shadcn: scrim `bg-black/50`, content slate-950 `rounded-lg` with slate-800 border and `shadow-2xl`, header `text-lg font-semibold`, footer buttons right-aligned. |
| **Tooltips** | Slate-700 bubble, 12px white-100, `rounded-sm`, `shadow-lg`. Triggered by the dashed-underline labels. |
| **Toasts** | Sonner-style slate-950 card, bottom-right, with a status icon (none observed live, since the wallet was disconnected). |
| **Loading** | Skeletons are rounded-md `slate-800` pills with `animate-pulse` (the Portfolio key-value values). The page-level loader is the animated `[XYZ]` mark centred in the chart pane. |
| **Empty state** | One centred slate-400 sentence with no icon. |
| **Geo banner** | Full-width `#9e1d40` bar, 12px white centred text. |
| **Marketing hero** | Video background, cream Britti 140px headline set per word with a staggered fade-up, the CTA below it, and an uppercase Geist Mono tagline bottom-left (max 450px). |
| **Marketing header/footer** | Header: logo left and `TRADEXYZ ©2025` right in cream Geist Mono caps, on a 1.5rem/2.25rem inset. There is no footer. |
| **Legal document** | See page #2. Includes an "important" callout (gold/10 bg with a 3px gold left rule, 600 weight). |

### 5.1 Mapping to HYPERTRADE components

| HYPERTRADE | Trade[XYZ] counterpart | Theme treatment |
|---|---|---|
| `AppShell` `.app-topbar` | Header | 48px, transparent border, translucent screen + 12px blur; the nav sits beside the wordmark (not centred). |
| `.app-wordmark` / `.app-wordmark-dot` | `trade[XYZ]` logo | Lowercase Hanken Grotesk 20px/−0.02em. The dot becomes a gold `[▪]` bracketed square. |
| `.app-nav-link[aria-current=page]` | Nav, active gold | Inter 14px sentence case (authored caps are lowercased and the first letter re-capitalised). Active = gold text, no rule. Hover = yellow-500. |
| `.app-tabbar` / `.app-tab` | Mobile bottom bar | Slate-950 bar. The active cell is a slate-800 rounded tile instead of the top rule. |
| `EngineTabs` `.subtabs` / `.subtab` | Content tabs | Inter 14px sentence case with a 2px **white** rule on the active tab. |
| `.tab-active` (generic) | Category tabs | Keeps the accent (gold) rule. |
| `Panel` `.panel*` | Card | 10px radius, slate-800 border, shadow-sm. The header has the panel's own background and is ≥40px tall. The title is Inter 14px/500 in sentence case. |
| `Button` ghost | Outline button ("Transfer") | `#ffffff26` border, faint fill, slate-700 hover. |
| `Button` neutral | Primary ("Connect Wallet") | Slate-100 slab with slate-900 text, 600 weight. |
| `Button` danger | Short-tinted outline | Rose text, rose/50 border, rose/10 hover. |
| `Badge` tones | chips / buy-sell pills | Plex 11px/500, 4px radius. Green = green-300 on green-300/20; gray = slate-700 chip. |
| `MomentumBadge` | ticker change + ▲▼ | Uses the green/red text tokens. The glyph is authored in the component, which matches the app's triangle convention. |
| `DataTable` `.dt` | Tables | 13px cells, 12px headers in Inter (not caps-tracked), zebra rows, hover slate-700/40, no row rules, row height from `--row-h` (30px). |
| `MetricStat` `.metric-value` | Market header stats | Plex 18px/500. |
| `Sparkline`, `CandleChart` | TradingView candles | Candles use `--color-green`/`--color-red` (#00bc7d / #ff637e). Axes read `--color-text-secondary`. |
| `charts/EquityChart` | Portfolio PNL / outcome chart | The equity line is white-100 and BTC is gold (the outcome lead line). USDC is slate-400 dashed. The projection is dusk `#96b0b9`: never green or red. |
| `charts/FanChart` | — | Dusk band at 14%, dusk median. |
| `ConfirmDialog` | shadcn dialog | Panel radius 10, scrim black/50, overlay shadow. |
| `state.tsx` (Skeleton / Empty / Error / Stale) | skeleton pills / empty sentence | Skeleton bars become rounded slate-800 pills. The error block uses the rose tint. |
| `SrcTag` | `xyz` chip | 4px radius; HL tag in green-300. |
| `ThemeSwitcher` | select trigger | Slate-900 well with a slate-800 border. |
| `strategy/*` (VerdictBadge, ProbBar, NoulBar) | badges, outcome bars | ProbBar should read like the event outcome bar: a lighter slate fill proportional to probability, never green/red, because it is a projection. |
| `sectors/MindshareGrid` | — | Momentum ramp: rose/emerald washes at 22%/45%, zero = slate-900. White-100 text on every bucket passes ≥6.4:1. |

---

## 6. Theme decisions (`src/ui/themes/tradexyz.css`)

- **Scheme**: `dark`. The token block sets `color-scheme: dark`.
- **Key tokens**: body `#0e141b` (plus the radial glow painted on `body`), panel `#11151b`, elevated/input `#151b23`, border `#1e252e`, text `#efece7` / `#cccfd3` / `#868d95` / `#535e69`, accent `#ffce55`, primary button `#cccfd3`/`#151b23`, up `#00bc7d` (text `#00d492`), down `#ff637e`, warn `#f99c00`, info `#96b0b9`.
- **Fonts**: sans Inter, mono IBM Plex Sans, display Hanken Grotesk (a stand-in for Britti Sans), control Geist Mono.
- **Radii**: panel 10, control 6, badge 4 (inputs 8 via a hook). Shadow: shadow-sm.
- **Density**: gutter 8, panel-pad 12, cell 8×6, row 30, controls 28/32/36, tap 28. The coarse-pointer block is restated.
- **Casing**: labels `none` (the app is sentence case). Controls stay `uppercase` Geist Mono 500 +0.02em, borrowing the marketing CTA ("TRADE NOW"), because HYPERTRADE's button copy is authored in caps. Nav, subtabs and panel titles are converted to sentence case with `lowercase` + `::first-letter { uppercase }`.
- **Scale**: the closed scale shifts up one notch (10/11/12/13/14/18/24) and the base is 14px, matching the app's `text-xs`/`text-sm` rhythm.

---

## 7. Gaps — what the contract and hooks can't express yet

1. **Copy is authored in UPPERCASE in JSX** ("BRANCHES", "PASSWORD", "RETRY"). `--label-case`/`--control-case` can only *add* case. The theme fakes sentence case on nav/subtab/panel titles with `lowercase` + `::first-letter`, which mangles acronyms ("STATE SENT TO JEV" → "State sent to jev", "MAX DD" would be "Max dd"). **Proposal**: author labels in sentence case and let Hyperion's `--label-case: uppercase` restore caps; or add a `data-acronym` / `<abbr>` convention that the lowercase rule skips.
2. **Hard-coded `uppercase tracking-wider` in `state.tsx`** (Empty/Error/Stale titles) and `!text-[10px]` in `MetricStat`/`ThemeSwitcher`. `!important` utilities in a layer outrank any theme rule, so the theme can't size those labels. **Proposal**: replace them with the `.label` class / `.metric-label` without `!`, and add `.state-title` and `.state-message` hooks.
3. **No hook for the top-bar structure.** Trade[XYZ] runs a live ticker marquee in the header and a **status footer** (network/websocket/wallet dots, version, links). HYPERTRADE's freshness dot lives in the top bar. **Proposal**: an optional `.app-statusbar` footer slot in `AppShell` (desktop only) and a `TickerMarquee` component fed by `/api/hl/markets`, both inert under Hyperion.
4. **Two tab-indicator colours.** The app uses a white rule for content tabs and gold for category/nav tabs. The contract has one `--color-accent` for `.tab-active`. The theme splits it by selector (`.subtab.tab-active` → white). **Proposal**: add a `--color-tab-rule` token (default = accent).
5. **Segmented controls don't exist as a component.** Governor mode chips, filters and the Supplied/All toggle are built ad hoc from ghost buttons. **Proposal**: a `Segmented` component with `.segmented` / `.segment[aria-pressed=true]` hooks, plus `--color-segment-track` / `--color-segment-active` tokens.
6. **Zebra rows.** Done through `.dt tbody tr:nth-child(odd)` in the theme. **Proposal**: a `--color-row-alt` token (default transparent) consumed by `DataTable` so every theme can opt in without a hook.
7. **Numeric face vs mono face.** The app's numbers are IBM Plex *Sans* with tnum, not a monospace. HYPERTRADE's `--font-mono` doubles as the input and code face, so JSON blocks (DecisionView "STATE SENT TO JEV") render in a proportional face under this theme. **Proposal**: split `--font-numeric` (tables/metrics) from `--font-code` (JSON/pre), with both defaulting to `--font-mono`.
8. **Panel header strip.** The app's cards have no tinted header except gate cards (support), which use slate-900. `--color-panel-header` is global. **Proposal**: a `.panel-header--strip` variant or a `--panel-header-border` token so a theme can drop the divider on plain cards.
9. **Chart internals.** Recharts colours are read from tokens, but grid dash style, axis-line visibility, tooltip radius and last-price tag shape are hard-coded in `CandleChart`/`EquityChart`/`FanChart`. Trade[XYZ] wants dashed horizontal grid only, no axis lines, and a filled price tag on the right axis. **Proposal**: `--chart-grid-dash` (e.g. `3 3`), `--chart-axis-line` (color or `transparent`), `--radius-tooltip`, and a shared `chartTheme()` helper that reads them via `getComputedStyle`.
10. **Page backgrounds / glow.** The glow is painted on `body` from the theme (outside the token contract). **Proposal**: a `--body-image` token (default `none`) applied in `index.css`.
11. **Wordmark.** The bracketed `[▪]` is drawn with pseudo-elements on `.app-wordmark-dot`. **Proposal**: a `--wordmark-case` token plus an optional `.app-wordmark-suffix` slot, so themes can add a bracketed suffix without abusing the dot.
12. **Outcome / probability bars** (`ProbBar`) should follow the Events "fill proportional to probability" pattern in neutral slate. **Proposal**: a `--color-prob-fill` token (default `--color-info-bg`).
13. **Title display face.** Page titles (Portfolio / Earn & Borrow are 18px/500) have no hook: pages render ad hoc `h1`s. **Proposal**: a `.page-title` class with `font-family: var(--font-display)` in the shared layout.
