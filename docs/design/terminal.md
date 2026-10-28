# DESIGN-terminal — TRADE (the Terminal family)

Binding interface brief for docs/SPEC.md § "Intel — LLM trading tools (phase 5)".
It **extends** docs/design/README.md and never overrides it: tokens (§2), contrast (§2.1),
type scale (§2.2), button tiers (§3), responsive contract (§4), shell (§5),
state vocabulary (§6), confirmation vocabulary (§7), motion (§8), a11y (§12)
and themes (§15) all apply unchanged. Where this file is silent, docs/design/README.md
decides. On data shape docs/SPEC.md wins; §13 below lists the fields the UI reads
that SPEC I2 does not name yet.

**No new tokens.** Every color, size and motion below already exists in
`src/ui/index.css` and the theme contract (`src/ui/themes/README.md`), so all
three themes work without edits. Two meanings are assigned to existing tokens:
`--color-info` / `--color-info-bg` mark **model inference** (hypotheses, LLM
edges), extending principle 6 ("speculation is info-blue, never green/red");
`--color-amber` marks **time pressure** (catalyst inside 24 h, preview about to
expire) in addition to staleness.

**Reused as-is:** `Panel`/`PanelHeader`/`PanelBody`, `Button` (ghost, neutral,
danger), `Badge`, `StatusDot`, `Segmented`, `DataTable` (incl. `isSelected`),
`ConfirmDialog`, `MetricStat`, `Sparkline`, `LabWarnings`, `SkeletonRows`,
`EmptyBlock`, `OfflineBlock`, `ErrorBlock`, `StaleBanner`, `AgeStamp`,
`SrcTag` (union extended, §1.6), `fmtUsd`, `fmtAge`, `fmtTs`, `classForPnl`.

**Principle for every surface here:** code detects, the model explains.
Numbers computed by code render as plain values. Words written by the model
render only as claim lines (§2), never as bare prose. No surface predicts
direction, prints a price target, or offers a trade on its own. Orders reach
the Desk venue (paper or testnet) only from an operator's click on a Level 2
dialog: here, the `/order` copilot (§7); on `/`, the Cockpit's APPROVE
(Cockpit section C5). Nothing on this surface places an order on a timer, on
Enter, or on preview.

---

## 1. Shared shell for the family

### 1.1 Routes

| Path | Tab | Content |
|---|---|---|
| `/terminal` | CHANGES | what changed since I last looked (§3); `/terminal?review=1` = Telegram deep link (§1.5); `/?review=1` redirects here with `replace` |
| `/watch` | WATCH | doc/contract/wallet watches (§8); `?id=<id>` selects a watch |
| `/journal` | JOURNAL | trades, per-tag stats, weekly report (§4); `?trade=<id>` selects a trade, `?tag=<tag>` filters |
| `/theses` | THESES | compose + saved list + detail (§5); `?id=<id>` selects a thesis |
| `/query` | QUERY | NL → DSL → SQL → result (§6) |
| `/` | FEED | the landing: ranked opportunity feed, liquidation map, detail (Cockpit section); `/?id=<opportunityId>` selects (`replace: true`) |
| `/order` | ORDER | order copilot (§7) |
| `/desk` | DESK | agentic portfolio desk (docs/design/README.md §10.11) |
| `/asset/:coin` | (drill-in) | asset page (§15.4); a drill-in of CHANGES: renders under TerminalTabs with the CHANGES segment active |

Selection uses query params (the route family is pinned by SPEC I0.1), written
with `replace: true` so back steps between routes, not rows (mobile exception:
§5.1 and the Cockpit detail screen).

### 1.2 Nav (docs/design/README.md §5)

The family is one shell cell, the first: top-bar and mobile label `TRADE`,
glyph `◉` (U+25C9, a text character like the others), link `/`. The shell has
five cells; DESK is a tab here, not a cell.

- Active on every route of the family: `/terminal`, `/watch`, `/journal`,
  `/theses`, `/query`, `/`, `/order`, `/desk` and `/asset/*`
  (`isTerminalPath(pathname)`, beside `isEnginePath` and `isMarketPath`).
- Wordmark click → `/` (the Cockpit feed).
- The freshness cluster is unchanged; per-source health lives in §3.3 and
  the Cockpit health strip (C6).
- Cockpit feed items and Terminal change items are two separate lists (the
  feed has a status machine and cost vs edge; change items have neither). The
  family shares the tab bar, the coin drill (`/asset/:coin`, `CHART →`,
  `INTEL →`, C1) and the action path (Level 2 dialogs, the shared kill
  switch). Neither list is merged into the other.

### 1.3 TerminalTabs (sub-tab strip)

One `SectionTabs` (a `Segmented`, `size: 'md'`, label `trade sections`) directly
under the shell, the LabTabs pattern exactly: `position: sticky;
top: var(--topbar-h)`, row height `var(--subnav-h)` (52px), `bg-body`, z-30.
Path-based: changing a segment navigates. Pages that anchor-scroll under it
use `scroll-mt-[calc(var(--topbar-h)+var(--subnav-h)+8px)]`.

Order and labels (desktop `label` / below-md `short`):

`CHANGES / CHNG · WATCH / WTCH · JOURNAL / JRNL · THESES / THES · QUERY / QRY · FEED / FEED · ORDER / ORDR · DESK / DESK`

Order: a funnel from intel (what changed for my book, the operator's own
record, the tools) to act (what to act on now, place an order, run the desk).
`SectionTabs` has no group separator, so the order alone carries it.

**Mobile: no horizontal scroll by design.** Eight ≤ 4-char short labels at the
`.seg-item` 10px size + 8px padding measure ≈ 350px: they fit at 400px, and
the wrapper's `overflow-x: auto` safety net covers 320px (and a wider theme
`--seg-pad`, 200% zoom). Rejected: a scrolling strip (hidden tabs defeat the
map, DESIGN §4.3/§5.2) and two rows (52px more on every route).

No count suffixes or dots on segments: each would cost a fetch on every route
of the family. Segment `title`s state the route's question: `what changed
since I last looked` · `watch docs, contracts and wallets` · `what my trades
say` · `test a thesis against the data` · `ask the snapshot store` · `what to
act on now` · `preview and place a Desk order` · `agent team, governor and
paper book`. Links reading `← CHANGES` (asset page) point at `/terminal`.

### 1.4 Polling and the hidden tab

**Polling pauses while `document.visibilityState === 'hidden'`**; on becoming
visible each poller refetches once if its last success is older than its
interval, then resumes. Unmounted routes never poll. Refetches update in place.

| Data | Endpoint | Cadence |
|---|---|---|
| Brief (review) | `POST /api/intel/brief` | on open only (§1.5) — never polled; it logs a review |
| Positions + sources | `GET /positions` | 60 s |
| Alerts | `GET /alerts?since=<brief.since>` | 60 s |
| Catalysts | `GET /catalysts?days=14` | 5 min |
| Watchlist | `GET /watchlist` | on mount + after a write |
| Exposure graph | `GET /graph?asset=` | on expand, then 10 min while expanded |
| Journal, theses, watches | their GETs | on mount + after a write; watches list 5 min |
| Order preview | `POST /order/preview` | never polled; it expires (§7.4) |
| Desk venue | `GET /api/desk/status` | on mount of `/order` + 60 s (the Cockpit polls it every 30 s) |

### 1.5 Review semantics and `/terminal?review=1`

`POST /brief` logs a review, so it must fire only on a real open:

- **Mount of `/terminal`** → `POST /brief` once, unless this tab posted one in the
  last 5 minutes (in-memory module cache mirrored to sessionStorage, so it is
  per tab and survives a reload; every storage access is in try/catch and the
  module cache alone still throttles; never localStorage), so hopping between
  sub-tabs does not reset the baseline.
- **`REVIEW NOW`** (ghost) → `POST /brief`; `title` `marks now as reviewed —
  the next brief diffs from here`.
- **`/terminal?review=1`** → `POST /brief`, bypassing the cache; once sent, the
  param is dropped with `navigate('/terminal', { replace: true })`. The old
  Telegram link `/?review=1` redirects here first. Gray Badge `FROM
  TELEGRAM` for this load only; WHAT CHANGED scrolls into view once.
- While a POST is in flight, `GET /brief/latest` (if any) renders at 70% with
  `LAST BRIEF · 2H OLD — REVIEWING…` (pulse) and is replaced in place (the
  DESIGN §10.9 "previous results at 70%" precedent).
- Nothing else (polling, focus, visibility) posts a brief.

### 1.6 Source tags

`SrcTag`'s `Source` union gains `manual`, `desk` and `snap` (snapshot store).
`hl` keeps its jade; the three new ones render gray like `cg`. Uses: position
rows (`MANUAL` / `HL` / `DESK`), journal venue (`HL` / `DESK`), and
snapshot-derived observed claims (`SNAP`).

### 1.7 Staleness rules per panel

Degraded = the age text turns amber; stale = `StaleBanner` appears. Content is
never dimmed except the 70% "superseded" precedents (§1.5, §6, §7.4).

| Panel | Age of | Degraded (amber age) | Stale (StaleBanner) |
|---|---|---|---|
| WHAT CHANGED | newest snapshot ts in the brief | > 30 min | > 2 h, noun `snapshots` |
| NEWS → POSITIONS | newest alert `createdAt` vs last ingest run | ingest > 30 min | ingest > 2 h, noun `news ingest` |
| CATALYSTS | fetch time | fetch failing > 10 min | — (calendar rows don't decay) |
| POSITIONS | last successful `/positions` | > 5 min | > 30 min, noun `positions` |
| EXPOSURE | each edge's `last_verified` | > 48 h (per edge, ClaimAge amber) | — |
| Journal report | `createdAt` | > 7 days | — |
| Thesis detail | `checkedAt` | > 24 h | — |
| Watch row | `checked_at` | > 2 h | > 6 h (row Badge `STALE`, amber) |
| Order preview | preview receipt | `VALID` countdown < 15 s (amber) | expired at 60 s → stale state |

`AgeStamp` prints whole hours, too coarse for 30 min; Intel uses **ClaimAge**
(§2.3) for age text. `StaleBanner` is used as-is.

---

## 2. Claim rendering vocabulary (used on every surface)

Every model-written line is a `Claim` (`src/shared/claims.ts`): `observed`
(text + `source {label, url?}` + `ts`) or `hypothesis` (text only). The server
already drops anything else. The UI makes the two **unmistakable at a glance,
at 390px, in every theme, without color.**

### 2.1 ClaimLine anatomy

```
desktop
│ OBS  HYPE open interest +18.4% in 6 h (z +3.1).          SNAP ↗ · 12M │
│ HYP ┃ Leverage is building into the unlock; a flush is plausible.     │

mobile (<768)
│ OBS  HYPE open interest +18.4% in 6 h  │
│      (z +3.1).                         │
│      SNAP ↗ · 12M                      │
│ HYP ┃ Leverage is building into the    │
│     ┃ unlock; a flush is plausible.    │
```

- **Prefix column**, fixed 4ch, top-aligned: observed → `Badge tone="gray"`
  `OBS`; hypothesis → `Badge tone="info"` `HYP`. The word is the signal.
- **Text**, 12px, hanging indent past the prefix: observed `text-primary`;
  hypothesis `text-muted` + a 2px `--color-info` left rule on the text block
  (inset box-shadow, no layout shift) + 6px padding. Model text is never
  uppercased, truncated or recolored (no green/red numbers inside it).
- **Source + age** (observed only): `SourceLink` then ` · ` then `ClaimAge`.
  Right-aligned on md+ on the same line when it fits, else on its own line
  under the text, left-aligned with the text (mobile always own line).
  Hypotheses print nothing here; the empty slot is part of the signal.
- `title` on the `HYP` badge: `inference by the model — not an observed fact`.
  `title` on `OBS`: `observed: <source label>, <full UTC ts>`.
- Screen readers: the badge carries visually hidden text `observed:` /
  `hypothesis, model inference:` before the line.

**Not italic:** Geist Mono has no italic face (a synthesized slant at 12px
reads as noise) and theme fonts differ; badge word + info rule work on any font.

### 2.2 SourceLink

`.src-tag` styling (9px uppercase, hairline box) with the source `label`:
- internal `url` (starts with `/`, e.g. `/markets/HYPE`) → router `Link`;
- external `url` → `<a target="_blank" rel="noopener noreferrer">` + ` ↗`;
- no `url` → the label as plain tag (not a link).
Snapshot facts (`label: "snapshot"`) render `SNAP` via `SrcTag source="snap"`
and link to `/markets/<COIN>`.

### 2.3 ClaimAge

Relative age, 10px tabular: `40S`, `12M`, `3H`, `2D`. `title` = full
`YYYY-MM-DD HH:mm UTC`. Props: `ts`, `thresholdHours?`; amber over threshold,
`text-secondary` otherwise. Text from the existing `fmtAge`.

### 2.4 ClaimList

An `<ol>` of ClaimLines, 6px row gap, in server order (never re-sorted).
Footer (only when the brief/report trace reports dropped lines): 10px
`text-secondary`: `2 lines dropped — no source or tag`. No list ever mixes
claim lines with untagged prose.

---

## 3. `/terminal` — CHANGES

Purpose: answer **"What changed since I last looked that could affect my
positions?"** in one screen: computed changes, model explanation, calendar,
book, and the exposure map connecting news to the book.

### 3.1 Desktop layout (`lg:`, 12-col grid, gutter 12px)

```
┌ TerminalTabs: [CHANGES|WATCH|JOURNAL|THESES|QUERY|FEED|ORDER|DESK] ─────────────────────────┐
├ REVIEW STRIP ─────────────────────────────────────────────────────────────────────────── 12 ┤
│ 4  THINGS CHANGED · SINCE 9H AGO · 2 ALERTS · NEXT CPI T−1D 04H        [REVIEW NOW]          │
│ (xl)  SOURCES ● MANUAL  ● HL  ✕ DESK  ● SNAP 12M  ● NEWS 18M  ● LLM                          │
├ WHAT CHANGED ─────────────── RANKED BY MATERIALITY ── 7 ┬ NEWS → POSITIONS ──────────── 5 ┤
│ OBS  HYPE OI +18.4% in 6 h (z +3.1).     SNAP ↗ · 12M   │ 0.62 [PUSHED] 14M      [USEFUL][NOISE]│
│ HYP ┃ Leverage is building into the unlock…             │ HYP ┃ Long SOL. The exploit is on  │
│ OBS  SOL funding at 7-day high (z +2.4).  SNAP ↗ · 12M  │     ┃ Jito, which affects LST…     │
│ ──────────────────────────────────────────────────────  │   · already −4.1%, OI −8%        │
│ ASSET     METRIC    Δ        Z      MAT   NOW    BASE   │ [Jito] →COLLATERAL→ [SOL]        │
│ HYPE HELD OI        +18.4%  +3.1   0.71  $1.2B  $1.0B   │ THE BLOCK ↗ · DECRYPT ↗          │
│ SOL  HELD funding   +0.012% +2.4   0.44  …      …       │ ─────────────────────────────── │
│ ETH  WATCH spread   +2.1bp  +2.2   0.11  …      …       │ 0.21 [BATCHED] 2H  …             │
├ POSITIONS & WATCHLIST ──────────────────────────── 8 ┬ CATALYSTS · 14D ─────────────── 4 ┤
│ MANUAL ● · HL ● 0x12…ab · DESK ✕ <error>             │ T−1D 04H  CPI (Sep)  MACRO       │
│ ASSET        NOTIONAL  STOP DIST  UPNL   SIZE  ENTRY…│   BTC ETH · HELD                 │
│ SOL MANUAL   $12.4K    −3.1% 0.8×ATR  +$210   [EDIT] │ T−3D      HYPE unlock 2.1%       │
│ LONG 3×                                              │   HYPE HELD · HYP risk-off       │
│ [+ ADD POSITION]                                     │ [+ ADD CATALYST]                 │
│ WATCHLIST · 6  SOL [l1] ✕  ENA [defi] ✕  [+ ADD]     │                                  │
├ EXPOSURE ──────────────────────────────────────────────────────────────────────────── 12 ┤
│ ▾ SOL · 9 EDGES · 4 PATHS                                                                    │
│   COLLATERAL  Jito → SOL  0.8  [SEED]  verified 2D       │ PATHS  USDC →DEPENDS_ON_STABLE→ … │
│ ▸ HYPE · 6 EDGES                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Mid (`md:`): REVIEW STRIP full width; WHAT CHANGED and NEWS stacked full
width; POSITIONS and CATALYSTS stacked; EXPOSURE full width.

