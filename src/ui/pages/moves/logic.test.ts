import { describe, expect, test } from 'bun:test'
import { DefinitionsResponseSchema } from '../../../shared/research'
import { ASOF, detail, movesResponse, nullRow, NOW, record, row, stats, triage } from './fixtures'
import {
  attributionCell, attributionSegments, barScale, barWidth, bestChecklist, budgetLine, chartData, coverageCopy, crowdText, falsifierLine, filterSector, fmtMove, fundingZText, gradeLine, headerLine,
  investigateFailure, investigateGate, layerChips, liqSigmaText, moveKey, outboundLinks, overBudgetLine, parseSort, parseWindow, progressLine, recordView, sectorOfFactor, sortRows, staleLine,
  studyLinkFor, tagText, trackLine, triageEmptyLabel, visibleItems,
} from './logic'

const withZ = (coin: string, z: number | null, total = 1, longMet = 0) =>
  row(coin, {
    attribution: z === null ? null : { ...row().attribution!, residualZ: z, totalPct: total },
    attributionReason: z === null ? 'no history' : null,
    positioning: { ...row().positioning, longMet, shortMet: 0 },
  })

describe('parse', () => {
  test('window falls back to 24h', () => {
    expect(parseWindow('4h')).toBe('4h')
    expect(parseWindow('72h')).toBe('72h')
    expect(parseWindow('7d')).toBe('24h')
    expect(parseWindow(null)).toBe('24h')
  })
  test('sort falls back to |z|', () => {
    expect(parseSort('crowd')).toBe('crowd')
    expect(parseSort('nope')).toBe('z')
  })
})

describe('sortRows', () => {
  const rows = [withZ('A', 1.2, 9, 1), withZ('B', -3.4, 2, 0), withZ('C', null), withZ('D', 2.0, -12, 4)]
  test('by |z|, null attribution last', () => expect(sortRows(rows, 'z').map((r) => r.coin)).toEqual(['B', 'D', 'A', 'C']))
  test('by |total|', () => expect(sortRows(rows, 'total').map((r) => r.coin)).toEqual(['D', 'A', 'B', 'C']))
  test('by crowding met, ties by coin', () => expect(sortRows(rows, 'crowd').map((r) => r.coin)).toEqual(['D', 'A', 'B', 'C']))
  test('does not mutate', () => {
    const copy = [...rows]
    sortRows(rows, 'z')
    expect(rows).toEqual(copy)
  })
  test('sector filter and factor ids', () => {
    expect(filterSector([row('A'), row('B', { sector: null })], 'defi').map((r) => r.coin)).toEqual(['A'])
    expect(filterSector([row('A')], null)).toHaveLength(1)
    expect(sectorOfFactor('sector:ai')).toBe('ai')
    expect(sectorOfFactor('ETHX')).toBeNull()
  })
})

describe('bars', () => {
  test('width is the share of the largest |residual|, per half', () => {
    expect(barWidth(5, 10)).toBe(50)
    expect(barWidth(-10, 10)).toBe(100)
    expect(barWidth(25, 10)).toBe(100)
    expect(barWidth(null, 10)).toBe(0)
    expect(barWidth(3, 0)).toBe(0)
  })
  test('scale ignores rows without an attribution', () => {
    expect(barScale([row('HYPE'), nullRow()])).toBe(6.2)
    expect(barScale([nullRow()])).toBe(0)
  })
  test('stacked segments share the Σ|part| and keep the buckets named', () => {
    const segs = attributionSegments(row().attribution!)
    expect(segs.map((s) => s.key)).toEqual(['btc', 'eth', 'sector', 'flow', 'news', 'other'])
    expect(segs.reduce((s, x) => s + x.width, 0)).toBeCloseTo(100, 0)
    expect(segs.find((s) => s.key === 'flow')!.label).toBe('RESIDUAL in OI-drop hours')
    expect(segs.find((s) => s.key === 'news')!.label).toBe('RESIDUAL in news hours')
  })
  test('a null bucket or sector is left out, not drawn as 0', () => {
    const a = { ...row().attribution!, sectorPct: null, residualFlowPct: null, residualNewsPct: null }
    expect(attributionSegments(a).map((s) => s.key)).toEqual(['btc', 'eth', 'other'])
  })
})

