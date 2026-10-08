# DESIGN-chat — PATHS (semantic simulation chat)

Binding interface brief for SPEC.md § "Paths — semantic simulation chat
(phase 4)". It **extends** DESIGN.md and never overrides it: tokens (§2),
responsive tiers (§4), state vocabulary (§6), confirmation levels (§7),
motion (§8), charts (§9), a11y (§12) and themes (§15) all apply unchanged.
Where this file is silent, DESIGN.md decides.

**No new tokens.** Every color, size and motion below already exists in
`src/ui/index.css` and the theme contract (`src/ui/themes/README.md`), so all
three themes work without edits.

**Reused as-is:** `Segmented`, `Button`, `Badge`, `DataTable` (one new
optional prop, §3.3), `EquityChart`, `ProjectionAssumptions`,
`DrawdownChart`, `LabWarnings`, `ErrorBlock`, `SkeletonRows`, `fmtUsd`,
`fmtPct`, `signClass`, `maxDdClass`, `rebalanceLabel`, `STABLE_COINS`.

---

## 1. `/analyst` mode toggle: ASK | SIMULATE

### 1.1 Placement

A `Segmented` (size `sm`) sits in the ANALYST panel header, **immediately
right of the panel title**, on the same row on every breakpoint. The model
selector cluster stays where it is (right side on md+, its own row below on
mobile, where the header already stacks).

```
desktop / mid
┌ ANALYST [ASK|SIMULATE] ───────── [● ANTHROPIC · Opus 5.5] [MED] [web search] [CLEAR] ┐

mobile (<768)
┌ ANALYST [ASK|SIM] ──────────────┐
│ [● ANTHROPIC · Opus 5.5] [MED]  │
│ [web search] [CLEAR]            │
```

- Options: `{ value: 'ask', label: 'ASK', title: 'Ask about the market' }`,
  `{ value: 'sim', label: 'SIMULATE', short: 'SIM', title: 'Simulate what-if portfolios' }`.
  No `tone` (a mode is not good/bad).
- `label` prop (accessible name): `analyst mode`.
- **Disabled while a turn streams** (`busy`), so a stream never changes
  threads under itself. Its `title` while disabled: `wait for the answer or STOP`.
- Persisted per browser: `localStorage['ht_analyst_mode']` = `ask | sim`,
  default `ask`. Read in try/catch like the model choice.
- The panel title stays `ANALYST` in both modes; the checked segment is the
  mode signal.

### 1.2 What changes per mode

| Surface | ASK (unchanged) | SIMULATE |
|---|---|---|
| Request | `mode` omitted | `mode: "sim"` in the body |
| Thread / session | `ht_analyst_session_v2`, 30 turns | **separate** `ht_paths_session_v1`, 10 turns (cards carry equity arrays) |
| Empty-thread intro | "Ask the analyst" | §1.3 |
| Prompt library (intro cards + rail PROMPTS panel) | `PROMPTS` | `SIM_PROMPTS` (§1.3) |
| Composer placeholder | `Ask about the tape, sectors, or the engine's decisions` | `Describe a what-if — "30% of my stack in SOL perps at 3x since January"` |
| Composer submit label | `ASK` | `SIMULATE` |
| Rail disclaimer | unchanged | §1.3 |
| CLEAR | clears the ASK thread | clears the SIMULATE thread only |
| Turn rendering | unchanged | plus PathCards (§2) |

Shared across modes: the model choice, the provider list, the TOOLS panel,
and the **composer draft** (one draft string; if you typed a what-if in ASK,
flipping to SIMULATE keeps it).

Why separate sessions: sim history carries a config trailer per turn (SPEC
decision 8) that would confuse the ask prompt, and a sim turn's equity
arrays should not bloat the 30-turn ask store. Switching modes swaps the
visible thread; each thread keeps its own turns in memory and storage.
Storage failure (quota) is already handled: the session lives for the tab.
`// ponytail:` 10 stored sim turns; downsample stored equity if quota bites.

### 1.3 Copy (exact strings)

