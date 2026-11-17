import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DeskCooldownResponse, PlanCheck } from '../../../shared/deskPlan'
import { CooldownNotice } from './CooldownNotice'
import { PlanForm, PlanSummary } from './PlanForm'
import { planStatus } from './PlanJournal'

// SSR render checks (no DOM in this repo's tests); the logic is in lib/deskPlan.test.ts.
const noop = () => {}
const NOW = Date.parse('2026-11-17T10:42:00Z')
const fill = { side: 'long' as const, size: 2, px: 140.5, pnl: -21 }
const solLock = { coin: 'SOL', until: '2026-11-17T14:00:00Z', stopOutAt: '2026-11-17T10:00:00Z', ref: { source: 'paper' as const, proposalId: null, planId: null, fill }, plan: null }

const check: PlanCheck = {
  metrics: {
    totalSize: 0.03, notionalUsd: 1790, avgEntryPx: 59666.67, topRungPx: 60000, lossAtStopUsd: 50, lossAtStopPct: 0.5,
    rrFull: 2.6, rrTopOnly: 2, dailyLimitUsedPct: 25, drawdownUsedPct: 5, equityUsd: 10000, markPx: 60100,
  },
  blockers: ['paper fills one entry at the mark and cannot rest a 2-rung ladder'],
  warnings: ['if only the top rung (60000) fills, reward:risk is 2, under 2.5'],
}

describe('PlanForm', () => {
  test('closed: the calm empty state, no buy or sell button', () => {
    const html = renderToStaticMarkup(<PlanForm venue="paper" cooldown={null} onSubmitted={noop} />)
    expect(html).toContain('No plan open. Nothing to do.')
    expect(html).toContain('WRITE A PLAN')
    expect(html).not.toMatch(/>\s*(BUY|SELL)\s*</)
  })

  test('open: every field, and Place plan starts disabled', () => {
    const html = renderToStaticMarkup(<PlanForm venue="paper" cooldown={null} onSubmitted={noop} initialOpen />)
    for (const label of ['COIN', 'SIDE', 'PRICE', 'STOP', 'TARGET', 'NOTE (OPTIONAL)', 'ADD LEVEL', 'SAVE TO JOURNAL']) expect(html).toContain(label)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>PLACE PLAN<\/button>/)
    expect(html).toContain('write a coin')
  })

  test('a global lock replaces the form; no override', () => {
    const cd: DeskCooldownResponse = { coins: [solLock], all: { until: '2099-01-01T00:00:00Z', reason: '2 stop-outs today' }, stopOutsToday: 2 }
    const html = renderToStaticMarkup(<PlanForm venue="paper" cooldown={cd} onSubmitted={noop} initialOpen />)
    expect(html).toContain('Two stop-outs today. New entries resume at 00:00 UTC.')
    expect(html).not.toContain('PLACE PLAN')
    expect(html).not.toContain('WRITE A PLAN')
    expect(html).not.toMatch(/override/i)
  })
})

describe('PlanSummary', () => {
  test('numbers, blockers and warnings, plainly', () => {
    const html = renderToStaticMarkup(<PlanSummary check={check} stale={false} />)
    expect(html).toContain('Loss at stop')
    expect(html).toContain('$50.00 (0.5% of account)')
    expect(html).toContain('✕ paper fills one entry')
    expect(html).toContain('⚠ if only the top rung')
    expect(html).toContain('opacity-100')
  })

  test('a stale answer is dimmed, not hidden', () => {
    expect(renderToStaticMarkup(<PlanSummary check={check} stale />)).toContain('opacity-60')
  })
})

describe('CooldownNotice', () => {
  test('coin lock: absolute time, coarse time left, the journal entry; no seconds', () => {
    const html = renderToStaticMarkup(<CooldownNotice lock={{ kind: 'coin', lock: solLock }} cooldown={null} now={NOW} />)
    expect(html).toContain('They resume at 14:00 UTC.')
    expect(html).toContain('about 3h left')
    expect(html).toContain('Settled fill: long 2 SOL at 140.500')
    expect(html).not.toMatch(/\d+s left|seconds/)
    expect(html).not.toContain('<button')
  })
})

describe('planStatus', () => {
  test('placed, dry run, refused, blocked, saved', () => {
    const placement = { proposalId: 'x', status: 'executed' as const, error: null, dryRun: false, note: null }
    expect(planStatus({ placed: true, placement, blockers: [] }).label).toBe('PLACED')
    expect(planStatus({ placed: false, placement: { ...placement, dryRun: true }, blockers: [] }).label).toBe('DRY RUN')
    expect(planStatus({ placed: false, placement: { ...placement, status: 'failed' }, blockers: [] }).label).toBe('FAILED')
    expect(planStatus({ placed: false, placement: null, blockers: ['no stop'] }).label).toBe('BLOCKED')
    expect(planStatus({ placed: false, placement: null, blockers: [] }).label).toBe('SAVED')
  })
})
