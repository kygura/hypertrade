# ROUTINE.md — hypertrade cloud routine contract

This file is the operating contract for the **hypertrade routine**: a Claude
session that runs in the user's Anthropic cloud environment (managed from
Claude Desktop), checks out this repository, does live market research, and
commits its findings as `data/*.json`. It has web access (`WebSearch`,
`WebFetch`) and git access to this repo. **It has no database access and no
API key of its own to call** — the hypertrade app itself makes zero LLM
calls (SPEC.md "Runtime shape"); this routine is the only place intelligence
gets produced, and the app only ever reads the files this routine commits.

This is the spiritual successor to the old `marketstate` project's
`CLAUDE.md`/`DESIGN.md`/`domains/*.md` corpus — the domain playbooks, hedge
vocabulary, and failure-handling discipline are carried over close to
verbatim. What changed: delivery is git commit + push instead of eight
Telegram messages, output is two structured JSON files instead of prose, and
there is a new fourth job (Sector Intelligence) that didn't exist before.

**Hard rule, unchanged:** this is market intelligence, not financial advice.
No trade recommendations, no position sizing, no "buy/sell X". Every
forward-looking statement is framed with explicit confidence language — see
§(d) hedge vocabulary. Never state a future market outcome as fact.

---

## (a) Mission + trigger context

Two outputs, one run:

1. **MarketState briefing** — cross-domain market-intelligence read (macro,
   equities, crypto, tech, geopolitics) plus a hedged thesis and forecast.
   Direct descendant of marketstate's 8-message briefing, compressed into
   `data/marketstate/latest.json`.
2. **Sector Intelligence** — an emergent (not hardcoded) taxonomy of
   crypto narrative/mindshare sectors, scored and cross-referenced against
   Hyperliquid's live listings, into `data/sectors/latest.json`. New in this
   project; see §(e).

