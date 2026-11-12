import type { Term } from '../../components'
import type { Attribution, MoveRow, MoveWindow } from '../../../shared/moves'
import { crowdScore, fmtMove, zWarn } from './logic'

// Reading guides for MOVES and the coin page: the numbers the copy quotes, the term lists behind each panel's
// "What the terms mean", and the one-line takeaways. Copy states how a number is computed (docs/SPEC.md § Moves,
// src/server/moves); it never judges a coin. GUIDE mirrors server constants and guide.test.ts holds the two together.

export const GUIDE = {
  /** Hourly bars before the window the betas are fitted on, and the least that must be present. */
  estBars: 168,
  minEstBars: 120,
  /** Share of the window's hourly bars a move needs. */
  minWindowSharePct: 75,
  sectorMinPeers: 2,
  sectorsShown: 6,
  /** An hour is an OI-drop hour at or below this robust z of the hourly OI change. */
  flowZ: -2,
  newsBeforeH: 2,
  newsAfterH: 1,
  fundingLookback: 336,
  fundingMinN: 168,
  crowdedFundingZ: 2,
  crowdedAprPct: 25,
  crowdedOiBuildPct: 10,
  crowdedPremiumBps: 5,
  oiTolMin: 20,
  liqBucketBps: 25,
  liqRangePct: 20,
  /** The queue bar on the 24h window. */
  queueZ: 2.5,
  queueMinMovePct: 1,
  queueMinChecks: 3,
  enterResidualZ: 1.5,
  enterCrowdMax: 1,
  fadeCrowdMin: 3,
  fadeLiqSigmas: 1,
  fadeMinCoveragePct: 25,
  universeByVolume: 30,
  universeTop: 40,
  /** The table prints z in amber from here (logic.zWarn). */
  zAmber: 2,
} as const

const G = GUIDE

export const PAGE_TERMS: readonly Term[] = [
  ['4H · 24H · 72H', 'The window the move is measured over: the last 4, 24 or 72 closed hourly bars.'],
  ['asOf', 'Close of the last full hourly bar. Every move is computed up to that time, not to the live price.'],
  ['coins', `Markets covered: BTC, ETH, the top ${G.universeByVolume} main-dex perps by 24h volume and your markets, at most ${G.universeTop}.`],
  ['dropped*', 'Coins left out. Hover for each reason (not listed, beyond the cap, or its history did not load).'],
  ['BETA · FLOW · NEWS · LIQ · AGENTS', 'The data each part of the page needs, with a status dot. BETA: hourly prices for the split. FLOW: open-interest snapshots. NEWS: the stored news feed. LIQ: the map of traders’ liquidation prices. AGENTS: the investigation agent. A part that is missing prints its reason under the header.'],
]

export const FACTOR_TERMS: readonly Term[] = [
  ['BTC, ETH', 'Price change over the window, in percent.'],
  ['ETH ex-BTC', `ETH’s change with the part that tracks BTC removed. ETH’s sensitivity to BTC is fitted on the ${G.estBars} hourly bars before the window.`],
  ['Sector cells', `Equal-weight average change of the sector’s coins, BTC and ETH left out. The ${G.sectorsShown} sectors that moved most are shown; a sector needs ${G.sectorMinPeers} coins with data.`],
  ['n', 'Coins in the basket (1 for BTC and ETH).'],
  ['Age stamp', 'When the sector membership lists were last generated.'],
]

