# hypertrade TUI — design

Binding UI brief for `tui/SPEC.md`. SPEC owns flows and data; `src/core/types.ts` owns shapes; this file
owns layout, components, color, formatting and keys. Where this file is silent, follow the spirit of
`DESIGN-terminal.md`: dense, tabular, numbers right-aligned, staleness always visible, **code computes
and the model explains** (model text is never recolored green/red), and nothing ever trades without the
human's own keypress.

## 1. Screen model

### 1.1 Why the status bar sits at the bottom

Ink cannot scroll. Finished output goes through `<Static>`: printed once, then owned by the terminal's
scrollback. Everything else is the **live region**, which Ink redraws below the Static output on every
frame. Top to bottom: **scrollback** (Static: banner, user turns, agent text, tool lines, alerts,
snapshots, sent tickets), then the **dock** (live): active area (streaming paragraph, running tool
lines, pending ticket, or overlay) → completion list (while Tab completing) → position strip (medium
tier) → rule + prompt line → hints line → **status bar, always the last line**.

**Hard rule:** the live region never exceeds `rows − 1` lines (Ink's redraw breaks and flickers past the
viewport). Every live component takes `maxHeight` and clips itself. Streaming text flushes each finished
paragraph (blank line or tool call) to Static, so the live area holds only the current paragraph,
clipped to its last `rows − 8` lines.

Minimum size 80×20. Below it the dock is replaced by one line `ht needs 80×20 (now 72×18)`; Static
output continues. On resize, widths are recomputed; already-printed Static lines are left to the
terminal.

### 1.2 Width tiers

| Tier | Cols | Differences |
|---|---|---|
| narrow | 80–99 | Status bar drops fields (§1.3). No position strip, no side panel. Tables drop columns (§4.3). Ticket card `cols − 2` below 82. |
| medium | 100–159 | Full status bar. **PositionStrip** line above the prompt rule. Tables full. |
| wide | ≥ 160 and rows ≥ 30 | Dock becomes two columns: left = active area + prompt + hints (`justifyContent="flex-end"`, so the prompt stays at the bottom); right = **PositionsMini**, 42 cols, left border `│`, max 9 rows. Status bar spans full width below both. Hidden while an overlay is open. |

Prose (agent text, alerts, notes) wraps at `min(cols − 4, 110)`; tables and the overlay use the full
width. At wide tier the transcript prose column is also capped to `cols − 44` so it lines up with the
dock's left column.

### 1.3 Status bar

One line, no border, fields separated by two spaces, in table order:

| Field | Format | Notes |
|---|---|---|
| DEMO | ` DEMO ` badge | only with `--demo` |
| network | ` TESTNET ` / ` MAINNET ` badge | MAINNET badge shows whenever network is mainnet; never dropped |
| account | `0x3fA2…91c0` (6+4) | `no account` dim when `account` null; `acct err` critical when `accountError` |
| equity | `eq $12,345.67` | |
| uPnL | `uPnL +$124.30` | up/down color + sign |
| margin | `margin $2,210 (18%)` medium+; `margin 18%` narrow | % = marginUsed / equity |
| pos / orders | `pos 2` `orders 3` | |
| ws | `ws live` / `ws connecting` / `ws down · poll 12s` / `ws off` | live dim, connecting warn, down critical, off dim |
| alerts | `alerts 3` colored by highest active level; `alerts 0` dim | |
| model | `sonnet-4.5`; `agent off` when no provider | |

Narrow truncation: render all fields, then while wider than `cols` drop the lowest-priority remaining
field. Priority, kept longest first: network badge, DEMO, uPnL, equity, alerts (when > 0), ws (when not
`live`), pos, margin, account, orders, ws (`live`), alerts (0), model. Never ellipsize inside a field.

### 1.4 Transcript vs. overlays (one choice per view)

| View | Kind | Why |
|---|---|---|
| `/markets` | **live overlay**, Esc closes, nothing appended | 200+ rows, sortable, ticking every poll; a frozen copy is noise in scrollback. |
| `/book COIN` | **live overlay**, Esc closes, appends a one-line `book-summary` snapshot | Book is stale within seconds; the summary (spread, depth, $50k slippage, time) is the part worth keeping. |
| `/pos` | inline snapshot | Small; the record of "what I held at 14:02" is useful context next to agent turns. Liveness comes from the strip / side panel / status bar. |
| `/coin`, `/alerts`, `/pulse`, `/brief`, `/model`, `/help` | inline snapshot | Read once, belong to the conversation. |
| ticket | live in the dock until resolved, then frozen (§5.4) | Must update on re-quote and block input. |

