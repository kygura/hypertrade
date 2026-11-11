import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { QueueResponse } from '../../../shared/queue'
import type { Feed } from '../moves/MovesView'
import { record } from '../moves/fixtures'
import { item, NOW, queueResponse, setupPart } from './fixtures'
import { QueueView, type QueueViewProps } from './QueueView'

// Render-checks (react-dom/server, no jsdom), the moves/render.test.tsx approach: the list is the page, a source
// problem is one quiet line, an empty queue is one calm line, handled items sit in a collapsed group, and nothing
// on the list approves or orders.

const noop = () => {}
const feed = (data: QueueResponse | null, over: Partial<Feed<QueueResponse>> = {}): Feed<QueueResponse> => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over })
const props = (q: Feed<QueueResponse>, over: Partial<QueueViewProps> = {}): QueueViewProps => ({
  queue: q, selected: null, onRow: noop, onDismiss: noop, pending: [], error: null, handledOpen: false, onHandled: noop, pane: false, now: NOW, ...over,
})
const html = (p: QueueViewProps) => renderToStaticMarkup(<MemoryRouter>{<QueueView {...p} />}</MemoryRouter>)

describe('QueueView', () => {
  test('items: header line, chips, rows with parts, side, age, record chip and DISMISS; no approve or order', () => {
    const q = queueResponse({
      overCap: 2,
      items: [
        item('SOL', { parts: [item('SOL').parts[0]!, setupPart('SOL')], record: record({ coin: 'SOL' }) }),
        item('WIF', { reason: 'FADE 3/3 · crowd long 3/4', firstAt: '2026-11-11T12:20:00.000Z' }),
      ],
    })
    const out = html(props(feed(q), { selected: 'SOL' }))
    expect(out).toContain('QUEUE · 2 listed of 8 · 2 weaker over cap')
    expect(out).toContain('MOVES·SETUP')
    expect(out).toContain('FADE 3/3 · crowd long 3/4')
    expect(out).toContain('14m')
    expect(out).toContain('2h')
    expect(out).toContain('OPEN record')
    expect(out).toContain('agents 2/6 today')
    expect(out.match(/DISMISS/g)).toHaveLength(2)
    expect(out).toContain('aria-selected="true"')
    expect(out).not.toMatch(/APPROVE|ORDER/)
    expect(out).not.toContain('aria-label="selected coin"') // no pane on a phone
  })

  test('empty: one calm line with the watched count, no panels stacked before it', () => {
    const out = html(props(feed(queueResponse({ watched: 38 }))))
    expect(out).toContain('nothing crossed the bar today · 38 coins watched')
    expect(out).not.toContain('DISMISS')
    expect(out).not.toContain('dismissed / acted')
  })

  test('empty with no scan (watched 0): the bare line, no count', () => {
    const out = html(props(feed(queueResponse({ watched: 0 }))))
    expect(out).toContain('nothing crossed the bar today')
    expect(out).not.toContain('coins watched')
  })

  test('an unavailable source is a chip with its reason and one quiet line, not a card', () => {
    const q = queueResponse({ sources: { moves: { state: 'unavailable', reason: 'needs the always-on server; or run `bun start`', count: 0 }, opportunity: { state: 'ok', reason: null, count: 0 }, radar: { state: 'unavailable', reason: 'sign in required', count: 0 } } })
    const out = html(props(feed(q)))
    expect(out).toContain('data-source="moves" data-state="off"')
    expect(out).toContain('title="sign in required"')
    expect(out).toContain('MOVES off: needs the always-on server; or run `bun start` · RADAR off: sign in required')
    expect(out).toContain('nothing crossed the bar today')
  })

  test('handled items are collapsed by default and listed when opened; they carry no DISMISS', () => {
    const q = queueResponse({ items: [item('SOL'), item('WIF', { state: 'acted' }), item('ETH', { state: 'dismissed', dismissedAt: '2026-11-11T14:15:00.000Z' })] })
    const closed = html(props(feed(q)))
    expect(closed).toContain('▸ dismissed / acted (2)')
    expect(closed).not.toContain('data-coin="WIF"')
    const opened = html(props(feed(q), { handledOpen: true }))
    expect(opened).toContain('▾ dismissed / acted (2)')
    expect(opened).toContain('data-coin="WIF" data-state="acted"')
    expect(opened).toContain('data-coin="ETH" data-state="dismissed"')
    expect(opened.match(/DISMISS</g)).toHaveLength(1)
  })

  test('a failed dismiss shows its words on the row', () => {
    const out = html(props(feed(queueResponse({ items: [item('SOL')] })), { error: { id: '2026-11-11:SOL', message: 'api unreachable' } }))
    expect(out).toContain('role="alert"')
    expect(out).toContain('api unreachable')
  })

  test('loading: skeleton rows, no items', () => {
    const out = html(props(feed(null, { loading: true })))
    expect(out).toContain('QUEUE')
    expect(out).not.toContain('nothing crossed the bar')
  })
})