export const TABLE_TERMS: readonly Term[] = [
  ['TOTAL', 'Price change over the window, in percent.'],
  ['BETA', `The part of the move that tracks BTC, plus ETH’s move beyond BTC. The coin’s sensitivities are fitted on the ${G.estBars} hourly bars before the window, so the window itself is not used to fit them.`],
  ['SECTOR', 'The part that tracks the coin’s sector basket beyond BTC and ETH. A dash means the coin has no usable basket.'],
  ['RESIDUAL', 'Total minus beta and sector: the part the market does not account for. It is unexplained, not a cause. The bar is scaled to the largest residual in the table.'],
  ['Z', `The residual divided by its usual size for this coin over a window this long (the hourly residual σ from the prior ${G.estBars} bars × √hours). Near 0 is an ordinary move; amber from ${G.zAmber} in either direction. On the 24h window, ${G.queueZ} or more with a total move of at least ${G.queueMinMovePct}% puts the coin in the queue.`],
  ['TAGS', `FLOW nH: hours in the window where open interest fell sharply (robust z of the hourly OI change at or below ${G.flowZ}). NEWS nH: other hours with a news item naming the coin first seen from ${G.newsBeforeH}h before to ${G.newsAfterH}h after the hour began. “none”: neither kind of hour.`],
  ['CROWD L/S', `Crowding checks met on the long side · on the short side, out of those that could be evaluated (4 at most): funding z ≥ ${G.crowdedFundingZ}, funding APR ≥ ${G.crowdedAprPct}%, open interest up ≥ ${G.crowdedOiBuildPct}% over 72h with price moving the same way, premium ≥ ${G.crowdedPremiumBps} bp. The short side uses the opposite signs.`],
  ['LIQ σ', 'Distance from the mark to the nearest liquidation cluster, in units of the coin’s usual 24h move (σ). L: long liquidations, below the mark. S: short liquidations, above it.'],
  ['CHECKLIST', 'The ENTER or FADE checklist closest to complete: conditions met / conditions that could be evaluated. A condition check, not a forecast.'],
  ['—', 'Not available. Hover for the reason. It never stands for zero.'],
]

export const ATTRIBUTION_TERMS: readonly Term[] = [
  ['TOTAL · n h', 'Price change over the window, and how many of its hourly bars had data.'],
  ['BTC', 'The part of the move that tracks BTC: the coin’s BTC beta × BTC’s move.'],
  ['ETH ex-BTC', 'The part that tracks ETH’s move beyond BTC.'],
  ['SECTOR', 'The part that tracks the sector basket (equal-weight peers, BTC and ETH left out) beyond BTC and ETH.'],
  ['RESIDUAL in OI-drop hours', `The unexplained part that fell in hours where open interest dropped sharply (robust z of the hourly OI change at or below ${G.flowZ}). nh is the count of those hours.`],
  ['RESIDUAL in news hours', `The unexplained part in the remaining hours that had a news item naming the coin, first seen from ${G.newsBeforeH}h before to ${G.newsAfterH}h after the hour began.`],
  ['RESIDUAL other hours', 'The unexplained part in all other hours.'],
  ['BETA (table)', 'Sensitivity to the factor: how much the coin moves per 1% move of the factor, hour by hour.'],
  ['CONTRIBUTION', 'Beta × the factor’s move over the window.'],
  ['BARS', `Hourly bars the fit used (${G.estBars} at most, ${G.minEstBars} at least).`],
  ['R²', 'Share of the coin’s hourly variation the factors explained on the fitting bars. 0 is none, 1 is all.'],
  ['hourly residual σ', 'The usual size of one hour’s unexplained move for this coin, from the fitting bars (a median-based estimate, so single spikes do not inflate it).'],
  ['z', 'The window’s residual divided by hourly residual σ × √hours.'],
  ['Chart', 'Solid: the coin’s cumulative change. Dashed: what its betas alone would have produced. The gap between them is the residual. Amber dot: an OI-drop hour. Blue dot: a news hour.'],
]

export const RECORD_TERMS: readonly Term[] = [
  ['HYPOTHESIS', 'Text written by the agent. Its numbers are checked against the inputs, but the cause it names is a claim, not a measurement.'],
  ['BETA · FORCED FLOW · MICROSTRUCTURE · NARRATIVE · UNEXPLAINED', 'The kind of cause the agent assigned the move to.'],
  ['OPEN · GRADED · FALSIFIED · NO CAUSE · FAILED · CAPPED', 'Open: waiting for its horizon. Graded: measured at the horizon. Falsified: price reached the falsifier level first. No cause: the agent found no public cause. Failed: the run did not finish. Capped: the daily agent cap was reached before the run.'],
  ['LONG · 24h', 'The direction the hypothesis implies and the hours until it is graded.'],
  ['falsifier', 'A price level named when the record was written. If an hourly bar reaches it before the horizon, the record is closed as a miss.'],
  ['unverified', 'A source the provider’s citations did not show. Numbers taken from it are not evidence.'],
  ['vs BTC', 'The coin’s change since the record was written minus BTC’s, signed by the record’s direction. Above 0 at the horizon is a hit.'],
  ['lines dropped by the number check', 'Sentences removed because a number or instruction in them was not backed by the inputs.'],
  ['agent records: n · hit · mean vs BTC [lo, hi]', 'The track record of all graded records at this horizon: how many, the share that were hits, the mean result against BTC and its 95% interval. The numbers are withheld below 5 independent groups of records (records written in the same day or horizon span count as one group).'],
]

