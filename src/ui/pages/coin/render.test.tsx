import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { MoveDetail } from '../../../shared/moves'
import type { OpportunityDetail } from '../../../shared/platform'
import type { Feed } from '../moves/MovesView'
import { detail, movesResponse, NOW, stats } from '../moves/fixtures'
import { SetupApproveView } from './Approve'
import { CoinDecision, CoinDecisionView, type CoinDecisionViewProps } from './CoinDecision'
import { queueItem } from './fixtures'
import { detailOutcome, hip3Reason, type DetailOutcome } from './logic'

// Render-checks (react-dom/server, no jsdom), the moves/render.test.tsx approach: block order (§2.4), the reason
// line in place of a missing detail, the pane layout, and the SETUP block's APPROVE gates.

const noop = () => {}
const feed = (data: DetailOutcome | null, over: Partial<Feed<DetailOutcome>> = {}): Feed<DetailOutcome> => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over })
const html = (el: React.ReactElement, url = '/coin/HYPE') => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}>{el}</MemoryRouter>)

const props = (over: Partial<CoinDecisionViewProps> = {}, d: MoveDetail = detail()): CoinDecisionViewProps => ({
  coin: 'HYPE', item: queueItem(), blocked: null, layout: 'page', window: '24h', onWindow: noop, chart: 'move', onChart: noop,
  tf: '1d', onTf: noop, detail: feed(detailOutcome(d)), stats: stats(), defs: null, now: NOW, busy: false, actionError: null, onInvestigate: noop, onAsk: noop,
  ...over,
})

/** Index of each marker in the markup; -1 when absent. */
const at = (out: string, ...marks: string[]) => marks.map((m) => out.indexOf(m))