An overlay replaces the active area, prompt, hints, strip and side panel; the status bar stays. Overlay
height = `rows − 1`. Store updates are coalesced to ≤ 4 renders/s; streamed tokens are batched every 50
ms.

## 2. Mockups (120 cols)

Main screen, mid-conversation (medium tier):

```
ht 0.1 · testnet · 0x3fA2…91c0 · read-write · agent sonnet-4.5 · /help for commands
› /pos
  POSITIONS · 14:01:58 · eq $12,345.67 · uPnL +$122.43 · margin $2,210 (18%)
  COIN   SIDE       SIZE       ENTRY        MARK       uPnL  LEV       STOP  →STOP         LIQ    →LIQ          TP
  BTC    LONG    0.04500    60,412.0    61,170.0    +$34.11   3x   59,200.0  -3.2%    41,050.0  -32.9%    63,500.0
  ETH    SHORT    1.2000     3,412.5     3,338.9    +$88.32   2x          —      —     4,980.2  +49.2%           —
  ORDERS  81234 BTC sell 0.04500 stop 59,200.0 sl·ro  ·  81235 BTC sell 0.04500 tp 63,500.0 tp·ro
› is the ETH short getting crowded? funding looks off
  ▸ get_coin ETH · 210ms
  ▸ get_funding_history ETH 48h · 340ms
● ETH funding is -14.2% APR (predicted -18.0%), negative in 31 of the last 48 hours, while OI rose 4.1% in 24h.
  That mix usually reads as shorts pressing; it could unwind quickly if price stops falling.
! WARN  14:02:40  ETH no stop on open position · short 1.2000 ETH, liq 4,980.2 (+49.2%)
● Your short has no stop resting. I can draft one at the prior-day high (3,455.0, +3.5%) for you to confirm.
  BTC L +$34.11 stop -3.2%  ·  ETH S +$88.32 no stop
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
› draft that stop█
  enter send · ↑↓ history · tab complete · / commands · ctrl-c ×2 quit
 TESTNET  0x3fA2…91c0  eq $12,345.67  uPnL +$122.43  margin $2,210 (18%)  pos 2  orders 2  ws live  alerts 1  sonnet-4.5
```

Markets overlay (row 2 selected, shown inverse):

```
 MARKETS  sort oi ↓  filter —  214 coins  poll 6s ago  ws live                                                    2/214
 COIN             MARK      24H    FUND/H      APR  PRED APR        OI       VOL     PREM  MAX
 BTC          61,170.0   +1.24%   0.0013%   +11.4%    +12.0%    $2.41B    $3.12B   +0.02%  40x
 ETH           3,338.9   -2.10%  -0.0016%   -14.2%    -18.0%    $1.12B    $1.48B   -0.05%  25x
 SOL            142.39   +4.88%   0.0041%   +35.9%    +31.2%     $612M     $904M   +0.11%  20x
 kPEPE        0.012345   -7.92%   0.0102%   +89.4%    +94.0%    $61.2M    $88.1M   +0.40%  10x cap
 …
 ↑↓ select · enter /coin · b /book · sort o oi  v vol  c chg  f funding (again reverses) · / filter · esc close
 TESTNET  0x3fA2…91c0  eq $12,345.67  uPnL +$122.43  margin $2,210 (18%)  pos 2  orders 2  ws live  alerts 1  sonnet-4.5
```

Ticket pending (agent drafted it; prompt disabled):

```
● Drafted below. It sizes to 0.5% risk with the stop 2% under entry; the governor passed it with one warning.
  ▸ draft_order BTC long risk 0.5% stop 2% tp 3% · 95ms
╭─ TICKET t-3f2a · OPEN · from agent ──────────────────────────────── TESTNET ─╮
│ LONG BTC   0.0123 BTC   ≈ $752.40 notional   3x cross   market IOC ±1%       │
│ entry ≈   61,170.0        slippage est   2.1 bps                             │
│ stop      59,946.6  -2.0%     tp        63,005.1  +3.0%                      │
│ liq ≈     41,320.0 -32.5%     R:R       1.5                                  │
│ risk      $15.05 · 0.50% of equity                                           │
│                                                                              │
│ governor  PASS                                                               │
│ ! gross leverage after this order 1.9x (limit 5x)                            │
│ · stop resolved as 2.0% from entry                                           │
│                                                                              │
│ y send · n discard                                       quoted 14:03:02     │
╰──────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
› ticket pending: y send · n discard
  y send · n/esc discard
 TESTNET  0x3fA2…91c0  eq $12,345.67  uPnL +$122.43  margin $2,210 (18%)  pos 2  orders 2  ws live  alerts 1  sonnet-4.5
```

