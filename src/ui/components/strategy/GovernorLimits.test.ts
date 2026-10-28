import { describe, expect, test } from 'bun:test'
import { governorLimitErrors, type LimitForm } from './GovernorLimits'

const form = (over: Partial<LimitForm> = {}): LimitForm => ({ min_confidence: '0.5', max_notional_usd: '100', max_open_intents: '2', ...over })

describe('governorLimitErrors', () => {
  test.each([
    ['valid', form(), false, []],
    ['blank required', form({ min_confidence: ' ' }), false, ['min_confidence']],
    ['blank allowed', form({ min_confidence: '', max_notional_usd: '', max_open_intents: '' }), true, []],
    ['confidence > 1', form({ min_confidence: '1.5' }), true, ['min_confidence']],
    ['negative notional', form({ max_notional_usd: '-1' }), false, ['max_notional_usd']],
    ['fractional intents', form({ max_open_intents: '1.5' }), true, ['max_open_intents']],
    ['not a number', form({ max_notional_usd: 'abc' }), true, ['max_notional_usd']],
  ])('%s', (_n, f, allowBlank, keys) => {
    expect(Object.keys(governorLimitErrors(f, { allowBlank })).sort()).toEqual([...keys].sort())
  })
})