describe('CoinDecisionView', () => {
  const out = html(<CoinDecisionView {...props()} />)

  test('blocks in the §2.4 order: header, IN QUEUE, actions, WHY IT MOVED, AGENT RECORD, PRICED IN, ATTENTION, ENTER/FADE', () => {
    const idx = at(out, '← QUEUE', 'data-block="inqueue"', 'HYPE actions', 'WHY IT MOVED', 'data-block="d1"', 'data-block="d2"', 'data-group="priced"', 'data-block="d3"', 'data-block="d4"', 'data-block="d5"', 'data-group="enterfade"', 'data-block="d6"')
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
    expect(out).toContain('href="/order"')
    expect(out).toContain('href="/board?coin=HYPE"')
    expect(out).toContain('href="/moves?coin=HYPE"')
    expect(out).toContain('/analyst?mode=sim&amp;q=')
    expect(out).toContain('>ASK<')
  })
  test('the action row has no approve control and no link to the feed; no form, no input', () => {
    expect(out).not.toMatch(/approve/i)
    expect(out).not.toContain('/feed')
    expect(out).not.toMatch(/<form|<input/i)
  })
  test('the SETUP block renders under the actions only for a ready opportunity, with its id', () => {
    const setup = (id: string) => <p data-setup={id} />
    const withOpp = html(<CoinDecisionView {...props({ setup })} />)
    expect(withOpp).toContain('data-setup="opp-1"')
    expect(withOpp.indexOf('HYPE actions')).toBeLessThan(withOpp.indexOf('data-setup'))
    expect(withOpp.indexOf('data-setup')).toBeLessThan(withOpp.indexOf('WHY IT MOVED'))
    expect(html(<CoinDecisionView {...props({ setup, item: null })} />)).not.toContain('data-setup')
  })
  test('no liquidation map on the coin page', () => {
    expect(out).not.toContain('LIQ MAP')
    expect(out).not.toContain('LIQUIDATIONS · HYPE')
  })
  test('MOVE view by default: the attribution chart, not the price chart', () => {
    expect(out).toContain('ATTRIBUTION · EXPLAINED AFTER THE FACT')
    expect(out).not.toContain('data-view="price"')
  })
  test('the page guide leads; not in the queue says so and why', () => {
    expect(out).toContain('One coin, read top to bottom')
    expect(out).not.toContain('No source flagged this coin today')
    expect(html(<CoinDecisionView {...props({ item: null })} />)).toContain('No source flagged this coin today (UTC).')
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

describe('SetupApproveView', () => {
  const pass = { approved: true, reasons: [], warnings: [] }
  const opp = (over: Partial<OpportunityDetail> = {}, status: OpportunityDetail['opportunity']['status'] = 'ready'): OpportunityDetail => ({
    opportunity: {
      id: '00000000-0000-4000-8000-000000000001', coin: 'HYPE', direction: 'long', setupKind: 'crowded_short', tradeType: 'directional', status,
      score: 3, scoreVersion: 'v1', netEdgeBps: 42.4, grossEdgeBps: 50, edgeBasis: 'unvalidated', costs: null, tags: [], liquidityTier: 1, regime: 'trend',
      invalidation: '15m close below 39.9', entryPx: 42.18, stopPx: 39.9, targetPx: 45, invalidationPx: 39.9,
      createdAt: '2026-11-11T14:00:00Z', updatedAt: '2026-11-11T14:00:00Z', statusChangedAt: '2026-11-11T14:00:00Z', snoozedUntil: null, dedupeKey: 'HYPE|long|crowded_short',
    },
    signals: [], bearCase: null, stats: null, evidence: 'ledger 24h: n 0', risk: { before: pass, after: pass },
    ticket: { side: 'long', entryPx: 42.18, stopPx: 39.9, targetPx: 45, sizeUsd: 1500, sizeSource: 'governor' },
    canApprove: true, approveBlockedReason: null, ...over,
  })
  const view = (d: OpportunityDetail | null, unavailable: string | null = null) => html(<SetupApproveView detail={d} unavailable={unavailable} busy={false} onApprove={noop} onReject={noop} />)
  const approveBtn = (out: string) => out.match(/<button[^>]*>APPROVE<\/button>/)?.[0] ?? ''

  test('a ready setup that passes every gate: facts, invalidation, APPROVE and REJECT enabled', () => {
    const out = view(opp())
    expect(out).toContain('crowded_short · long · READY')
    expect(out).toContain('net 42 bps · entry 42.180 · stop 39.900 · target 45.000 · size $1,500')
    expect(out).toContain('invalidation: 15m close below 39.9')
    expect(approveBtn(out)).not.toContain('disabled=""')
    expect(out).not.toContain('approve blocked')
  })
  test('the server freshness gate disables APPROVE and prints its reason', () => {
    const out = view(opp({ canApprove: false, approveBlockedReason: 'no live mid for HYPE' }))
    expect(approveBtn(out)).toContain('disabled=""')
    expect(out).toContain('approve blocked: no live mid for HYPE')
  })
  test('a governor block and a missing preview disable APPROVE too', () => {
    expect(view(opp({ risk: { before: pass, after: { approved: false, reasons: ['gross leverage 3.2 > 3'], warnings: [] } } }))).toContain('approve blocked: gross leverage 3.2 &gt; 3')
    const none = view(opp({ risk: null }))
    expect(approveBtn(none)).toContain('disabled=""')
    expect(none).toContain('approve blocked: governor preview unavailable')
  })
  test('a decided setup cannot be approved again', () => {
    const out = view(opp({}, 'approved'))
    expect(approveBtn(out)).toContain('disabled=""')
    expect(out).not.toContain('approve blocked')
  })
  test('an extremes take: no costs, no net edge, no target — facts render with dashes and APPROVE stays enabled', () => {
    const base = opp()
    const out = view({
      ...base,
      opportunity: { ...base.opportunity, setupKind: 'oi_flush', scoreVersion: 'extremes-1', score: 4.2, netEdgeBps: null, grossEdgeBps: null, costs: null, targetPx: null, invalidation: 'Below 39.9 (kill). Forced unwind.', dedupeKey: 'HYPE|long|oi_flush' },
      evidence: 'extremes take: severity 4.20 (extremes-1, detector sigmas, not the scanner score)',
      ticket: { ...base.ticket, targetPx: null },
    })
    expect(out).toContain('oi_flush · long · READY')
    expect(out).toContain('net — · entry 42.180 · stop 39.900 · target — · size $1,500')
    expect(out).toContain('invalidation: Below 39.9 (kill). Forced unwind.')
    expect(approveBtn(out)).not.toContain('disabled=""')
  })
  test('no detail: one reason line, or nothing while loading', () => {
    expect(view(null, 'platform API unreachable')).toContain('SETUP · platform API unreachable')
    expect(view(null)).toBe('')
  })
})
