import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { fmtR, planFraction, PlanProgress, rMultiple, stopDistPct } from './PlanProgress'

describe('rMultiple', () => {
  test('long: (mark − entry) / (entry − stop)', () => {
    expect(rMultiple('long', 100, 106, 90)).toBeCloseTo(0.6)
    expect(rMultiple('long', 100, 90, 90)).toBeCloseTo(-1)
  })

  test('short: signed for the side', () => {
    expect(rMultiple('short', 100, 94, 110)).toBeCloseTo(0.6)
    expect(rMultiple('short', 100, 105, 110)).toBeCloseTo(-0.5)
  })

  test('no stop, or a stop on the wrong side of entry → null', () => {
    expect(rMultiple('long', 100, 105, null)).toBeNull()
    expect(rMultiple('long', 100, 105, 101)).toBeNull()
    expect(rMultiple('short', 100, 95, 99)).toBeNull()
    expect(rMultiple('long', 100, 105, 100)).toBeNull()
  })
})

describe('planFraction', () => {
  test('long: stop 0, target 1, clamped', () => {
    expect(planFraction(90, 90, 120)).toBe(0)
    expect(planFraction(105, 90, 120)).toBeCloseTo(0.5)
    expect(planFraction(130, 90, 120)).toBe(1)
    expect(planFraction(80, 90, 120)).toBe(0)
  })

  test('short: stop above target, still 0 → 1', () => {
    expect(planFraction(110, 110, 80)).toBe(0)
    expect(planFraction(95, 110, 80)).toBeCloseTo(0.5)
    expect(planFraction(70, 110, 80)).toBe(1)
    expect(planFraction(120, 110, 80)).toBe(0)
  })

  test('degenerate span → null', () => {
    expect(planFraction(100, 100, 100)).toBeNull()
  })
})

describe('fmtR and stopDistPct', () => {
  test('fmtR signs and rounds; near zero prints unsigned', () => {
    expect(fmtR(0.6)).toBe('+0.6R')
    expect(fmtR(-1)).toBe('−1.0R')
    expect(fmtR(0.01)).toBe('0.0R')
    expect(fmtR(null)).toBe('—')
  })

  test('stopDistPct is absolute percent of mark', () => {
    expect(stopDistPct({ markPx: 100, stopPx: 95 })).toBeCloseTo(5)
    expect(stopDistPct({ markPx: 100, stopPx: 105 })).toBeCloseTo(5)
    expect(stopDistPct({ markPx: 100, stopPx: null })).toBeNull()
  })
})

describe('PlanProgress markup', () => {
  test('with a target: one meter, mark position and R, no dollar sign', () => {
    const html = renderToStaticMarkup(<PlanProgress side="long" entry={100} mark={106} stop={90} target={120} />)
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="53"')
    expect(html).toContain('+0.6R')
    expect(html).not.toContain('$')
  })

  test('without a target: distance to stop and R, no bar', () => {
    const html = renderToStaticMarkup(<PlanProgress side="short" entry={100} mark={94} stop={110} />)
    expect(html).not.toContain('role="meter"')
    expect(html).toContain('17.0% to stop')
    expect(html).toContain('+0.6R')
  })

  test('without a stop: says so', () => {
    expect(renderToStaticMarkup(<PlanProgress side="long" entry={100} mark={106} stop={null} />)).toContain('no stop')
  })
})
