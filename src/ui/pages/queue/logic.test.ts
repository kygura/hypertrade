import { describe, expect, test } from 'bun:test'
import { record } from '../moves/fixtures'
import { item, NOW, queueResponse, setupPart } from './fixtures'
import { agentLine, ageText, defaultSelection, directionOf, emptyLine, headerLine, partLabel, partsLabel, recordChip, sourceChips, sourceProblemLine, splitItems, staleLine } from './logic'

describe('queue logic', () => {
  test('headerLine: listed of cap, over cap only when some wait', () => {
    expect(headerLine(queueResponse({ items: [item('SOL'), item('WIF')] }))).toBe('QUEUE · 2 listed of 8')
    expect(headerLine(queueResponse({ items: [item('SOL')], overCap: 2 }))).toBe('QUEUE · 1 listed of 8 · 2 weaker over cap')
  })

  test('source chips: counts when ok, the reason as hover and as one quiet line when unavailable', () => {
    const q = queueResponse({ sources: { moves: { state: 'ok', reason: null, count: 3 }, opportunity: { state: 'ok', reason: null, count: 1 }, radar: { state: 'unavailable', reason: 'sign in required', count: 0 } } })
    expect(sourceChips(q).map((c) => [c.label, c.ok, c.count, c.title])).toEqual([
      ['MOVES', true, 3, '3 coins today, before the cap'],
      ['SETUP', true, 1, '1 coin today, before the cap'],
      ['RADAR', false, 0, 'sign in required'],
    ])
    expect(sourceProblemLine(q)).toBe('RADAR off: sign in required')
    expect(sourceProblemLine(queueResponse())).toBeNull()
  })

  test('staleLine: only the stale inputs, aged to now; nothing when fresh or not stored', () => {
    expect(staleLine(queueResponse(), NOW)).toBeNull()
    expect(staleLine(queueResponse({ freshness: { movesRun: null, triage: null } }), NOW)).toBeNull()
    const old = { movesRun: { at: '2026-11-11T11:10:00.000Z', stale: true }, triage: { at: '2026-11-11T13:40:00.000Z', stale: true } }
    expect(staleLine(queueResponse({ freshness: old }), NOW)).toBe('moves run 3h old · triage 40m old')
    expect(staleLine(queueResponse({ freshness: { ...old, movesRun: { at: '2026-11-11T14:03:00.000Z', stale: false } } }), NOW)).toBe('triage 40m old')
  })

  test('labels: MOVES/SETUP/RADAR, the parts joined, one side or mixed or a dash', () => {
    expect(['moves', 'opportunity', 'radar'].map((s) => partLabel(s as never))).toEqual(['MOVES', 'SETUP', 'RADAR'])
    const both = item('SOL', { parts: [item('SOL').parts[0]!, setupPart('SOL')] })
    expect(partsLabel(both)).toBe('MOVES·SETUP')
    expect(directionOf(both)).toBe('long')
    expect(directionOf(item('WIF'))).toBe('—')
    expect(directionOf({ parts: [setupPart('SOL'), { ...setupPart('SOL'), direction: 'short' }] })).toBe('mixed')
  })

  test('agentLine and the calm empty line', () => {
    expect(agentLine(queueResponse())).toBe('agents 2/6 today')
    expect(agentLine(queueResponse({ agentBlockedReason: 'no LLM provider configured' }))).toBe('agents 2/6 today · investigate off: no LLM provider configured')
    expect(emptyLine(38)).toBe('nothing crossed the bar today · 38 coins watched')
    expect(emptyLine(null)).toBe('nothing crossed the bar today')
  })

  test('ageText reads from firstAt', () => {
    expect(ageText('2026-11-11T14:06:00.000Z', NOW)).toBe('14m')
    expect(ageText('2026-11-11T12:00:00.000Z', NOW)).toBe('2h')
  })

  test('defaultSelection: the URL coin (any case), else the first new item, else the first item', () => {
    const items = [item('WIF', { state: 'acted' }), item('SOL'), item('xyz:TSLA')]
    expect(defaultSelection(items, null)).toBe('SOL')
    expect(defaultSelection(items, 'XYZ:tsla')).toBe('xyz:TSLA')
    expect(defaultSelection(items, 'BTC')).toBe('BTC')
    expect(defaultSelection([item('WIF', { state: 'dismissed', dismissedAt: '2026-11-11T14:10:00.000Z' })], null)).toBe('WIF')
    expect(defaultSelection([], null)).toBeNull()
  })

  test('splitItems: new first; acted and dismissed in the handled group', () => {
    const s = splitItems([item('A'), item('B', { state: 'acted' }), item('C', { state: 'dismissed', dismissedAt: '2026-11-11T14:10:00.000Z' })])
    expect([s.open.map((i) => i.coin), s.handled.map((i) => i.coin)]).toEqual([['A'], ['B', 'C']])
  })

  test('recordChip: none without a record; open, graded hit/miss, no cause', () => {
    expect(recordChip(null)).toBeNull()
    expect(recordChip(record())).toEqual({ label: 'OPEN record', tone: 'info' })
    const grade = { atHours: 24, px: 40, btcPx: 98000, relPct: 2.1, hit: true, falsifiedAt: null }
    expect(recordChip(record({ status: 'graded', grade }))!.label).toBe('graded · hit')
    expect(recordChip(record({ status: 'graded', grade: { ...grade, hit: false } }))!.label).toBe('graded · miss')
    expect(recordChip(record({ status: 'no_cause' }))!.label).toBe('no cause found')
  })
})