export const POSITIONING_TERMS: readonly Term[] = [
  ['FUNDING APR', 'The current hourly funding rate × 24 × 365. Positive: longs pay shorts.'],
  ['z · n', `The current hourly funding against its own prior ${G.fundingLookback} hourly values (median-based z). n is how many values exist; it needs ${G.fundingMinN}.`],
  ['PREMIUM', 'Perp price above (+) or below (−) the oracle price, in basis points (1 bp = 0.01%).'],
  ['OI', 'Open interest in USD. n is the number of stored OI snapshots.'],
  ['OI CHANGE 24H · 72H', `Open interest now against the snapshot nearest 24h or 72h ago (within ${G.oiTolMin} minutes). A dash means no snapshot that old.`],
  ['OI / VOLUME', 'Open interest divided by 24h traded notional. Higher means more standing positions per unit of trading.'],
  ['funding z', `Long side met at ≥ +${G.crowdedFundingZ}, short side at ≤ −${G.crowdedFundingZ}.`],
  ['funding APR', `Long side met at ≥ +${G.crowdedAprPct}%, short side at ≤ −${G.crowdedAprPct}%.`],
  ['OI build 72h', `Open interest up ≥ ${G.crowdedOiBuildPct}% over 72h. It counts for the long side when price rose over those 72h and for the short side when it fell.`],
  ['premium', `Long side met at ≥ +${G.crowdedPremiumBps} bp, short side at ≤ −${G.crowdedPremiumBps} bp.`],
  ['MET', '✓ met, ✗ not met, — could not be evaluated (missing history). The thresholds are starting points, not fitted values.'],
]

export const LIQ_TERMS: readonly Term[] = [
  ['nearest long · short', 'Long liquidations sit below the mark, short liquidations above. Each line: cluster price · distance from the mark · that distance in σ · position value in the cluster.'],
  ['Cluster', `The ${G.liqBucketBps} bp price bucket nearest the mark, within ±${G.liqRangePct}% of it, that holds at least 1% of that side’s mapped liquidation value and at least $250k.`],
  ['σ · σ24h', `The coin’s usual 24h move: its hourly σ over the prior ${G.estBars} bars × √24. A cluster 1σ away is one usual day’s move from the mark.`],
  ['% of OI mapped', 'Value of the positions the crawler has seen divided by the exchange’s open interest. Under 25% the map is partial; under 5% no cluster is named.'],
]

export const ATTENTION_TERMS: readonly Term[] = [
  ['news 24h · 72h', 'Stored news items naming the coin, first seen in the last 24h or 72h.'],
  ['7d daily mean', 'Average items per day over the 7 days before the last 24h.'],
  ['ratio', 'News in the last 24h divided by that daily mean (the mean is floored at 0.5). 1× is a usual day.'],
  ['social mentions 24h · Δ', 'Mentions counted by Elfa in the last 24h and the change against the 24h before, as of the stamp shown.'],
  ['Sector stage', 'A label for the coin’s sector from 7-day and 30-day data. EMERGING or EXPANDING: ahead of BTC over 7 days with open interest rising (expanding when also ahead over 30 days). CROWDED: funding z ≥ 2 with open interest rising. FADING: ahead over 30 days but behind over 7 days or losing open interest. QUIET: none of these. UNKNOWN: not enough data.'],
]

