import { describe, expect, test } from 'bun:test'
import { fngWord, pctChange, METRIC_DEFS, type MetricSummaryRow } from './MetricsStrip'

const row = (p: Partial<MetricSummaryRow>): MetricSummaryRow => ({ seriesId: 'x', ts: null, latest: null, previous: null, delta: null, z30: null, ...p })

describe('MetricsStrip helpers', () => {
  test('pctChange', () => {
    expect(pctChange(110, 100)).toEqual({ text: '+10.0% ▲', positive: true })
    expect(pctChange(90, 100)).toEqual({ text: '-10.0% ▼', positive: false })
    expect(pctChange(1, 0)).toBeNull()
    expect(pctChange(null, 5)).toBeNull()
  })
  test('fngWord bands', () => {
    expect([10, 30, 50, 60, 90].map(fngWord)).toEqual(['EXTREME FEAR', 'FEAR', 'NEUTRAL', 'GREED', 'EXTREME GREED'])
  })
  test('metric defs cover the four series plus total OI', () => {
    expect(METRIC_DEFS.map((d) => d.id)).toEqual(['hl.total_oi_usd', 'hl.funding_skew', 'fng.value', 'cg.btc_dominance', 'llama.stablecoin_cap_usd'])
    const skew = METRIC_DEFS[1]
    expect(skew.fmtValue(0.0123)).toBe('+0.0123')
    expect(skew.fmtDelta(row({ delta: -0.001 }))?.positive).toBe(false)
    expect(skew.fmtDelta(row({}))).toBeNull()
  })
})
