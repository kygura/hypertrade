import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { AskDrawer, AskDrawerView, type AskDrawerViewProps } from './AskDrawer'
import { offlineFrom } from '../analyst/useAnalystThread'
import { ApiError } from '../../lib/api'

// SSR render-checks (no jsdom): effects do not run, so the live status/queue reads are covered through the view.

const view = (over: Partial<AskDrawerViewProps> = {}): AskDrawerViewProps => ({
  onClose: () => {},
  coin: 'SOL',
  onDropChip: () => {},
  offline: null,
  onRetry: () => {},
  loading: false,
  catalog: null,
  choice: null,
  onPick: () => {},
  turns: [],
  busy: false,
  labelFor: (id) => id,
  draft: '',
  setDraft: () => {},
  onAsk: () => {},
  onStop: () => {},
  ready: true,
  ...over,
})

describe('AskDrawer', () => {
  test('closed renders nothing', () => {
    expect(renderToStaticMarkup(<AskDrawer open={false} onClose={() => {}} />)).toBe('')
  })

  test('open on /queue?coin=SOL renders the dialog, the SOL chip and the composer', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/queue?coin=SOL']}>
        <AskDrawer open onClose={() => {}} />
      </MemoryRouter>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('data-context-chip')
    expect(html).toContain('SOL')
    expect(html).toContain('<textarea')
    expect(html).toContain('OPEN FULL PAGE')
  })

  test('no chip off a coin screen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/branches']}>
        <AskDrawer open onClose={() => {}} />
      </MemoryRouter>,
    )
    expect(html).not.toContain('data-context-chip')
  })

  test('a 503 status reads ANALYST NOT CONFIGURED and the composer is disabled', () => {
    const offline = offlineFrom(new ApiError('not configured', 503))
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AskDrawerView {...view({ offline, ready: false })} />
      </MemoryRouter>,
    )
    expect(html).toContain('ANALYST NOT CONFIGURED')
    expect(html).toMatch(/<textarea[^>]*disabled/)
  })
})
