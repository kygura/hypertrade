import { describe, expect, test } from 'bun:test'

const src = require('node:fs').readFileSync(`${import.meta.dir}/App.tsx`, 'utf8') as string

// The parked MARKET-family pages keep their tab row (design §10.2).
describe('App routes', () => {
  test.each(['Sectors', 'State', 'Cycles'])('%s sits inside MarketLayout', (name) => {
    const re = new RegExp(`<MarketLayout>[\\s\\S]{0,120}<${name} />[\\s\\S]{0,80}</MarketLayout>`)
    expect(src).toMatch(re)
  })

  test('/ is the MARKET landing; /markets and /overview redirect to it', () => {
    expect(src).toMatch(/path="\/"\s+element=\{\s*<Shell>\s*<Market \/>/)
    expect(src).toContain(`<Route path="/markets" element={<Navigate to="/" replace />} />`)
    expect(src).toContain(`<Route path="/overview" element={<Navigate to="/" replace />} />`)
  })

  test('the coin page renders in the plain shell', () => {
    expect(src).toMatch(/path="\/markets\/:coin"\s+element=\{\s*<Shell>[\s\S]{0,80}<MarketDrill \/>/)
  })

  test('the Cockpit is parked at /feed; /asset/:coin lands on the coin page', () => {
    expect(src).toContain(`{ path: '/feed', Page: Cockpit }`)
    expect(src).not.toContain(`{ path: '/', Page: Cockpit }`)
    expect(src).toContain('<Route path="/asset/:coin" element={<AssetRedirect />} />')
    expect(src).toContain('<Navigate to={`/markets/${encodeURIComponent(coin)}`} replace />')
  })
})

// /desk is in the TRADE family: the tab row sits above it.
describe('App TRADE family', () => {
  test('Desk sits inside TradeLayout', () => {
    expect(src).toMatch(/<TradeLayout>[\s\S]{0,80}<Desk \/>[\s\S]{0,80}<\/TradeLayout>/)
  })
})
