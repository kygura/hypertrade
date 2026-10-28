import { describe, expect, test } from 'bun:test'
import { resolveSelection, toggleSelection } from './selection'

const sectors = [{ id: 'ai' }, { id: 'defi' }]
const narratives = [{ id: 'ai' }, { id: 'rwa' }]

describe('resolveSelection', () => {
  const cases: [string, string | null, { id: string } | null, { id: string } | null][] = [
    ['none selected', null, null, null],
    ['in both payloads', 'ai', { id: 'ai' }, { id: 'ai' }],
    ['only in /sectors', 'defi', { id: 'defi' }, null],
    ['only in narratives', 'rwa', null, { id: 'rwa' }],
    ['in neither', 'zzz', null, null],
  ]
  for (const [name, id, sector, narrative] of cases) {
    test(name, () => {
      expect(resolveSelection(id, sectors, narratives)).toEqual({ sector, narrative })
    })
  }
  test('payloads still loading', () => {
    expect(resolveSelection('ai', undefined, undefined)).toEqual({ sector: null, narrative: null })
  })
})

describe('toggleSelection', () => {
  test('selects, switches, clears', () => {
    expect(toggleSelection(null, 'ai')).toBe('ai')
    expect(toggleSelection('ai', 'defi')).toBe('defi')
    expect(toggleSelection('ai', 'ai')).toBeNull()
  })
})