## 3. Components (`tui/src/ui/`)

Names avoid the `BookView`/`CoinView` type names. Every component is pure (props in, no store access)
except `App` and the two overlays, which subscribe to the store. All take `width`; live ones also take
`maxHeight`.

**Shell**
- `App {store, config, agent, commands}` — owns `mode` (§6), transcript `entries: Entry[]`, pending
  ticket, history. Renders `<Transcript>` + `<Dock>`.
- `Transcript {entries, width}` — `<Static items={entries}>` → `EntryView`.
- `EntryView {entry, width}` — switch on `entry.kind`, one component per kind.
- `Dock {mode, active: ReactNode, state: AppState, prompt: PromptProps, width, rows}` — lays out
  §1.1/§1.2; picks tier; hosts `PositionStrip` / `PositionsMini`.
- `StatusBar {state: AppState, agentLabel: string | null, width, now}` — §1.3.
- `PositionStrip {positions: PositionRow[], width}` — `BTC L +$34.11 stop -3.2%` joined by ` · `; `no
  stop` in warn; overflow → `+3 more`. Hidden when no account.
- `PositionsMini {account: AccountSnapshot | null, maxRows}` — header `POSITIONS  uPnL ±$`, rows `COIN
  L|S size uPnL stop-dist`, footer `orders N · margin N%`.
- `Prompt {value, cursor, disabled, disabledText, onChange, onSubmit}` — rule line then `› ` + input.
  Disabled: dim `disabledText`, no cursor.
- `Hints {mode, width, quitArmed, agentElapsedS}` — the per-mode hint line (§6).
- `CompletionList {items: {label, detail}[], selected, maxRows: 6}`.

**Entry kinds** (`type Entry = {id, at} & (…)`), each with its renderer:

| kind | fields | renderer / look |
|---|---|---|
| `banner` | config summary | `BannerLine`: dim `ht 0.1 · testnet · 0x… · read-only|read-write · agent … · /help` |
| `user` | `text` | `UserLine`: `› ` accent + text bold |
| `agent-text` | `text` | `AgentText`: `● ` accent on first line, 2-space hanging indent. Only `**bold**` and `` `code` `` (accent) are interpreted; no colors inside model text |
| `tool-line` | `name, args, status: running\|ok\|error, ms?, error?` | `ToolLine`: dim `  ▸ name args · 210ms`; running `· …`; error appends `· error: msg` (word in critical) |
| `alert` | `alert: Alert` | `AlertLine` (§7) |
| `view-snapshot` | `view: pos\|coin\|alerts\|pulse\|brief\|help\|model\|book-summary, data, at` | `PositionsTable`+`OrdersList`, `CoinCard`, `AlertsList`, `PulseList`, `BriefBlock`, `HelpList`, `ModelLine`, `BookSummaryLine`. Every snapshot's header names the clock time it was taken |
| `ticket` | `ticket, outcome: sent\|failed\|discarded\|dismissed` | `TicketCard` frozen, or one-line `TicketNote` for discarded/dismissed (§5.4) |
| `result` | `result: SendResult, ticketId` | `ResultBlock` (§5.4) |
| `error` | `source, message, hint?` | `ErrorLine`: `✗ ` critical + `source: message`, hint dim on next line |
| `note` | `text` | `NoteLine`: dim `– text` (aborted, cleared, overlay closed with summary, etc.) |

**Views**
- `Table {columns: Column[], rows, width}` — the only table primitive. `Column {key, header, width,
  align: left|right, dropRank: number (0 = never), render(row) → {text, tone?}}`. Drops highest
  `dropRank` first until `Σwidth + gaps ≤ width`; one space gap; headers dim uppercase, same alignment
  as the column.
- `MarketsTable {rows: MarketRow[], width, selected: number | null, offset}`.
- `MarketsOverlay {store, sort, dir, filter, maxHeight, width, onClose, onCoin(coin), onBook(coin)}` —
  header line, `MarketsTable` windowed around the selection, key footer.