### 3.2 Mobile order (<768)

REVIEW STRIP (xl + `THINGS CHANGED` / `SINCE` + `REVIEW NOW` / source chips,
wrapping) → WHAT CHANGED → NEWS → POSITIONS → CATALYSTS → EXPOSURE. The question first; the book and the map follow.

### 3.3 ReviewStrip

A `Panel` without a title header (the strip is the header), `bg-panel-alt`.

- **xl** (the view's one `text-xl`, `AnimatedDigits`): `brief.items.length`
  + `.label` `THINGS CHANGED`; silent → `0` + `NOTHING CLEARED THE THRESHOLD`.
- `SINCE 9H AGO` from `brief.since` (`title`: full ts + `baseline = snapshot
  nearest your last review`); `2 ALERTS` (click scrolls to NEWS); `NEXT
  <title> T−1D 04H`, the soonest catalyst on held ∪ watched (amber < 24 h,
  click scrolls to CATALYSTS, omitted when none); `FROM TELEGRAM` (§1.5).
- **Sources cluster**, `StatusDot` + word each, 10px. `MANUAL` `HL` `DESK`
  from `/positions` `sources[]` (failed → dot down + `✕` + red-text word,
  `title` = verbatim error; never fatal, SPEC I0.2). `SNAP 12M` (ok < 30 min,
  degraded to 2 h, down beyond). `NEWS 18M` from `brief.ingest` (§13;
  degraded if any source failed, `title` = `source · ok|error · age` lines;
  omitted when absent). `LLM` (degraded, `title` = verbatim reason such as
  `LLM cap reached`, when items exist but `lines` is empty).
- `REVIEW NOW` ghost (§1.5), in flight `REVIEWING…` with pulse.

### 3.4 WhatChangedPanel

Header: `WHAT CHANGED`, the `.label` `RANKED BY MATERIALITY` (the rank key is
named, Lab honesty rule 2), `ClaimAge` of the newest snapshot (§1.7).
StaleBanner `snapshots Nh old` when > 2 h.

Body, top to bottom:

1. **ClaimList** of `brief.lines` (3–5 lines, §2).
2. Hairline.
3. **DiffTable** (`DataTable`, rows = `brief.items`, server order, not
   sortable — materiality is the only order). Row tap/Enter →
   `/markets/:coin`.

| Column | Priority | Render |
|---|---|---|
| `ASSET` | 1 | coin (sm, primary) + 9px tag `HELD` (text-primary) or `WATCH` (secondary) |
| `METRIC` | 1 | display name: `price`, `OI`, `funding`, `premium`, `basis`, `vol 24h`, `depth ±1%`, `depth ±2%`, `spread` |
| `MAT` | 1 | materiality, 2 decimals, tabular; ≥ push threshold → amber text |
| `Δ` | 2 | signed change in the metric's unit (`+18.4%`, `+0.012%`, `+2.1 bp`); **only `price` is green/red**, every other metric prints its sign in `text-primary` (more OI or wider spread is not "good") |
| `Z` | 2 | signed, 1 decimal, `z +3.1`; `—` with `title` `fewer than 24 samples` when null |
| `NOW` | 3 | current value, compact |
| `STOP` | 3 | distance to stop as `−3.1% · 0.8×ATR` when a stop is known, else `—` |
| `BASE` | 4 | baseline value at `brief.since` |
| `WEIGHT` | 4 | exposure weight, 2 decimals (`0.05 floor` in `title` for watch-only) |

**Silent** (`brief.silent`): no claims, no table; EmptyBlock `nothing cleared
z ≥ <minZ> since <age>` (threshold echoed, §13; else `nothing cleared the
threshold since <age>`) + 10px secondary `<n> assets diffed · held ∪ watched`.

**LLM unavailable** (items exist, `lines` empty): the table alone, after one
11px `text-muted` row with a 6px amber square: `no narration — <verbatim
reason>` (fallback `every line failed the claim check`). Never an ErrorBlock:
the computed answer is complete.

### 3.5 NewsFeedPanel (NEWS → POSITIONS)

Header: `NEWS → POSITIONS`, right: ClaimAge of the last ingest. Rows = alerts
since `brief.since`, newest first, plus batched alerts merged into the brief.
Each alert is an **AlertItem** (`<article>`, hairline separated):

- Line 1 (10px): materiality `0.62` (amber ≥ push threshold), Badge
  `PUSHED` (amber, it reached Telegram) or `BATCHED` (gray), ClaimAge, kind
  word when not news (`CATALYST T−24H`, `WATCH CHANGE`), feedback at right.
- Line 2: the alert's **ClaimLine** (usually `HYP`); beneath it, indented,
  the **priced-in suffix** 11px `text-muted`: `· already −4.1%, OI −8%`
  (signs printed, no green/red: context, not PnL).
- Line 3: **ExposurePathChips**: nodes as `.src-tag`-boxed names (11px,
  primary, normal case), edges `→COLLATERAL→` 9px uppercase secondary; wraps
  at nodes; `title` `2 hops · path weight 0.30`.
- Line 4: one SourceLink per cluster source, joined by ` · `.
- **Feedback**: ghost `USEFUL` / `NOISE` (words, not emoji: emoji are OS color
  bitmaps outside the palette); `aria-label`s `mark alert useful` / `mark alert
  as noise`, `aria-pressed` = stored vote, voted one reads `✓ USEFUL` in
  `text-primary`. Level 1, optimistic; failure reverts + compact ErrorBlock.
  No un-vote (no endpoint).

At the panel's foot, **FEEDBACK · 7D** (`GET /feedback/report/latest`, on
mount): the weekly report's worst buckets, one row each, 11px tabular
`<event type> · <edge type> · <n> hops · n <votes> · net −60%`, then the
code-written suggestion verbatim in `text-muted`. Read-only (SPEC I0.12: the
operator tunes by hand). States per §10.

### 3.6 CatalystsPanel (CATALYSTS · 14D)

Rows from `GET /catalysts?days=14`, ascending by `scheduled_at`; rows more
than 1 h past are hidden. **CatalystRow**:

- `T−1D 04H` countdown (sm, tabular; `T−42M` under an hour; amber < 24 h),
  `title` = UTC date-time. Updates each minute (content, not motion).
- Title (sm, `text-primary`, wraps).
- Assets as 9px tags suffixed `HELD`/`WATCH` where true; origin Badge gray
  (`MANUAL`, `GOV`, `MACRO`, `SWEEP`); `size` 10px `text-muted`; direction
  hypothesis always as `HYP` badge + words (`HYP supply overhang`), never
  green/red (SPEC I0.13); SourceLink when present.
- Manual rows: Danger `✕` (`aria-label` `delete catalyst <title>`), Level 2
  `DELETE CATALYST`, body `Delete "<title>" on <date>? Alerts for it stop.`

`+ ADD CATALYST` → inline form: `TITLE`, `WHEN (UTC)` (`datetime-local`,
submitted as UTC), `ASSETS` (comma list), `SIZE` optional; Neutral `ADD`
(`ADDING…`), ghost `CANCEL`; validation `title and time required`, `time must
be in the future`; verbatim ErrorBlock on failure.

### 3.7 PositionsPanel (POSITIONS & WATCHLIST)

Header: `POSITIONS`, right: `$48.2K TOTAL` (`totalNotionalUsd`) + ClaimAge of
the last successful fetch.

**SourcesRow** (10px): `MANUAL ● · HL ● 0x12…ab · DESK ● PAPER`; a failed
source reads red-text + `✕`, with a compact ErrorBlock `HL — <verbatim error>`
+ `RETRY` under the row. Other sources still render.

**PositionsTable** (`DataTable`, rows = `positions[]`, default sort notional
desc). Row tap/Enter → `/markets/:coin`.

- P1 `ASSET`: line 1 coin (sm, primary) + `SrcTag` (`manual`/`hl`/`desk`);
  line 2 side word green/red + leverage `LONG 3×` (9px). P1 `NOTIONAL`
  (`fmtUsd` compact). P1 actions (unlabelled): manual rows only, ghost `EDIT`
  (`aria-label` `edit <coin> position`, stops row-tap propagation).
- P2 `STOP DIST`: `−3.1% · 0.8×ATR` (`title` stop px); no stop → amber Badge
  `NO STOP` (stop proximity drives materiality, so it outranks PnL).
- P3 `UPNL` (signed, `classForPnl`, `—` when null), `SIZE`, `ENTRY`, `MARK`.
- P4 `STOP` (px or `—`), `VENUE` (verbatim, xs).

`+ ADD POSITION` ghost below the table.

**PositionForm** (inline below the table; edit prefills and scrolls into view
once; grid 4 cols lg / 2 mobile): `ASSET` (8ch, `<datalist>` HL universe),
`SIDE` (`Segmented` `LONG | SHORT`, green/red), `SIZE` (coins > 0), `ENTRY`,
`STOP` (optional), `LEVERAGE` (1–50, default 1), `VENUE` (default `manual`).
Neutral `SAVE` (`SAVING…`), ghost `CANCEL`; edit adds Danger `DELETE` (Level 2
`DELETE POSITION`, body `Delete the manual <SIDE> <coin> position (<size> @
<entry>)? It stops counting toward exposure and materiality.`). Validation
`size must be above 0`, `stop is on the wrong side of entry for a LONG`; 400 →
verbatim ErrorBlock above the buttons.

**Watchlist** (below a hairline): `.label` `WATCHLIST · 6`, chips of coin +
9px tag chips + `✕` (Level 1, no confirm; `aria-label` `remove <coin> from
watchlist`); `+ ADD` → one-row form `ASSET`, `TAGS` (comma list), `ADD`. Every
write is a full `PUT /watchlist`. Fallback (§13 `fallback`): gray Badge
`FALLBACK` + `empty — using DESK_WATCHLIST`, chips without `✕`.

### 3.8 ExposurePanel

Header: `EXPOSURE`, right: `.label` `HELD ASSETS · 1–2 HOPS`. One
**ExposureAssetRow** per held asset (watch-only assets excluded), sorted by
notional desc; the first is expanded on load. Collapsed: `▸ SOL · 9 EDGES · 4
PATHS` (`aria-expanded`). Expanding fetches `GET /graph?asset=SOL`.

Expanded, two columns lg (edges 7 / paths 5), stacked on mobile:

- **Edges** grouped by type in weight order (`DIRECT, COLLATERAL,
  SETTLES_ON, DEPENDS_ON_STABLE, BRIDGE, PRIMARY_VENUE, NARRATIVE,
  MACRO_BETA`, `.label` + count). Row: `src → dst` (sm), weight (xs), origin
  Badge `SEED` gray / `LLM` info (model-proposed = HYP meaning) / `USER` gray,
  SourceLink, `verified 2D` ClaimAge (amber > 48 h). User edges: Danger `✕`,
  Level 2 `DELETE EDGE`, body `Delete your edge <src> →<type>→ <dst>?`.
- **Paths**: up to 8 two-hop paths to held ∪ watched, each as
  ExposurePathChips + `w 0.30` (xs).
- `+ ADD EDGE` ghost → inline form: `FROM` (text), `TYPE` (`<select>` of the
  8 types), `TO` (prefilled with the asset), `SOURCE URL` (optional). Neutral
  `ADD EDGE`. Stored as `origin: user`.

---

## 4. `/journal`

Purpose: what my own trades say — where I leak, where I have an edge.

### 4.1 Desktop (`lg:`)

```
┌ JOURNAL BAR ────────────────────────────────────────────────────────────────── 12 ┐
│ 38 TRADES (xl) · [7D|30D|90D] · HL ● DESK ●            [TAG UNTAGGED · 7]          │
├ WEEKLY REPORT ─ WEEK OF 2026-10-05 ── GEN 2D AGO ─ 5 ┬ BY TAG ─ RANKED BY EXPECTANCY ─ 7 ┤
│ LEAKS                                                │ TAG        N   EXP     WIN  AVG R  │
│ OBS  Breakouts in the asia session lost 1.4R avg…    │ pullback   9   +0.41R  67%  +0.6R  │
│      [hl:BTC:8812] [desk:SOL:51]                     │ breakout   7   −0.38R  29%  −0.5R  │
│ EDGES                                                │ ...                               │
│ HYP ┃ Funding-fade entries held under 6 h …          │                                   │
│ [GENERATE REPORT]                                    │                                   │
├ TRADES ──────────────────────────────────────── 8 ┬ TRADE ──────────────────────── 4 ┤
│ CLOSED   COIN      SIDE   R      HOLD  MAE/MFE  TAGS│ hl:BTC:8812  (sticky, top 92px)  │
│ 10-12    BTC HL    LONG   −1.2R  3H    −1.6/+0.4 …  │ entry state: funding z +1.1 …    │
│ ...                                                  │ NOTE [ inline textarea ] [SAVE]  │
└──────────────────────────────────────────────────────┴──────────────────────────────────┘
```

Mobile order: JOURNAL BAR → WEEKLY REPORT → BY TAG → TRADES → TRADE (the
detail panel renders under the table and scrolls into view once when a row
is selected).

### 4.2 Components

- **JournalBar**: xl `trades.length` + `TRADES`; `Segmented` `7D | 30D | 90D`
  (label `journal window`, default 30D, persisted per browser in try/catch);
  sources from `sources[]` (dot + word, failed → red-text + `title` error);
  ghost `TAG UNTAGGED · n` (`POST /journal/tag`, Level 1, `TAGGING…` pulse,
  disabled at n = 0, `title` `the model tags each untagged trade's setup
  type`). Verbatim ErrorBlock under the bar on failure.
- **TradesTable** (`DataTable`, newest close first, `isSelected` = the
  `?trade` row; row tap/Enter sets `?trade=<id>`; `id="trade-<id>"` on rows
  for report links). A `?tag=` filter shows a chip `TAG: breakout ✕` above.

  Columns: P1 `COIN` (+ `SrcTag` `hl`/`desk`), `SIDE` (word, green/red), `R`
  (signed `+1.4R`, green/red; `—` + `title` `no stop known`); P2 `CLOSED`
  (`MM-DD HH:mm` UTC), `HOLD` (`3H`, `2D 4H`); P3 `MAE/MFE` (`−1.6 / +0.4`, R
  when known else %), `TAGS` (gray 9px chips, `—`); P4 `PNL` (`closedPnl`,
  `classForPnl`), `OPENED`, `SESSION` (`ASIA`/`EU`/`US`/`OFF`), `NOTE` (40ch,
  `text-muted`).

- **TradeDetail** (selected trade; desktop sticky at 92px): id (xs, `title`
  full), all table fields as label/value pairs, **entry state** row (`FUNDING
  z +1.1 · OI z −0.4 · 24H −2.1%` — computed values, plain), tags, and the
  **NoteEditor**: textarea (3 rows, max 280 chars, counter `120/280`),
  Neutral `SAVE NOTE` (`PUT /journal/:tradeId/note`, Level 1, `SAVING…`),
  saved state `SAVED ✓` for 3 s then idle. The model's note summary, when
  present, renders below as a ClaimLine. No selection → EmptyBlock `select a
  trade`.
