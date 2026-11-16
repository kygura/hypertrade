import { describe, expect, test } from 'bun:test'
import { createElement, Fragment } from 'react'
// @ts-expect-error react-is ships no types; this test only needs isFragment
import { isFragment } from 'react-is'
import { buildChartRows } from './FanChart'

const pt = (ts: number, value: number) => ({ ts, value })

describe('buildChartRows', () => {
  test('history and projection share one array, keyed and sorted by day, with ranged bands', () => {
    const rows = buildChartRows([pt(1, 100), pt(2, 110)], [pt(1, 100), pt(2, 105)], [pt(1, 100), pt(2, 100)], {
      median: [pt(3, 110), pt(4, 120)],
      p10: [pt(3, 110), pt(4, 90)],
      p90: [pt(3, 110), pt(4, 150)],
      p25: [pt(3, 110), pt(4, 100)],
      p75: [pt(3, 110), pt(4, 135)],
    })
    expect(rows.map((r) => r.ts)).toEqual([1, 2, 3, 4])
    expect(rows[1]).toEqual({ ts: 2, value: 110, btc: 105, usdc: 100 })
    expect(rows[3]).toEqual({ ts: 4, median: 120, band: [90, 150], inner: [100, 135] })
  })

  test('results cached without p25/p75 get no inner band', () => {
    const rows = buildChartRows([pt(1, 100)], [pt(1, 100)], [pt(1, 100)], { median: [pt(2, 100)], p10: [pt(2, 90)], p90: [pt(2, 110)] })
    expect(rows[1]!.inner).toBeUndefined()
  })
})

// recharts unwraps <>…</> children with react-is. A react-is major behind React reports false here, and
// every series inside a fragment silently stops drawing (the projection fan did). Kept in step by
// package.json "overrides".
test('react-is recognises React fragments', () => {
  expect(isFragment(createElement(Fragment))).toBe(true)
})
