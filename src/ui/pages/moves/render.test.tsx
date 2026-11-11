import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { MoveDetail, MoveRow, MovesResponse } from '../../../shared/moves'
import type { TriageResponse } from '../../../shared/agentRecords'
import { ASOF, detail, movesResponse, nullRow, NOW, record, row, stats, triage } from './fixtures'
import { sortRows } from './logic'
import { MovesHeader, MovesTablePanel, MovesView, FactorsPanel, TriagePanel, type Feed, type MovesViewProps } from './MovesView'

// Render-checks (react-dom/server, no jsdom), the cockpit/render.test.tsx approach: each state per panel, the
// separate NOT A FORECAST block, no APPROVE anywhere, and the triage budget lines. Fixtures parse against the
// shared zod schemas (fixtures.ts).

const noop = () => {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = <T = any,>(data: T | null, over: Partial<Feed<T>> = {}): Feed<T> => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const none = (over: Partial<Feed<any>> = {}): Feed<any> => feed<any>(null, over)
const html = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)

const tableProps = (m: Feed<MovesResponse>, rows: MoveRow[] = m.data?.rows ?? []) => ({ moves: m, rows: sortRows(rows, 'z'), sort: 'z' as const, onSort: noop, sector: null, onSector: noop, selected: null, onSelect: noop, now: NOW })

describe('MovesTablePanel', () => {
  test('ok: rows with signed residual, z, bar, and a null attribution as a dash with its reason', () => {
    const out = html(<MovesTablePanel {...tableProps(feed(movesResponse()))} />)
    expect(out).toContain('HYPE')
    expect(out).toContain('+6.2%')
    expect(out).toContain('3.1')
    expect(out).toContain('data-bar="100"')
    expect(out).toContain('title="needs 120 of 168 hourly bars before the window — has 74"')
    expect(out).toContain('FADE 2/3')
    expect(out).toContain('3/3 · 0/3')
    expect(out).toContain('MOVES · BY |Z|')
    expect(out).not.toContain('old —')
  })
  test('z at or past 2 is amber', () => {
    expect(html(<MovesTablePanel {...tableProps(feed(movesResponse()))} />)).toContain('text-amber')
  })
  test('loading: skeleton, no table', () => {
    const out = html(<MovesTablePanel {...tableProps(none({ loading: true }))} />)
    expect(out).toContain('pulse-label')
    expect(out).not.toContain('<table')
  })
  test('pending: first-run progress', () => {
    const m = movesResponse({ state: 'pending', progress: { loaded: 21, total: 40 }, asOf: null, rows: [] })
    expect(html(<MovesTablePanel {...tableProps(feed(m))} />)).toContain('FIRST RUN — 21 OF 40 COINS LOADED')
  })
  test('unavailable: the reason verbatim', () => {
    const m = movesResponse({ state: 'unavailable', reason: 'needs the always-on server (bun run moves)', rows: [] })
    expect(html(<MovesTablePanel {...tableProps(feed(m))} />)).toContain('needs the always-on server (bun run moves)')
  })
  test('offline and error blocks', () => {
    expect(html(<MovesTablePanel {...tableProps(none({ offline: 'api unreachable' }))} />)).toContain('API UNREACHABLE')
    const err = html(<MovesTablePanel {...tableProps(none({ error: 'moves response mismatch: rows.0.mark Required' }))} />)
    expect(err).toContain('role="alert"')
    expect(err).toContain('moves response mismatch: rows.0.mark Required')
  })
  test('a failed refetch keeps the rows and adds the error above them', () => {
    const out = html(<MovesTablePanel {...tableProps(feed(movesResponse(), { error: 'boom' }))} />)
    expect(out).toContain('boom')
    expect(out).toContain('HYPE')
  })
  test('stale banner past 2h, none under', () => {
    const late = { ...tableProps(feed(movesResponse())), now: Date.parse(ASOF) + 3.2 * 3_600_000 }
    expect(html(<MovesTablePanel {...late} />)).toContain('attribution 3h old — last closed hour 14:00')
    expect(html(<MovesTablePanel {...tableProps(feed(movesResponse()))} />)).not.toContain('attribution 0h')
  })
  test('empty: no history, and an empty sector filter', () => {
    const m = movesResponse({ rows: [] })
    expect(html(<MovesTablePanel {...tableProps(feed(m))} />)).toContain('no coin has enough history for this window')
    const filtered = html(<MovesTablePanel {...tableProps(feed(movesResponse()), [])} sector="ai" />)
    expect(filtered).toContain('no coins in ai')
    expect(filtered).toContain('SHOW ALL')
  })
  test('selected row is marked', () => {
    expect(html(<MovesTablePanel {...tableProps(feed(movesResponse()))} selected="HYPE" />)).toContain('aria-selected="true"')
  })
})