export const CHECKLIST_TERMS: readonly Term[] = [
  ['ENTER', `Three conditions on the side of the 24h residual: attention rising, at most ${G.enterCrowdMax} crowding check met on that side, and a residual z of ${G.enterResidualZ} or more in size.`],
  ['FADE', `Three conditions on the crowded side (the side with ${G.fadeCrowdMin} or more crowding checks met): that crowding, attention saturated, and a liquidation cluster on that side within ${G.fadeLiqSigmas}σ of the mark with at least ${G.fadeMinCoveragePct}% of OI mapped.`],
  ['side', 'The side the checklist is evaluated for. A dash means no side qualifies, so side-dependent conditions cannot be evaluated.'],
  ['met n of m', `Conditions met out of those that could be evaluated. A checklist with all of ${G.queueMinChecks} met puts the coin in the queue.`],
  ['✓ ✗ —', 'Met, not met, could not be evaluated. Each line shows the value, then the threshold.'],
  ['tested as', 'The saved signal definition that tests a daily version of this checklist. STUDY opens its event study. ENTER has none because news counts are not a Lab metric.'],
]

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The table's takeaway, facts only: how many of the shown coins have a residual beyond the amber mark (|z| ≥ 2),
 * their direction, how many of those had no news hour, and how many coins meet 3+ crowding checks on one side.
 * Null when no shown coin has an attribution. `tracks` and the residual are ordinary percent changes (fmtMove).
 */
export function movesTakeaway(rows: readonly MoveRow[], window: MoveWindow): string | null {
  const known = rows.flatMap((r) => (r.attribution ? [r.attribution] : []))
  if (known.length === 0) return null
  const big = known.filter((a) => zWarn(a.residualZ))
  const up = big.filter((a) => a.residualPct > 0).length
  const newsKnown = big.filter((a) => a.newsHours != null)
  const noNews = newsKnown.filter((a) => a.newsHours === 0).length
  const crowded = rows.filter((r) => crowdScore(r.positioning) >= GUIDE.fadeCrowdMin).length
  const missing = rows.length - known.length
  const parts = [`${window}: a residual of ${GUIDE.zAmber}σ or more on ${big.length} of ${n(known.length, 'coin', 'coins')}`]
  if (big.length > 0) {
    parts[0] += ` (${up} up, ${big.length - up} down)`
    parts.push(newsKnown.length === 0 ? 'news is unknown for those' : `${noNews} of ${newsKnown.length === big.length ? 'those' : `the ${newsKnown.length} with news data`} had no news hour`)
  }
  parts.push(`${n(crowded, 'coin meets', 'coins meet')} ${GUIDE.fadeCrowdMin} or more crowding checks on one side`)
  if (missing > 0) parts.push(`${n(missing, 'coin lacks', 'coins lack')} the history for a split`)
  return `${parts.join('; ')}.`
}

/**
 * One coin's takeaway: the move, the part that tracks BTC, ETH and sector, the residual and how many times its
 * usual size it is, then the OI-drop and news hour counts when known. Null for BTC (it is the factor).
 */
export function moveTakeaway(coin: string, a: Attribution): string | null {
  if (coin === 'BTC') return null
  const market = a.btcPct + a.ethPct + (a.sectorPct ?? 0)
  const tracks = coin === 'ETH' ? 'BTC' : a.sectorPct == null ? 'BTC and ETH' : 'BTC, ETH and its sector'
  const out = [`Over ${a.window} ${coin} moved ${fmtMove(a.totalPct)}: ${fmtMove(market)} tracks ${tracks}, ${fmtMove(a.residualPct)} does not.`]
  if (a.residualZ != null) out.push(`That residual is ${Math.abs(a.residualZ).toFixed(1)}× its usual size for a ${a.window} window.`)
  const of = `of ${n(a.hours, 'hour', 'hours')}`
  const hours = [
    ...(a.flowHours != null ? [`Open interest dropped sharply in ${a.flowHours} ${of}`] : []),
    ...(a.newsHours != null ? [a.flowHours != null ? `${n(a.newsHours, 'other hour', 'other hours')} had news` : `News in ${a.newsHours} ${of}`] : []),
  ]
  if (hours.length > 0) out.push(`${hours.join('; ')}.`)
  return out.join(' ')
}