**Intro** (EmptyThread in sim mode, same layout as ASK's):

- Heading (16px, text-primary): `Simulate a path`
- Body (11px, text-secondary, max 560px):
  `Describe a what-if in plain words — sizes, leverage, shorts, DCA, a start date. It becomes one to four branches, backtested on daily candles against HODL BTC and USDC, with every assumption it made listed on the card. Historical simulation, not advice.`

**SIM_PROMPTS** (group → items; same shape as `PROMPTS`):

| Group | Prompt |
|---|---|
| `Perps` | `What if I'd put 30% of my stack into SOL perps at 3x and DCA'd ETH weekly since January?` |
| `Hedge` | `Hedge my ETH with a short BTC position.` |
| `Compare` | `Compare 60/40 ETH/USDC against 100% BTC since 2023.` |
| `Leverage` | `Same 50/50 BTC/ETH portfolio at 1x, 2x and 5x since 2024.` |
| `DCA` | `DCA $200 a month into BTC from a USDC stack since 2022.` |

**Rail disclaimer** (10px text-secondary, replaces the ASK paragraph):
`Historical simulation on daily candles. Perp legs ignore funding, fees and slippage and liquidate at 100% margin loss on the day's low or high. Saving creates a branch; nothing is traded. Not financial advice.`

---

## 2. PathCard

One PathCard per `sim_result` event, inside the assistant turn.

### 2.1 Position in the turn

Order inside a sim-mode assistant turn:

```
model label · phase pulse
▸ REASONING (if any)
TOOLS · n [chips]
PathCard(s)            ← here, in sim_result arrival order
narrated answer (markdown)
ErrorBlock (if any)
usage row · COPY · ASK AGAIN
```

**Cards above the narration.** The card is the fact; the narration is
commentary on it. `sim_result` arrives before the narration streams, so the
card lands first and the text grows **below** it — the card never shifts
while text streams. A rare preamble sentence the model writes before calling
the tool ends up under the card; accepted.

### 2.2 Sizing

- Full width of the thread column (no bubble max-width); it is a `.panel`
  nested in the thread with `bg-panel-alt` body so it reads as a sub-surface.
- Fixed chart heights at every breakpoint (no JS breakpoint switch):
  equity **220px** (`<EquityChart height={220} />`), drawdown **90px**
  (`<DrawdownChart height={90} />`). These are DESIGN §4.5's mobile values —
  a thread holds several cards, so the compact size is right everywhere.
- Thread gap between turns stays `gap-6`.

### 2.3 Anatomy — desktop (`lg:`), two branches, A selected

```
┌ SIM  SOL 3x perp + weekly ETH DCA since Jan ────────────────────── 2 PATHS ┐
│ ASSUMED                                                                     │
│ · stack assumed $10,000 (not stated)                                        │
│ · DCA $250/week funded from the USDC sleeve                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│   PATH                               RETURN     MAX DD     VS BTC           │
│ ▸ A  30% SOL 3x + ETH DCA  2 WARN    +41.2%     −38.1%     +12.3%    (sel.) │
│   B  100% BTC                        +28.0%     −21.4%      +0.0%           │
├─────────────────────────────────────────────────────────────────────────────┤
│ A · 30% SOL 3x + ETH DCA                       [SAVE AS BRANCH]  [FORK]     │
│ SOL 30% [LONG 3×] · USDC 70%                                                │
│ DCA $250 → ETH WEEKLY                                                       │
│ FROM 2026-01-01 · $10,000 · NO REBAL                                        │
│ ▪ rebalance forced to none — DCA would be undone by a rebalance   (amber)   │
│ ▪ no funding, no fees, liquidation on daily lows/highs only       (amber)   │
│ FINAL      RETURN     CAGR      MAX DD     VS BTC                           │
│ $14,120    +41.2%     +52.0%    −38.1%     +12.3%                           │
│ — BRANCH — HODL BTC ┄ USDC                                                  │
│ [ equity chart 220px ]                                                      │
│ DRAWDOWN                                                  MAX DD −38.1%     │
│ [ drawdown chart 90px ]                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Mobile (<768): same blocks, same order, single column. The compare table
drops VS BTC (P3); the selected branch's stats grid shows all five values,
so nothing is lost. Action buttons go full width, side by side (`flex-1`).

```
┌ SIM  SOL 3x perp + weekly… 2 PATHS ┐
│ ASSUMED                            │
│ · stack assumed $10,000 …          │
├────────────────────────────────────┤
│   PATH               RETURN  MAXDD │
│ ▸ A 30% SOL 3x + …   +41.2% −38.1% │
│   2 WARN                           │
│   B 100% BTC         +28.0% −21.4% │
├────────────────────────────────────┤
│ A · 30% SOL 3x + ETH DCA           │
│ [ SAVE AS BRANCH ][   FORK   ]     │
│ SOL 30% [LONG 3×] · USDC 70%       │
│ …legs, DCA, config line, warnings  │
│ FINAL $14,120   RETURN +41.2%      │
│ CAGR +52.0%     MAX DD −38.1%      │
│ VS BTC +12.3%                      │
│ [ equity 220 ]  [ drawdown 90 ]    │
└────────────────────────────────────┘
```

### 2.4 Blocks, top to bottom

1. **Header** (`.panel-header`): left — `panel-title` `SIM`, then
   `intent.title` verbatim (12px text-primary, normal case, wraps; it is
   model-authored content, never uppercased). Right — `n PATHS` (10px
   text-secondary; `1 PATH` singular).
2. **ASSUMED** (always rendered, never collapsed — principle 6): `.label`
   `ASSUMED`, then one row per `intent.assumptions` item, 11px `text-muted`,
   `·` bullet, verbatim. Zero assumptions → one row
   `nothing inferred — every input was stated`.
3. **Compare table** (`PathCompare`) — **only when ≥ 2 branches**. See §2.5.
4. **Selected-branch section** (`PathBranch`):
   - Title row: `A · <branch name>` (12px text-primary) left; actions
     (§3) right on md+, below the title on mobile.
   - **Legs** (`PathLegs`): one inline item per allocation, joined by ` · `:
     `SOL 30%`, then for a perp leg a gray `Badge`: `LONG 3×` /
     `SHORT 1×` / `SHORT 2×` (side word + leverage, always both; leverage
     prints `×` U+00D7, integers without decimals, else one decimal).
     Spot legs and stables get no badge. 11px text-primary. Wraps freely.
   - **DCA line** (only when `config.dca` present): `DCA ` then entries
     joined by ` · `: `$250 → ETH WEEKLY`, `$100 → BTC MONTHLY`
     (`fmtUsd` 0 decimals). 11px text-muted.
   - **Config line**: `FROM <startDate> · <fmtUsd capital 0dp> · <rebalanceLabel>`
     e.g. `FROM 2026-01-01 · $10,000 · NO REBAL`. 10px text-secondary. The
     date is the normalized (post-clamp) date; the clamp warning says why.
   - **Warnings**: `<LabWarnings warnings={branch.warnings} />` — the amber
     strip, verbatim sentences, nothing rendered when empty. All adapter
     warnings and engine caveats (normalization, listing clamp, leverage
     clamp, DCA→no rebalance, projection skipped, perp caveats) go here.
     Amber because they qualify a valid result; red is reserved for failure.
   - **Stats** (`PathStats`): label/value grid, `grid-cols-2 md:grid-cols-5`,
     same cell markup as BranchDetail's StatsPanel: `FINAL` (`fmtUsd` 0dp,
     text-primary), `RETURN` (= `finalValue / config.initialCapitalUsd − 1`,
     signed, `signClass`), `CAGR` (signed, `signClass`), `MAX DD`
     (`maxDdClass`, always printed negative), `VS BTC` (signed,
     `signClass`). These are historical results, so green/red per DESIGN
     applies; every value prints its sign.
   - **Equity**: `<EquityChart equity btc usdc projection={result.montecarlo} height={220} />`.
     The fan, its `TODAY` divider and the P90/P50/P10 readout appear only
     when `montecarlo` is present, in info-blue as §9.3 — never green/red.
     When the fan is drawn, `<ProjectionAssumptions scenario={config.scenario} />`
     sits directly under the chart (principle 6).
   - **Drawdown**: a sub-header row `DRAWDOWN` (`.label`) left,
     `MAX DD −38.1%` (11px, `maxDdClass`) right, then
     `<DrawdownChart equity={result.equity} height={90} />`.

### 2.5 Comparing branches — decision

**Compare table for the numbers, one chart for the selected branch.** No
overlaid equity lines.

Why not overlay: `EquityChart` already draws three lines (branch, HODL BTC,
USDC) plus an optional fan. Four branches overlaid means seven lines and four
new series colors — new tokens for every theme, colors that must avoid
green/red (realized PnL) and blue (projection) — and an unreadable chart at
390px. Why not tabs: branch names are sentences ("30% SOL 3x + ETH DCA");
four of them do not fit a `Segmented` on a phone, and tabs hide the other
branches' numbers, which is the comparison the user asked for.

The table shows every branch's headline numbers at once; selecting a row
swaps the detail section below. Same chart component, zero new tokens, works
at every width.

`PathCompare` = `DataTable` with:

| Column | Priority | Render |
|---|---|---|
| `PATH` | 1 | `▸` (selected only, else a same-width space) + letter `A`–`D` + name (wraps) + suffix: `n WARN` 10px amber when warnings exist; `FAILED` red `Badge` when `error` |
| `RETURN` | 1 | signed %, `signClass`; `—` when failed |
| `MAX DD` | 2 | negative %, `maxDdClass`; `—` when failed |
| `VS BTC` | 3 | signed %, `signClass`; `—` when failed |

- Row click / Enter selects it (`onRowClick`). Selected row: `bg-selected`
  + the `▸` glyph + `aria-selected="true"` (glyph is the non-color signal).
  This needs one optional prop on `DataTable`: `isSelected?: (row) => boolean`
  → adds `bg-selected` and `aria-selected` on that `<tr>`. Nothing else in
  DataTable changes.
- Initial selection: the first branch without `error`; if all failed, the
  first branch.
- Selection is card-local state (not persisted).
- Letters `A`–`D` are display-only, by array index.

### 2.6 Per-branch error

A branch with `error` (unknown coin, no candles, timeout):

- Compare row: `FAILED` badge, numeric cells `—`.
- Selected detail: title row, legs, DCA line, config line, warnings as usual
  (the config is still useful context), then `<ErrorBlock message={error} />`
  verbatim in place of stats and charts. **No SAVE AS BRANCH** (it would
  fail the same way on run); FORK stays (the fix is usually a follow-up).
- Other branches render normally.
- All branches failed: same rendering; the user steps through rows to read
  each error. The narration (model) explains.

Single-branch card with an error: no table; header, ASSUMED, detail with the
ErrorBlock.

### 2.7 Pending state (tool running)

When a `tool_call` named `simulate_paths` arrives, a **PathPending** shell
renders in the card slot, keyed by the call `id`:

```
┌ SIM  SOL 3x perp + weekly ETH DCA since Jan ─────── SIMULATING 2 PATHS… ┐
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬                                            │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬                                                      │
│ ▬▬▬▬▬▬▬▬▬                                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

- Title: `input.title` if it is a string, else nothing. Right side:
  `SIMULATING n PATHS…` with `.pulse-label`, `n` = `input.branches.length`
  when it is an array, else `SIMULATING…`. Then `<SkeletonRows rows={3} />`.
- Replaced in place by the PathCard when the `sim_result` with the same `id`
  arrives.
- Removed when that call's `tool_result` arrives without a `sim_result`
  (zod reject, 40 s deadline). The TOOLS chip already turns red with the
  summary; the model reports or retries. No separate card error.
- Removed when the turn stops (STOP / stream error) without a result.
- No spinners; reduced motion makes the pulse a static `…` (global rule).

### 2.8 Data plumbing (UI side, for the implementer)

- `AnalystStreamEvent` gains `{ type: 'sim_result'; id; intent; branches }`.
- `TurnState` gains `sims: SimResultEvent[]` (append on `sim_result`) and
  `saved: Record<string, string>` mapping `"<simId>#<branchIndex>"` → branch
  id. Both are persisted with the turn, so a reload keeps the cards and their
  SAVED state (no accidental duplicate saves).
- Pending shells derive from `trace` (`name === 'simulate_paths'`, no result,
  no matching `sims` entry) — no extra state.
- `streamAnalyst` takes the mode; in sim mode `toHistory` appends the config
  trailer (SPEC decision 8).

---

## 3. Actions

Both live in the selected-branch title row. Confirmation level: **Level 1**
(§7) for both — saving is additive and reversible (the branch can be
deleted), forking only edits the composer.

### 3.1 SAVE AS BRANCH (`SaveBranchButton`)

| State | Render |
|---|---|
| idle | Neutral `Button`: `SAVE AS BRANCH` |
| saving | same button, disabled, label `SAVING…` with `.pulse-label` |
| saved | the button is replaced by a ghost-styled react-router `Link` to `/branches/:id`: `SAVED · OPEN ↗`; focus moves to it |
| error | back to idle button; under the actions row `<ErrorBlock message={verbatim} onRetry={save} />` |
| branch failed | not rendered (§2.6) |

Request: `POST /api/branches` with
`{ name: branch.name, config: { ...branch.config, description } }` where
`description` = `Paths: <intent.title>. Assumed: <a1>; <a2>.` (assumptions
joined by `; `; the `Assumed:` part omitted when there are none). The
assumptions thereby travel with the saved branch and show in its
DESCRIPTION field (principle 6). On 201, store the id in
`turn.saved["<simId>#<i>"]`, then fire `POST /api/branches/:id/run` without
awaiting, so the branch opens with a cached result; its outcome is not shown
on the card (if it fails, `/branches/:id` shows its normal
`not simulated yet — RUN SIMULATION` state).

Each branch saves independently; saving A leaves B's button idle.

### 3.2 FORK

Ghost `Button`: `FORK`. On click:

- Prefix = `Fork "<branch name>": ` .
- Composer draft becomes `prefix + draft` (an existing draft is kept after
  the prefix; if the draft already starts with that exact prefix, nothing is
  added).
- Focus the composer (`#analyst-q`) with the caret at the end.
- Never auto-sends. Works while another turn streams (only sending waits).
- Shown for failed branches too.

The history trailer carries the normalized config, so "same but 5x" resolves
against the named path.

---

## 4. `/branches/:id` editor additions (round-trip)

All editable — each is a small extension of the existing allocation row
pattern. A saved path opens, edits, saves and re-runs like any branch.

### 4.1 AllocationEditor: SIDE and LEV columns

```
ALLOCATIONS
COIN    WEIGHT    SIDE        LEV
[SOL ]  [30 ] %   [LONG|SHORT] [3  ]×   ✕
[USDC]  [70 ] %   [LONG|SHORT] [1  ]×   ✕     ← stable: SIDE + LEV disabled
[+ ADD COIN]                       Σ 100%
```

- A header row of `.label` text (10px): `COIN  WEIGHT  SIDE  LEV`.
- **SIDE**: `Segmented` size `sm`, options `LONG` (short `L`) / `SHORT`
  (short `S`), no tone, `label` = `<COIN> side`.
- **LEV**: `<input type="number" min=1 max=50 step=1>`, `w-[5ch]`, followed
  by `×` in 11px text-secondary; `aria-label` = `<COIN> leverage`.
- **Stables** (`STABLE_COINS`): SIDE disabled at LONG, LEV disabled at 1,
  `title` on both: `stablecoins are spot only`. Typing a stable into COIN
  resets that row to long / 1.
- A row is a perp leg when SHORT or LEV > 1 — no extra marker; the controls
  say it.
- Out-of-range LEV (< 1, > 50, not a number): line under the Σ footer,
  `--color-red-text` 11px: `leverage must be 1–50`; RUN and SAVE disabled
  (same rule as the Σ check).
- The rows sit in `.table-scroll` (§4.4) so a narrow phone scrolls the editor,
  never the page.
- Submitted config **omits** `side` when long and `leverage` when 1, so an
  untouched legacy branch saves byte-identical.

### 4.2 DCA section (new, between ALLOCATIONS and REBALANCE)

```
DCA
COIN    AMOUNT       EVERY
[ETH ]  $[250    ]   [WEEKLY|MONTHLY]   ✕
[+ ADD DCA]
buys from the USDC/USDT sleeve; stops when it runs out
```

- Section `.label` `DCA`, same top hairline as the others.
- Row: COIN (text, uppercased, `w-[6ch]`), AMOUNT (`$` prefix, number,
  `min=1`, `w-[7ch]`), EVERY (`Segmented` sm: `WEEKLY` short `WK` /
  `MONTHLY` short `MO`), Danger `✕`. `aria-label`s: `DCA coin`,
  `DCA amount USD`, `DCA <COIN> every`.
- `+ ADD DCA` ghost adds `{ coin: '', amountUsd: 100, every: 'weekly' }`.
- Footnote, 10px text-secondary: `buys from the USDC/USDT sleeve; stops when it runs out`.
- Invalid row (empty coin or amount ≤ 0): 11px red-text line
  `each DCA row needs a coin and an amount above $0`; RUN/SAVE disabled.
- No stable allocation while DCA rows exist: 10px amber line (not blocking)
  `no USDC/USDT allocation — DCA has nothing to spend`.
- Zero rows → `dca` omitted from the config.

**DCA forces no rebalance.** While ≥ 1 DCA row exists:

- Adding the first row sets `rebalance` to `none`.
- The REBALANCE `Segmented` is `disabled`, showing `NONE` checked.
- Under it, 10px text-secondary:
  `NONE — DCA needs no rebalance (a rebalance would undo the buys)`.
- Removing the last DCA row re-enables the control; the value stays `none`.

### 4.3 Scenario editor with perp legs

Monte Carlo is skipped for any branch with a perp leg. In the SCENARIO
section, when any allocation is a perp leg:

- No scenario in the form: `+ ADD PROJECTION` is disabled; under it, 10px
  text-secondary: `projection unavailable — Monte Carlo models unlevered long-only portfolios`.
- A scenario already in the form (manual edit of an old branch): the
  scenario inputs are disabled, the same line shows in `--color-red-text`
  11px with the action: `remove the projection or the perp leg — Monte Carlo models unlevered long-only portfolios`,
  `REMOVE PROJECTION` (Danger, its existing Level 2 confirm) stays enabled,
  and RUN/SAVE are disabled until one of the two is removed. Nothing is
  silently dropped — removing a scenario is Level 2 per §7.

Paths saved from chat never hit the second case: the adapter already
dropped the scenario and the card warned.

### 4.4 Branches list summary

`allocationSummary` appends perp info so a saved path doesn't read as spot in
`/branches`: `30 SOL 3×` (long levered), `30 BTC SHORT` (short 1×),
`30 BTC SHORT 2×`; a `+ DCA` suffix when `dca` exists. Spot rows unchanged.

---

## 5. Components and boundaries

New files under `src/ui/components/paths/`:

| Component | Props | Owns |
|---|---|---|
| `PathCard` | `sim: SimResultEvent`, `saved: Record<string,string>`, `onSaved(key, branchId)`, `onFork(name)` | header, ASSUMED, selection state, picks table vs single |
| `PathCompare` | `branches`, `selected: number`, `onSelect(i)` | the `DataTable` config of §2.5 |
| `PathBranch` | `branch`, `letter`, `title`, `assumptions`, `savedId?`, `onSaved(id)`, `onFork()` | §2.4 item 4 (legs, DCA, config line, warnings, stats, charts, or ErrorBlock) |
| `PathLegs` | `config` | legs + DCA line + config line |
| `PathStats` | `result`, `initialCapitalUsd` | 5-cell grid |
| `SaveBranchButton` | `name`, `config`, `description`, `savedId?`, `onSaved(id)` | §3.1 state machine + POST |
| `PathPending` | `input: unknown` | §2.7 shell |

Not new components (deliberately): the mode toggle is a `Segmented` inline
in `Analyst.tsx`; warnings use `LabWarnings`; the FORK button is an inline
`Button`. SIDE/LEV and the DCA section stay inline in `BranchDetail.tsx`
next to the existing allocation and scenario code.

`Analyst.tsx` changes: mode state + toggle, per-mode session key and store
size, `SIM_PROMPTS`, mode-dependent intro/placeholder/submit label/rail
disclaimer, `sim_result` in `applyEvent`, rendering pending shells and
PathCards between `Timeline` and `Markdown`, the FORK draft handler.

---

## 6. States matrix

| Surface | Loading | Empty | Error | Notes |
|---|---|---|---|---|
| Mode toggle | — | — | — | disabled while streaming |
| SIMULATE thread | SkeletonRows (status probe, shared) | sim intro + SIM_PROMPTS | OfflineBlock (503/502, shared); per-turn ErrorBlock | — |
| PathPending | `SIMULATING n PATHS…` pulse + SkeletonRows 3 | — | removed; TOOLS chip shows the error | — |
| PathCard | — | ASSUMED shows `nothing inferred — every input was stated` | per-branch ErrorBlock (§2.6) | warnings amber via LabWarnings |
| Fan | — | absent when no `montecarlo` (no placeholder; the skip is a warning) | — | info-blue only |
| SaveBranchButton | `SAVING…` pulse | — | ErrorBlock verbatim + RETRY | saved → `SAVED · OPEN ↗` link, persisted |
| FORK | — | — | — | never sends |
| AllocationEditor | as today | as today | red lines: Σ, leverage range | stables locked |
| DCA section | — | `+ ADD DCA` only | red line: invalid row; amber: no stable sleeve | forces rebalance NONE |
| Scenario w/ perp | — | ADD disabled + reason | red line + RUN/SAVE disabled if scenario present | Level 2 removal |

Every cell is a DESIGN §6 named pattern. Nothing bespoke.

---

## 7. Keyboard and a11y (on top of DESIGN §12)

- Mode toggle and SIDE/EVERY controls are `Segmented` radiogroups: Tab to
  the checked segment, arrows move and select.
- PathCard is a `<section aria-label="Simulation: <intent.title>">`.
- Compare table rows are focusable (DataTable); Enter selects;
  `aria-selected` on the selected row; `▸` glyph so selection isn't color-only.
- After SAVE succeeds, focus moves to the `SAVED · OPEN ↗` link (the focused
  button disappeared). After FORK, focus moves to the composer.
- Color is never the only signal: perp badges say `LONG`/`SHORT` and `3×`;
  `FAILED` and `n WARN` are words; every stat prints its sign; warnings carry
  the square bullet and full sentences.
- ErrorBlocks keep `role="alert"`. Pulse labels are not live regions.
- Every new input has a visible column label and an `aria-label` naming its
  coin (§4.1, §4.2).
- Touch: all new controls read `--control-*`/`--tap-min`; the full-width
  mobile SAVE/FORK pair is ≥ 44px on coarse pointers.

---

## 8. Copy index

| Where | String |
|---|---|
| Mode options | `ASK`, `SIMULATE` (mobile `SIM`) |
| Mode group label | `analyst mode` |
| Mode disabled title | `wait for the answer or STOP` |
| Sim intro heading | `Simulate a path` |
| Sim intro body | §1.3 |
| Sim placeholder | `Describe a what-if — "30% of my stack in SOL perps at 3x since January"` |
| Sim submit | `SIMULATE` |
| Rail disclaimer (sim) | §1.3 |
| Card header | `SIM`, `n PATHS` / `1 PATH` |
| Assumptions label / empty | `ASSUMED` / `nothing inferred — every input was stated` |
| Compare columns | `PATH`, `RETURN`, `MAX DD`, `VS BTC` |
| Row markers | `n WARN`, `FAILED` |
| Perp badge | `LONG 3×`, `SHORT 1×` |
| DCA line | `DCA $250 → ETH WEEKLY · $100 → BTC MONTHLY` |
| Config line | `FROM 2026-01-01 · $10,000 · NO REBAL` |
| Stats labels | `FINAL`, `RETURN`, `CAGR`, `MAX DD`, `VS BTC` |
| Drawdown | `DRAWDOWN`, `MAX DD −38.1%` |
| Pending | `SIMULATING n PATHS…` / `SIMULATING…` |
| Save | `SAVE AS BRANCH` → `SAVING…` → `SAVED · OPEN ↗` |
| Save description | `Paths: <title>. Assumed: <a1>; <a2>.` |
| Fork | `FORK`; prefix `Fork "<branch name>": ` |
| Editor headers | `COIN`, `WEIGHT`, `SIDE`, `LEV`; `LONG`/`SHORT` (`L`/`S`) |
| Stable lock title | `stablecoins are spot only` |
| Leverage error | `leverage must be 1–50` |
| DCA | `DCA`, `+ ADD DCA`, `AMOUNT`, `EVERY`, `WEEKLY`/`MONTHLY` (`WK`/`MO`) |
| DCA footnote | `buys from the USDC/USDT sleeve; stops when it runs out` |
| DCA invalid | `each DCA row needs a coin and an amount above $0` |
| DCA no sleeve | `no USDC/USDT allocation — DCA has nothing to spend` |
| Rebalance locked | `NONE — DCA needs no rebalance (a rebalance would undo the buys)` |
| Projection unavailable | `projection unavailable — Monte Carlo models unlevered long-only portfolios` |
| Projection conflict | `remove the projection or the perp leg — Monte Carlo models unlevered long-only portfolios` |
| List summary | `30 SOL 3×`, `30 BTC SHORT`, `30 BTC SHORT 2×`, `+ DCA` |

Warning and error sentences from the server (adapter warnings, engine
caveats, per-branch errors, save errors) render **verbatim** — the UI never
rewrites them.

---

Skipped: overlaid multi-branch equity (needs four new series tokens per
theme; add when the compare table proves insufficient), a URL `?mode=` param
(add when something links into SIMULATE), downsampling stored sim turns (add
on a real quota failure).