- `PositionsTable {positions: PositionRow[], width}` and `OrdersList {orders: OpenOrder[], width}`.
- `BookLadder {book: BookView, levels, szDecimals, width}` — asks descending, spread row, bids
  descending; `PX  SIZE  CUM USD  bar`; bar = `█` scaled to max cumulative, bids up-colored, asks
  down-colored, bar column dropped < 100 cols. Below: `spread 0.8 bps · ±50bps $4.1M / $3.9M` and a
  slippage table `SIZE  BUY bps  SELL bps` for $10k/$50k/$250k (`—` = too thin).
- `BookOverlay {store, coin, maxHeight, width, onClose}` — fetches/polls the book, `levels = min(10,
  ⌊(maxHeight − 9)/2⌋)`, `+`/`-` change levels.
- `CoinCard {view: CoinView, width}` — header `BTC  61,170.0  +1.24%  24h`, then label/value rows:
  funding (hourly, APR, predicted APR), OI, 24h vol, premium, ATR14 (+ % of mark), regime, then
  `diagnostics` verbatim as `· ` lines, then the position (one `PositionsTable` row) or `no position`.
- `TicketCard {ticket, ui: TicketUi, width}` with `TicketUi = {phase: awaiting|requoting|sending|frozen,
  changedWhy?: string, previous?: Ticket, source: command|agent, outcome?}` (§5).
- `ResultBlock {result: SendResult}`, `AlertLine {alert}`, `AlertsList {alerts, now}`, `HelpList
  {commands: {usage, summary}[], width}` (usage left-aligned in a column sized to the longest, summary
  dim), `PulseList`, `BriefBlock` (headline bold, tldr verbatim, risks as `· `, top sectors,
  `generated_at` age — warn > 36 h).

## 4. Theme and formatting

### 4.1 Semantic tokens (`ui/theme.ts`)

Only the 16 ANSI names, so the user's terminal palette keeps text readable on dark and light
backgrounds. Never `white`/`black` as text color; primary text is the terminal default. Hex values are
the web tokens they stand for, not used.

| Token | Ink props | Web origin | Used for |
|---|---|---|---|
| `fg` | none | `--color-text-primary` | values, agent text |
| `dim` | `dimColor` | `--color-text-secondary` | labels, headers, tool lines, hints, ages |
| `up` | `color="green"` | `#38a67c` | positive PnL/change, LONG, bids |
| `down` | `color="red"` | `#e8677d` | negative PnL/change, SHORT, asks |
| `warn` | `color="yellow"` | `#ffb800` | warn alerts, CLIPPED, stale data, changed fields, ws connecting |
| `critical` | `color="red" bold` | `#bc263e` | critical alerts, errors, REJECTED, blockers, ws down |
| `accent` | `color="cyan"` | `#6ea8d8` | prompt caret, `●`, slash-command names, completion selection |
| `pass` | `color="green" bold` | | governor PASS, `✓` |
| `badgeMainnet` | `color="red" inverse bold` | `--color-red-accent` | ` MAINNET ` |
| `badgeTestnet` | `color="yellow" inverse` | | ` TESTNET ` |
| `badgeDemo` | `color="magenta" inverse` | | ` DEMO ` |
| `selected` | `inverse` | `--color-selected` | overlay selected row |

**NO_COLOR** (set and non-empty), `FORCE_COLOR=0`, or non-TTY stdout: every token renders with no color;
`bold`, `inverse` and `dimColor` stay. Meaning is never color-only anyway: signs on every signed number,
words `LONG`/`SHORT`, `PASS`/`CLIPPED`/`REJECTED`, alert tags `INFO`/`WARN`/`CRIT`, badges are words in
inverse. `HT_ASCII=1` swaps box drawing to `borderStyle="classic"` and `▸ › ● ✓ ✗ █ →` to `> > * + x #
->`.

### 4.2 Number rules (`ui/format.ts`, all pure, unit-tested)