- **TagStatsTable** (`DataTable`, rows = `stats`, server order = expectancy
  desc, header label `RANKED BY EXPECTANCY`): P1 `TAG`, `N`, `EXP` (signed R,
  green/red); P2 `WIN` %, `AVG R`; P3 `HOLD`; P4 `MAE`, `MFE`. `N < 5` → amber
  Badge `FEW` beside the tag, `title` `fewer than 5 trades — not evidence`.
  Row tap sets `?tag=` and scrolls to TRADES.
- **ReportCard**: header `WEEKLY REPORT · WEEK OF <date>` + ClaimAge
  (threshold 168 h). Sections `.label` `LEAKS` (top 3) and `EDGES` (top 2),
  each item a ClaimLine followed by **TradeIdLinks**: 9px boxed chips of the
  trade ids (`hl:BTC:8812`); click sets `?trade=` (and the window to 90D if
  the trade is outside the current one) and scrolls to that row. Neutral
  `GENERATE REPORT` (`POST /journal/report`, `GENERATING…` pulse). Footer
  10px secondary: `historical record`.

---

## 5. `/theses`

Purpose: write a thesis, see which of its claims the data supports or
contradicts, and what would prove it wrong.

### 5.1 Desktop (`lg:`)

```
┌ COMPOSE ───────────────────────────── 4 ┬ THESIS ──────────────── LAST CHECKED 2H AGO ─ 8 ┤
│ [ textarea, 8 rows                    ] │ "HYPE grinds higher into the unlock because…"    │
│ [        STRESS-TEST        ]           │ 1 CONTRADICTED (xl) · 4 SUPPORTED · 2 UNKNOWN     │
├ SAVED · 5 ──────────────────────────────┤ [RECHECK]                              [DELETE]  │
│ ▸ HYPE grinds higher…  1✗ 4✓ 2?  2H     │ CLAIMS & ASSUMPTIONS                              │
│   ETH/BTC bottoming…   0✗ 3✓ 1?  1D     │ [CONTRADICTED] CLAIM  OI keeps rising             │
│                                         │   check: HYPE OI change 24h > +5%                 │
│                                         │   now −3.2% · SNAP ↗ · 12M                        │
│                                         │ INVALIDATION                                       │
│                                         │ · BTC daily close < $79.2K  [UNKNOWN]             │
│                                         │ WHAT HAS TO BE TRUE FOR THIS TO BE WRONG          │
│                                         │ HYP ┃ Unlock recipients sell into strength…       │
└─────────────────────────────────────────┴───────────────────────────────────────────────────┘
```

Mobile: without `?id` — COMPOSE, then SAVED. With `?id` — ghost `← THESES`,
then the detail only; on mobile, selecting from the list sets `?id` with
`push` (the one exception to §1.1) so the back button returns to the list.

### 5.2 Components

- **ThesisComposer**: `.label` `THESIS`, textarea (8 rows, max 2000 chars,
  placeholder `HYPE grinds higher into the unlock because perp OI keeps
  rising while funding stays flat`), Neutral `STRESS-TEST` at `--control-lg`
  (`POST /theses`; in flight `EXTRACTING…` pulse + 10px hint `the model
  extracts claims, code checks each one — up to ~30 s`). Success → select the
  new thesis. Verbatim ErrorBlock under the button. Disabled when empty.
- **ThesisList**: rows (`--row-h`, focusable, `aria-selected`): `▸` on the
  selected row, first line of the text (ellipsis, `title` full), counts as
  `1✗ 4✓ 2?` with visually hidden words, ClaimAge of `checkedAt`.
  Contradicted count > 0 → its number in red-text.