**Trigger:** the user hits "Trigger routine" in the app, which fires
`POST /api/routines/trigger` → if `ROUTINE_WEBHOOK_URL` is configured, that
webhook is expected to kick off this Claude session (the wiring between the
webhook and the actual session launch is the user's, outside this repo).
There is no fixed cadence mandated here — run whenever invoked. The app
always shows the last trigger request and the last `generated_at` from the
committed data, so staleness is visible regardless of how often this
actually runs.

**No local fetch script.** Unlike old marketstate (`bun run fetch` against a
bundled TS fetcher writing `data/summary.json` with rolling baselines), this
repo has no equivalent script for the routine to run — `src/server/collectors/`
exists but writes to Postgres via the app's own cron endpoint, which this
routine does not have credentials for. **Consequence: no rolling-baseline
stats (30-run means, z-scores) are available to this routine.** Where the old
corpus said "state moves as deltas and z-scores against the rolling
baseline," this routine instead:
- Fetches Hyperliquid data directly from its public REST API
  (`https://api.hyperliquid.xyz/info`, POST body `{"type":"metaAndAssetCtxs"}`
  for OI/funding/price, no auth needed — same endpoint `src/shared/hl-client.ts`
  hits) via `WebFetch`.
- Pulls everything else (FRED-style macro series, equity indices, mega-cap
  quotes, crypto context, geopolitics) via `WebSearch`/`WebFetch` — there is
  no armed data-connector layer to assume here, unlike old marketstate's
  Composio-bound tools.
- For day-over-day framing, reads the previous `data/marketstate/latest.json`
  and `data/sectors/latest.json` (before overwriting them) and computes a
  plain delta against **that one prior run** — never invent a rolling mean or
  z-score this routine has no data to back.

---

## (b) Repo workflow

1. **Checkout / update.** Start from a clean, up-to-date checkout of this
   repo (`git pull` before doing anything, so the diff you produce is against
   current `main`/`master`, not a stale base).
2. **Do the research and synthesis** — §(d) and §(e) below.
3. **Write files:**
   - `data/marketstate/latest.json` — overwrite in place.
   - `data/marketstate/<YYYY-MM-DD>.json` — a dated copy of the same content,
     `<YYYY-MM-DD>` = the UTC date the run started. If a file for today's date
     already exists (a second run same day), overwrite it too — `latest.json`
     and today's dated file always match.
   - `data/sectors/latest.json` — overwrite in place.
   - `data/sectors/<YYYY-MM-DD>.json` — same dated-copy rule.
4. **Update the two history indexes.** Vercel's Node function bundler only
   ships files reachable via static `import` — there is no directory scan at
   runtime, so a bare dated JSON file with no import pointing at it will not
   be visible to the deployed app. `data/marketstate/index.ts` and
   `data/sectors/index.ts` are small hand-maintained (routine-maintained)
   index files for exactly this. **Every run that adds a new date**, append
   one import line and one array entry to each, e.g. for
   `data/marketstate/index.ts`:
   ```ts
   import d20260831 from "./2026-08-31.json"; // add this line

   export const MARKETSTATE_HISTORY: Array<{ date: string; data: unknown }> = [
     { date: "2026-08-30", data: d20260830 },
     { date: "2026-08-31", data: d20260831 }, // add this line
   ];
   ```
   Same pattern for `data/sectors/index.ts` (`SECTORS_HISTORY`). If a run
   overwrites an *existing* date's file (second run same day), the index
   already has that entry — do not duplicate it.
5. **Validate before committing** — §(f).
6. **Commit** everything from this run in one commit:
   `chore(data): routine run <ISO>` where `<ISO>` is the run's start
   timestamp, e.g. `chore(data): routine run 2026-08-31T06:03:11Z`. Stage
   only the files this routine owns (`data/marketstate/**`,
   `data/sectors/**`) — never touch `src/`, `api/`, or anything else in the
   repo.
7. **Push** to `origin` on the default branch. This is what redeploys
   Vercel — a routine run with no push never reaches production.
8. **Failure handling:**
   - If research for a domain or the sector sweep comes back empty even
     after retry, do not skip it — write the JSON with that domain/sector's
     `summary`/`rationale` stating plainly what's missing, same as old
     marketstate never silently dropping a message.
   - If validation (§f) fails, fix the JSON before committing — never commit
     data that fails schema parse.
   - If the push fails (auth, offline, network), the local commit still
     exists — note the failure, do not discard the commit, and retry the
     push once. A local commit with a failed push is recoverable next run; a
     lost commit is not.

---

## (c) JSON output schemas (copied exactly from `src/shared/schemas.ts`)

These are the real zod schemas — the API routes parse committed files
against them, so drifting from this shape breaks the app at request time,
not at commit time. Field names and types below are authoritative.

### `data/marketstate/latest.json` — `MarketStateDataSchema`

```
{
  generated_at: string                 // ISO timestamp, run start
  headline:     string                 // one line, the regime read
  tldr:         string                 // short paragraph, glanceable close
  domains: [{
    domain:  string                    // "macro" | "equities" | "crypto" | "tech" | "geopolitics"
    summary: string                    // prose synthesis of that domain's playbook (§d)
    signals: [{ label: string, value: string, direction: string }]  // direction: "up"|"down"|"flat"
  }]
  thesis: {
    observe:    string                 // facts only, no interpretation
    infer:      string                 // the reasoned read — how markets are pricing it
    forecast:   string                 // base case + tail case, hedged (§d)
    disclaimer: string                 // fixed line, verbatim, see §d
  }
  risks: [string]                      // short tail-risk bullets
}
```

Worked example — see `data/marketstate/latest.json` in this repo (seed data,
replace on first real run; format/shape is exactly what to match).

### `data/sectors/latest.json` — `SectorsDataSchema`

```
{
  generated_at: string
  sectors: [{
    id:              string            // kebab-case, routine's own choice, not fixed
    label:           string            // human-readable
    mindshare_score: number            // 0..1
    momentum:        number            // -1..1
    rationale:       string            // why this score/momentum, this run
    tokens:          [string]          // Hyperliquid symbols where listed (§e)
    sources:         [string]          // what grounded this read
  }]
  rotations: [{
    from:       string                 // a sector id above
    to:         string                 // a sector id above
    confidence: number                 // keep to 0..1 by convention (schema doesn't clamp it)
    trigger:    string                 // the condition that would confirm this rotation
    note:       string                 // hedge-language color
  }]
}
```

Worked example — see `data/sectors/latest.json` in this repo (seed data,
same rule).

Both schemas use zod's default (non-strict) object parsing — unrecognized
extra keys (e.g. a `note` field marking seed data) are silently stripped on
parse, not rejected. Don't rely on that for anything the app needs to read;
it's only safe for throwaway annotations.

---

## (d) MarketState synthesis

Five domains, fixed set, same order as old marketstate: **macro → equities →
crypto → tech → geopolitics.** Each becomes one entry in the `domains[]`
array — a `summary` paragraph plus a handful of `signals`. Condensed from the
old `domains/*.md` playbooks:

**macro** — Treasury yields (10Y, 2Y, compute 2s10s), Fed funds rate, CPI YoY
vs. prior, unemployment, NFP, real GDP, retail sales, dollar direction
(DXY-proxy), WTI/Brent, gold. Read Hyperliquid data separately (crypto
domain) — macro is traditional-market only. Bias tag for the header read
(hawkish/dovish/neutral) comes from rates + inflation taken together, not a
separate lookup. `summary` should read like the old "Liquidity read" line:
one synthesized qualitative call (easing/tightening/neutral), grounded in
what's in `signals`.

**equities** — Market open/closed first (frames everything else — if closed,
say so in `summary`, e.g. "as of last close"). SPY, QQQ, DIA, IWM + VIX
level/direction. Put/call ratio if you can find one (commonly can't — VIX-only
regime read is fine, just say so). Breadth/sector tilt from gainers/losers.
Sentiment + earnings on deck.

**crypto** — BTC, ETH, SOL spot (24h and 7d % if available). Hyperliquid
perp OI total and funding skew (fetched directly per §a — no baseline
z-score available, state the raw current levels). ETH/BTC relative-strength
read, which of the three leads. Risk-appetite read tying crypto's direction
back to the macro USD read: is crypto moving with or independent of broad
risk sentiment? Ground it in Fear & Greed (alternative.me), BTC DVOL
(Deribit) if findable, stablecoin cap growth (DefiLlama) as a dry-powder
proxy — all via WebSearch, no bundled fetcher for these either. Flow/news
tone.

**tech** — AAPL, MSFT, NVDA, GOOGL, AMZN, META **individually** — dispersion
is the point, never average them into one number. SMH level + a note on
whether semis breadth is wide or concentrated (commonly NVDA). 2-3 AI-cycle/
product/regulatory beats. Earnings on deck among the six.

**geopolitics** — Scheduled catalysts (central bank meetings, key data
prints, elections, OPEC+) with dates — **this repo has no
`data/catalysts.json` equivalent**, so this is 100% `WebSearch`-sourced here,
unlike old marketstate which had a persisted FRED-calendar file. Active
tensions (conflicts, sanctions, tariffs/trade) — **mandatory live web
search every run, never skipped, never served from memory** (carried over
verbatim from old marketstate's hard rule — this briefing serves a reader
checked out from the news). Market linkage: one line per item on what it
means for the tape.

### Hedge vocabulary (carried over verbatim — do not invent substitutes)

Use these terms, exactly, in the `thesis` block:
`base case`, `tail case`, `low-confidence`, `we lean`, `risk skews`,
`consensus is pricing … / we read …`.

- **`thesis.observe`** — facts only, drawn from what's already in `domains[]`.
  No interpretation here.
- **`thesis.infer`** — the reasoned read: how markets are pricing the known
  catalysts, and where this read diverges from consensus. Keep it visibly
  separate from `observe` — a reader should always be able to tell fact from
  inference.
- **`thesis.forecast`** — a **base case** (labeled) and at least one
  **low-confidence tail case** (labeled). Where the read differs from
  consensus, say so explicitly: `consensus is pricing X; we read the risk as
  Y`. A probability may be hedged qualitatively ("a bit above even odds")
  but **never** given as a false-precision point estimate ("73%"). Every
  forward-looking clause carries a hedge word — no bare future-tense
  assertion of a market outcome.
- **`thesis.disclaimer`** — this exact string, every run, no variation:
  `"Not financial advice. Market intelligence only — a reasoned read of public data, not a recommendation to buy or sell anything."`

### Signal conventions

- `direction` is one of `"up"` / `"down"` / `"flat"` — the UI renders these,
  don't invent other values.
- `value` carries the formatted number as a string, old marketstate's
  price-level conventions still apply: plain number for index/stock points
  (`"559.30"`), `$` prefix for crypto/commodities (`"$68,400"`), thousands
  separators at ≥ 10,000, `%`/`bp` signed for changes (`"+2.1%"`, `"+6bp"`),
  state the window when not obvious (`"+2.1% 24h"`).
- `headline` and `tldr` play the role of the old TLDR message: `headline` is
  the one-line regime read, `tldr` is the short paragraph a reader gets if
  they read nothing else — regime + one clause per domain + a "watch" line,
  short disclaimer folded in.
- `risks[]` — 2-4 short bullets, the tail risks that would break the base
  case (this is where old marketstate's "Watch:" line and tail-case
  material naturally lands as scannable bullets instead of prose).

---

## (e) Sector Intelligence

New relative to old marketstate — no prior corpus to port, designed fresh
for this project. **Goal: visualize where mindshare/liquidity is rotating
before price follows** (SPEC.md pillar 3).

**The taxonomy is emergent, not fixed.** Do not reuse a hardcoded sector
list — decide, each run, what sectors/narratives actually have mindshare
right now from live research (crypto-twitter sentiment sweeps, CT trending
topics, CoinGecko/DefiLlama trending, crypto news). A sector that mattered
last run can disappear this run if nothing is holding its mindshare, and a
brand-new one can appear.

For each sector, produce:
- `id` / `label` — your own naming, kebab-case id.
- `mindshare_score` (0-1) — how much attention this narrative is
  commanding right now, relative to the rest of the field this run (not an
  absolute, cross-run-comparable number — it's a within-run ranking signal).
- `momentum` (-1..1) — direction: is mindshare/price building or fading.
  Negative = fading/rolling over, positive = building.
- `rationale` — the concrete evidence behind the score (a launch, a TVL
  inflow, a social-volume spike, a rollover after a euphoric run) — not a
  restatement of the score.
- `tokens` — **Hyperliquid symbols only, and only where actually listed.**
  Cross-check every symbol against Hyperliquid's live universe (same
  `metaAndAssetCtxs` fetch as §a) before listing it. The app enriches each
  sector with live HL OI/funding data by matching these symbols
  case-sensitively against the HL universe (`src/server/routes/sectors.ts`)
  and **skips anything that doesn't match, silently** — an unlisted or
  misspelled symbol doesn't error, it just quietly loses that token's
  weight from the sector's OI numbers. Get the symbols right.
- `sources` — where the mindshare read came from, compact (e.g.
  `"crypto-twitter mindshare sweep"`, `"defillama TVL deltas"`,
  `"coingecko trending"`) — not URLs, not payloads, same spirit as old
  marketstate's sources-footer convention (which tool/method ran, not what
  it returned).

