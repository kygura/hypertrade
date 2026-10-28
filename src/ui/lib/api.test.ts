import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { parseWith } from './api'

describe('parseWith', () => {
  const parse = parseWith(z.object({ a: z.object({ b: z.number() }) }), 'engine')
  test('returns parsed data', () => {
    expect(parse({ a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })
  test.each([
    [{ a: { b: 'x' } }, /^engine response mismatch: a\.b /],
    [null, /^engine response mismatch: <root> /],
  ])('mismatch names prefix and path: %p', (body, re) => {
    expect(() => parse(body)).toThrow(re)
  })
})