describe('cells', () => {
  test('null attribution keeps the server reason as the title', () => {
    expect(attributionCell(nullRow())).toEqual({ text: '—', title: 'needs 120 of 168 hourly bars before the window — has 74' })
    expect(attributionCell(row())).toBeNull()
  })
  test('crowd, liq sigma, tags, best checklist', () => {
    expect(crowdText({ longMet: 3, shortMet: 0, of: 4 })).toBe('3/4 · 0/4')
    expect(crowdText({ longMet: 0, shortMet: 0, of: 0 })).toBe('—')
    expect(liqSigmaText({ longSigmas: 1.3, shortSigmas: 0.8 })).toBe('0.8σ S')
    expect(liqSigmaText({ longSigmas: 0.9, shortSigmas: null })).toBe('0.9σ L')
    expect(liqSigmaText({ longSigmas: null, shortSigmas: null })).toBe('—')
    expect(tagText(3, 'FLOW')).toBe('FLOW 3H')
    expect(tagText(0, 'NEWS')).toBeNull()
    expect(tagText(null, 'NEWS')).toBeNull()
    expect(bestChecklist(row().setups)!.kind).toBe('fade')
    expect(bestChecklist([{ kind: 'fade', side: null, checks: [], met: 0, of: 0, definitionId: null }])).toBeNull()
  })
  test('null funding z says how much history is missing', () => {
    expect(fundingZText({ fundingZ: null, fundingN: 40 })).toBe('z — · n 40 of 168')
    expect(fundingZText({ fundingZ: 2.34, fundingN: 336 })).toBe('z 2.3 · n 336')
  })
  test('coverage copy follows the 5% / 25% thresholds', () => {
    expect(coverageCopy(0.02).text).toContain('too little coverage to name clusters')
    expect(coverageCopy(0.1).text).toContain('PARTIAL MAP')
    expect(coverageCopy(0.6).kind).toBe('full')
    expect(coverageCopy(null).kind).toBe('unknown')
  })
})

describe('header and states', () => {
  test('pending, unavailable and ok sentences', () => {
    const ok = movesResponse()
    expect(headerLine(ok)).toBe('asOf 14:00 UTC (last closed hour) · 3 coins · 1 dropped*')
    expect(headerLine(movesResponse({ state: 'pending', progress: { loaded: 21, total: 40 }, asOf: null }))).toBe('FIRST RUN — 21 OF 40 COINS LOADED')
    expect(progressLine({ loaded: 0, total: 40 })).toBe('FIRST RUN — 0 OF 40 COINS LOADED')
    expect(headerLine(movesResponse({ state: 'unavailable', reason: 'needs the always-on server' }))).toBe('needs the always-on server')
  })
  test('stale line only past 2h, in whole hours', () => {
    const at = (h: number) => Date.parse(ASOF) + h * 3_600_000
    expect(staleLine(ASOF, at(1.9))).toBeNull()
    expect(staleLine(ASOF, at(3.2))).toBe('attribution 3h old — last closed hour 14:00')
    expect(staleLine(null, NOW)).toBeNull()
  })
  test('layer chips map states to dots and keep reasons', () => {
    const chips = layerChips(movesResponse().layers)
    expect(chips.map((c) => `${c.label}:${c.dot}`)).toEqual(['BETA:ok', 'FLOW:degraded', 'NEWS:down', 'LIQ:ok', 'AGENTS:ok'])
    expect(chips[2]!.reason).toBe('needs a database')
  })
})

describe('triage words', () => {
  test('budget line and the over-budget fact', () => {
    expect(budgetLine({ surfaced: 6, budget: 8 })).toBe('6 OF 8 TODAY')
    expect(overBudgetLine(4)).toBe('budget reached: 4 more candidates not shown')
    expect(overBudgetLine(1)).toBe('budget reached: 1 more candidate not shown')
    expect(overBudgetLine(0)).toBeNull()
  })
  test('empty label states what was watched', () => {
    expect(triageEmptyLabel({ watched: 38, items: [], surfaced: 0 })).toBe('nothing crossed the bar today — 38 coins watched, residual |z| ≥ 2.5 or a 3/3 checklist surfaces an item')
  })
  test('dismissed items leave the queue', () => expect(visibleItems(triage().items).map((i) => i.coin)).toEqual(['HYPE', 'SOL']))
  test('record views', () => {
    expect(recordView(null, false).kind).toBe('absent')
    expect(recordView(null, true).text).toBe('INVESTIGATING…')
    expect(recordView(record({ status: 'no_cause' }), false).text).toBe('no cause found')
    expect(recordView(record(), false)).toEqual({ kind: 'claim', text: 'Buyback announcement reported 2h before the move.' })
  })
  test('INVESTIGATE gate carries the server reason, and the 409 / 429 / 503 words', () => {
    expect(investigateGate('no LLM provider configured', false)).toEqual({ disabled: true, title: 'no LLM provider configured' })
    expect(investigateGate(null, true).disabled).toBe(true)
    expect(investigateGate(null, false).title).toContain('one LLM run')
    expect(investigateFailure(409, '')).toContain('already running')
    expect(investigateFailure(429, '')).toBe('daily agent cap reached')
    expect(investigateFailure(503, '')).toBe('no LLM provider configured')
    expect(investigateFailure(500, 'boom')).toBe('boom')
  })
})

