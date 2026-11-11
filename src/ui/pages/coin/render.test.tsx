import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { MoveDetail } from '../../../shared/moves'
import type { Feed } from '../moves/MovesView'
import { detail, movesResponse, NOW, stats } from '../moves/fixtures'
import { CoinDecision, CoinDecisionView, type CoinDecisionViewProps } from './CoinDecision'
import { queueItem } from './fixtures'
import { detailOutcome, hip3Reason, type DetailOutcome } from './logic'

// Render-checks (react-dom/server, no jsdom), the moves/render.test.tsx approach: block order (§2.4), the reason
// line in place of a missing detail, the pane layout, and no approve/order control.

const noop = () => {}
const feed = (data: DetailOutcome | null, over: Partial<Feed<DetailOutcome>> = {}): Feed<DetailOutcome> => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over })
const html = (el: React.ReactElement, url = '/coin/HYPE') => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}>{el}</MemoryRouter>)

const props = (over: Partial<CoinDecisionViewProps> = {}, d: MoveDetail = detail()): CoinDecisionViewProps => ({
  coin: 'HYPE', item: queueItem(), blocked: null, layout: 'page', window: '24h', onWindow: noop, chart: 'move', onChart: noop, liqOpen: false, onLiq: noop,
  tf: '1d', onTf: noop, detail: feed(detailOutcome(d)), stats: stats(), defs: null, now: NOW, busy: false, actionError: null, onInvestigate: noop, onAsk: noop,
  ...over,
})

/** Index of each marker in the markup; -1 when absent. */
const at = (out: string, ...marks: string[]) => marks.map((m) => out.indexOf(m))

