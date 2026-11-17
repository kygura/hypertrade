import { describe, expect, test } from 'bun:test'
import type { DeskCooldownResponse, DeskPlanRecord, PlanCheck } from '../../shared/deskPlan'
import {
  addRung,
  draftToInput,
  emptyDraft,
  fmtTimeLeft,
  fmtUntilUtc,
  globalLockLine,
  lockFor,
  MAX_RUNGS,
  metricRows,
  parsePositive,
  placeSummary,
  planKey,
  removeRung,
  stopOutEntry,
  submitGate,
  submitOutcome,
  type PlanDraft,
} from './deskPlan'

const draft = (p: Partial<PlanDraft> = {}): PlanDraft => ({
  coin: 'btc',
  side: 'long',
  rungs: [
    { px: '60,000', size: '0.01' },
    { px: '59500', size: '0.02' },
  ],
  stop: '58000',
  target: '64000',
  note: '  range low retest ',
  ...p,
})

const check = (p: Partial<PlanCheck> = {}): PlanCheck => ({
  metrics: {
    totalSize: 0.03,
    notionalUsd: 1790,
    avgEntryPx: 59666.67,
    topRungPx: 60000,
    lossAtStopUsd: 50,
    lossAtStopPct: 0.5,
    rrFull: 2.6,
    rrTopOnly: 2,
    dailyLimitUsedPct: 25,
    drawdownUsedPct: 5,
    equityUsd: 10000,
    markPx: 60100,
  },
  blockers: [],
  warnings: [],
  ...p,
})

describe('parsePositive', () => {
  test('accepts typed numbers with separators, rejects the rest', () => {
    expect(parsePositive('61,250.5')).toBe(61250.5)
    expect(parsePositive(' 0.5 ')).toBe(0.5)
    expect(parsePositive('.25')).toBe(0.25)
    expect(parsePositive('')).toBeNull()
    expect(parsePositive('0')).toBeNull()
    expect(parsePositive('-3')).toBeNull()
    expect(parsePositive('12abc')).toBeNull()
  })
})

describe('draftToInput', () => {
  test('form → DeskPlanInput: coin upper-cased, numbers parsed, note trimmed', () => {
    expect(draftToInput(draft())).toEqual({
      input: {
        coin: 'BTC',
        side: 'long',
        rungs: [
          { px: 60000, size: 0.01 },
          { px: 59500, size: 0.02 },
        ],
        stopPx: 58000,
        targetPx: 64000,
        note: 'range low retest',
      },
      problems: [],
    })
  })

  test('blank stop and target go to the server as null (it says what is missing); an empty note is left out', () => {
    const r = draftToInput(draft({ stop: '', target: ' ', note: '' }))
    expect(r.input).toMatchObject({ stopPx: null, targetPx: null })
    expect(r.input).not.toHaveProperty('note')
  })

  test('fully blank levels are skipped; half-filled ones are problems', () => {
    expect(draftToInput(draft({ rungs: [{ px: '60000', size: '0.01' }, { px: '', size: '' }] })).input?.rungs).toEqual([{ px: 60000, size: 0.01 }])
    const r = draftToInput(draft({ rungs: [{ px: '60000', size: '' }] }))
    expect(r.input).toBeNull()
    expect(r.problems).toEqual(['level 1: size is not a positive number'])
  })

  test('no coin, no levels and a typed-but-invalid stop are all reported', () => {
    const r = draftToInput(draft({ coin: ' ', rungs: [{ px: '', size: '' }], stop: 'abc' }))
    expect(r.input).toBeNull()
    expect(r.problems).toEqual(['write a coin', 'write at least one level: a price and a size', 'stop is not a positive number'])
  })

  test('add and remove levels: capped at 20, the last one is cleared, not removed', () => {
    let d = emptyDraft('ETH')
    for (let i = 0; i < 30; i++) d = addRung(d)
    expect(d.rungs).toHaveLength(MAX_RUNGS)
    const one = removeRung({ ...emptyDraft(), rungs: [{ px: '1', size: '2' }] }, 0)
    expect(one.rungs).toEqual([{ px: '', size: '' }])
    expect(removeRung(draft(), 0).rungs).toEqual([{ px: '59500', size: '0.02' }])
  })
})