describe('record words', () => {
  test('falsifier distance from the mark', () => {
    expect(falsifierLine({ level: 39.9, side: 'below', text: 'closes below' }, 42.18)).toBe('below 39.900 (−5.4% from mark) — closes below')
    expect(falsifierLine({ level: 39.9, side: 'below', text: 'x' }, null)).toBe('below 39.900 — x')
  })
  test('grade line', () => {
    expect(gradeLine(record())).toBe('open — grades at 24h')
    const graded = record({ status: 'graded', grade: { atHours: 24, px: 44, btcPx: 98500, relPct: 1.234, hit: true, falsifiedAt: null } })
    expect(gradeLine(graded)).toBe('GRADED at 24h · vs BTC +1.2% · hit')
    const fals = record({ status: 'falsified', grade: { atHours: 6, px: 39, btcPx: 98000, relPct: -3, hit: false, falsifiedAt: '2026-11-11T19:00:00.000Z' } })
    expect(gradeLine(fals)).toBe('FALSIFIED at 6h · vs BTC −3.0% · miss')
  })
  test('track line carries n and the interval, and says n<5 under 5 clusters', () => {
    expect(trackLine(stats(), 24)).toBe('agent records: n 23 graded · hit 52% · mean vs BTC +0.4% [−0.6, +1.4] · 24h')
    expect(trackLine(stats({ byHorizon: [{ key: '24h', n: 3, clusters: 3, meanRelPct: null, ci95: null, hitRate: null }] }), 24)).toBe('agent records: n 3 graded · n<5 — not enough graded · 24h')
    expect(trackLine(stats(), 72)).toBe('agent records: none graded at 72h yet')
    expect(trackLine(null, 24)).toBe('agent records: —')
  })
})

describe('moves print as ordinary percent', () => {
  test('a log-% is shown as the price change it stands for', () => {
    expect(fmtMove(-69.6)).toBe('−50.1%') // a halving, not a 70% drop
    expect(fmtMove(69.3)).toBe('+100.0%')
    expect(fmtMove(1)).toBe('+1.0%')
    expect(fmtMove(null)).toBe('—')
  })
})

describe('chart data', () => {
  test('marks sit on the actual line at flow and news hours', () => {
    const { points, marks } = chartData(detail().series)
    expect(points).toHaveLength(4)
    expect(marks.map((m) => `${m.kind}@${m.y.toFixed(2)}`)).toEqual(['flow@4.08', 'news@6.18']) // log-% 4 and 6 as ordinary percent
  })
})

describe('links', () => {
  const defs = DefinitionsResponseSchema.parse({
    definitions: [{ id: 'funding_fade', name: 'Funding fade', thesis: 't', rule: { asset: 'UNIVERSE', direction: 'short', horizonDays: 3, conditions: [{ feature: 'ht:funding', op: '>=', threshold: 0.0001 }] }, ruleText: 'r', intradayKinds: [] }],
  })
  test('outbound set: no approve, no order params', () => {
    const links = outboundLinks(row('HYPE'), null)
    expect(links.map((l) => `${l.label} ${l.to}`)).toEqual(['COIN /coin/HYPE', 'EVIDENCE /?coin=HYPE', 'CHART /coin/HYPE?chart=price', 'ORDER /order'])
    expect(links.some((l) => /approve|kill/i.test(l.label + l.to))).toBe(false)
  })
  test('every link stays on linked screens: no /asset, /feed?liq, /sectors, /markets', () => {
    const all = outboundLinks(row('HYPE', { opportunityId: 'opp 1' }), defs).map((l) => l.to)
    for (const to of all) expect(to).not.toMatch(/^\/asset|^\/feed\?liq|^\/sectors|^\/markets/)
    expect(outboundLinks(row('xyz:TSLA'), null)[0]!.to).toBe('/coin/xyz%3ATSLA')
  })
  test('opportunity and study links appear only when they exist', () => {
    const r = row('HYPE', { opportunityId: 'opp 1' })
    const labels = outboundLinks(r, defs).map((l) => l.label)
    expect(labels).toContain('OPPORTUNITY')
    expect(labels).toContain('STUDY')
    expect(outboundLinks(r, defs).find((l) => l.key === 'opportunity')!.to).toBe('/coin/HYPE')
    expect(outboundLinks(row('HYPE'), null).map((l) => l.label)).not.toContain('STUDY')
    expect(studyLinkFor(defs, 'funding_fade', 'HYPE')).toStartWith('/lab/study?rule=')
    expect(studyLinkFor(defs, null, 'HYPE')).toBeNull()
    expect(studyLinkFor(defs, 'unknown', 'HYPE')).toBeNull()
  })
})

describe('keys', () => {
  const base = { dialogOpen: false }
  test('j k Enter only', () => {
    expect(moveKey({ ...base, key: 'j' })).toBe('next')
    expect(moveKey({ ...base, key: 'k' })).toBe('prev')
    expect(moveKey({ ...base, key: 'Enter' })).toBe('open')
    expect(moveKey({ ...base, key: 'a' })).toBeNull()
    expect(moveKey({ ...base, key: 'x' })).toBeNull()
  })
  test('typing, modifiers and dialogs are not ours', () => {
    expect(moveKey({ ...base, key: 'j', target: 'INPUT' })).toBeNull()
    expect(moveKey({ ...base, key: 'j', metaKey: true })).toBeNull()
    expect(moveKey({ key: 'j', dialogOpen: true })).toBeNull()
  })
})
