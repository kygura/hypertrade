import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Quiet motion (the calm desk): nothing blinks, flashes or loops, and every
// animation or transition is at least 300 ms. Scans every CSS and TSX source
// under src/ui (tests excluded) so a regression anywhere fails here.

const ROOT = join(import.meta.dir)
const MIN_MS = 300

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(css|tsx)$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p)
  }
  return out
}

const SOURCES = files(ROOT).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }))

/** Drops block and line comments so prose about motion never trips the scan. */
function stripComments(text: string, css: boolean): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return css ? noBlock : noBlock.replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Every time value in a CSS value list, in ms. */
function timesMs(value: string): number[] {
  return [...value.matchAll(/(?<![\w-])(\d*\.?\d+)(ms|s)\b/g)].map(([, n, u]) => Number(n) * (u === 's' ? 1000 : 1))
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

interface Hit {
  where: string
  what: string
}

function scan(): { infinite: Hit[]; tailwindLoops: Hit[]; short: Hit[]; sounds: Hit[] } {
  const infinite: Hit[] = []
  const tailwindLoops: Hit[] = []
  const short: Hit[] = []
  const sounds: Hit[] = []
  for (const { path, text } of SOURCES) {
    const css = path.endsWith('.css')
    const src = stripComments(text, css)

    for (const m of src.matchAll(/\binfinite\b/g)) infinite.push({ where: `${path}:${lineOf(src, m.index!)}`, what: 'infinite' })
    for (const m of src.matchAll(/\banimate-(pulse|ping|bounce|spin)\b/g)) tailwindLoops.push({ where: `${path}:${lineOf(src, m.index!)}`, what: m[0] })
    for (const m of src.matchAll(/new Audio\(|<audio\b|AudioContext/g)) sounds.push({ where: `${path}:${lineOf(src, m.index!)}`, what: m[0] })

    if (css) {
      // animation / transition declarations (shorthand or -duration/-delay), possibly spanning lines.
      for (const m of src.matchAll(/(?<![\w-])(animation|transition)(-duration|-delay)?\s*:\s*([^;{}]+);/g)) {
        for (const ms of timesMs(m[3]!)) if (ms > 0 && ms < MIN_MS) short.push({ where: `${path}:${lineOf(src, m.index!)}`, what: `${m[1]}${m[2] ?? ''} ${ms}ms` })
      }
    } else {
      // Tailwind: duration-N below the floor, and a transition utility without an explicit
      // duration (Tailwind's default is 150 ms).
      for (const m of src.matchAll(/(?<![\w-])duration-(\d+)\b/g)) {
        if (Number(m[1]) < MIN_MS) short.push({ where: `${path}:${lineOf(src, m.index!)}`, what: m[0] })
      }
      for (const m of src.matchAll(/(?<![\w-])transition(?:-(?:colors|opacity|all|transform|shadow|\[[^\]]+\]))?(?=[\s'"`}])/g)) {
        const line = src.split('\n')[lineOf(src, m.index!) - 1]!
        if (!/(?<![\w-])duration-\d+/.test(line)) short.push({ where: `${path}:${lineOf(src, m.index!)}`, what: `${m[0]} without duration-N (defaults to 150ms)` })
      }
      // Inline styles: style={{ transition: '...' }} / animationDuration etc.
      for (const m of src.matchAll(/\b(transition|animation)(Duration|Delay)?\s*:\s*['"`]([^'"`]+)['"`]/g)) {
        for (const ms of timesMs(m[3]!)) if (ms > 0 && ms < MIN_MS) short.push({ where: `${path}:${lineOf(src, m.index!)}`, what: `${m[1]} ${ms}ms` })
      }
    }
  }
  return { infinite, tailwindLoops, short, sounds }
}

describe('quiet motion', () => {
  const found = scan()

  test('the scan sees the stylesheet and components', () => {
    expect(SOURCES.some((s) => s.path === 'index.css')).toBe(true)
    expect(SOURCES.some((s) => s.path.startsWith('themes/'))).toBe(true)
    expect(SOURCES.filter((s) => s.path.endsWith('.tsx')).length).toBeGreaterThan(50)
  })

  test('no infinite animations anywhere', () => {
    expect(found.infinite).toEqual([])
  })

  test('no looping Tailwind animations (pulse, ping, bounce, spin)', () => {
    expect(found.tailwindLoops).toEqual([])
  })

  test(`no animation or transition shorter than ${MIN_MS} ms`, () => {
    expect(found.short).toEqual([])
  })

  test('no sounds', () => {
    expect(found.sounds).toEqual([])
  })

  test('the scanner itself catches what it must', () => {
    expect(timesMs('color 150ms cubic-bezier(0.4, 0, 0.2, 1), opacity .2s')).toEqual([150, 200])
    expect(timesMs('busy-settle 600ms ease-out 1 both')).toEqual([600])
    expect(stripComments('a /* infinite */ b', true)).not.toContain('infinite')
  })
})
