import { describe, expect, test } from 'bun:test'
import type { DecisionRecord } from '../../../shared/strategy-protocol'
import { summarizeDecision } from './summarize'

const dec = (over: Record<string, unknown>) => ({ error: null, dry_run: false, intents: [], ...over }) as unknown as DecisionRecord
const intent = (action: string, market: string) => ({ action, market })

describe('summarizeDecision', () => {
  test.each([
    ['no decision', undefined, {}, '—', 'text-text-secondary'],
    ['no decision, fallback', undefined, { fallback: 'OPEN LONG BTC' }, 'OPEN LONG BTC', 'text-text-muted'],
    ['error', dec({ error: 'boom' }), {}, 'ERROR', 'text-red-text'],
    ['hold', dec({}), {}, 'HOLD', 'text-text-muted'],
    ['one intent', dec({ intents: [intent('open_long', 'BTC')] }), {}, 'OPEN LONG BTC', 'text-green'],
    ['extra intents', dec({ intents: [intent('open_short', 'ETH'), intent('close', 'BTC')] }), {}, 'OPEN SHORT ETH +1', 'text-red-text'],
    ['dry flag shown only when asked', dec({ dry_run: true, intents: [intent('close', 'BTC')] }), { dry: true }, 'CLOSE BTC (DRY)', 'text-text-muted'],
    ['dry flag omitted by default', dec({ dry_run: true, intents: [intent('close', 'BTC')] }), {}, 'CLOSE BTC', 'text-text-muted'],
  ])('%s', (_n, d, opts, text, className) => {
    expect(summarizeDecision(d, opts)).toEqual({ text, className })
  })
})