describe('MovesHeader', () => {
  test('ok: asOf, counts, dropped with its reason, layer chips and their notes', () => {
    const out = html(<MovesHeader moves={feed(movesResponse())} window="24h" onWindow={noop} />)
    expect(out).toContain('asOf 14:00 UTC (last closed hour) · 3 coins · 1 dropped*')
    expect(out).toContain('OLD: delisted')
    for (const l of ['BETA', 'FLOW', 'NEWS', 'LIQ', 'AGENTS']) expect(out).toContain(l)
    expect(out).toContain('FLOW: OI snapshots cover 31h of 48h')
    expect(out).toContain('NEWS: needs a database')
    expect(out).toContain('role="radiogroup"')
  })
  test('pending and unavailable', () => {
    const p = movesResponse({ state: 'pending', progress: { loaded: 21, total: 40 }, asOf: null })
    expect(html(<MovesHeader moves={feed(p)} window="4h" onWindow={noop} />)).toContain('FIRST RUN — 21 OF 40 COINS LOADED')
    const u = movesResponse({ state: 'unavailable', reason: 'provider down' })
    expect(html(<MovesHeader moves={feed(u)} window="4h" onWindow={noop} />)).toContain('provider down')
  })
  test('loading: one skeleton row', () => {
    expect(html(<MovesHeader moves={none({ loading: true })} window="24h" onWindow={noop} />)).toContain('pulse-label')
  })
})

describe('FactorsPanel', () => {
  test('factors with n, sector buttons (no /sectors link), 9d-old sector file amber', () => {
    const out = html(<FactorsPanel moves={feed(movesResponse())} sector={null} onSector={noop} />)
    expect(out).toContain('ETH ex-BTC')
    expect(out).toContain('DeFi ex-majors')
    expect(out).toContain('n 9')
    expect(out).not.toContain('/sectors')
    expect(out).toContain('aria-pressed="false"')
    expect(out).toContain('GEN ')
  })
  test('active sector is pressed', () => {
    expect(html(<FactorsPanel moves={feed(movesResponse())} sector="defi" onSector={noop} />)).toContain('aria-pressed="true"')
  })
  test('pending and unavailable say why there are no factors', () => {
    expect(html(<FactorsPanel moves={feed(movesResponse({ state: 'pending', factors: [], progress: { loaded: 1, total: 2 } }))} sector={null} onSector={noop} />)).toContain('factors appear when the first run finishes')
    expect(html(<FactorsPanel moves={feed(movesResponse({ state: 'unavailable', reason: 'no scanner', factors: [] }))} sector={null} onSector={noop} />)).toContain('no scanner')
  })
})

const triageProps = (t: Feed<TriageResponse>) => ({ triage: t, selected: null, onOpen: noop, onDismiss: noop, onInvestigate: noop, busy: [] as string[], error: null, now: NOW })