describe('submitGate', () => {
  const parse = draftToInput(draft())
  const key = `0|${planKey(parse.input!)}`
  const ok = { key, check: check(), error: null }

  test('enabled only for a checked plan with a stop, no blockers, no edit since, no cooldown', () => {
    expect(submitGate({ parse, key, result: ok, locked: false, busy: false })).toEqual({ canPlace: true, canSave: true, reason: null })
  })

  test('pending (no answer yet) and stale (answer for an older input) both disable placing, not saving', () => {
    expect(submitGate({ parse, key, result: null, locked: false, busy: false })).toEqual({ canPlace: false, canSave: true, reason: 'checking the plan' })
    expect(submitGate({ parse, key, result: { ...ok, key: '0|older' }, locked: false, busy: false }).canPlace).toBe(false)
  })

  test('blockers disable placing and are counted', () => {
    const g = submitGate({ parse, key, result: { ...ok, check: check({ blockers: ['a', 'b'] }) }, locked: false, busy: false })
    expect(g).toEqual({ canPlace: false, canSave: true, reason: '2 blockers below' })
  })

  test('a missing stop disables placing even before the check answers', () => {
    const p = draftToInput(draft({ stop: '' }))
    const k = `0|${planKey(p.input!)}`
    expect(submitGate({ parse: p, key: k, result: { key: k, check: check(), error: null }, locked: false, busy: false })).toEqual({ canPlace: false, canSave: true, reason: 'write a stop' })
  })

  test('a failed check, an incomplete form, a cooldown and an in-flight submit all disable placing', () => {
    expect(submitGate({ parse, key, result: { key, check: null, error: 'desk down' }, locked: false, busy: false }).reason).toBe('the check failed: desk down')
    const bad = draftToInput(draft({ coin: '' }))
    expect(submitGate({ parse: bad, key: null, result: null, locked: false, busy: false })).toEqual({ canPlace: false, canSave: false, reason: 'write a coin' })
    expect(submitGate({ parse, key, result: ok, locked: true, busy: false }).canPlace).toBe(false)
    expect(submitGate({ parse, key, result: ok, locked: false, busy: true })).toMatchObject({ canPlace: false, canSave: false })
  })
})

describe('wording', () => {
  test('metric rows carry every number the spec asks for', () => {
    const rows = Object.fromEntries(metricRows(check()))
    expect(rows['Total size']).toBe('0.03')
    expect(rows['Loss at stop']).toContain('0.5% of account')
    expect(rows['R:R all filled']).toBe('2.60')
    expect(rows["Today's loss limit used"]).toBe('25%')
    expect(rows['Max drawdown used']).toBe('5%')
    expect(Object.keys(rows).some((k) => k.startsWith('R:R top level only'))).toBe(true)
  })

  test('the confirm body restates the plan and names the venue, without urgency', () => {
    const s = placeSummary(draftToInput(draft()).input!, 'paper', check())
    expect(s).toContain('Long BTC on PAPER: 2 levels, 0.03 BTC in total')
    expect(s).toContain('stop')
    expect(s).toContain('journaled')
    expect(s).not.toMatch(/now|hurry|quick/i)
  })

  test('submit outcome: saved, placed, dry run, refused with reason', () => {
    const rec = (p: Partial<DeskPlanRecord>): DeskPlanRecord => ({
      id: 'p1', createdAt: '2026-11-17T10:00:00Z', source: 'plan', venue: 'paper', input: draftToInput(draft()).input!,
      metrics: check().metrics, blockers: [], warnings: [], placed: false, placement: null, ...p,
    })
    const placement = { proposalId: 'x', status: 'executed' as const, error: null, dryRun: false, note: null }
    expect(submitOutcome({ record: rec({}), check: check(), placed: false }, false).tone).toBe('saved')
    expect(submitOutcome({ record: rec({ placed: true, placement }), check: check(), placed: true }, true).tone).toBe('placed')
    expect(submitOutcome({ record: rec({ placement: { ...placement, dryRun: true } }), check: check(), placed: false }, true).tone).toBe('dry')
    const refused = submitOutcome({ record: rec({ placement: { ...placement, status: 'failed', error: 'insufficient margin' } }), check: check(), placed: false }, true)
    expect(refused).toEqual({ tone: 'refused', text: 'Not placed (failed): insufficient margin. Journaled.' })
    expect(submitOutcome({ record: rec({}), check: check({ blockers: ['no target: every plan needs one'] }), placed: false }, true).text).toBe(
      'Not placed: no target: every plan needs one. Journaled.',
    )
  })
})

