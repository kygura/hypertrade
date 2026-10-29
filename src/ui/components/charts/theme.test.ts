import { describe, expect, test } from 'bun:test'
import { alpha } from './theme'

describe('alpha', () => {
  test.each([
    ['#ff8000', 0.5, 'rgba(255,128,0,0.5)'],
    ['rgb(10, 20, 30)', 0.5, 'rgba(10,20,30,0.5)'],
    ['rgba(10, 20, 30, 0.5)', 0.5, 'rgba(10,20,30,0.25)'],
    ['red', 0.5, 'red'],
  ])('%s at %d', (color, a, want) => {
    expect(alpha(color, a)).toBe(want)
  })
})
