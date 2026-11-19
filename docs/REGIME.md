# Regime thesis

One living document about where the crypto market sits (Bitcoin-led), rewritten when new intelligence arrives, with a
dated changelog of how each piece of intel moved it. Glassnode's weekly report (The Week On-chain) is the reference
source; every other open source is read and weighed beside it, and the weighted field is computed by code. The thesis
informs a written plan; it never places, sizes or closes a trade, and nothing in the Desk reads it to act.

Tradespace carries the same core (its `src/intel/core/`); the files under `src/shared/regime/` here are the same set
with `.js` imports.

## Pieces

| Piece | Where |
|---|---|
| Shapes, catalog, consensus, prompt, build, Markdown | `src/shared/regime/` (pure, no imports outside the folder but zod) |
| Zod contracts (model draft, stored thesis, feed) | `src/shared/regime/schema.ts` |
| Collectors | `src/server/regime/collect.ts` |
| One rewrite, the seed | `src/server/regime/run.ts` |
| Store (pg, file, memory twins) | `src/server/regime/store.ts`, `db/migrations/030_regime_thesis.sql` |
| Read route | `GET /api/intel/regime` (`?format=md` for Markdown), `src/server/routes/intel/regime.ts` |
| Page | `/regime`, the REGIME tab in the TRADE row |
| CLI | `bun run regime update [--if-new] \| show [--json] \| status \| collect \| seed <file> [--force]` |
| Schedule | `.github/workflows/regime.yml`: daily 06:53 UTC, plus Tue and Wed 18:23 UTC with `--if-new` |

## A rewrite

1. Take the lock (one row in `regime_lock`, taken over after 10 minutes).
2. Collect. Each collector is keyless and optional; a failure is a note the model sees, never a failed run.
   - **glassnode**: the newest weekly report and other posts from the last 8 days, full text. RSS first, then the
     Ghost sitemap, then the slug guessed from the ISO week (Glassnode's week number trails the ISO week it is
     published in by one).
   - **feeds**: `REGIME_FEEDS`, more RSS/Atom feeds (recent items, summaries).
   - **notion**: one notes page (`REGIME_NOTION_PAGE_ID` with `NOTION_TOKEN`), counted as one light source
     (`own_notes`, weight 0.3) so it never stands in for the sources it summarizes.
   - **market**: Deribit DVOL and option open interest, Fear & Greed, DefiLlama stablecoin supply, CoinGecko
     dominance, Coinbase vs Hyperliquid BTC, Hyperliquid funding and open interest for BTC, ETH, SOL and HYPE.
3. Reports and notes count as new once (`regime_seen`); snapshots are read fresh every run. `--if-new` stops here when
   the thesis already exists and nothing is new.
4. One `completeStructured` call on the strong tier (the Desk's PM model) with hosted web search (12 searches,
   6-minute deadline). The prompt asks for a sweep across on-chain research, flows, derivatives, macro, desks and
   news, one read per independent source (lean −2..+2, confidence 0..1, the claim with its numbers), and a rewrite
   that keeps what holds and logs each change with the intel that moved it. The payload (previous thesis, reports,
   snapshots) goes in as untrusted data. Zod checks the draft; one retry, then fail closed and the previous version
   stands. Spend is capped per run by `REGIME_MAX_USD` (default $3); a typical rewrite costs well under $1.
5. Code cleans the draft (`build.ts`): fields clamped, one read per source, weights from the catalog
   (`sources.ts`, Glassnode 1.0 down to news 0.3), the consensus computed (`consensus.ts`: weighted mean, label,
   dispersion, agreement aligned / split / contested / thin, and whether the field agrees with Glassnode), scenario
   odds normalized, and every URL dropped unless the run saw it (a search result or a collected report).
6. Save the version and its changelog row, remember the reports read, release the lock.

## Seeding

`bun run regime seed <file>` writes version 1 from a seed file: a thesis body in the same shape plus `history`, the
changelog rows before it (stored as version 0, shown as "notes"). Keep seed files out of this repo; they hold personal
notes. A second seed needs `--force`.

## Storage

Postgres when a database URL is set (apply `030_regime_thesis.sql` first). Otherwise `REGIME_STORE_FILE`, or
`~/.hypertrade/regime.json` with `REGIME_LOCAL=1`. Otherwise memory, which keeps nothing; the route then answers
`persistent: false` and the page says so. The store keeps the last 60 versions and 400 changelog rows.

## Public repo

The workflow log carries one status line per run (version, source count, field), never the thesis text, and no job
summary. Read the thesis at `/api/intel/regime` or the REGIME tab.