- **Price** `fmtPx(px, szDecimals)`: 5 significant figures, decimals capped at `6 − szDecimals`
  (Hyperliquid's tick rule), thousands separators, fixed decimals per coin within a view so a column of
  one coin aligns. `61,170.0`, `3,338.9`, `142.39`, `0.012345`.
- **Size** `fmtSz(sz, szDecimals)`: exactly `szDecimals` decimals.
- **USD, account scale** `fmtUsd`: `$12,345.67` (2 decimals) below $1M, then compact. Signed form
  `+$34.11` / `-$31.20`.
- **USD, market scale** `fmtUsdCompact`: 3 significant figures with K/M/B/T: `$2.41B`, `$612M`,
  `$61.2M`, `$12.3K`, `$950`.
- **Percent** `fmtPct`: signed, 2 decimals (`+1.24%`); |x| ≥ 100 → 0 decimals. Distances (`→STOP`,
  `→LIQ`, ticket distances) 1 decimal (`-3.2%`).
- **Funding** hourly: 4 decimals percent, signed only when negative (`0.0013%`, `-0.0016%`); APR
  `fmtApr`: signed, 1 decimal (`+11.4%`).
- **bps** `fmtBps`: < 10 → 1 decimal (`2.1 bps`), else integer (`14 bps`).
- **Leverage** `3x`; R:R `1.5`; clock `14:02:40` local; ages `6s` `4m` `2h` `3d`; missing `—`; ASCII
  `+`/`-` signs (not U+2212).
- Widths measured with `string-width`; every number column right-aligned, text columns left-aligned.
  Tones: change/PnL/funding by sign (`up`/`down`; exact zero `fg`); prices never colored.

### 4.3 Table columns (width, align, dropRank — highest drops first)

**MarketsTable**: COIN 9 L 0 · MARK 11 R 0 · 24H 8 R 0 · FUND/H 9 R 5 · APR 8 R 0 · PRED APR 9 R 3 · OI
9 R 0 · VOL 9 R 1 · PREM 8 R 4 · MAX 4 R 2 · FLAG 8 L 6 (dim `cap` at OI cap, `delisted`). At 80 cols
FLAG, FUND/H, PREM drop. Default sort `oi` desc; `chg` sorts by |24h| desc; `funding` by |APR| desc;
reversing flips the sign order.

**PositionsTable**: COIN 6 L 0 · SIDE 5 L 0 · SIZE 9 R 5 · ENTRY 11 R 4 · MARK 11 R 0 · uPnL 10 R 0 ·
LEV 4 R 6 · STOP 10 R 3 · →STOP 6 R 0 · LIQ 11 R 2 · →LIQ 7 R 0 · TP 11 R 7. At 80 cols TP, LEV, SIZE,
ENTRY drop. `→STOP` within 1% of mark → warn; no stop → `—` in warn.

**OrdersList**: one line per order when < 4 orders (`81234 BTC sell 0.045 stop 59,200.0 sl·ro`), else a
`Table`: OID 9 R 0 · COIN 6 L 0 · SIDE 4 L 0 · SIZE 9 R 0 · PX 11 R 0 · TRIGGER 11 R 2 · TYPE 10 L 1 ·
AGE 5 R 3.

**BookLadder**: PX 11 R 0 · SIZE 10 R 0 · CUM USD 9 R 1 · bar flex L 2.

## 5. Ticket card

### 5.1 Frame and fields

Round border, width 80 when `cols ≥ 82`, else `cols − 2`. Border dim on testnet/demo, `critical` on
mainnet. Title on the top border: `TICKET <id> · OPEN|CLOSE|CANCEL|STOP · from agent|command`; network
badge right-aligned on the top border. Body rows in this order; a row renders only when its values are
non-null; values use §4.2 and labels are dim:

1. Headline: `LONG|SHORT` (up/down, bold) `COIN  size COIN  ≈ $notional notional  Nx cross  market IOC
   ±N%` (or `limit @px`). Close: `CLOSE 50% of LONG BTC  0.0225 BTC ≈ $1,376 · reduce-only IOC`. Cancel:
   `CANCEL 2 orders` then one dim line per oid (`81234 BTC sell 0.045 stop 59,200.0`). Stop: `MOVE STOP
   BTC  59,200.0 → 59,800.0 (-2.2%)`.
2. `entry ≈ px` · `slippage est N bps`.
3. `stop px  dist%` · `tp px  dist%`.
4. `liq ≈ px  dist%` · `R:R x`.
5. `risk $x · y% of equity`.
6. Blank, then **governor** line: `PASS` (pass), `CLIPPED` (warn; when `verdict.approved` and a warning
   matches `/\bclipped\b/`, that warning prints first), `REJECTED` (critical), or `n/a · reduce-only`
   when `verdict` is null.
7. `✗ ` critical lines: `verdict.reasons`, then `ticket.blockers` not already printed (dedupe by exact
   string). `! ` warn lines: `verdict.warnings` then `ticket.warnings` (deduped). `· ` dim lines:
   `ticket.notes`. All verbatim, wrapped with hanging indent.
8. Blank, then footer: key hints left, `quoted HH:MM:SS` dim right.

Mainnet adds, directly under the headline, a critical line `MAINNET · real funds · sending is
irreversible`, and the footer key reads `y send on MAINNET`.

### 5.2 Footer by phase

| Phase / condition | Footer left |
|---|---|
| awaiting, `canSend` | `y send · n discard` (`y` bold) |
| awaiting, `!canSend`, key present | `blocked · n/esc dismiss` (critical word) |
| awaiting, read-only (`!config.canTrade`) | `read-only: no key · n/esc dismiss`; `y` absent |
| requoting | `re-quoting…` dim; y/n ignored |
| changed (after re-quote) | `y send new quote · n discard` |
| sending | `sending… leverage 3x → order` dim; all keys ignored except Ctrl-C arming |
| demo | `y send (demo, simulated) · n discard` |

### 5.3 Re-quote "changed" state

On `y` the card enters `requoting`. `Requote.same` → `sending` without redraw of fields.
`Requote.changed` → the card redraws from the new ticket with a warn line under the title: `! re-quoted:
<why>`. Every field whose formatted value differs from `previous` renders in warn with a dim `(was
<old>)` suffix; a verdict change reads `governor CLIPPED (was PASS)`. Another `y` re-quotes again
(repeatable). If the new ticket has `canSend = false`, the footer switches to `blocked`.

### 5.4 Resolution

- **Sent / failed**: the card freezes into Static (border dim, footer `sent 14:03:04` or `send failed
  14:03:04` critical), followed by a `result` entry. `ResultBlock`: first line `✓ ` pass (ok) or `✗
  order failed` critical (not ok); `result.lines` as `  · ` lines verbatim; `result.errors` as `  ✗ `
  critical lines (shown even when ok, e.g. TP trigger rejected after fill); `oids` dim at the end `oids
  91234 91235`.
- **Discarded / dismissed**: one `note` line, no card: `– ticket t-3f2a discarded · LONG 0.0123 BTC ≈
  $752.40`.
- Agent-drafted tickets also tell the agent the outcome on its next turn (`[human discarded ticket
  t-3f2a]` / the result lines). The agent can never produce `y`.

## 6. Modes, keys, state machine

`mode ∈ prompt | agent | ticket | overlay` plus an orthogonal `quitArmed` (2 s). Priority for key
routing: Ctrl-C handler → ticket → overlay → agent → prompt.

| From | Event | To |
|---|---|---|
| prompt | Enter on `/markets`, `/book X` | overlay |
| prompt | Enter on `/long`, `/short`, `/close`, `/cancel`, `/stop` | ticket (or `error` entry on parse error naming the bad token) |
| prompt | Enter on other `/cmd` | prompt (snapshot appended) |
| prompt | Enter on text | agent (or `error` entry if agent off) |
| agent | stream ends / error / Esc (abort) | prompt (`note` `aborted` on Esc) |
| agent | `draft_order` tool | ticket (agent keeps streaming above the card) |
| ticket | resolved | agent if the agent is still running, else prompt |
| overlay | Esc / q | prompt (book appends summary) |
| overlay | Enter on row (markets) | prompt, runs `/coin X` as if typed |
| overlay | `b` (markets) | overlay(book X); Esc from it returns to markets |

**Keys per mode**

- **prompt**: Enter submit (empty: no-op) · ←/→, Ctrl-A/E, Ctrl-U clear · ↑/↓ history (in-memory, 200,
  consecutive dupes collapsed; ↓ past newest restores the draft) · Tab complete · Esc clears input, or
  closes completion.
- **Tab completion**: token 1 starting `/` → command names. Later tokens: coins (prefix,
  case-insensitive, ordered by OI desc) after `/coin /book /long /short /close /stop`; `oi vol chg
  funding` after `/markets`; `all` + open oids after `/cancel`. One match → insert + space. Several →
  `CompletionList` (max 6, `detail` dim, e.g. mark price); Tab / ↑↓ move; Enter accepts without
  submitting; Esc closes.
- **agent**: typing allowed (type-ahead), Enter ignored with hint `agent running 7s · esc abort`; Esc
  aborts (stream stops, partial text kept, running tool lines marked `· aborted`). A 1 s elapsed
  counter, no spinner.
- **ticket**: only `y`, `n`, Esc (= n). Prompt disabled with `ticket pending: y send · n discard`; typed
  keys are dropped, not buffered. At most one ticket; an agent `draft_order` while one is pending gets
  the tool result `a ticket is already pending`.
- **overlay (markets)**: ↑/↓ or k/j select · PgUp/PgDn page · g/G top/bottom · `o v c f` sort
  oi/vol/chg/funding, same key again reverses · `/` edits the filter in the footer (substring on coin;
  Enter applies, Esc cancels) · Enter `/coin` · `b` book · Esc/q close. Initial sort/filter from the
  command.
- **overlay (book)**: `+`/`-` levels · Esc/q close.
- **Ctrl-C** (any mode): first press arms quit, hint line reads `press ctrl-c again to quit` for 2 s,
  nothing else happens. Second press within 2 s: abort agent, discard any pending ticket (never sends),
  close WS, unmount, exit 0. `/quit` does the same at once.

## 7. Alerts

New alerts (core already dedupes by key with 30 min cooldown) append one `alert` entry to Static,
wherever the mode is (they print above an open overlay or streaming text, never into it):

`! WARN  14:02:40  ETH no stop on open position · short 1.2000 ETH, liq 4,980.2 (+49.2%)`

| Level | Marker + tag | Tone |
|---|---|---|
| info | `· INFO` | dim tag, fg title, dim detail |
| warn | `! WARN` | warn marker+tag, fg title, dim detail |
| critical | `!! CRIT` | critical marker+tag+title (bold), fg detail |

Format: marker, tag, clock, `title`, ` · detail` (wraps with hanging indent under the title). Status bar
`alerts N` counts the active set, toned by its highest level. No blink, no bell, no inverse flash, no
re-render of old lines. `/alerts` prints `AlertsList`: the active set newest first, with ages.

## 8. Demo, empty, loading and error states

**Demo** (`--demo`): ` DEMO ` badge first in the status bar and in the banner (`ht 0.1 · DEMO ·
fixtures, no network · …`); `ws off`; ticket sends are simulated and their result lines are prefixed
`demo: `. Ages are computed against the fixture clock so nothing reads stale.

| Surface | Loading | Empty | Error / degraded |
|---|---|---|---|
| status bar | `markets loading…` in place of eq/uPnL | `no account` dim; eq/uPnL/margin/pos/orders dropped | `acct err` critical + one `error` entry with `accountError`; `ws down · poll 12s` |
| markets overlay | `loading markets…` one line | `no coin matches "xyz"` | header `poll 52s ago` warn after 45 s, critical after 120 s; table stays |
| `/pos` | `fetching account…` (live, then snapshot) | `no account configured — set HT_ACCOUNT or HT_AGENT_KEY`; or `no open positions` / `no open orders` | `error` entry, `source: account` |
| `/book` | `fetching BTC book…` | unknown coin → `error` with up to 3 closest coins | thin book → `—` slippage + `book too thin for $250k`; fetch failure → overlay line in critical, Esc closes |
| `/coin` | `loading BTC…` | unknown coin as above | ATR `—` + dim `candles unavailable`; regime `—` |
| ticket | `quoting…` live line | — | resolve/governor failure → `error` entry naming the step (`resolve: stop must be below entry for a long`) |
| agent | `● thinking 3s · esc abort` | — | no provider → `error`: `agent unavailable — no LLM provider configured (set ANTHROPIC_API_KEY or ANALYST_PROVIDER); slash commands still work`, status `agent off`; mid-stream failure keeps partial text + `error` entry; 120 s timeout → `note` `timed out after 120s`; 8 tool rounds → `note` `stopped after 8 tool rounds` |
| `/pulse` | `fetching lab pulse…` | `lab not configured — set LAB_URL and LAB_API_TOKEN` | HTTP code verbatim in `error` |
| `/brief` | — | `no brief at data/marketstate/latest.json` | parse failure in `error`; `generated_at` age warn > 36 h |

Every live number that comes from a poll carries its age somewhere on screen (status bar ws/poll,
overlay header, snapshot header). A stale number that looks live is the failure this UI exists to avoid.
