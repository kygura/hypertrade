import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AsyncBody } from './state'

const render = (p: Partial<Parameters<typeof AsyncBody<string[]>>[0]>) =>
  renderToStaticMarkup(
    <AsyncBody<string[]> loading={false} data={null} error={null} {...p}>
      {(d) => <b>{d.join(',')}</b>}
    </AsyncBody>,
  )

describe('AsyncBody state order', () => {
  test('first load is a skeleton, even if an error or offline flag is stale', () => {
    const html = render({ loading: true, rows: 2 })
    expect(html).toContain('pulse-label')
    expect(html).not.toContain('<b>')
  })
  test('offline beats error; error shows verbatim with no data', () => {
    expect(render({ offline: true, error: 'x' })).toContain('API UNREACHABLE')
    expect(render({ offline: 'down hard' })).toContain('down hard')
    expect(render({ offline: true, offlineMessage: 'platform API unreachable' })).toContain('platform API unreachable')
    const html = render({ error: 'boom' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('boom')
  })
  test('settled with no data renders the EmptyBlock when asked, else nothing', () => {
    expect(render({})).toBe('')
    expect(render({ empty: { label: 'no brief yet' } })).toContain('no brief yet')
    expect(render({ loading: true, empty: { label: 'no brief yet' } })).not.toContain('no brief yet')
    expect(render({ error: 'boom', empty: { label: 'no brief yet' } })).not.toContain('no brief yet')
  })
  test('data wins over loading; a failed refetch keeps the data and shows the error above it', () => {
    expect(render({ loading: true, data: ['a'] })).toBe('<b>a</b>')
    const html = render({ data: ['a'], error: 'boom' })
    expect(html).toContain('<b>a</b>')
    expect(html).toContain('boom')
    expect(html.indexOf('<b>')).toBeGreaterThan(html.indexOf('boom'))
    expect(render({ data: ['a'], offline: true })).toContain('api unreachable')
    expect(render({ data: ['a'], offline: true, offlineMessage: 'platform down' })).toContain('platform down')
    expect(render({ data: ['a'], offline: true, staleError: false })).toBe('<b>a</b>')
    expect(render({ data: ['a'], error: 'boom', staleError: false })).toBe('<b>a</b>')
  })
  test('empty data renders the EmptyBlock only when asked', () => {
    expect(render({ data: [] })).toBe('<b></b>')
    const html = render({ data: [], empty: { label: 'nothing yet' } })
    expect(html).toContain('nothing yet')
    expect(html).not.toContain('<b>')
    expect(render({ data: ['a'], empty: { label: 'nothing yet' } })).toBe('<b>a</b>')
  })
})
