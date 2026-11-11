import { describe, expect, test } from 'bun:test'

// The MARKET family pages render under MarketTabs + MetricsStrip (design §10.2); QUEUE and the coin page keep the
// tabs but never the strip: nothing above the content that is not the content.
describe('App routes', () => {
  const src = require('node:fs').readFileSync(`${import.meta.dir}/App.tsx`, 'utf8') as string
  test.each(['Markets', 'Sectors', 'State', 'Cycles'])('%s sits inside MarketLayout with the strip', (name) => {
    const re = new RegExp(`<MarketLayout>[\\s\\S]{0,120}<${name} />[\\s\\S]{0,80}</MarketLayout>`)
    expect(src).toMatch(re)
  })
  test.each(['Queue', 'CoinPage'])('%s sits inside MarketLayout without the strip', (name) => {
    const re = new RegExp(`<MarketLayout metrics=\\{false\\}>[\\s\\S]{0,120}<${name} />[\\s\\S]{0,80}</MarketLayout>`)
    expect(src).toMatch(re)
  })
})

// /desk is in the TRADE family: the tab row sits above it.
describe('App TRADE family', () => {
  const src = require('node:fs').readFileSync(`${import.meta.dir}/App.tsx`, 'utf8') as string
  test('Desk sits inside TradeLayout', () => {
    expect(src).toMatch(/<TradeLayout>[\s\S]{0,80}<Desk \/>[\s\S]{0,80}<\/TradeLayout>/)
  })
})
