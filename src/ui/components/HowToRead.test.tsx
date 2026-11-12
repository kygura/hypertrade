import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HowToRead } from './HowToRead'

test('the lead sentence is always in the markup; terms sit behind a disclosure', () => {
  const html = renderToStaticMarkup(
    <HowToRead terms={[['z30', 'Distance from the 30-day mean, in standard deviations.']]}>Coins that moved more than usual today.</HowToRead>,
  )
  expect(html).toContain('Coins that moved more than usual today.')
  expect(html).toContain('<details')
  expect(html).toContain('<dt')
  expect(html).toContain('Distance from the 30-day mean')
})

test('no terms, no disclosure', () => {
  expect(renderToStaticMarkup(<HowToRead>Just the lead.</HowToRead>)).not.toContain('<details')
})