describe('cooldown', () => {
  const now = Date.parse('2026-11-17T10:42:00Z')
  const coinLock = {
    coin: 'SOL',
    until: '2026-11-17T14:00:00Z',
    stopOutAt: '2026-11-17T10:00:00Z',
    ref: { source: 'paper' as const, proposalId: 'q1', planId: null, fill: { side: 'long' as const, size: 2, px: 140.5, pnl: -21 } },
    plan: null,
  }
  const cd = (p: Partial<DeskCooldownResponse> = {}): DeskCooldownResponse => ({ coins: [coinLock], all: null, stopOutsToday: 1, ...p })

  test('coarse time left: hours, minutes, never seconds', () => {
    expect(fmtTimeLeft('2026-11-17T14:00:00Z', now)).toBe('about 3h left')
    expect(fmtTimeLeft('2026-11-17T11:22:00Z', now)).toBe('about 40 min left')
    expect(fmtTimeLeft('2026-11-17T10:42:30Z', now)).toBe('less than a minute left')
    expect(fmtTimeLeft('2026-11-17T10:00:00Z', now)).toBe('ending now')
    expect(fmtTimeLeft('2026-11-17T14:41:00Z', now)).toBe('about 4h left')
  })

  test('until time in UTC, with the date when it is another day', () => {
    expect(fmtUntilUtc('2026-11-17T14:00:00Z', now)).toBe('14:00 UTC')
    expect(fmtUntilUtc('2026-11-18T02:30:00Z', now)).toBe('Nov 18 02:30 UTC')
  })

  test('global lock line', () => {
    expect(globalLockLine('2026-11-18T00:00:00.000Z', 2)).toBe('Two stop-outs today. New entries resume at 00:00 UTC.')
  })

  test('lockFor: the global lock first, then the coin (case-insensitive), expired locks ignored', () => {
    expect(lockFor(cd(), 'sol', now)).toMatchObject({ kind: 'coin', lock: { coin: 'SOL' } })
    expect(lockFor(cd(), 'BTC', now)).toBeNull()
    expect(lockFor(cd(), 'SOL', Date.parse('2026-11-17T14:00:01Z'))).toBeNull()
    expect(lockFor(cd({ all: { until: '2026-11-18T00:00:00Z', reason: 'x' } }), 'BTC', now)).toMatchObject({ kind: 'all' })
    expect(lockFor(null, 'SOL', now)).toBeNull()
  })

  test('the journal entry: the plan when linked, else the settled fill', () => {
    expect(stopOutEntry(coinLock)).toBe('Settled fill: long 2 SOL at 140.500, −$21.00.')
    const plan: DeskPlanRecord = {
      id: 'p', createdAt: '', source: 'plan', venue: 'paper', metrics: check().metrics, blockers: [], warnings: [], placed: true, placement: null,
      input: { coin: 'SOL', side: 'long', rungs: [{ px: 141, size: 2 }], stopPx: 135, targetPx: 160, note: 'breakout' },
    }
    expect(stopOutEntry({ ...coinLock, plan })).toBe('Plan: long SOL, 1 level from 141.000, stop 135.000, target 160.000. Note: breakout.')
  })
})