describe('TriagePanel', () => {
  test('header states the budget as facts; rows carry reason, record claim, falsifier and actions', () => {
    const out = html(<TriagePanel {...triageProps(feed(triage()))} />)
    expect(out).toContain('TRIAGE · 6 OF 8 TODAY')
    expect(out).toContain('residual +6.2% · z 3.1 · 24h · no news in window')
    expect(out).toContain('Buyback announcement reported 2h before the move.')
    expect(out).toContain('falsifier: price trades below 39.9')
    expect(out).toContain('>OPEN<')
    expect(out).toContain('>DISMISS<')
    expect(out).not.toContain('DOGE') // dismissed
    expect(out).not.toContain('budget reached')
  })
  test('INVESTIGATE only without a record, and it says it costs one run', () => {
    const out = html(<TriagePanel {...triageProps(feed(triage()))} />)
    expect(out.match(/>INVESTIGATE</g)).toHaveLength(1)
    expect(out).toContain('costs one LLM run')
  })
  test('INVESTIGATE disabled with the server reason', () => {
    const out = html(<TriagePanel {...triageProps(feed(triage({ agentBlockedReason: 'daily agent cap reached (6/6)' })))} />)
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*title="daily agent cap reached \(6\/6\)"[^>]*>INVESTIGATE|<button[^>]*title="daily agent cap reached \(6\/6\)"[^>]*disabled=""[^>]*>INVESTIGATE/)
    expect(out).toContain('INVESTIGATE off: daily agent cap reached (6/6)')
  })
  test('in flight shows INVESTIGATING… and disables the button', () => {
    const out = html(<TriagePanel {...triageProps(feed(triage()))} busy={['SOL']} />)
    expect(out).toContain('INVESTIGATING…')
  })
  test('budget exhausted: the last line is a fact', () => {
    const out = html(<TriagePanel {...triageProps(feed(triage({ surfaced: 8, overBudget: 4 })))} />)
    expect(out).toContain('TRIAGE · 8 OF 8 TODAY')
    expect(out).toContain('budget reached: 4 more candidates not shown')
  })
  test('empty, unavailable, loading, offline', () => {
    expect(html(<TriagePanel {...triageProps(feed(triage({ items: [], surfaced: 0 })))} />)).toContain('nothing crossed the bar today — 38 coins watched, residual |z| ≥ 2.5 or a 3/3 checklist surfaces an item')
    expect(html(<TriagePanel {...triageProps(feed(triage({ state: 'unavailable', reason: 'needs the platform store', items: [] })))} />)).toContain('needs the platform store')
    expect(html(<TriagePanel {...triageProps(none({ loading: true }))} />)).toContain('pulse-label')
    expect(html(<TriagePanel {...triageProps(none({ offline: 'api unreachable' }))} />)).toContain('API UNREACHABLE')
  })
  test('no_cause, failed and capped records read as plain facts', () => {
    const t = triage({
      items: [
        { id: 'a', day: '2026-11-11', coin: 'AAA', reason: 'r', score: 1, residualZ: 3, surfacedAt: '2026-11-11T13:00:00.000Z', dismissedAt: null, recordId: 'x', record: record({ id: 'x', coin: 'AAA', status: 'no_cause', claim: '' }) },
        { id: 'b', day: '2026-11-11', coin: 'BBB', reason: 'r', score: 1, residualZ: 3, surfacedAt: '2026-11-11T13:00:00.000Z', dismissedAt: null, recordId: 'y', record: record({ id: 'y', coin: 'BBB', status: 'failed' }) },
      ],
    })
    const out = html(<TriagePanel {...triageProps(feed(t))} />)
    expect(out).toContain('no cause found')
    expect(out).toContain('investigation failed')
  })
})

const viewProps = (over: Partial<MovesViewProps> = {}): MovesViewProps => {
  const m = movesResponse()
  return {
    window: '24h', onWindow: noop, moves: feed(m), triage: feed(triage()), detail: feed<MoveDetail>(detail()), stats: stats(), defs: null,
    rows: sortRows(m.rows, 'z'), sort: 'z', onSort: noop, sector: null, onSector: noop, selected: 'HYPE', onSelect: noop, onBack: noop,
    showList: true, showDetail: true, now: NOW, onDismiss: noop, onInvestigate: noop, busy: [], actionError: null, ...over,
  }
}
const block = (out: string, id: string) => out.slice(out.indexOf(`data-block="${id}"`)).split('</section>')[0]!