describe('CoinDecisionView', () => {
  const out = html(<CoinDecisionView {...props()} />)

  test('blocks in the §2.4 order: header, IN QUEUE, actions, WHY IT MOVED, AGENT RECORD, PRICED IN, LIQ MAP, ATTENTION, ENTER/FADE', () => {
    const idx = at(out, '← QUEUE', 'data-block="inqueue"', 'HYPE actions', 'WHY IT MOVED', 'data-block="d1"', 'data-block="d2"', 'data-group="priced"', 'data-block="d3"', 'data-block="d4"', '▸ LIQ MAP', 'data-block="d5"', 'data-group="enterfade"', 'data-block="d6"')
    for (const i of idx) expect(i).toBeGreaterThan(-1)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
  test('page: two columns from lg; header facts and the window toggle', () => {
    expect(out).toContain('lg:col-span-7')
    expect(out).toContain('lg:col-span-5')
    expect(out).toContain('DeFi · mark 42.180 · 24h')
    expect(out).toContain('href="/queue?coin=HYPE"')
    expect(out).toContain('aria-label="window"')
  })
  test('IN QUEUE parts and the actions of §2.6', () => {
    expect(out).toContain('IN QUEUE · 14M')
    expect(out).toContain('crowded_short long · ready · net 42 bps')
    expect(out).toContain('href="/feed?id=opp-1"')
    expect(out).toContain('OPPORTUNITY · APPROVE ON FEED')
    expect(out).toContain('href="/order"')
    expect(out).toContain('href="/board?coin=HYPE"')
    expect(out).toContain('href="/moves?coin=HYPE"')
    expect(out).toContain('/analyst?mode=sim&amp;q=')
    expect(out).toContain('>ASK<')
  })
  test('no approve or order control: APPROVE is only the FEED link; no form, no input', () => {
    expect(out.replace(/<a [^>]*href="\/feed\?id=opp-1"[^>]*>[^<]*<\/a>/, '')).not.toMatch(/approve/i)
    expect(out).not.toMatch(/<form|<input/i)
  })
  test('MOVE view by default: the attribution chart, not the price chart', () => {
    expect(out).toContain('ATTRIBUTION · EXPLAINED AFTER THE FACT')
    expect(out).not.toContain('data-view="price"')
  })
  test('LIQ MAP is closed until asked', () => {
    expect(out).toContain('aria-expanded="false"')
    expect(out).not.toContain('LIQUIDATIONS · HYPE')
    const open = html(<CoinDecisionView {...props({ liqOpen: true })} />)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('LIQUIDATIONS · HYPE')
  })
  test('not in the queue says so in one line', () => {
    expect(html(<CoinDecisionView {...props({ item: null })} />)).toContain('not in today&#x27;s queue')
    expect(html(<CoinDecisionView {...props({ item: undefined })} />)).not.toContain('data-block="inqueue"')
  })
})

describe('layouts and states', () => {
  test("layout='pane': one column, no ← QUEUE", () => {
    const pane = html(<CoinDecisionView {...props({ layout: 'pane' })} />, '/queue')
    expect(pane).not.toContain('← QUEUE')
    expect(pane).not.toContain('lg:col-span-7')
    expect(pane).toContain('data-layout="pane"')
    expect(pane).toContain('data-block="d6"')
  })
  test('unavailable detail: the reason line, IN QUEUE parts still render, no empty cards', () => {
    const un = html(<CoinDecisionView {...props({}, detail({ state: 'unavailable', reason: 'HYPE is not in the moves universe' }))} />)
    expect(un).toContain('HYPE is not in the moves universe')
    expect(un).toContain('crowded_short long · ready · net 42 bps')
    for (const b of ['d1', 'd2', 'd3', 'd5', 'd6']) expect(un).not.toContain(`data-block="${b}"`)
    expect(un).not.toContain('PRICED IN')
  })
  test('a rejected coin (HIP-3) keeps the parts, the PRICE view and an INVESTIGATE that is off with the reason', () => {
    const reason = hip3Reason('xyz:TSLA')
    const p = props({ coin: 'xyz:TSLA', item: queueItem({ id: '2026-11-11:xyz:TSLA', coin: 'xyz:TSLA', href: '/coin/xyz%3ATSLA', record: null }), blocked: reason, detail: feed({ detail: null, reason }) })
    const move = html(<CoinDecisionView {...p} />)
    expect(move).toContain('xyz:TSLA is a HIP-3 market')
    expect(move).toContain('IN QUEUE')
    expect(move).toMatch(/disabled=""[^>]*title="xyz:TSLA is a HIP-3 market/)
    const price = html(<CoinDecisionView {...p} chart="price" />)
    expect(price).toContain('data-view="price"')
    expect(price).toContain('xyz:TSLA is a HIP-3 market')
  })
  test('loading and error blocks under WHY IT MOVED', () => {
    expect(html(<CoinDecisionView {...props({ detail: feed(null, { loading: true }) })} />)).toContain('pulse-label')
    expect(html(<CoinDecisionView {...props({ detail: feed(null, { error: 'move detail response mismatch' }) })} />)).toContain('move detail response mismatch')
  })
  test('no record: INVESTIGATE in the actions, off with the agent layer reason', () => {
    const d = detail({ record: null, layers: { ...movesResponse().layers, agents: { state: 'unavailable', reason: 'no LLM provider configured' } } })
    const out = html(<CoinDecisionView {...props({ item: null }, d)} />)
    expect(out.indexOf('INVESTIGATE')).toBeLessThan(out.indexOf('WHY IT MOVED'))
    expect(out).toContain('no LLM provider configured')
  })
  test('an INVESTIGATE failure shows its words', () => {
    const out = html(<CoinDecisionView {...props({ actionError: { coin: 'HYPE', message: 'daily agent cap reached' } }, detail({ record: null }))} />)
    expect(out).toContain('daily agent cap reached')
  })
})

describe('CoinDecision container', () => {
  test('a HIP-3 coin renders its reason without fetching or crashing', () => {
    const out = html(<CoinDecision coin="xyz:TSLA" item={null} />, '/coin/xyz:TSLA')
    expect(out).toContain('xyz:TSLA is a HIP-3 market')
    expect(out).toContain('not in today&#x27;s queue')
  })
  test('?chart=price opens the PRICE view (the redirect target of /markets/:coin)', () => {
    expect(html(<CoinDecision coin="HYPE" />, '/coin/HYPE?chart=price&tf=4h')).toContain('data-view="price"')
    expect(html(<CoinDecision coin="HYPE" />, '/coin/HYPE')).not.toContain('data-view="price"')
  })
})
