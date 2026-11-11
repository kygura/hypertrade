import { describe, expect, test } from 'bun:test'
import { detail, NOW } from '../moves/fixtures'
import { queueItem } from './fixtures'
import { coinActions, detailOutcome, hip3Reason, isHip3, opportunityId, parseChart, parseLiq, queueHeadline, queuePartsLine, rejectedDetail, simulateHref, simulatePrompt } from './logic'

describe('url state', () => {
  test('parseChart defaults to move; only `price` switches', () => {
    expect(parseChart(null)).toBe('move')
    expect(parseChart('')).toBe('move')
    expect(parseChart('PRICE')).toBe('move')
    expect(parseChart('price')).toBe('price')
  })
  test('parseLiq opens only on 1', () => {
    expect(parseLiq('1')).toBe(true)
    expect(parseLiq(null)).toBe(false)
    expect(parseLiq('0')).toBe(false)
  })
})

describe('simulate', () => {
  test('simulateHref sets mode=sim and encodes the coin in the prefilled question', () => {
    expect(simulatePrompt('SOL')).toBe('What if I had put 10% of my stack into SOL perps at 1x 30 days ago?')
    const href = simulateHref('xyz:TSLA')
    expect(href.startsWith('/analyst?mode=sim&q=')).toBe(true)
    const q = new URLSearchParams(href.split('?')[1])
    expect(q.get('mode')).toBe('sim')
    expect(q.get('q')).toBe(simulatePrompt('xyz:TSLA'))
    expect(href).not.toContain('xyz:TSLA')
  })
})

describe('coinActions', () => {
  const keys = (a: ReturnType<typeof coinActions>) => a.map((x) => x.key)

  test('APPROVE ON FEED only with an opportunity id', () => {
    const none = coinActions('HYPE', null, detail())
    expect(keys(none)).not.toContain('opportunity')
    const withPart = coinActions('HYPE', queueItem(), detail())
    expect(withPart.find((a) => a.key === 'opportunity')).toMatchObject({ label: 'OPPORTUNITY · APPROVE ON FEED', kind: 'link', to: '/feed?id=opp-1' })
    const fromDetail = coinActions('HYPE', null, detail({ opportunityId: 'o 2' }))
    expect(fromDetail.find((a) => a.key === 'opportunity')!.to).toBe('/feed?id=o%202')
  })
  test('a decided opportunity part is not a ready one', () => {
    const acted = queueItem({ parts: [{ ...queueItem().parts[1]!, actedAt: '2026-11-11T14:15:00.000Z' }], state: 'acted' })
    expect(opportunityId(acted, null)).toBeNull()
  })
  test('never an approve or order POST: links, ASK and INVESTIGATE only', () => {
    for (const a of coinActions('HYPE', queueItem(), detail({ opportunityId: 'o', record: null }))) {
      expect(['link', 'ask', 'investigate']).toContain(a.kind)
      if (a.kind === 'link') expect(a.to).toBeString()
      if (a.kind !== 'link') expect(a.label).not.toMatch(/approve|order/i)
    }
    expect(coinActions('HYPE', null, null).find((a) => a.key === 'order')!.to).toBe('/order')
  })
  test('INVESTIGATE only while no agent record is known', () => {
    expect(keys(coinActions('HYPE', null, detail()))).not.toContain('investigate')
    expect(keys(coinActions('HYPE', null, detail({ record: null })))).toContain('investigate')
    expect(keys(coinActions('HYPE', queueItem(), null))).not.toContain('investigate')
    expect(keys(coinActions('HYPE', null, null))).toEqual(['investigate', 'ask', 'simulate', 'order', 'evidence', 'moves'])
  })
  test('EVIDENCE and MOVES encode the coin', () => {
    const a = coinActions('xyz:TSLA', null, null)
    expect(a.find((x) => x.key === 'evidence')!.to).toBe('/board?coin=xyz%3ATSLA')
    expect(a.find((x) => x.key === 'moves')!.to).toBe('/moves?coin=xyz%3ATSLA')
  })
})

describe('IN QUEUE', () => {
  test('headline: unknown → null, absent → not in today\'s queue, else age and a non-new state', () => {
    expect(queueHeadline(undefined, NOW)).toBeNull()
    expect(queueHeadline(null, NOW)).toBe("not in today's queue")
    expect(queueHeadline(queueItem(), NOW)).toBe('IN QUEUE · 14M')
    expect(queueHeadline(queueItem({ state: 'dismissed', dismissedAt: '2026-11-11T14:12:00.000Z' }), NOW)).toBe('IN QUEUE · DISMISSED · 14M')
  })
  test('parts: label per source, side, reason; no drill-in back to this page', () => {
    const lines = queuePartsLine(queueItem(), 'HYPE')
    expect(lines.map((l) => [l.label, l.direction, l.to])).toEqual([
      ['MOVES', null, '/moves?coin=HYPE'],
      ['SETUP', 'long', null],
    ])
    expect(queuePartsLine(null, 'HYPE')).toEqual([])
  })
})

describe('detail outcome', () => {
  test('ok detail passes; unavailable is its reason', () => {
    expect(detailOutcome(detail()).detail?.coin).toBe('HYPE')
    expect(detailOutcome(detail({ state: 'unavailable', reason: 'not in the universe' }))).toEqual({ detail: null, reason: 'not in the universe' })
  })
  test('400 and 404 become the reason line; other failures stay errors', () => {
    expect(rejectedDetail(400, 'invalid coin: a main-dex perp name', 'xyz:TSLA')).toEqual({ detail: null, reason: 'invalid coin: a main-dex perp name' })
    expect(rejectedDetail(404, 'unknown coin FOO: not a listed main-dex perp', 'FOO')!.reason).toContain('unknown coin FOO')
    expect(rejectedDetail(500, 'boom', 'FOO')).toBeNull()
    expect(rejectedDetail(undefined, 'net', 'FOO')).toBeNull()
  })
  test('HIP-3 coins are recognised and named', () => {
    expect(isHip3('xyz:TSLA')).toBe(true)
    expect(isHip3('kPEPE')).toBe(false)
    expect(hip3Reason('xyz:TSLA')).toContain('xyz:TSLA is a HIP-3 market')
  })
})