describe('MovesView', () => {
  const out = html(<MovesView {...viewProps()} />)

  test('never renders APPROVE, KILL or an order entry', () => {
    expect(out).not.toMatch(/approve/i)
    expect(out).not.toMatch(/\bkill\b/i)
    expect(out).not.toMatch(/<form|<input/i)
    expect(out).toContain('href="/order"')
  })
  test('outbound links of the selected coin', () => {
    for (const to of ['/coin/HYPE', '/?coin=HYPE', '/coin/HYPE?chart=price', '/coin/HYPE?liq=1']) expect(out).toContain(`href="${to}"`)
    for (const gone of ['/asset/', '/feed?liq', '/sectors', '/markets/']) expect(out).not.toContain(gone)
    expect(out).not.toContain('OPPORTUNITY')
  })
  test('the condition check is its own info-styled block, apart from attribution', () => {
    const d1 = block(out, 'd1')
    const d6 = block(out, 'd6')
    expect(d6).toContain('CONDITION CHECK · NOT A FORECAST')
    expect(d6).toContain('border-info')
    expect(d6).toContain('met 2 of 3')
    expect(d6).toContain('tested as: funding_fade (daily version)')
    expect(d6).toContain('untested — attention is not a Lab metric')
    expect(d1).not.toContain('NOT A FORECAST')
    expect(d1).not.toContain('border-info')
    expect(d1).toContain('ATTRIBUTION · EXPLAINED AFTER THE FACT')
    expect(d1.indexOf('d1')).toBeLessThan(out.indexOf('data-block="d6"'))
  })
  test('agent record is info-styled with HYP, falsifier distance, sources and the track record', () => {
    const d2 = block(out, 'd2')
    expect(d2).toContain('border-info')
    expect(d2).toContain('HYP')
    expect(d2).toContain('NARRATIVE')
    expect(d2).toContain('CONDITION CHECK · NOT A FORECAST')
    expect(d2).toContain('falsifier: below 39.900 (−5.4% from mark) — price trades below 39.9')
    expect(d2).toContain('HYPE buyback')
    expect(d2).toContain('open — grades at 24h')
    expect(d2).toContain('agent records: n 23 graded · hit 52% · mean vs BTC +0.4% [−0.6, +1.4] · 24h')
  })
  test('residual buckets are labelled by hours, not causes', () => {
    const d1 = block(out, 'd1')
    expect(d1).toContain('RESIDUAL in OI-drop hours')
    expect(d1).toContain('RESIDUAL in news hours')
    expect(d1).toContain('They are not causes')
    expect(d1).toContain('R² 0.62')
    expect(d1).toContain('n 168')
  })
  test('positioning shows n and check marks; a null z names the missing history', () => {
    const d3 = block(out, 'd3')
    expect(d3).toContain('z 2.3 · n 336')
    expect(d3).toContain('✓')
    expect(d3).toContain('✗')
    expect(d3).toContain('met long 3 of 3')
    const thin = html(<MovesView {...viewProps({ detail: feed(detail({ positioning: { ...row().positioning, fundingZ: null, fundingN: 40, premiumBps: null } })) })} />)
    expect(block(thin, 'd3')).toContain('z — · n 40 of 168')
  })
  test('phone detail screen: back link, no list, no triage', () => {
    const phone = html(<MovesView {...viewProps({ showList: false })} />)
    expect(phone).toContain('← MOVES')
    expect(phone).not.toContain('TRIAGE')
    expect(phone).not.toContain('moves table')
  })
  test('no TriagePanel on /moves: one line pointing at QUEUE', () => {
    expect(out).not.toContain('TRIAGE')
    expect(out).toContain('href="/queue"')
    expect(out).toContain('today&#x27;s triage is in QUEUE →')
  })
  test('phone list: no detail pane', () => {
    const list = html(<MovesView {...viewProps({ showDetail: false })} />)
    expect(list).toContain('href="/queue"')
    expect(list).not.toContain('data-block="d1"')
  })
})