For `rotations[]`, describe expected mindshare/liquidity moves **between**
sectors already listed above (`from`/`to` must be ids from `sectors[]`):
- `confidence` — keep to 0-1 by convention even though the schema doesn't
  enforce a range; treat it with the same hedge discipline as the thesis
  forecast (this is a low-confidence prediction domain, most rotations
  should sit well under 0.7).
- `trigger` — the concrete condition that would confirm the rotation is
  actually happening (a TVL inflow crossing some threshold, a funding-rate
  flip, a specific catalyst) — something checkable next run, not vibes.
- `note` — hedge-language color, same vocabulary discipline as §d
  (`low-confidence`, `we lean`, etc. apply here too where useful).

Sectors and rotations are read straight — no financial-advice framing issue
here since nothing is a buy/sell call, but keep the same intellectual
honesty: state uncertainty as uncertainty, don't manufacture false
precision in `mindshare_score`/`momentum`/`confidence`.

---

## (f) Validation before committing

Before writing the commit, verify both JSON files actually parse against the
real schemas — don't eyeball it against the shape in §(c) alone. This repo
already has zod and the schemas installed; run the real parse as the
authoritative check:

```bash
cd <repo-root>
bun -e "
import { MarketStateDataSchema, SectorsDataSchema } from './src/shared/schemas.ts';
import ms from './data/marketstate/latest.json';
import sec from './data/sectors/latest.json';
MarketStateDataSchema.parse(ms);
SectorsDataSchema.parse(sec);
console.log('both files parse OK');
"
```

If this throws, the error names the exact field and expected type — fix the
JSON and re-run before committing. Do a mental pass on the range constraints
the schema enforces beyond types: `mindshare_score` must be `0..1`,
`momentum` must be `-1..1` (both zod-enforced, will throw if violated).
`confidence` is not range-enforced by the schema but keep it `0..1` by the
convention in §(e) anyway.

If `bun` isn't available in this session's environment, fall back to a
manual pass against the §(c) shape — check every required field is present
with the right type, and the two numeric ranges above by hand — but prefer
the real parse whenever `bun` is there, since it's the actual gate the app
applies at request time.

---

## Repository map (routine's-eye view)

- `ROUTINE.md` — this file.
- `SPEC.md` — the app's full contract; "Runtime shape" and "Routine
  Contract" sections are the parts most relevant here.
- `src/shared/schemas.ts` — the real zod schemas (§c is a copy; this file is
  the source of truth if they ever drift).
- `data/marketstate/`, `data/sectors/` — `latest.json` + dated copies this
  routine owns, plus `index.ts` in each (§b step 4).
- Everything else in the repo (`src/server/`, `src/ui/`, `api/`, `db/`) is
  the app itself — this routine never edits it, only `data/**`.
