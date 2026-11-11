import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { consumeRedirectTarget, parseWith, REDIRECT_KEY, rememberReturnPath, safeReturnPath } from './api'

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

describe('login return path', () => {
  const store = new Map<string, string>()
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  test('keeps the query: /feed?id=… and /lab/study?rule=… survive the login bounce', () => {
    rememberReturnPath({ pathname: '/feed', search: '?id=abc&status=ready' })
    expect(sessionStorage.getItem(REDIRECT_KEY)).toBe('/feed?id=abc&status=ready')
    expect(consumeRedirectTarget()).toBe('/feed?id=abc&status=ready')
    expect(consumeRedirectTarget()).toBe('/queue')
  })
  test('only same-origin app paths are returned to', () => {
    expect(safeReturnPath('/lab/study?rule=%7B%7D')).toBe('/lab/study?rule=%7B%7D')
    for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', null]) expect(safeReturnPath(bad)).toBeNull()
    sessionStorage.setItem(REDIRECT_KEY, '//evil.example')
    expect(consumeRedirectTarget('/')).toBe('/')
  })
})