describe('detail states', () => {
  const view = (d: Partial<Feed<MoveDetail>> & { data?: MoveDetail | null }, over: Partial<MovesViewProps> = {}) => html(<MovesView {...viewProps({ detail: feed(d.data ?? null, d), ...over })} />)

  test('loading, offline, error', () => {
    expect(view({ loading: true })).toContain('pulse-label')
    expect(view({ offline: 'api unreachable' })).toContain('API UNREACHABLE')
    expect(view({ error: 'move detail response mismatch: series Required' })).toContain('move detail response mismatch: series Required')
  })
  test('unavailable detail shows its reason', () => {
    expect(view({ data: detail({ state: 'unavailable', reason: 'HYPE is not in the moves universe' }) })).toContain('HYPE is not in the moves universe')
  })
  test('no selection', () => expect(view({}, { selected: null })).toContain('select a coin'))
  test('null attribution: the server reason, no chart', () => {
    const out = view({ data: detail({ attribution: null, attributionReason: 'needs 120 of 168 hourly bars before the window — has 74', series: [] }) })
    expect(block(out, 'd1')).toContain('needs 120 of 168 hourly bars before the window — has 74')
    expect(block(out, 'd1')).not.toContain('R²')
  })
  test('BTC is the factor: total only', () => {
    const out = view({ data: detail({ coin: 'BTC' }) })
    expect(block(out, 'd1')).toContain('BTC is the factor')
    expect(block(out, 'd1')).not.toContain('RESIDUAL')
  })
  test('null buckets are dashes with the layer reason, never 0', () => {
    const a = { ...row().attribution!, residualFlowPct: null, residualNewsPct: null, flowHours: null, newsHours: null }
    const d1 = block(view({ data: detail({ attribution: a }) }), 'd1')
    expect(d1).toContain('— OI snapshots cover 31h of 48h')
    expect(d1).toContain('— needs a database')
  })
  test('liquidation: unavailable, too little coverage, partial map', () => {
    const liq = (over: Record<string, unknown>) => detail({ liq: { ...row().liq, ...over } })
    expect(block(view({ data: liq({ state: { state: 'unavailable', reason: 'needs the always-on scanner and crawler' } }) }), 'd4')).toContain('needs the always-on scanner and crawler')
    expect(block(view({ data: liq({ coverageRatio: 0.02 }) }), 'd4')).toContain('too little coverage to name clusters')
    const partial = block(view({ data: liq({ coverageRatio: 0.1 }) }), 'd4')
    expect(partial).toContain('PARTIAL MAP')
    expect(partial).toContain('1.3σ')
  })
  test('attention: unavailable reason, and headlines with age', () => {
    const un = detail({ attention: { ...row().attention, state: { state: 'unavailable', reason: 'needs a database (news and Elfa are stored)' } }, headlines: [] })
    expect(block(view({ data: un }), 'd5')).toContain('needs a database (news and Elfa are stored)')
    const ok = block(view({ data: detail() }), 'd5')
    expect(ok).toContain('news 24h 4 vs 7d daily mean 1.5')
    expect(ok).toContain('HYPE announces buyback')
    expect(ok).toContain('href="https://example.com/n1"')
    expect(ok).toContain('href="/moves?sector=defi"')
  })
  test('no record: reason line and an INVESTIGATE button that is off with the agent layer reason', () => {
    const d = detail({ record: null, layers: { ...movesResponse().layers, agents: { state: 'unavailable', reason: 'no LLM provider configured' } } })
    const d2 = block(view({ data: d }), 'd2')
    expect(d2).toContain('no agent record for this coin yet')
    expect(d2).toContain('INVESTIGATE')
    expect(d2).toContain('disabled=""')
    expect(d2).toContain('no LLM provider configured')
  })
  test('a graded record shows its grade and no_cause says so', () => {
    const graded = record({ status: 'graded', grade: { atHours: 24, px: 44, btcPx: 98500, relPct: 1.2, hit: true, falsifiedAt: null } })
    expect(block(view({ data: detail({ record: graded }) }), 'd2')).toContain('GRADED at 24h · vs BTC +1.2% · hit')
    expect(block(view({ data: detail({ record: record({ status: 'no_cause', claim: '' }) }) }), 'd2')).toContain('no cause found')
  })
  test('thin track record reads n<5', () => {
    const thin = stats({ byHorizon: [{ key: '24h', n: 3, clusters: 3, meanRelPct: null, ci95: null, hitRate: null }] })
    expect(block(view({ data: detail() }, { stats: thin }), 'd2')).toContain('n&lt;5 — not enough graded')
  })
  test('checklist with no definition and unevaluable values', () => {
    const d = detail({ setups: [{ kind: 'enter', side: null, met: 0, of: 0, definitionId: null, checks: [{ key: 'k', label: 'attention rising', value: null, threshold: '≥ 2×', met: null }] }] })
    const d6 = block(view({ data: d }), 'd6')
    expect(d6).toContain('side —')
    expect(d6).toContain('untested — attention is not a Lab metric')
    expect(d6).toContain('—')
  })
})
