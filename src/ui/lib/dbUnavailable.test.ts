import { describe, expect, test } from 'bun:test'
import { isDbUnavailable } from './dbUnavailable'

describe('isDbUnavailable', () => {
  test('matches the stated no-database reason only', () => {
    expect(isDbUnavailable('DATABASE_URL is not set — database queries are unavailable')).toBe(true)
    expect(isDbUnavailable('watches error')).toBe(false)
    expect(isDbUnavailable(null)).toBe(false)
  })
})
