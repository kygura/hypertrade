import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PNL_PLACEHOLDER, REVEAL_INITIAL, RevealPnl, revealReducer, type RevealEvent, type RevealState } from './RevealPnl'

// Render-check (react-dom/server, no jsdom) plus the pure reveal state machine:
// SSR can't dispatch events, so the reducer carries the behaviour.

const run = (events: RevealEvent[], from: RevealState = REVEAL_INITIAL) => events.reduce(revealReducer, from)

describe('RevealPnl markup', () => {
  test('hidden by default: placeholder only, the value is not in the markup', () => {
    const html = renderToStaticMarkup(<RevealPnl value="+$412.50" label="day P&L" />)
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="day P&amp;L hidden, press to show for 4 seconds"')
    expect(html).toContain(PNL_PLACEHOLDER)
    expect(html).not.toContain('412.50')
  })

  test('revealed: value with the caller tone, accessible name carries it', () => {
    const shown = run(['activate'])
    const html = renderToStaticMarkup(<RevealPnl value="+$412.50" label="day P&L" className="text-green" initial={shown} />)
    expect(html).toContain('+$412.50')
    expect(html).toContain('text-green')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="day P&amp;L +$412.50"')
  })

  test('no motion shorter than 300 ms', () => {
    const html = renderToStaticMarkup(<RevealPnl value="$1" label="x" />)
    expect(html).toContain('duration-300')
    expect(html).not.toMatch(/duration-(?:[0-9]|[1-2][0-9]{2})\b/)
  })
})

describe('revealReducer', () => {
  test('click/Enter/Space reveals, the timer hides it again', () => {
    expect(run(['activate']).shown).toBe(true)
    expect(run(['activate', 'expire']).shown).toBe(false)
  })

  test('a second activation hides at once', () => {
    expect(run(['activate', 'activate']).shown).toBe(false)
  })

  test('every reveal restarts the timer (seq bumps)', () => {
    const a = run(['activate'])
    const b = run(['activate', 'expire', 'activate'])
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(b.shown).toBe(true)
    expect(b.expired).toBe(false)
  })

  test('hover reveals; the value stays while the mouse is over it and hides on leave after the timer', () => {
    const over = run(['enter', 'expire'])
    expect(over.shown).toBe(true)
    expect(run(['enter', 'expire', 'leave']).shown).toBe(false)
  })

  test('leaving before the timer keeps it until the timer runs out', () => {
    const left = run(['enter', 'leave'])
    expect(left.shown).toBe(true)
    expect(run(['enter', 'leave', 'expire']).shown).toBe(false)
  })

  test('hovering an already revealed value does not restart its timer', () => {
    const a = run(['activate'])
    expect(revealReducer(a, 'enter').seq).toBe(a.seq)
  })
})
