import { describe, expect, test } from 'bun:test'
import { patchQuery } from './hooks'

describe('patchQuery', () => {
  test.each([
    ['sets a key', 'a=1', { b: '2' }, 'a=1&b=2'],
    ['overwrites a key', 'a=1', { a: '9' }, 'a=9'],
    ['null deletes', 'a=1&b=2', { a: null }, 'b=2'],
    ['empty string deletes', 'a=1&b=2', { b: '' }, 'a=1'],
    ['deleting a missing key is a no-op', 'a=1', { z: null }, 'a=1'],
  ])('%s', (_name, start, patch, want) => {
    expect(patchQuery(new URLSearchParams(start), patch).toString()).toBe(want)
  })

  test('does not mutate the input', () => {
    const prev = new URLSearchParams('a=1')
    patchQuery(prev, { a: null })
    expect(prev.toString()).toBe('a=1')
  })
})
