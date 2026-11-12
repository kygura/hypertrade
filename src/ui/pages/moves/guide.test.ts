import { describe, expect, test } from 'bun:test'
import * as C from '../../../server/moves/constants'
import { TRIAGE_MIN_CHECKS, TRIAGE_MIN_MOVE_PCT, TRIAGE_Z } from '../../../server/moves/triage'
import { detail, nullRow, row } from './fixtures'
import { GUIDE, movesTakeaway, moveTakeaway } from './guide'
import { zWarn } from './logic'

// The reading guides quote thresholds; this holds each quoted number to the server constant it describes, and
// pins the two takeaway lines.

describe('GUIDE', () => {
  test('every quoted number is the server constant', () => {
    expect<Record<string, number>>(GUIDE).toEqual({
      estBars: C.EST_BARS, minEstBars: C.MIN_EST_BARS, minWindowSharePct: C.MIN_WINDOW_SHARE * 100, sectorMinPeers: C.SECTOR_MIN_PEERS, sectorsShown: 6,
      flowZ: C.FLOW_Z, newsBeforeH: C.NEWS_BEFORE_MS / C.HOUR_MS, newsAfterH: C.NEWS_AFTER_MS / C.HOUR_MS,
      fundingLookback: C.FUNDING_Z_LOOKBACK, fundingMinN: C.FUNDING_Z_MIN_N, crowdedFundingZ: C.CROWDED_FUNDING_Z, crowdedAprPct: C.CROWDED_FUNDING_APR_PCT,
      crowdedOiBuildPct: C.CROWDED_OI_BUILD_PCT, crowdedPremiumBps: C.CROWDED_PREMIUM_BPS, oiTolMin: C.OI_CHG_TOLERANCE_MS / 60_000,
      liqBucketBps: C.LIQ_BUCKET_BPS, liqRangePct: C.LIQ_RANGE * 100,
      queueZ: TRIAGE_Z, queueMinMovePct: TRIAGE_MIN_MOVE_PCT, queueMinChecks: TRIAGE_MIN_CHECKS,
      enterResidualZ: C.ENTER_RESIDUAL_Z, enterCrowdMax: C.ENTER_CROWD_MAX, fadeCrowdMin: C.FADE_CROWD_MIN, fadeLiqSigmas: C.FADE_LIQ_SIGMAS, fadeMinCoveragePct: C.FADE_MIN_COVERAGE * 100,
      universeByVolume: C.MOVES_TOP_VOLUME, universeTop: C.MOVES_TOP, zAmber: 2,
    })
    expect([zWarn(GUIDE.zAmber), zWarn(GUIDE.zAmber - 0.01)]).toEqual([true, false])
  })
})

const attr = (over: Record<string, unknown>) => ({ attribution: { ...row().attribution!, ...over } })

describe('movesTakeaway', () => {
  test('counts residuals at 2σ or more, their direction, the no-news ones, crowded coins and coins without history', () => {
    const rows = [
      row('HYPE'), // z +3.1, news in 2 hours, long crowding 3
      row('WIF', attr({ residualPct: -5, residualZ: -2.4, newsHours: 0 })),
      row('SOL', { ...attr({ residualPct: -2.5, residualZ: -1.2 }), positioning: { ...row().positioning, longMet: 1 } }),
      nullRow('NEWC'),
    ]
    expect(movesTakeaway(rows, '24h')).toBe(
      '24h: a residual of 2σ or more on 2 of 3 coins (1 up, 1 down); 1 of those had no news hour; 3 coins meet 3 or more crowding checks on one side; 1 coin lacks the history for a split.',
    )
  })
  test('none beyond 2σ: no direction or news clause; unknown news says so', () => {
    expect(movesTakeaway([row('SOL', { ...attr({ residualZ: -1.2 }), positioning: { ...row().positioning, longMet: 0 } })], '4h')).toBe(
      '4h: a residual of 2σ or more on 0 of 1 coin; 0 coins meet 3 or more crowding checks on one side.',
    )
    expect(movesTakeaway([row('HYPE', attr({ newsHours: null }))], '24h')).toContain('(1 up, 0 down); news is unknown for those;')
    expect(movesTakeaway([row('HYPE'), row('WIF', attr({ newsHours: null }))], '24h')).toContain('0 of the 1 with news data had no news hour')
  })
  test('null when no shown coin has an attribution', () => {
    expect(movesTakeaway([nullRow()], '24h')).toBeNull()
    expect(movesTakeaway([], '24h')).toBeNull()
  })
})

describe('moveTakeaway', () => {
  const a = detail().attribution!
  test('the move, the part that tracks the market, the residual in units of its usual size, then the hour counts', () => {
    expect(moveTakeaway('HYPE', a)).toBe(
      'Over 24h HYPE moved +9.9%: +3.3% tracks BTC, ETH and its sector, +6.4% does not. That residual is 3.1× its usual size for a 24h window. Open interest dropped sharply in 3 of 24 hours; 2 other hours had news.',
    )
  })
  test('no sector, no z, unknown layers; BTC has none', () => {
    expect(moveTakeaway('HYPE', { ...a, sectorPct: null, residualZ: null, flowHours: null, newsHours: 1 })).toBe('Over 24h HYPE moved +9.9%: +1.5% tracks BTC and ETH, +6.4% does not. News in 1 of 24 hours.')
    expect(moveTakeaway('HYPE', { ...a, flowHours: null, newsHours: null })).not.toContain('hours')
    expect(moveTakeaway('BTC', a)).toBeNull()
  })
})
