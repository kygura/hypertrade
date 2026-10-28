import { describe, expect, test } from 'bun:test'

// Both drills of the MARKET family render under MarketTabs + MetricsStrip (design §10.2).
describe('App routes', () => {
  const src = require('node:fs').readFileSync(`${import.meta.dir}/App.tsx`, 'utf8') as string
  test.each(['Markets', 'Sectors', 'State', 'MarketDrill', 'Cycles'])('%s sits inside MarketLayout', (name) => {
    const re = new RegExp(`<MarketLayout>[\\s\\S]{0,120}<${name} />[\\s\\S]{0,80}</MarketLayout>`)
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