- **ThesisDetail**:
  - Thesis text verbatim, base 13px, `text-muted`.
  - xl = contradicted count + `CONTRADICTED` (the number to face), then `4
    SUPPORTED · 2 UNKNOWN`; ClaimAge `LAST CHECKED 2H AGO` (24 h), Neutral
    `RECHECK` (`POST /theses/:id/check`, `CHECKING…`), Danger `DELETE`
    (Level 2 `DELETE THESIS`, `Delete this thesis and its check history?`).
  - **CheckRows** (`CLAIMS & ASSUMPTIONS`), contradicted first, then unknown,
    then supported: status Badge (`SUPPORTED` green, `CONTRADICTED` red,
    `UNKNOWN` gray), kind word `CLAIM`/`ASSUMPTION` (xs secondary), the
    extracted text (sm, primary — it restates the operator's own words), then
    `check:` + the check typeset in our language (`HYPE price < $79.2K`,
    `BTC funding positive`, `HYPE OI change 24h > +5%`, `metric fred.DGS10 ≥
    4.5`, `event since 48h: "<query>"`, `no automatic check` for `unknown`),
    then evidence: observed value + SourceLink + ClaimAge (`now −3.2% · SNAP
    ↗ · 12M`). Unknown with no data → `no data`.
  - **Invalidation** list: each condition as text + its status Badge when it
    maps to a check.
  - **What has to be true for this to be wrong**: ClaimList (normally all
    `HYP`).
  - Footer 10px secondary: `checks are code over stored data; the model only
    extracted them`.

---

## 6. `/query`

Purpose: ask a question of the snapshot store in words, see exactly what ran.

### 6.1 Desktop (`lg:`)

```
┌ QUESTION ───────────────────────────────────────────────────────────────────── 12 ┐
│ [ Which watched coins had funding z above 2 and OI up 10% in 24h?     ] [PARSE]     │
│ examples: [held coins with widest spread today] [OI up >20% in 7d] […]               │
├ DSL (EDITABLE JSON) ─────────────────────────── 7 ┬ SQL (READ-ONLY) ──────────── 5 ┤
│ [ textarea, monospace, 14 rows                  ] │ select … from intel_snapshots  │
│ ✓ valid JSON  /  ✗ line 4: unexpected "}"         │ where … $1 $2                  │
│                                                   │ params: ["SOL", 2]             │
├───────────────────────────────────────────────────┴────────────────────────────────┤
│ [ RUN ]  read-only · 5 s timeout · ≤ 500 rows · ≤ 90 days                            │
├ RESULT · 42 ROWS · 312 MS ─────────────────────────────────────────────────────── 12 ┤
│ asset   ts                 funding_z  oi_change_24h                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Mobile order: QUESTION → DSL → SQL → RUN row → RESULT.

### 6.2 Components and flow

- **QueryInput**: one-line input (wraps to a textarea at > 80 chars), `.label`
  `QUESTION`, Neutral `PARSE` (`POST /query/parse`, `PARSING…`). Enter
  submits. Three ghost example chips fill the input (never auto-run).
- **DslEditor**: textarea (14 rows lg / 10 mobile), 12px mono,
  `spellcheck=false`, the parsed `dsl` pretty-printed. Validity line: `✓ valid
  JSON` (secondary) or `✗ <parse error>` (red-text); client checks syntax
  only, server zod is the authority.
- **SqlBlock**: read-only `<pre>` 11px, `bg-panel-alt`, max-height 280px lg /
  160px mobile, `params` line, ghost `COPY`. After a DSL edit: 70% + 10px
  `DSL edited — SQL recompiles on RUN`; the RUN response's `sql` replaces it.
- **RUN**: Neutral, `--control-lg`, the view's primary action (`POST
  /query/run {dsl}`, `RUNNING…`); disabled while the JSON is invalid or
  empty. Constraint line beside it, 10px secondary: `read-only · 5 s timeout
  · ≤ 500 rows · ≤ 90 days`. No raw-SQL editing exists (SPEC I4).
- **ResultTable**: columns come from the response, so priority hiding does
  not apply; it is the §4.4 escape hatch: `.table-scroll`, sticky first
  column, header row sticky. Numbers right-aligned tabular; timestamps as
  `MM-DD HH:mm` with `title` full. Header `RESULT · 42 ROWS · 312 MS`; at 500
  rows an amber Badge `LIMIT 500`. No xl on this view (the result is a table).

Parse/run errors render **verbatim** under the step that failed (zod paths,
timeouts, Postgres messages); a failed run keeps the prior result at 70%.

---

## 7. `/order` — order copilot

Purpose: turn an order described in words into an exact, governor-checked
preview, and place it on the Desk venue only after an explicit confirm.

### 7.1 Signalling a paper/testnet order (Money tier stays retired)

No real-money path exists (Desk venue only: paper or HL testnet; mainnet
refused server-side), so the Money tier stays retired. A fill on the Desk book
still cannot be undone, so it is signalled by **words and placement**:

1. **OrderBanner** (persistent, top of the view, all breakpoints, not
   dismissible): full-width strip, `bg-panel-alt`, 1px border, 11px
   `text-muted`: `[VENUE] Operator orders only — preview, then your confirm,
   then the Desk venue. No autonomous execution. Paper or testnet only.
   Mainnet is refused.`
2. **VenueBadge**, the Desk page precedent: `PAPER` info Badge; `TESTNET`
   amber Badge (a live exchange, even if test funds). Shown in the banner,
   the preview header, the dialog title and the confirm label.
3. **Confirm label names the venue**: `CONFIRM PAPER ORDER` /
   `CONFIRM TESTNET ORDER`; the dialog's confirm reads `PLACE PAPER ORDER` /
   `PLACE TESTNET ORDER`.
4. **Level 2** (DESIGN §7) via the existing `ConfirmDialog`, **no typed
   word** (Level 3 is reserved for the kill switches; the preview card is the review, the
   dialog restates it). Its Danger confirm reads as "irreversible" here.

If the Desk status reports a venue other than paper/testnet, or is
unreachable, the composer still previews but CONFIRM is disabled with the
10px red-text line `venue unknown — open DESK to check` (or the verbatim
mainnet refusal).

### 7.2 Desktop (`lg:`)

```
┌ ORDER BANNER: [PAPER] Operator orders only — preview, then your confirm, then … ─ 12 ┐
├ DESCRIBE ─────────────────────────── 5 ┬ PREVIEW ─────────── [PAPER] · VALID 0:42 ─ 7 ┤
│ [ long eth 3x 1.5k, stop under         │ LONG ETH 3×                         (lg)      │
│   yesterday's low                    ] │ 0.8% (xl)  RISK OF BOOK · $78.90               │
│ [        PREVIEW        ]              │ SIZE 0.42 ETH   NOTIONAL $1,512   ENTRY MARKET │
│ examples: [short 0.5% of book SOL …]   │   ≈ $3,600.1                                   │
│ ▸ ADJUST                               │ STOP $3,412.5 · prev-day low (10-12) · −5.2%   │
│   ASSET [ETH] SIDE [LONG|SHORT]        │ LIQ $2,431.0 · −32.5% from entry               │
│   LEV [3] SIZE [$1500|% BOOK]          │ TARGET — (R:R check skipped)                    │
│   ENTRY [MARKET|LIMIT] STOP [kind][v]  │ GOVERNOR [CLIPPED] size 0.60 → 0.42 ETH        │
│   [RE-PREVIEW]                         │ ▪ target missing — R:R not checked (amber)     │
│                                        │ PARSED FROM "long eth 3x 1.5k stop under…"     │
│                                        │ [      CONFIRM PAPER ORDER      ]              │
└────────────────────────────────────────┴────────────────────────────────────────────────┘
```

Mobile order: banner → DESCRIBE (ADJUST collapsed) → PREVIEW; CONFIRM full
width at the card's bottom.

### 7.3 Components

- **OrderComposer**: textarea (4 rows), `.label` `DESCRIBE THE ORDER`,
  Neutral `PREVIEW` `--control-lg` (`POST /order/preview {text}`,
  `PREVIEWING…`); fill-only example chips (`long ETH 3x $1500, stop below
  yesterday's low`, `short SOL 0.5% of book, stop 2 ATR`).
- **AdjustDisclosure** (`▸ ADJUST`, collapsed by default; prefilled from the
  last preview's `intent`): `ASSET` text, `SIDE` Segmented (green/red tone),
  `LEV` number 1–50, `SIZE` number + Segmented `USD | % BOOK`, `ENTRY`
  Segmented `MARKET | LIMIT` (+ px input for limit), `STOP` `<select>`
  (`price · pct · prev-day low · prev-day high · ATR multiple`) + value input
  (hidden for prev-day kinds), `TARGET` optional px. Ghost `RE-PREVIEW` →
  `POST /order/preview {intent}`. Inline red-text validation.
- **PreviewCard** (from `{intent, resolved, verdict, warnings}`):
  - Header: `PREVIEW`, VenueBadge, `VALID 0:42` countdown (§7.4).
  - Hero (lg): side word green/red + coin + `3×`.
  - xl: `resolved.riskPct` as `0.8%` + `.label` `RISK OF BOOK` + `$78.90`
    (`riskUsd`). Risk is the governor's language, so it is the headline.
  - Facts grid (label xs over value sm, `grid-cols-2 md:grid-cols-3`):
    `SIZE` (coins), `NOTIONAL`, `ENTRY` (`MARKET ≈ <px>` or `LIMIT <px>`),
    `STOP` (px), `LIQ` (px + `−32.5% from entry`), `TARGET` (px or `—`).
  - **Stop resolution line** (10px `text-muted`, under STOP): how the stop
    was resolved, from the intent's stop kind: `as given`, `−5% from entry`,
    `prev-day low (2026-10-12 candle)`, `prev-day high (…)`, `2 × ATR14 1h =
    $187.6` — plus the distance `−5.2%`.
  - **Governor row**: `GOVERNOR` label + verdict Badge: `PASS` green,
    `CLIPPED` amber, `REJECTED` red; the clip as `size 0.60 → 0.42 ETH` (or
    the clipped field) in `text-primary`; verdict reasons verbatim, 11px.
  - **Warnings**: `LabWarnings` (verbatim). Then `PARSED FROM "<text>"`
    (10px secondary, verbatim input — what the model read).
  - **CONFIRM** button: Neutral, `--control-lg`, full width, label per §7.1.
    Disabled with a 10px reason line when: verdict `REJECTED` (`governor
    rejected — adjust and re-preview`), preview stale, venue unknown.
- **Confirm flow**: `ConfirmDialog` title + confirm `PLACE PAPER ORDER` (or
  `TESTNET`), cancel focused, body naming everything: `LONG 0.42 ETH (≈ $1,512)
  at market on PAPER, stop $3,412.5, liq $2,431.0. Risks 0.8% of the book
  ($78.90). Nothing goes to mainnet.` → `POST /order/confirm {intent,
  previewHash}` (`busy`). Success → **OrderResult**: Badge `PLACED · PAPER`,
  fill summary, ClaimAge, ghost `OPEN DESK →`, ghost `NEW ORDER` (keeps the
  composer text). Non-409 failure → dialog stays open, verbatim (DESIGN §7).

### 7.4 Stale preview

- The card starts a 60 s countdown at receipt: `VALID 0:42` (10px tabular;
  amber under 15 s). It is content, so it still ticks under reduced motion.
- At 0, or on a **409** (marks moved > 0.5% or > 60 s): the dialog closes,
  the card body drops to 70% (not actionable, like a dead socket), an amber
  strip reads `preview stale — marks moved or 60 s passed; re-preview before
  confirming` (409: server message verbatim), and CONFIRM becomes Neutral
  `RE-PREVIEW` (same intent).
- Editing ADJUST also marks the card stale until RE-PREVIEW.

---

## 8. `/watch`

Purpose: watch a doc page, a contract or a wallet for changes, and see what
changed in words, routed to exposed assets.

### 8.1 Desktop (`lg:`)

```
┌ WATCHES · 6 ───────────────────────────────────── 5 ┬ CHANGES · Jito docs ─────────── 7 ┤
│ KIND      TARGET            ASSET  CHECKED  STATE   │ [CHECK NOW]               [DELETE]│
│ URL       docs.jito…/fees   SOL    12M      ●       │ url https://docs.jito… ↗  SOL     │
│ CONTRACT  0x1234…cdef ETH   ENA    1H       ✕ err   │ 2026-10-13 09:12 UTC · 3H         │
│ WALLET    0xabcd…0001 ARB   ARB    3H       ●       │ OBS  Fee section now lists 8%…    │
│ [+ ADD WATCH]                                       │ HYP ┃ Higher fees could reduce…    │
│ KIND [URL|CONTRACT|WALLET] TARGET [      ]          │ ▸ DIFF (12 lines)                 │
│ CHAIN [eth ▾] ASSET [SOL] LABEL [   ] [ADD]         │ 2026-10-10 …                      │
└─────────────────────────────────────────────────────┴───────────────────────────────────┘
```

Mobile: without `?id` — WATCHES (table + add form); with `?id` — `← WATCHES`
then CHANGES (same push/back rule as §5.1).

### 8.2 Components

- **WatchesTable** (`DataTable`, `isSelected` = `?id`): P1 `TARGET` (label
  when set, else target shortened `0x1234…cdef` / host+path; `title` full),
  `STATE` (StatusDot ok, or `✕` red-text with `title` = verbatim `error`);
  P2 `KIND` (`URL` / `CONTRACT` / `WALLET`), `CHECKED` (ClaimAge, amber > 2 h;
  `STALE` amber Badge > 6 h); P3 `ASSET`; P4 `CHAIN`. Rows with `error`
  also show the error text as a 10px red-text second line at lg.
- **WatchForm** (inline, `+ ADD WATCH`): `KIND` Segmented `URL | CONTRACT |
  WALLET`, `TARGET`, `CHAIN` `<select>` (not for URL), `ASSET` (required — the
  graph entry point), `LABEL` optional; Neutral `ADD` (Level 1). Validation
  `enter an https URL` / `enter a 0x address (40 hex)`; URL hint (10px):
  `JS-rendered or bot-blocked pages fail visibly`.
- **WatchChanges** (selected watch): header label + Neutral `CHECK NOW`
  (`POST /watches/:id/check`, `CHECKING…`) + Danger `DELETE` (Level 2:
  `DELETE WATCH`, body `Stop watching <label|target>? Its change history goes
  with it.`). Meta line: kind, full target (link for URL, explorer-free text
  for addresses), asset, last checked ClaimAge, error ErrorBlock when set.
  Then one **ChangeEntry** per change, newest first: detected time + ClaimAge;
  ClaimList summary (§2); for contracts the computed facts as plain rows
  (`code hash changed`, `implementation 0x… → 0x…`, `admin unchanged`); for
  wallets `balance Δ`, `nonce Δ`; a `▸ DIFF (n lines)` disclosure for URL
  watches showing the line diff in `<pre>` 11px (`+` lines green-text, `−`
  lines red-text, signs printed), max-height 320px with internal scroll; and
  the alerted assets as tags when the mapper routed it (`ALERTED SOL`).

---

## 9. `/overview`

Removed. `/overview` redirects to `/markets`; its metrics strip is the MARKET
header (docs/design/README.md §10.2).

---

## 10. State → surface matrix

The per-panel state copy lives here; panel sections above only add states
that this table cannot hold. `RETRY` accompanies every ErrorBlock/OfflineBlock.

| Surface | Loading | Empty | Error | Stale / other |
|---|---|---|---|---|
| ReviewStrip | SkeletonRows (1 row); last brief at 70% + `REVIEWING…` | xl `0` + `NOTHING CLEARED THE THRESHOLD` | ErrorBlock (brief POST failed) | source dots; `FROM TELEGRAM` |
| What changed | SkeletonRows; last brief at 70% | EmptyBlock silent copy (§3.4); EmptyBlock `no brief yet` before the first brief | ErrorBlock / OfflineBlock | ClaimAge amber > 30 min; StaleBanner `snapshots Nh old` > 2 h; no-narration row |
| News → positions | SkeletonRows | EmptyBlock `no news touched your positions since <age>` | ErrorBlock | StaleBanner `news ingest Nh old` > 2 h |
| News feedback (FEEDBACK · 7D) | SkeletonRows (2) | EmptyBlock `no noisy buckets this week` | ErrorBlock / OfflineBlock | — |
| Catalysts | SkeletonRows | EmptyBlock `no catalysts in the next 14 days` + `ADD CATALYST` | ErrorBlock | countdown amber < 24 h |
| Positions | SkeletonRows | EmptyBlock `no positions — add one, or set DESK_WATCH_ADDRESS` + `ADD POSITION` (only when every source is ok and empty) | per-source ErrorBlock; OfflineBlock when `/positions` is unreachable | StaleBanner `positions Nh old` > 30 min |
| Watchlist | SkeletonRows | `FALLBACK` Badge + `empty — using DESK_WATCHLIST` | ErrorBlock under the chips | — |
| Exposure | SkeletonRows per asset row | panel: EmptyBlock `hold a position to see its exposure`; row: EmptyBlock `no edges — the daily refresh adds them for held and watched assets` | ErrorBlock per row, others unaffected | edge ClaimAge amber > 48 h |
| Journal trades | SkeletonRows | EmptyBlock `no closed trades in <window>` (the selected window: `7 days`, `30 days`, `90 days`) | ErrorBlock / OfflineBlock | failed source inline in JournalBar |
| Journal tag stats | SkeletonRows | EmptyBlock `no tagged trades — TAG UNTAGGED` | ErrorBlock | `FEW` Badge for N < 5 |
| Journal report | SkeletonRows; `GENERATING…` | EmptyBlock `no report yet` + `GENERATE REPORT` | verbatim ErrorBlock (LLM failure, cap) | ClaimAge amber > 7 d |
| Thesis composer | `EXTRACTING…` | — | verbatim ErrorBlock under STRESS-TEST | — |
| Thesis list | SkeletonRows | EmptyBlock `no theses yet — write one above` | ErrorBlock | — |
| Thesis detail | SkeletonRows; `CHECKING…` | EmptyBlock `select a thesis` / `thesis not found` (bad `?id`) | ErrorBlock; recheck failure → ErrorBlock under RECHECK, previous results stay | ClaimAge amber > 24 h |
| Query DSL/SQL | `PARSING…` | EmptyBlock `ask a question, or paste a DSL` (DSL stays editable) | verbatim ErrorBlock under QUESTION | SQL at 70% after a DSL edit |
| Query result | `RUNNING…` | EmptyBlock `run a query` / `0 rows` | verbatim ErrorBlock under RUN; OfflineBlock | `LIMIT 500` Badge; prior result at 70% after a failed run |
| Order composer | `PREVIEWING…` | — | verbatim ErrorBlock (parse failure, unknown coin, LLM unavailable) | — |
| Order preview | — | EmptyBlock `describe an order to preview it` | dialog keeps the verbatim error (non-409) | stale state §7.4; `REJECTED` disables CONFIRM |
| Order banner venue | `VENUE …` gray until Desk status lands | — | red line `venue unknown — open DESK to check` | — |
| Watches | SkeletonRows | EmptyBlock `nothing watched — add a doc page, contract or wallet` + `ADD WATCH` | ErrorBlock / OfflineBlock | row `STALE` Badge > 6 h; row error line |
| Watch changes | SkeletonRows; `CHECKING…` | EmptyBlock `select a watch` / `no changes since <created>` | ErrorBlock | — |

Every cell is a DESIGN §6 named pattern or a pulse label. No spinners, no
bespoke states. Server strings (errors, warnings, governor reasons, claim
text, 409 messages) render **verbatim**; the UI never rewrites them.

---

## 11. Keyboard and a11y (on top of DESIGN §12)

- TerminalTabs: `Segmented` radiogroup (arrows move and navigate).
- ClaimLines: `<li>` + hidden prefix (§2.1); external SourceLinks add hidden
  `(opens in a new tab)`.
- Tables are DataTable `<table>`s: focusable rows, Enter = row action; inner
  buttons are their own tab stops.
- AlertItem is an `<article aria-label="Alert: <asset>, materiality 0.62">`;
  feedback buttons use `aria-pressed`.
- Countdowns (`T−1D 04H`, `VALID 0:42`) are **not** live regions. The only
  live regions are ErrorBlocks (`role="alert"`) and one `aria-live="polite"`
  line on `/terminal` announcing `4 things changed since 9 hours ago` when a brief
  lands, and on `/order` announcing `preview ready` / `preview stale`.
- Inline forms: visible `.label` per input; first field focused on open;
  `Esc` closes and refocuses the opener. Trade-id chips are real links
  (`href="?trade=<id>"`).
- Color never alone: `OBS`/`HYP` words; side words; `✓/✗/?` with hidden
  words; `PUSHED`/`BATCHED`, `PASS`/`CLIPPED`/`REJECTED`, `SUPPORTED`/
  `CONTRADICTED`/`UNKNOWN` are words; every computed number prints its sign.
- Touch: all controls read `--control-*`/`--tap-min`; feedback buttons and
  `EDIT` are ≥ 44px on coarse pointers.

---

## 12. Where docs/design/README.md points here

README §5 (the Terminal family is cell 1, TRADE), §7 (Level 2 order
dialogs, Level 3 kill switches), §10 (route map; §10.2 is the MARKET-header metrics strip), §11
(shared rows `ClaimLine`, `ClaimList`, `ClaimAge`, `SourceLink`, `VenueBadge`;
`SrcTag` union incl. `manual`, `desk`, `snap`; the Intel and Cockpit
component groups from §14 and C9) and §13 (one row per route here, defined by
§10 of this file). The theme README's `--color-info` role also marks model
inference (HYP claims, LLM-proposed edges).

---

## 13. Fields the UI reads that SPEC I2 does not name

Pinned in `src/shared/intel.ts` (the contract both sides import); names
below are the contract's. If the server cannot provide one, the UI omits the
element as stated.

| Field | Used by | If absent |
|---|---|---|
| `DiffItem {asset, metric, held: boolean, from (baseline value), to (current value), delta, deltaUnit: 'pct'\|'bps'\|'usd'\|'abs', z, materiality, exposureWeight, stopProximity, stopDistPct?, stopDistAtr?, ts, baselineTs}` | DiffTable, snapshot age | `ts` absent → snapshot age from the newest observed `snapshot` claim |
| `Brief.threshold? {minZ, pushMateriality}` | silent copy, amber MAT | generic silent copy; MAT never amber |
| `Brief.trace.error?`, `Brief.trace.dropped?` (`trace.model` is null when no provider was called) | no-narration row, dropped footer | generic reason; no footer |
| `Brief.ingest? [{source, ok, lastRunAt: string\|null, error?}]` | NEWS dot, news staleness | NEWS dot omitted; staleness from newest alert |
| `Brief.diffedCount?` | silent sub-line | sub-line omitted |
| `Alert {id, kind, asset, title, line: Claim, path: [{from, to, type}], hops, pathWeight, pricedIn: {pricePct, oiPct: number\|null, since}\|null, materiality, route: 'push'\|'batch', feedback: 1\|-1\|null, sources: [{label, url?}], window: '24h'\|'1h'\|null, createdAt}` (vote is the request body of `POST /alerts/:id/feedback`) | AlertItem | — |
| `Catalyst {eventId, title, type, scheduledAt, assets[], exposed[], origin, catalyst: {size?, directionHypothesis?}\|null, tag, sources: [{label, url?}]}` (first source is the link) | CatalystRow | — |
| `GET /watchlist` → `fallback: boolean` | FALLBACK badge | badge omitted |
| `Trade {id, venue, asset, side, openedAt, closedAt, holdMs, r, mae, mfe, maeUnit: 'r'\|'pct', pnlUsd, feesUsd, session, entryState {fundingZ, oiZ, change24hPct}, tag: string\|null, note: string\|null, noteSummary: Claim\|null}` (one setup tag per trade) | trades table, detail | — |
| `Thesis {id, text, assets[], createdAt, checkedAt, claims: [{kind: 'claim'\|'assumption', text, check, status, evidence? {value, source: {label, url?}, ts}}], invalidation: [{text, status?: 'triggered'\|'clear'\|'unknown'}], wrongIf: Claim[]}` | theses | — |
| `order/preview` → `previewHash`, `markPx`, `expiresAt`, `venue`, `verdict {decision: 'approve'\|'clip'\|'reject', reasons[], warnings[], clip?: string}` (the Desk governor Verdict mapped by `toOrderVerdict`) | PreviewCard, confirm | — |
| `Watch` / `WatchChange {id, ts (detected at), lines: Claim[] (summary), facts: string[], diff: string\|null, alertedAssets[]}` | watch view | — |

---

## 14. Component boundaries

Route pages under `src/ui/pages/terminal/`; panels and cards under
`src/ui/components/intel/`. Data via the typed client `src/ui/lib/intel.ts`.

| Component | File | Props |
|---|---|---|
| `TerminalTabs` | `components/intel/TerminalTabs.tsx` | none (reads location); exports `terminalTabOf(pathname)`, `isTerminalPath(pathname)` |
| `ClaimLine` / `ClaimList` | `components/intel/ClaimLine.tsx`, `ClaimList.tsx` | `claim: Claim` / `claims: Claim[]`, `dropped?: number` |
| `ClaimAge` | `components/intel/ClaimAge.tsx` | `ts: string`, `thresholdHours?: number`, `prefix?: string` |
| `SourceLink` | `components/intel/SourceLink.tsx` | `source: {label: string, url?: string}` |
| `VenueBadge` | `components/intel/VenueBadge.tsx` | `venue: 'paper' \| 'testnet' \| null` |
| `ExposurePathChips` | `components/intel/ExposurePathChips.tsx` | `path: {from, to, type}[]`, `weight?: number` |
| `ReviewStrip` | `components/intel/ReviewStrip.tsx` | `brief: Brief \| null`, `reviewing: boolean`, `sources`, `alertsCount`, `nextCatalyst?`, `fromTelegram: boolean`, `onReview()` |
| `WhatChangedPanel` / `DiffTable` | `components/intel/WhatChangedPanel.tsx`, `DiffTable.tsx` | `brief: Brief \| null`, `loading`, `error?`, `onRetry()` / `items: DiffItem[]` |
| `NewsFeedPanel` / `AlertItem` | `components/intel/NewsFeedPanel.tsx`, `AlertItem.tsx` | `since: string` (fetches alerts) / `alert: Alert`, `onVote(vote: 1 \| -1)` |
| `CatalystsPanel` | `components/intel/CatalystsPanel.tsx` | `heldWatched: Set<string>` (fetches) |
| `CatalystRow` / `CatalystForm` | `components/intel/CatalystRow.tsx`, `CatalystForm.tsx` | `catalyst, held, onDelete?` / `onAdded()` |
| `PositionsPanel` | `components/intel/PositionsPanel.tsx` | none (fetches positions + watchlist) |
| `PositionsTable` / `PositionForm` | `components/intel/PositionsTable.tsx`, `PositionForm.tsx` | `positions: ExposurePosition[]`, `onEdit(p)` / `initial?: ExposurePosition`, `onSaved()`, `onCancel()`, `onDeleted?()` |
| `WatchlistEditor` | `components/intel/WatchlistEditor.tsx` | `items: {asset, tags}[]`, `fallback: boolean`, `onChange(items)` |
| `ExposurePanel` / `ExposureAssetRow` | `components/intel/ExposurePanel.tsx`, `ExposureAssetRow.tsx` | `assets: string[]` / `asset`, `defaultOpen` |
| `JournalBar` | `components/intel/JournalBar.tsx` | `count`, `days`, `onDays(d)`, `sources`, `untagged`, `onTag()` |
| `TradesTable` / `TradeDetail` / `NoteEditor` | `components/intel/TradesTable.tsx`, `TradeDetail.tsx`, `NoteEditor.tsx` | `trades, selectedId, tagFilter, onSelect(id)` / `trade` / `tradeId, note, onSaved(note)` |
| `TagStatsTable` | `components/intel/TagStatsTable.tsx` | `stats: TagStats[]`, `onTag(tag)` |
| `ReportCard` / `TradeIdLinks` | `components/intel/ReportCard.tsx`, `TradeIdLinks.tsx` | `report \| null`, `onGenerate()` / `ids: string[]` |
| `ThesisComposer` / `ThesisList` / `ThesisDetail` / `CheckRow` | `components/intel/Thesis*.tsx`, `CheckRow.tsx` | `onCreated(id)` / `theses, selectedId, onSelect` / `thesis, onRecheck, onDelete` / `check` |
| `QueryInput` / `DslEditor` / `SqlBlock` / `ResultTable` | `components/intel/Query*.tsx`, `DslEditor.tsx`, `SqlBlock.tsx`, `ResultTable.tsx` | `onParsed({dsl, sql, params})` / `value, onChange, error?` / `sql, params, stale` / `columns, rows, ms` |
| `OrderBanner` | `components/intel/OrderBanner.tsx` | `venue: 'paper' \| 'testnet' \| null`, `venueError?` |
| `OrderComposer` / `AdjustDisclosure` | `components/intel/OrderComposer.tsx`, `AdjustDisclosure.tsx` | `onPreview(text)` / `intent, onRepreview(intent)` |
| `PreviewCard` / `OrderResult` | `components/intel/PreviewCard.tsx`, `OrderResult.tsx` | `preview, venue, receivedAt, stale, onConfirm(), onRepreview()` / `result, onNew()` |
| `WatchesTable` / `WatchForm` / `WatchChanges` / `ChangeEntry` | `components/intel/Watch*.tsx`, `ChangeEntry.tsx` | `watches, selectedId, onSelect` / `onAdded()` / `watch` / `change` |
| `Terminal` | `pages/terminal/Terminal.tsx` | route `/terminal`; owns the brief POST cache (§1.5) and `?review=1` |
| `Journal`, `Theses`, `Query`, `Order`, `Watch` | `pages/terminal/<Name>.tsx` | routes `/journal` … `/watch`; own their fetches and `?id`/`?trade`/`?tag` params |
| 
| `Asset` | `pages/terminal/Asset.tsx` | route `/asset/:coin` (§15.4); `AssetHeader` is local to it |
| `Cockpit` | `pages/cockpit/Cockpit.tsx` | route `/`; see C9 |

Shared files outside these folders: `AppShell.tsx` NAV entry and
`isTerminalPath`; `SrcTag.tsx` union; `App.tsx` routes.

---

Skipped: sub-tab count suffixes (a fetch per route), a node-link exposure
drawing (needs a library, fails at 390px), query CSV export, alert un-vote.

---

## 15. Flow (phase 6)

Binding layout for docs/SPEC.md § "Flow — quant gaps" (F0.8). Everything above
stands; this section adds one panel to `/terminal`, one route, and no tokens. The
principle is unchanged: every number here is computed by code and prints
plainly; the only model text is the alert lines that already exist (§2).

**Reused as-is:** `Panel`, `Segmented`, `Badge`, `StatusDot`, `StaleBanner`,
`SkeletonRows`, `EmptyBlock`, `OfflineBlock`, `ErrorBlock`, `ClaimLine`,
`ClaimAge`, `SourceLink`, `ExposurePathChips`, the ExposureAssetRow body
(extracted, §15.6), Recharts (DESIGN §4.5/§9) for the timeline, the momentum
ramp tokens `--color-mom-*` (DESIGN §2) for the heatmap scale.

### 15.1 FLOW panel on `/terminal`

**Desktop (`lg:`)** — a full-width 12 row between the WHAT CHANGED / NEWS row
and the POSITIONS / CATALYSTS row. The brief answers "what cleared the
threshold"; the heatmap is the whole matrix that answer was cut from, so it
sits directly under it, before the book.

```
├ FLOW ─ RANKED BY MATERIALITY ─ [REV|1H|6H|24H] ──────────────── SNAP 12M ─ 12 ┤
│ DETECTORS  [CROWDED LONG · HYPE 24H] [SQUEEZE SETUP · SOL 6H] [DELEVERAGING · NO LIQ DATA] │
│            ┌ SNAPSHOT ─────────────────────────────────────┐┌ FLOW ──────────────┐        │
│ ASSET      PRICE  OI    FUND  BASIS PREM  VOL   DEPTH SPRD ││ L/S  LIQS PERP SPOT│ FLAGS  │
│ HYPE HELD  +0.4  +3.1  +2.4  +0.3  +1.9  +1.2  −0.8  +0.2 ││+1.4  +0.6 +1.1 ▢   │ crowded long │
│ SOL  HELD  −2.3  +1.4  −1.1  ▢     −0.4  +2.6  −2.2  +2.2 ││−0.2  +2.3 +2.0 +0.9│ squeeze setup +1 │
│ ETH  WATCH +0.1  −0.3  +0.2  −0.1  +0.0  −0.6  +0.3  −0.2 ││ ▢    ▢    ▢    ▢   │        │
```

Mid (`md:`): same row, full width. **Mobile (<768)**: REVIEW STRIP → WHAT
CHANGED → NEWS → **FLOW** → POSITIONS → CATALYSTS → EXPOSURE. The grid is the
§4.4 escape hatch like ResultTable: `.table-scroll`, sticky `ASSET` column,
sticky header; columns are never priority-hidden (a heatmap with missing
columns is a different chart). Chips wrap freely above it.

**Header.** `FLOW`, the `.label` `RANKED BY MATERIALITY` (rank key named), the
window `Segmented` (label `flow window`, `size: 'sm'`), right: `SrcTag snap` +
`ClaimAge` of `asOf` (amber > 30 min; StaleBanner `snapshots Nh old` > 2 h,
same row as WHAT CHANGED in §1.7).

**Window switch** `REV | 1H | 6H | 24H` → `?window=review|1h|6h|24h`. Default
`REV`, persisted per browser (try/catch, like the journal window). `title`s:
`REV` = `since your last review (<age>) — z against the 7-day history
(SPEC I0.4)`; `1H`/`6H`/`24H` = `Δ over <window> — z against the trailing
30-day distribution of <window> changes`. The two z definitions differ, so the
`title` says which one the cell is using; the cell itself never mixes them.
Changing the window refetches in place (no skeleton after first data).

### 15.2 FlowHeatmap

Rows = `assets` in server order (materiality desc: row materiality = the
row's max |z| × exposure weight × stop proximity, §13 field). Not sortable by
click; materiality is the only order (DiffTable rule). Each row: `ASSET`
coin (sm, primary) + 9px tag `HELD` / `WATCH`, then the cells, then `FLAGS`.

**Columns, in this order** (header 9px uppercase, `title` = full name + unit):

| Group | Header | Metric | `title` |
|---|---|---|---|
| SNAPSHOT | `PRICE` | `price` | price |
| | `OI` | `oi_usd` | open interest (USD) |
| | `FUND` | `funding` | hourly funding (level z) |
| | `BASIS` | `basis` | mark vs oracle (level z) |
| | `PREM` | `premium` | premium (level z) |
| | `VOL` | `vol24h` | 24 h volume (ratio z) |
| | `DEPTH` | `depth_2` | book depth ±2 %, bid + ask (ratio z) |
| | `SPRD` | `spread_bps` | spread (ratio z) |
| FLOW | `L/S` | `long_short_ratio` | long/short ratio |
| | `LIQS` | `liq_usd` | liquidations, long + short (USD); `title` splits long / short when both are known |
| | `PERP` | `perp_volume_usd` | perp volume (USD) |
| | `SPOT` | `spot_volume_usd` | spot volume (USD) |

Pruned: `depth_1` (the brief named ±2 only; ±1 is on the asset page tooltip),
`perp_buy_volume_usd` (it feeds `spot_led`/`perp_led`; the chip shows it). The
two groups are separated by a 1px `--color-border` vertical rule and a group
header row (`SNAPSHOT` / `FLOW`, `.label`), so twelve metrics read as 8 + 4.

**Cell.** 11px tabular, signed z with one decimal (`+3.1`, `−0.8`, `+0.0`),
centered, min-width 44px, `--tap-min` tall. Background from the momentum ramp,
bucketed on z (not on the sector momentum edges):

| z | Background | Text |
|---|---|---|
| null | `--color-panel-alt`, no text (`▢` above is the diagram's stand-in) | — |
| \|z\| < 1 | `--color-mom-zero` | `text-secondary` (muted: inside noise) |
| 1 ≤ z < 2 / −2 < z ≤ −1 | `--color-mom-pos1` / `--color-mom-neg1` | `text-primary` |
| z ≥ 2 / z ≤ −2 | `--color-mom-pos2` / `--color-mom-neg2` | `text-primary` |

Hue encodes the **sign of z**, the same meaning the ramp already has on the
sector grid (momentum, not PnL). It is not the DiffTable's "only price is
green/red" rule: that table prints deltas in units where up is not good; here
every cell is a z in the same unit and the printed number is always present,
so color is never the sole signal (DESIGN §12.3). The ramp is a 2-step
diverging scale on the theme's own green/red, which keeps contrast under
§2.1 in all three themes; no new tokens.

`title` on a cell: `<ASSET> <metric name> · <window> · Δ <delta in unit> · z
+3.1`; null: `fewer than 48 samples` (fixed windows) / `fewer than 24 samples`
(REV). `aria-label` = the same text. 1px gap between cells (`--color-body`
seam, the MindshareGrid idiom), no borders.

**FLAGS** column: up to two gray Badges in plain words (§15.3 copy), then
`+n` (`title` lists all). Badges are gray because every flag is an observed,
code-computed fact (the §2 vocabulary: gray = OBS, info = model). A row with
no flags leaves the cell empty.

**Interaction.** Cell click → `/asset/:coin?metric=<metric>` (the matching
pane is highlighted on arrival, §15.5); asset cell or row Enter →
`/asset/:coin`. Keyboard: the DataTable idiom — one tab stop per row, Enter
opens the asset page, `←`/`→` move a visible cell focus along the row (the
focused cell's `title` text is read; Enter on a focused cell opens with
`?metric`). Flags badges are not tab stops (their text is in the row's
`aria-label`).

**Degraded FLOW group** ("no flow source configured"): when the response
reports the flow source as not ok (§15.8 `flow` field), the `FLOW` group
header reads `FLOW · NO SOURCE` in `text-secondary`, its four cells render as
null cells with `title` = the verbatim `flow.error` (fallback `no flow source
configured — see docs/research/flow-sources.md`), and the grid stays 12 wide
so the layout never shifts between runs. A flow source that is configured but
young (< 48 samples) renders ordinary null cells; the two are distinguishable
by the `title`.

**Polling** (§1.4 row): `GET /heatmap?window=` on mount, on window change,
then every 5 min (the grid is 15-min data; 60 s would only re-render the same
cells). Pauses hidden like the others.

### 15.3 DetectorChips

A wrapping row at the top of the FLOW body: `.label` `DETECTORS` then one
chip per `(name, asset)` in `flags`, ordered by the row's materiality then
newest `ts`. Chip = `<button>` styled as a gray Badge with the detector in
plain words, ` · `, coin, ` `, window: `CROWDED LONG · HYPE 24H`. Max 8
visible, then ghost `+3 MORE` toggles the rest. None firing → 10px
`text-secondary` `no detectors firing` (not an EmptyBlock; the grid still
renders).

Copy (code names never reach the screen):

| Event | Chip text | Numbers line (from `numbers`) |
|---|---|---|
| `crowded_long` / `crowded_short` | `CROWDED LONG` / `CROWDED SHORT` | `funding z +2.4 · OI 24h z +1.3 · price 24h z +0.2` |
| `squeeze_setup` | `SQUEEZE SETUP` | `funding −0.004% · OI 24h z +1.6 · price 24h z −0.3` |
| `deleveraging` | `DELEVERAGING` | `OI 6h −9.2% · liqs 6h z +2.8` |
| `spot_led` / `perp_led` | `SPOT LED` / `PERP LED` | `price 6h z +2.3 · spot/perp vol z gap +1.4` |
| `liquidity_thinning` | `THIN BOOK` | `depth ±2% $1.2M · 30d p10 $1.5M` |
| flip `funding` | `FUNDING FLIPPED +` / `−` | `−0.002% → +0.001%` |
| flip `basis` | `BASIS INVERTED` / `BASIS BACK ABOVE 0` | `+0.8 bp → −0.4 bp` |
| flip `oi_vs_price` | `OI UP, PRICE DOWN` | `OI 24h z +1.4 · price 24h z −1.2` |
| crossing | `FUNDING > 0.05%/8H` (the threshold typeset: hourly → per-8 h when the metric is funding) | `now 0.061%/8h` |

Hover → `title` = the numbers line + `· <ClaimAge>`. Tap or Enter →
`aria-expanded`, and an 11px line opens under the chips row: the numbers
line, ClaimAge, and a ghost `OPEN HYPE →` (`/asset/HYPE`). One chip expanded
at a time; `Esc` collapses. Numbers are printed exactly as the detector
emitted them (code values; signs always printed, no green/red).

**Degraded detectors.** A detector the server reports as `degraded` (no
liquidation data, no spot data) renders one summary chip, not per asset:
`DELEVERAGING · NO LIQ DATA` / `SPOT/PERP LED · NO SPOT DATA`, `text-secondary`
on a 1px dashed `--color-border` box, `title` = the verbatim reason. It is
visibly "cannot fire", never "did not fire" (SPEC F0.4). Expanding it shows the
reason and `see docs/research/flow-sources.md`.

A ReviewStrip count joins the cluster: `3 DETECTORS` (omitted at 0), click
scrolls to FLOW (`FLOW_ANCHOR`, the NEWS/CATALYSTS precedent).

### 15.4 `/asset/:coin` — AssetPage

Reached by click only (heatmap cell, detector chip, and the row taps of
DiffTable §3.4 and PositionsTable §3.7, which go to `/asset/:coin` instead
of `/markets/:coin`; the candle chart stays one click away via `CHART →`).
It is a drill-in of `/terminal`, not a sub-tab: it renders under TerminalTabs
with the CHANGES segment active (`isTerminalPath` covers `/asset/*`), the
`/markets/:coin` precedent. `?days=1|7|30` (default 7), `?metric=` highlights
a pane on arrival.

```
┌ TerminalTabs ──────────────────────────────────────────────────────────────── 12 ┐
├ [← CHANGES]  HYPE (lg)  HELD · LONG 3× · 12.4 HYPE · $12.4K  MANUAL   [1D|7D|30D] ─ 12 ┤
│ MARK $32.18 · STOP −3.1% · 0.8×ATR · MAT 0.71 · FLAGS crowded long   SNAP 12M  [CHART →]   │
├ TIMELINE ─────────────────────────────────────────────────── 8 ┬ EXPOSURE ──────── 4 ┤
│ PRICE  ╱╲╱╲╲╱╱   ┆      ┆  ┆                                   │ 9 EDGES · 4 PATHS     │
│ OI     ────╱╱─   ┆      ┆  ┆                                   │ COLLATERAL · 2        │
│ FUND   ▁▂▃▅▆▇▆   ┆      ┆  ┆                                   │ Jito → SOL 0.8 [SEED] │
│ DEPTH  ──╲╲──╱   ┆      ┆  ┆                                   │ PATHS                 │
│ LIQS   ▁▁▅▁▁▇▁ · L/S ──                                       │ [USDC]→…→[HYPE] w 0.30│
├ EVENTS · 7D ────────────────────────────────────────────────── 8 ┤ [+ ADD EDGE]          │
│ 10-13 14:02  OBS  crowded long · funding z +2.4 · OI 24h z +1.3                       │
│ 10-13 09:40  HYP ┃ Leverage is building into the unlock…   THE BLOCK ↗ · 2H           │
│ 10-12 00:00  OBS  CATALYST  HYPE unlock 2.1%  MANUAL                                  │
└───────────────────────────────────────────────────────────────┴───────────────────────┘
```

Mobile order: header → TIMELINE → EVENTS → EXPOSURE. Pane heights are the
DESIGN §4.5 table extended: price 160 / 220px (mobile / lg), each other pane
90 / 120px.

**Header** (a `Panel` without title, `bg-panel-alt`, the ReviewStrip idiom):
ghost `← CHANGES`; coin (lg, primary); `HELD` / `WATCH` tag; when held, one
line per position from the shared `/positions` fetch: side word green/red +
leverage, size in coins, notional (`fmtUsd`), `SrcTag` of the source; `MARK
<px>`; `STOP −3.1% · 0.8×ATR` (`title` stop px) or amber Badge `NO STOP`;
`MAT 0.71` (the row's materiality, 2 decimals); the row's flags as gray
Badges; `SrcTag snap` + ClaimAge of the newest snapshot; ghost `CHART →`
(`/markets/:coin`). `Segmented` `1D | 7D | 30D` (label `asset window`).

### 15.5 AssetTimeline

Recharts, not lightweight-charts: 30 days of 15-min snapshots is ≤ 2,880
points per series with no paging, panning or live bar, which is exactly the
DESIGN §4.5 boundary (lightweight-charts is reserved for the bar-paging
market chart). Stacked `ComposedChart`s sharing `syncId="asset"` (one
crosshair and tooltip across panes) and the same `margin`, so the time axes
align; only the bottom pane draws x ticks. All §4.5 rules apply (no
animation, dark tooltip, 9px ticks, horizontal dashed grid, inline legend row
above the stack).

| Pane | Series | Render |
|---|---|---|
| `PRICE` | `price` | `Line`, `--color-equity`, 1px |
| `OI` | `oi_usd` | `Line`, `--color-info`, 1px, USD compact (the §9.4 OI color) |
| `FUND` | `funding` (hourly %) | `Bar`, `--color-green` ≥ 0 / `--color-red` < 0 at 60 % opacity, zero `ReferenceLine` (the §9.4 funding idiom) |
| `DEPTH` | `depth_bid_2 + depth_ask_2` | `Line`, `--color-bench-usdc`, 1px, USD compact; tooltip splits bid / ask and shows ±1 % and spread bps |
| `LIQS · L/S` | `liq_long_usd + liq_short_usd`; `long_short_ratio` | `Bar`, `--color-bench-usdc` 60 %, left axis USD; `Line` L/S, `--color-equity`, 1px, right axis. Omitted (pane and legend entry) when the flow source is not ok; one 10px `text-secondary` line in its place: `no flow source configured` (or the verbatim error) |

Spot / perp volume are not panes (the chip carries their ratio); `premium`,
`basis`, `vol24h` ride in the tooltip only. `?metric=` → the matching pane
gets a 2px left inset `--color-red-accent` (the selection idiom) until any
click.

**Event markers.** Vertical `ReferenceLine`s on the PRICE pane only (every
pane would be clutter), no text labels on the canvas (they collide):

- observed events — detector hits, flips, crossings, catalysts at their
  `scheduledAt` — 1px dashed `--color-text-secondary`;
- model events — news alerts (their line is a Claim, usually `HYP`) — 1px
  dashed `--color-info`, extending principle 6 (speculation is info-blue).

Markers carry no words, so they are never the only place an event lives: the
**EventList** under the stack is the labeled form. One row per event, newest
first: `MM-DD HH:mm` (10px tabular, `title` full UTC), then for an alert its
`ClaimLine` (§2, badge `OBS`/`HYP` and SourceLink as stored); for a detector
hit / flip / crossing a plain row with gray Badge `OBS` and the §15.3 numbers
line (`crowded long · funding z +2.4 · OI 24h z +1.3`); for a catalyst the
CatalystRow fields (`CATALYST` word, title, origin Badge). Hovering or
focusing a row sets its marker's stroke to `text-primary`; clicking a marker
scrolls to its row. Upcoming catalysts inside the window are listed with
their `T−` countdown but drawn only when inside the x-range. Tooltip on the
chart adds `2 events` for a timestamp with markers.

### 15.6 ExposureGraph

A **list**, not a radial drawing. ≤ 30 edges over 8 long type names at 390px
is exactly the case §14 already rejected for node-link drawing, and the
operator reads edges by type (collateral, settlement, stable dependence), not
by angle. The panel is the §3.8 expanded row body as its own component:
edges grouped by type in weight order with weight, origin Badge (`SEED` gray /
`LLM` info / `USER` gray), SourceLink, `verified` ClaimAge (amber > 48 h),
Danger `✕` on user edges; then `PATHS` as ExposurePathChips + `w 0.30` (2-hop
paths to held ∪ watched); `+ ADD EDGE` form. `ExposureAssetRow` becomes a
disclosure around `ExposureGraph`, so `/terminal` and `/asset/:coin` render the same
thing from the same code. Header right: `9 EDGES · 4 PATHS`. The asset page
passes the `graph` it already has; the `/terminal` row keeps fetching on expand.

### 15.7 LLM cap copy

No new banner. `LLM cap reached ($1.37 / $2.00)` is the server's verbatim
reason (`trace.error`; spent / cap, two decimals, server-formatted, never
reformatted by the UI) and renders where reasons already render:

- WHAT CHANGED: the §3.4 no-narration row (6px amber square + `no narration —
  LLM cap reached ($1.37 / $2.00)`); the DiffTable stays — the computed answer
  is complete.
- ReviewStrip `LLM` dot: amber (degraded, not down) with `title` = the string.
- NEWS → POSITIONS: an alert that went out with raw numbers and no line
  renders line 1 as usual, then the same amber-square row in place of the
  ClaimLine, then the priced-in suffix and path chips as usual.
- `/journal` report, `/theses`, `/query`, `/order`: the existing verbatim
  ErrorBlocks (§10), unchanged.
- `/asset/:coin` EventList: alert rows without a line use the amber-square
  row.

### 15.8 States, fields, components

**State → surface (extends §10):**

| Surface | Loading | Empty | Error | Stale / other |
|---|---|---|---|---|
| FLOW heatmap | SkeletonRows (4) | EmptyBlock `nothing held or watched — add a position or watch an asset` | ErrorBlock / OfflineBlock + `RETRY` | ClaimAge amber > 30 min; StaleBanner `snapshots Nh old` > 2 h; FLOW group `NO SOURCE`; null cells |
| Detector chips | — (rendered with the grid) | `no detectors firing` (10px) | — (the panel's ErrorBlock) | degraded summary chips |
| Asset header | SkeletonRows (1) | `WATCH`-only header without position line | — (the page's ErrorBlock) | `NO STOP` Badge |
| Asset timeline | SkeletonRows per pane | EmptyBlock `no snapshots yet — the collector adds <COIN> once it is held, watched or top-20 by OI`; unknown coin (404) → EmptyBlock `no data for <COIN>` + ghost `← CHANGES` | ErrorBlock / OfflineBlock | StaleBanner `snapshots Nh old` > 2 h; LIQS pane replaced by the no-source line |
| Asset events | SkeletonRows (2) | EmptyBlock `no events in <window>` (`1 day`, `7 days`, `30 days`) | — | alert rows without a line → amber-square row |
| Asset exposure | SkeletonRows | EmptyBlock `no edges — the daily refresh adds them for held and watched assets` | ErrorBlock, timeline unaffected | edge ClaimAge amber > 48 h |

**Fields the UI reads (extends §13; pinned in `src/shared/intel.ts`):**

| Field | Used by | If absent |
|---|---|---|
| `GET /heatmap` → `assets: {asset, held: boolean, materiality}[]` (ordered) | row order, `HELD`/`WATCH` tag, `MAT` | `string[]` → rows in server order, no tag, header label `SERVER ORDER` |
| `GET /heatmap` → `flags: {asset, kind: 'detector'\|'flip'\|'crossing', name, window, numbers: Record<string, number>, degraded?: string, ts}[]` | chips, FLAGS column, header flags | without `numbers` the chip has no numbers line; `degraded` absent → no degraded chips |
| `GET /heatmap` / `GET /asset/:coin` → `flow: {ok: boolean, error?: string}` | `NO SOURCE` group, LIQS pane omission | FLOW group renders as ordinary null cells |
| `GET /asset/:coin` → `events: {ts, kind: 'detector'\|'flip'\|'crossing'\|'alert'\|'catalyst', name?, numbers?, line?: Claim, sources?, catalyst?}[]` | markers, EventList | — |
| `GET /heatmap` → `window`, `since` (REV baseline ts) | window `title`, `REV` age | `REV` `title` without the age |

**Polling (extends §1.4):** heatmap 5 min (+ on window change); `/asset/:coin`
on mount + on `days` change + 5 min while mounted; the asset header reads the
shared positions poller.

**Staleness (extends §1.7):** FLOW and asset timeline — age of `asOf` /
newest snapshot; degraded > 30 min; stale > 2 h, noun `snapshots`.

**Components (extends §14):**

| Component | File | Props |
|---|---|---|
| `FlowPanel` | `components/intel/FlowPanel.tsx` | `state` (heatmap poller), `window`, `onWindow(w)` |
| `DetectorChips` | `components/intel/DetectorChips.tsx` | `flags: HeatFlag[]`, `materiality: Map<asset, number>` |
| `FlowHeatmap` | `components/intel/FlowHeatmap.tsx` | `assets, metrics, cells, flags, window, flow` |
| `HeatCell` | inside `FlowHeatmap.tsx` | `z, delta, unit, metric, asset, window` (bucket → class) |
| `AssetPage` | `pages/terminal/Asset.tsx` | route `/asset/:coin`; owns `?days`, `?metric`, the asset fetch; reads the positions poller |
| `AssetHeader` | `components/intel/AssetHeader.tsx` | `coin, positions, held, watched, materiality, flags, asOf, days, onDays` |
| `AssetTimeline` | `components/intel/AssetTimeline.tsx` | `snapshots, flow, events, days, highlight?: metric, onMarker(eventId)` |
| `EventList` | `components/intel/EventList.tsx` | `events, highlighted?, onHover(id)` |
| `ExposureGraph` | `components/intel/ExposureGraph.tsx` (extracted from `ExposureAssetRow`) | `asset, edges, paths, onDeleted?()`, `onAdded?()` |
| `Terminal` | `pages/terminal/Terminal.tsx` | gains the heatmap poller and `FLOW_ANCHOR`; passes `3 DETECTORS` to ReviewStrip |

Chart primitive: Recharts (`ComposedChart`, `Line`, `Bar`, `ReferenceLine`,
`syncId`). No new dependency.

Skipped: a radial exposure SVG (§14's reason holds); per-cell tab stops (one
row stop + arrows); sortable heatmap columns (materiality is the order);
spot/perp volume panes (chip ratio covers it); a dedicated LLM-cap banner (the
no-narration row is the place reasons already live).

---

## 16. Scout / Research (phase 7)

Binding layout for docs/SPEC.md § "Scout — research on the Terminal" (S0.8). §15
stands; this section adds one panel to `/terminal`, one action on the detector chips,
one event kind on `/asset/:coin`, one badge on digest items, and no tokens.
Research is **model output with code-checked provenance**: every evidence row
is a Claim and renders through §2, so OBS and HYP stay unmistakable, and a
hypothesis is never typeset as a fact. Nothing on this surface tells the
operator what to do; a result explains, it never recommends.

**Reused as-is:** `Panel`, `Badge`, `Button`, `StatusDot`, `SkeletonRows`,
`EmptyBlock`, `OfflineBlock`, `ErrorBlock`, `ClaimLine`, `ClaimList`,
`ClaimAge`, `SourceLink`, `useAction`, the QueryInput field idiom (§6.2), the
pulse label (`REVIEWING…`), the §15.3 expanded-line disclosure, the §15.5
selection inset.

### 16.1 RESEARCH panel on `/terminal`

**Desktop (`lg:`)** — a full-width 12 row directly under FLOW, before
POSITIONS / CATALYSTS. FLOW shows *what* moved; research is the attempt to
find *why*, so it sits under the matrix it explains, above the book.

```
├ RESEARCH ─ NEWEST FIRST ─────────────────────────────── 3 / 10 TODAY · 12M ─ 12 ┤
│ QUESTION  [ What explains the OI build on HYPE over 24 h?            ] ASSET [HYPE ] [RESEARCH] │
│ ─────────────────────────────────────────────────────────────────────────────────────────── │
│ FOUND  HYPE · What explains the OI build on HYPE over 24 h?                 MEDIUM   12M     │
│ EXPLANATION  A token unlock of 2.1% is scheduled for 10-15; OI rose 18.4% while price… │
│ OBS  Unlock of 2.1% of supply scheduled 2026-10-15.               THE BLOCK ↗ · 3H      │
│ HYP ┃ Market makers may be hedging unlock supply ahead of time.                         │
│ OPEN QUESTIONS  ? Which wallets received the unlock allocation                          │
│ MANUAL · 6 SEARCHES · $0.04 · claude-sonnet · 12M                          OPEN HYPE → │
│ ─────────────────────────────────────────────────────────────────────────────────────────── │
│ NO CAUSE  SOL · funding flipped +  (FLAG)                                   LOW     2H      │
│ EXPLANATION  No public cause found. Checked: exchange status pages, SOL news 24 h, …     │
```

Mid (`md:`): same, full width. **Mobile (<768)**: … → FLOW → **RESEARCH** →
POSITIONS → …; the ask box stacks `QUESTION` / `ASSET` / button, cards keep
§2.1's mobile ClaimLine wrap. Nothing is priority-hidden.

**Header.** `RESEARCH`, the `.label` `NEWEST FIRST` (the order is named and is
the only order), right: the usage line `3 / 10 TODAY` (10px tabular,
`title` = `manual research runs this UTC day · INTEL_RESEARCH_DAILY`; amber
when `usedToday ≥ limit`) and `ClaimAge` of the newest result (no staleness
threshold: research is on demand, an old result is not a stale one).

**Ask box** (`ResearchAsk`). `.label QUESTION` + the §6.2 one-line textarea
(grows to 3 rows, `maxLength 500`, a 10px `412 / 500` counter appears past
400); `.label ASSET` + a 6ch uppercase input with a `datalist` of held ∪
watched (optional; free text allowed, the server decides what it knows);
`Button` primary `RESEARCH`. Enter submits, Shift+Enter breaks a line.
Disabled while the question is < 3 chars, while a run is in flight, while a
`running` row is in the list, and while `usedToday ≥ limit` (`title` says
which). In flight: `RESEARCHING…` pulse on the button; the list gains a
placeholder card at the top (§16.2 `running`). The call is synchronous for up
to 45 s, so the pulse is the whole progress UI: no bar, no countdown (there
is no signal to drive one, and a fake one lies).

**Results list** — one `ResearchCard` per item, newest first, server order,
limit 20. After a successful POST the response is prepended locally and
deduplicated by `id` on the next poll; no refetch. A card arriving from the
cron (trigger `flag`) appears on the next poll with no announcement.

### 16.2 ResearchCard

An `<article aria-label="Research: <ASSET or 'no asset'>, <status word>">`,
`px-3 py-2.5`, `border-b border-border-subtle`. Top to bottom:

1. **Status line.** `Badge` with the status word, then coin (sm, primary;
   omitted when `asset` is null), ` · `, the question (12px `text-primary`,
   never truncated or uppercased), then right: confidence Badge and
   `ClaimAge` of `createdAt`.

   | `status` | Badge | Body |
   |---|---|---|
   | `running` | gray `RUNNING` + pulse (the §1.5 `REVIEWING…` motion) | `SkeletonRows (2)`; replaced in place by the response |
   | `found` | gray `FOUND` | full card |
   | `no_cause` | gray `NO CAUSE` | explanation (`No public cause found.` + what was checked, verbatim), no evidence block, open questions if any |
   | `capped` | amber `CAPPED` | the §15.7 amber-square row with the verbatim reason (`LLM cap reached ($1.37 / $2.00)`), nothing else |
   | `failed` | red `FAILED` | the verbatim server reason in an 11px `text-muted` row (`provider has no web search`), nothing else |

   `no_cause` is a valid answer and looks like one: gray, not amber, not
   empty. Confidence is a gray Badge `LOW` / `MEDIUM` / `HIGH` for `found`
   and `no_cause` only, `title` = `the model's own confidence in this
   explanation — not a probability`. It is never color-graded: a green
   `HIGH` would read as a go signal.

2. **`.label EXPLANATION`** + the explanation as one 12px `text-primary`
   paragraph, model text rendered verbatim (§2.1 rules: no uppercase, no
   truncation, no recolored numbers). It is prose, not a Claim, so it never
   sits inside the ClaimList below; the model name in the meta line is its
   provenance.

3. **Evidence** — a `ClaimList` of `evidence[]` mapped by `toClaim`:
   `observed` → `{kind: 'observed', text: claim, source: {label: hostname of
   url, url}, ts}` (ts may be null → no ClaimAge); `hypothesis` → `{kind:
   'hypothesis', text: claim}`. A hypothesis that kept its url (the provider
   saw it, a number did not match) renders the SourceLink **inside** the
   muted text block after the text, never in the right-hand source slot:
   the link is useful, the HYP badge and info rule still say "not verified".
   Omitted when empty (`no_cause`).

4. **`.label OPEN QUESTIONS`** + a `<ul>` of 11px `text-muted` lines, each
   prefixed `? ` (4ch, matching the OBS/HYP column). Omitted when empty.

5. **Meta line**, 10px `text-secondary` tabular: trigger word (`MANUAL`, or
   `FLAG · <chip text in lowercase>` when `trigger: 'flag'`), ` · `,
   `<searches> SEARCHES`, ` · `, `$<costUsd>` (2 decimals, server value,
   never recomputed), ` · `, `model`, ` · `, ClaimAge; right: ghost `OPEN
   <ASSET> →` (`/asset/:coin`) when `asset` is set.

**Highlight.** A card addressed by `researchId` (§16.3) gets the §15.5
selection inset (2px left `--color-red-accent`) and `bg-hover` until the next
click anywhere, and is scrolled to `start` with `scroll-mt-[100px]`
(`id="research-<id>"`).

### 16.3 Detector chip action

The chip stays one tab stop; the action lives in the §15.3 expanded line,
after `OPEN HYPE →`:

- `flag.researchId == null` → ghost `RESEARCH`. Click submits through the
  same ask action as the box, with the question `What explains <chip text,
  lowercase> on <ASSET> over <window>?` (e.g. `What explains crowded long on
  HYPE over 24h?`), `asset` = the flag's coin and `flagId` = the flag id
  (§16.6), and scrolls to RESEARCH where the `running` placeholder is
  already visible. It is one click because the chip already holds the whole
  question; it counts against the daily limit like any manual run, and the
  usage line says so. Disabled, with the same `title`, under the same
  conditions as the box button. Degraded summary chips have no action.
- `flag.researchId` set → ghost `SEE RESEARCH →`. Click scrolls to the card
  in RESEARCH and highlights it (§16.2). **Why the panel and not the asset
  page:** the chip is on `/terminal` and the result is already on `/terminal`; a page hop
  would drop the heatmap context the operator is reading the chip against.
  If the id is not among the 20 loaded cards, the panel refetches with
  `?asset=<coin>` and highlights on arrival; still missing → `/asset/:coin`
  (the timeline has it as an event).

The chip text itself does not change; a flag with research shows a 9px
`text-secondary` `·R` suffix inside the chip (`title` `research available`),
so the state is visible before expanding.

### 16.4 `/asset/:coin` timeline

`AssetEvent.kind: 'research'` joins the §15.5 EventList and markers:

- **Marker:** 1px dashed `--color-info` on the PRICE pane at `createdAt`
  (model output, the news-alert class), every status included; a `no_cause`
  is still an event that happened.
- **Row:** `MM-DD HH:mm`, then the status Badge (§16.2 words), `.label`
  `RESEARCH`, the question in `text-primary`. The row is a disclosure
  (`aria-expanded`, the §15.3 idiom, one open at a time, `Esc` collapses):
  tap/Enter opens the full `ResearchCard` body (explanation, evidence, open
  questions, meta) under the row. When the event carries no `research`
  payload (§16.6), the row is not expandable and ends with ghost `SEE ON
  TERMINAL →` (`/terminal#research-<id>`).
- The header's flags Badges gain the same `·R` suffix as the chips.

### 16.5 Confluence on digest items

Where an item's `confluence > 1`, a 9px gray `Badge` `×1.25` follows the
materiality number in the DiffTable `MAT` cell. Only digest items (`DiffItem`)
carry `confluence`. Alerts and heatmap rows don't, so AlertItem and the asset
header show no badge until they do. Format: `×` + the factor with two
decimals, trailing zero kept (`×1.50`); `confluence ≤ 1` renders nothing, not
`×1.00`. `title`: `confluence ×1.25 — 2 independent signal sources on <ASSET>
in the window (snapshot moves, flow detectors, flips, news); this item's own
source is not counted` — the count is `1 + round((f − 1) / 0.25)`, and at the
`1.50` cap it reads `3 or more`. The badge is a suffix, not a column: the
tables keep their widths, and materiality stays the one printed rank.

### 16.6 States, fields, components

**State → surface (extends §10 / §15.8):**

| Surface | Loading | Empty | Error | Stale / other |
|---|---|---|---|---|
| RESEARCH list | SkeletonRows (3) | EmptyBlock `no research yet — ask a question above, or press RESEARCH on a detector chip` (ask box always rendered) | ErrorBlock / OfflineBlock + `RETRY` under the ask box; a loaded list stays | `running` placeholder card; usage line amber at the limit |
| Ask box submit | `RESEARCHING…` pulse, button disabled | — | verbatim ErrorBlock (`role="alert"`) under the box; `RETRY` only when offline or ≥ 500 | **409** (a run in flight): verbatim string, box disabled until the next poll shows no `running` row; **429** (daily limit): verbatim string, usage line amber, box disabled until `usedToday < limit` after the UTC day turns; **capped**: not an error — a 200 `CAPPED` card (§16.2), box stays enabled; **failed**: a `FAILED` card |
| No DB | — | the same EmptyBlock: without `DATABASE_URL` the server uses `MemoryIntelStore`, so every state above renders and results live until restart; no demo copy | — | — |
| Asset research row | — (with events) | — | — | no payload → `SEE ON TERMINAL →` |
| Chip action | `RESEARCH` disabled with `title` while in flight | — | the box's ErrorBlock | `·R` suffix; `SEE RESEARCH →` fallback to `/asset/:coin` |

A `running` row older than deadline + 15 s (SPEC S0.3) is stale; the panel
renders it as `FAILED` with reason `timed out` only after the server reports
it so (the UI never guesses); until then it is `RUNNING`.

**Fields the UI reads (extends §13; pinned in `src/shared/intel.ts`):**

| Field | Used by | If absent |
|---|---|---|
| `ResearchResult {id, trigger: 'manual'\|'flag', flagId?, asset: string\|null, question, status, explanation, evidence: {claim, url?, ts: string\|null, type: 'observed'\|'hypothesis'}[], confidence, openQuestions: string[], searches, costUsd, model, createdAt}` | ResearchCard | `costUsd`/`searches`/`model` absent → that meta segment omitted |
| `GET /research` → `{items, usedToday, limit}` | list, usage line, box gating | `usedToday`/`limit` absent → usage line omitted, box never limit-gated (the 429 still renders) |
| `POST /research {question, asset?, flagId?}` | ask box, chip action | the UI **sends** `flagId` when the run comes from a chip; a server that ignores it leaves the chip on `RESEARCH` until a poll returns a `researchId` (S1 names only `question`, `asset`) |
| `FlowFlag.researchId: string\|null` | chip action, `·R` suffix, header flags | treated as null |
| `AssetEvent {kind: 'research', ts, title (= question), research?: ResearchResult}` | timeline marker, row, disclosure | no `research` → non-expandable row + `SEE ON TERMINAL →` |
| `DiffItem.confluence?`, `Alert.confluence?`, heatmap row `confluence?` | ConfluenceBadge | no badge |

**Polling (extends §1.4):** `GET /research?limit=20` on mount, then every 60 s
(results also arrive from the cron); 15 s while any row is `running`; paused
hidden. `/asset/:coin` needs no new fetch (events carry research).

**Keyboard / a11y (extends §11):** the textarea has a visible `.label` and
`aria-describedby` on the counter; Enter submits, Shift+Enter inserts a
newline; the asset input is a labeled `<input list>`; ErrorBlocks are the
only live regions, plus the existing `/terminal` polite line, which announces
`research ready: <status word>` when a POST resolves; cards are `<article>`s
with the status word in `aria-label`; the chip action and `OPEN HYPE →` are
ordinary buttons inside the expanded line (tab order after the chip);
`OBS`/`HYP`, status words, `×1.25` and the `? ` prefix are text, so color is
never the only signal.

**Components (extends §14 / §15.8):**

| Component | File | Props |
|---|---|---|
| `ResearchPanel` (container) | `components/intel/ResearchPanel.tsx` | `state: IntelState<ResearchListResponse>`, `ask: ActionState` (shared with the chip action), `heldWatched: Set<string>`, `highlightId: string\|null`, `onHighlighted()`; merges the locally prepended results into `state.data.items`; exports `RESEARCH_ANCHOR` |
| `ResearchAsk` | `components/intel/ResearchAsk.tsx` | `assets: string[]`, `busy`, `disabledReason: string\|null`, `error`, `offline`, `onSubmit({question, asset?})` |
| `ResearchCard` | `components/intel/ResearchCard.tsx` | `result: ResearchResult`, `highlighted?: boolean`, `compact?: boolean` (asset page body: no status line, the row has it) |
| `ConfluenceBadge` | `components/intel/ConfluenceBadge.tsx` | `factor: number\|undefined`, `asset: string` (renders nothing ≤ 1) |
| `research.ts` (pure) | `components/intel/research.ts` | `toClaim(evidence)`, `statusWord(status)`, `statusTone(status)`, `chipQuestion(flag)`, `confluenceTitle(factor, asset)`, `fmtCost(usd)` (the `flow.ts` precedent; unit-tested like `flow.test.tsx`) |
| `DetectorChips` | `components/intel/DetectorChips.tsx` | gains `onResearch(flag)`, `onSeeResearch(researchId, asset)`, `askDisabledReason: string\|null` |
| `EventList` | `components/intel/EventList.tsx` | gains the `research` row + disclosure (renders `ResearchCard compact`) |
| `DiffTable` | existing file | renders `ConfluenceBadge` after materiality (digest items only) |
| `Terminal` | `pages/terminal/Terminal.tsx` | gains the research poller, the ask `useAction` (POST + local prepend), `highlightId`, and `RESEARCH_ANCHOR`; wires the chip actions |
| `intel` client | `lib/intel.ts` | gains `research(q)`, `ask(input)`; `events` and `flows` removed (SPEC S0.9) |

Skipped: a progress bar or elapsed counter for the 45 s run (no signal to
drive it); a research sub-tab or `/research` route (the panel is the
surface; the list is capped at 20 by the API); per-card feedback buttons
(SPEC S0 defines none); an asset filter control on the panel (the refetch in
§16.3 is the only use, and the ask box's ASSET field already scopes new
runs); typing the explanation as a Claim (it is a synthesis, and the evidence
rows carry the tags).

---

## Cockpit (phase 8)

Binding layout for docs/SPEC.md § Platform P3. Everything above stands unless
named here. Question the screen answers: **"what should I act on now, and is
it worth the cost?"** It is a ranked feed with one selected opportunity,
never a wall of charts. No new tokens, no new endpoints: data comes from
`/api/platform` (P2) plus the existing `GET /api/desk/status` and
`POST /api/desk/kill` for the kill switch.

**Reused as-is:** `Panel`, `Badge` (`green|red|amber|info|gray`), `Button`,
`Segmented`, `DataTable` (`isSelected`), `ConfirmDialog`, `DialogShell`,
`KillSwitchDialog` (typed `KILL`),
`StatusDot`, `SkeletonRows`, `EmptyBlock`, `OfflineBlock`, `ErrorBlock`,
`StaleBanner`, `ClaimAge`, `ClaimLine`, `VenueBadge`, `fmtUsd`, `fmtAge`,
`usePoll`, the shared HL WS client (`activeAssetCtx` for the selected mark),
Recharts.

### C1. Routes and navigation

The route table, the shell cell and the tab strip are §1.1–§1.3 and §1.5:
`/` is this page (the FEED tab), `/terminal` is CHANGES, and `/?review=1`
redirects to `/terminal?review=1`. This page owns `/?id=<opportunityId>`
(selection, `replace: true`; a real history entry on mobile), `?status=`,
`?tier=`, `?liqh=` and `?liq=<coin>`.

Coin cross-links: the detail header carries ghost `CHART →`
(`/markets/:coin`) and `INTEL →` (`/asset/:coin`); `/asset/:coin` links back
with `CHART →` and `/markets/:coin` with `INTEL →`, so from any coin page the
other two are one click away.

### C2. Layout

**Desktop ≥1280 (`xl:`, 12-col, gutter 12px).** Feed 4 | right column 8.

```
┌ TerminalTabs [CHANGES|WATCH|…|FEED|ORDER|DESK] ─────────────────────────────────────────────┐
├ COCKPIT  [PAPER]  14 LIVE · 3 READY                         [? KEYS]  [KILL] / ●KILLED ┤
├ HEALTH  ● WS 2S  ● SCAN 41S  ● CRAWL 388/MIN · 9.4K ADDR  ● LOOPS 8/8  ● LLM $0.42/$2.00┤
├ FEED ─ BY SCORE ─ [LIVE|READY|DECIDED|ALL] [ALL|T1|T2|T3] 4 ┬ LIQUIDATIONS · HYPE ─ [6H|24H|72H] ─ 8 ┤
│▌HYPE  LONG  0.82  +38bp UNVALIDATED  [READY]   2M          │ COVERAGE 31% OF OI · 4,210 ADDR · POLL p50 6M p90 24M │
│   oi-accel  funding-z  liq-pressure                        │  history (time × price) ░▒▓  ──price──   │ profile │
│ SOL   SHORT 0.71  −12bp [COSTS EXCEED EDGE] [CALC] 6M      │  ░░▒▒▓▓▓▒░  ───────────╲                │ ▇▇▇ SHORT│
│ ETH   LONG  0.55  +9bp UNVALIDATED [NEW]     9M            │  ─────────────────── MARK 42.18 ─────── │ ──────── │
│ …                                                          │  ▒▓▓▒░                                  │ ▇▇▇▇ LONG│
│ SNOOZED · 2 ▸                                              │ SHORT CLUSTER $6.1M @ 44.20 +4.8% · LONG $9.3M @ 39.90 −5.4% │
│                                                            ├ HYPE · LONG · OI ACCELERATION ─ READY ─ score 0.82 ─ 8 ┤
│                                                            │ [APPROVE a] [REJECT r] [SNOOZE s ▾] [RESEARCH d]   PAPER │
│                                                            │ 1 WHY IT PASSED   2 COST TO TRADE   (scrolls: 3 4 5)    │
└────────────────────────────────────────────────────────────┴─────────────────────────────────────┘
```

Above the fold on load (1280×800): header, health strip, ~14 feed rows, the
liquidation panel (320 px) and the detail's action bar + questions 1–2. On
load the top row of the filtered feed is selected, so the map and detail are
populated without a click.

The liquidation panel always renders: its coin is the one picked (`?liq=`,
set from the board), else the selected idea's coin, else BTC. When the feed is
empty its column shows a **LIQUIDATION BOARD ─ BY NEAREST CLUSTER**
(`DataTable`: COIN, MARK, LONG LIQS, SHORT LIQS, COV; row tap picks the coin),
preceded by a `SCANNER WARMING UP — n OF 60 MIN HISTORY` line while the
scanner ring is short.

**Laptop ~1024 (`lg:`).** Feed 5 | right 7. The liquidation panel shows one
view at a time via `Segmented` `PROFILE | HISTORY` (default PROFILE); detail
below it. Health strip wraps to two lines if needed; never hidden.

**Phone ~400 (<768).** Single column: header (COCKPIT, venue, KILL) → health
as one line of dots + worst item text (`● SCAN 3M OLD`), tap expands the full
strip → filters (wrapping) → feed. Tapping a row (or Enter) pushes
`/?id=` (a real history entry on mobile, the §5.1 exception) and shows the
detail screen: `← FEED`, the opportunity header, liquidation panel (PROFILE
default, `Segmented` to HISTORY), the five questions, and the action bar
**sticky at the bottom** (`env(safe-area-inset-bottom)` padding, controls
≥ `--tap-min`). Md (768–1023): mobile order, with feed and detail side by side
only from `lg:`.

### C3. Feed

**Row (DataTable, one tab stop, `isSelected`).** Line 1: coin (sm, primary) ·
direction word `LONG`/`SHORT` · `score` (2 dp, tabular) · edge cell · status
pill · age (`fmtAge` of `createdAt`; amber when the row is `ready` and within
10 min of `PLATFORM_READY_TTL_MIN`). Line 2 (10px, secondary): signal tags as
plain words, max 3 + `+n`; `tier T1|T2|T3`; `tradeType` only when not
`directional`.

- **Edge cell:** `netEdgeBps` signed (`+38bp`, `−12bp`). `edgeBasis:
  "unvalidated"` → info Badge `UNVALIDATED` (`title`: `gross edge is the
  setup's stop-to-target distance; fewer than 30 resolved outcomes for this
  setup`). `netEdgeBps < 0` → red Badge `COSTS EXCEED EDGE` in place of the
  sign color. `netEdgeBps: null` (non-directional) → `—` with `title` `no cost
  model for <tradeType>`. Score and edge are never combined or multiplied.
- **Status pill** (Badge, word always printed): `NEW` gray, `INVESTIGATING`
  info (pulse), `CALC` gray, `READY` green, `APPROVED` green outline, `OPEN`
  info, `REJECTED`/`EXPIRED`/`CLOSED` gray.
- **Snoozed:** rows with `snoozedUntil > now` leave the ranked list and sit in
  a collapsed `SNOOZED · n ▸` group at the bottom; each shows `SNOOZED 42M`
  (time left). Expanding keeps order by score.
- **Sort:** server order (score desc). No click sort (DiffTable rule).
- **Filters** (`Segmented`, `size: 'sm'`, persisted to `?status=`/`?tier=`):
  status `LIVE` (new, investigating, calculated, ready; default) · `READY` ·
  `DECIDED` (approved, open, rejected, expired, closed) · `ALL`; tier `ALL ·
  T1 · T2 · T3`. One `GET /opportunities?limit=100` feeds all filters; the UI
  filters client-side (no refetch on toggle).
- **Selection:** `?id`. Default = first row of the filtered list. If the
  selected id leaves the filtered list, the detail stays and shows gray Badge
  `NOT IN FEED`; `j`/`k` resume from the top.

**Keyboard** (one page-level handler; ignored while focus is in an
input/textarea/select, while any dialog is open, or with Ctrl/Meta/Alt):

| Key | Action |
|---|---|
| `j` / `k` | next / previous row; selects, focuses and scrolls it into view |
| `Enter` | open detail: desktop moves focus to the detail heading; phone pushes `/?id=` |
| `a` | approve → ticket dialog (C5); not `ready` → inline line `approve needs READY — status is CALC` |
| `r` | reject dialog |
| `s` | snooze menu; `1`/`2`/`3` = 15M/1H/4H, `Esc` closes |
| `d` | deeper research (`POST /research`) |
| `x` | kill switch (`KillSwitchDialog`: typed `KILL`; resume has none) |
| `?` | keys overlay (dialog listing this table) |
| `Esc` | closes the topmost dialog/menu, refocuses the opener |

Buttons print their key (`APPROVE a`) on fine pointers only.

### C4. Liquidation panel

Header: `LIQUIDATIONS · <COIN>`, history window `Segmented` `6H|24H|72H`
(default 24H, `?liqh=`), right: coverage line. The two views share one price
axis (right edge) so a history row and a profile bar at the same height are
the same price. Defaults: `range=10` (±10% of mark), `bucketBps=25`.

**Colour (no new tokens).** Long-liquidation notional (below mark) =
`--color-proj-line` (blue); short-liquidation notional (above mark) =
`--color-bench-btc` (yellow). Both are chart-series tokens, so they never read
as good/bad (green/red) or momentum (`--color-mom-*`), and blue/yellow stays
distinct under red-green colour blindness. Amber stays text-only on this panel
(ages, coverage) so it never competes with the fills. Mark line =
`--color-equity`, 1px, label tag `MARK 42.18` on the axis. Words `LONG LIQS`
/ `SHORT LIQS` always label the halves; colour is never alone.

**(a) PROFILE (live, `GET /liqmap`).** Recharts horizontal `BarChart`
(`layout="vertical"`): y = bucket price, x = notional (`fmtUsd` compact,
ticks at 0 / half / max). Mark from the WS (`activeAssetCtx.markPx`), falling
back to the response `mark`; the line moves with the WS, the buckets refresh
on poll. Callouts under the chart, one per side:
`SHORT CLUSTER $6.1M @ 44.20 · +4.8%` and `LONG CLUSTER $9.3M @ 39.90 · −5.4%`
(% = signed distance from mark). Cluster = the bucket nearest the mark whose
notional is ≥ 20% of the side's largest bucket (pure `nearestCluster` in
`cockpit.ts`, tested). Bar `title`: `<price> · long liqs $x · <n> positions`.

**(b) HISTORY (`GET /liqmap/history`).** One `<canvas>` (device-pixel-ratio
scaled): columns = 15-min snapshots, rows = price buckets, each cell's alpha in
5 steps of its notional over the window's 95th percentile (clipped). Side
colour per cell from that snapshot's mark. Mark per snapshot drawn as a 1.5px
`--color-equity` line on top. Hover/tap crosshair → one tooltip line
`14:15 · 44.20 · short liqs $1.2M`. Time axis: 4–6 local-time labels.

**Chart choice:** Recharts for PROFILE (≤ 80 bars; axes, tooltip, a11y for
free; already used, §15.8). Plain canvas for HISTORY: 288 × 80 = 23K cells
at 72H is too many SVG nodes, and lightweight-charts has no 2-D cell series.
No new dependency.

**Coverage (always visible, header right).** `COVERAGE 31% OF OI · 4,210
ADDR · POLL p50 6M p90 24M`. Below 25%: the line turns amber, an amber Badge
`PARTIAL MAP` appears, a caption `only 18% of open interest is mapped —
missing clusters are likely` sits above the chart, and cluster callouts read
`≥ $6.1M`. Below 5%: callouts are replaced by `too little coverage to name
clusters`; bars still draw. Poll p90 > 30 min → that segment amber.

**Empty/sparse.** No buckets → EmptyBlock `no tracked positions on <COIN>
yet — the crawler adds addresses as they trade`. History with < 2 snapshots →
EmptyBlock `history builds every 15 min — first snapshot <age> ago`. Coin not
in the snapshot set → EmptyBlock `history is kept for the top 30 coins by
OI — <COIN> is not one` (PROFILE unaffected).

### C5. Detail (selected opportunity)

Header: `<COIN> · <DIRECTION> · <setup kind>` · status pill · `score 0.82` ·
age. Action bar directly under it (sticky in the panel), then five numbered
sections in this fixed order, each a `.label` heading:

1. **WHY IT PASSED** — table: signal name · value (unit) · z (signed, 1 dp,
   amber when |z| ≥ 2) · threshold for this tier. Plain values, code-computed.
2. **COST TO TRADE** — `gross +62bp − fees 2×4.5bp − slippage 11bp − funding
   4bp (8h) = net +38bp`, as a column of `MetricStat`s; `absorbableUsd`
   `$84K absorbable (10% of depth ±0.5%)`; `UNVALIDATED`/`COSTS EXCEED EDGE`
   as in the feed.
3. **INVALIDATION & BEAR CASE** — invalidation level and its distance from
   mark; research bear case as `ClaimList` (model words, §2). None →
   EmptyBlock `no research yet` + `RESEARCH` button; `investigating` →
   `RESEARCHING…` pulse.
4. **HAVE SIMILAR SETUPS PAID** — `n 41 · hit 54% · mean net +0.21% · 95% CI
   −0.08% to +0.50%` for the setup kind (regime/tier sub-rows when present).
   Interval `null` → `n<5 — not enough outcomes`. CI straddling 0 → gray
   word `NOT DISTINGUISHABLE FROM ZERO`.
5. **PORTFOLIO RISK** — governor preview, two columns `BEFORE` / `AFTER`
   (gross, net, per-asset, margin use), verdict reasons verbatim; a blocked
   verdict → red Badge `GOVERNOR BLOCKS` and the reasons.

**Actions.**
- `APPROVE` (neutral tier; enabled only in `ready`) → the Level 2 ticket
  dialog (`TicketDialog`, on `DialogShell`) titled `APPROVE — PAPER` /
  `— TESTNET` (VenueBadge, large, from desk status): the pre-filled ticket
  (side, size USD, entry ref, stop, target, net edge) read from detail;
  CONFIRM → `POST /approve`. Desk APPROVE asks the same weight of
  confirmation (docs/design/README.md §7). Governor blocked → APPROVE disabled
  with `title` = first reason.
- `REJECT` (ghost) → dialog with a required `REASON` textarea; CONFIRM
  disabled while blank → `POST /reject {reason}`.
- `SNOOZE ▾` → menu `15M · 1H · 4H` → `POST /snooze {minutes}`.
- `RESEARCH` → `POST /research`; disabled with `title` while investigating.
- After any action: refetch feed + detail; failures render verbatim in an
  ErrorBlock under the action bar.
- **409 `stale_feed`:** dialog stays open, CONFIRM disabled, amber
  StaleBanner with the server string verbatim + `RETRY` (re-POSTs). The
  health strip will show the cause.

### C6. Health strip

One row of `StatusDot` + label + value, from `GET /health`, polled 15 s.
Green = ok, amber = warn, red = critical, gray = unknown (field absent).

| Item | Shows | Warn | Critical |
|---|---|---|---|
| `WS` | state + last message age | > 10 s | > 30 s or not connected |
| `SCAN` | last scan age | > 90 s | > 120 s (2 × interval, the approve gate) |
| `CRAWL` | polls/min · address count | < 100/min | 0/min |
| `LOOPS` | `beating/total` (`title` lists each loop + last beat) | any beat > 2 × its interval | any > 5 × or crashed |
| `LLM` | `$spent/$cap` today | ≥ 80% | ≥ 100% (`LLM CAP REACHED`) |

Desk kill switch lives in the cockpit header, not the strip: `KILL` (danger)
when off; when on, red Badge `KILLED` + `RESUME` (ghost) with reason/age. Both
open the shared `KillSwitchDialog` driven by `useDeskKill`, the Desk page's
implementation (README §7); the page refetches desk status after every
attempt, success or failure.

### C7. Named states (extends §10; copy verbatim)

| Panel | Skeleton | Empty | Offline | Error | Stale |
|---|---|---|---|---|---|
| Feed | SkeletonRows (8) | EmptyBlock `nothing cleared the bar — the scanner runs every minute` (filter empty: `no <FILTER> opportunities`) | OfflineBlock `platform API unreachable` + RETRY | ErrorBlock verbatim + RETRY | scan > 120 s: StaleBanner `scan Nm old — scores are frozen` |
| Liquidations | SkeletonRows (6) | C4 empties | OfflineBlock | ErrorBlock | live response > 60 s: StaleBanner `liquidation map Nm old` |
| Detail | SkeletonRows (5) | EmptyBlock `select an opportunity` / `opportunity not found` (bad `?id`) | OfflineBlock | ErrorBlock | mid > 30 s: StaleBanner `live price Ns old — approve is blocked` |
| Health | 1 SkeletonRow | — | red `HEALTH UNREACHABLE` line (health is public; this means the server is down) | same | items go amber/red per C6 |
| Kill switch | `KILL` disabled until desk status lands | — | `DESK —` gray + `title` | verbatim under header | — |

**No DB:** the platform store falls back to memory, so the feed renders empty
with the copy above plus gray Badge `NO DATABASE — MEMORY STORE` in the
header (from `/health`). Never demo data.

### C8. Polling (extends §1.4; all pause when hidden)

Feed 15 s · detail on select + 30 s · liqmap live on coin change + 15 s ·
history on coin/window change + 5 min · health 15 s · desk status 30 s · WS
mark live. Every POST refetches feed + detail.

### C9. Components (`src/ui/pages/cockpit/`, client `src/ui/lib/platformApi.ts`)

| Component | Kind | Consumes / props |
|---|---|---|
| `Cockpit` (`Cockpit.tsx`) | container (route `/`) | owns pollers (C8), `?id/status/tier/liqh/liq`, keyboard handler, action state, the `?review=1` redirect |
| `CockpitHeader`, `KeyHint` (`Header.tsx`) | presentational | `venue, liveCount, readyCount, desk, noDb, killRef, onKill(), onHelp()`; desk status via Cockpit |
| `HealthStrip` (`Header.tsx`) | presentational | `health` (`GET /health`), `loading, offline, error, now` |
| `OpportunityFeed` / `FeedFilters` / `StatusPill` / `EdgeCell` / `WarmingLine` (`Feed.tsx`) | presentational | `GET /opportunities`: rows, selection, status/tier filters |
| `LiqMapPanel` (`LiqMap.tsx`) | container | `coin`; polls `GET /liqmap`, `GET /liqmap/history`; WS mark |
| `LiqProfile` / `LiqHistory` / `CoverageLine` / `LiqBoard` (`LiqMap.tsx`) | presentational | `buckets, mark, coverage` / `history` / `coverage` / board rows from `GET /liqmap/board` |
| `OpportunityDetail` (`Detail.tsx`) | presentational | `GET /opportunities/:id` → the five numbered sections of C5 (`SimilarSetups` and `PortfolioRisk` are local components; ledger stats come inside the detail) |
| `ActionBar` / `TicketDialog` / `RejectDialog` / `SnoozeMenu` (`Detail.tsx`) | presentational | `status, blocked, venue, busy, error, onApprove/onReject(reason)/onSnooze(min)/onResearch` → the four POSTs |
| `KeysHelp` (`Header.tsx`) | presentational | C3 table |
| `logic.ts` | pure, tested | `filterFeed`, `stepSelection`, `edgeWord`, `coverageTreatment`, `healthItems`, `worstItem`, `keyAction`, `denseBuckets`, `alphaStep`, `priceY` |

Shared files: `App.tsx` routes (`/` Cockpit, `/terminal` Terminal),
`AppShell.tsx` NAV, `TerminalTabs.tsx`.

**Fields read beyond SPEC P2** (pin in `src/shared/platform.ts`; if absent the
named fallback applies): row `direction`, `setupKind`, `liquidityTier`,
`createdAt` (else no tier tag / age from `age`); detail `ticket {side,
sizeUsd, entryPx, stopPx, targetPx}` and `invalidationPx` (else APPROVE
dialog shows `size set by the desk` and section 3 shows research only);
history buckets on an **absolute** price grid plus `mark` per snapshot (else
HISTORY is not drawn: EmptyBlock `history unavailable`); health `llm
{spentUsd, capUsd}`, per-loop `intervalSec`, `store: 'pg'|'memory'` (else
gray dots).

Skipped: drag-resizable panes, a multi-coin heatmap grid (one selected asset
is the point), click-sortable feed, bulk actions, sound alerts.
