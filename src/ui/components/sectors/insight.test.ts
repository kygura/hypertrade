import { describe, expect, test } from 'bun:test'
import type { NarrativeHtf, NarrativeStage } from '../../../shared/intel'
import { mindshareInsight, narrativesInsight } from './insight'

const htf = (relBtc7d: number | null): NarrativeHtf => ({ pricePct7d: null, pricePct30d: null, relBtc7d, relBtc30d: null, oiPct7d: null, oiPct30d: null, funding: null, fundingZ: null })
const row = (label: string, stage: NarrativeStage, rel: number | null) => ({ label, stage, htf: htf(rel) })

describe('narrativesInsight', () => {
  test('stage counts in a fixed order, then the widest 7-day gap to BTC by size', () => {
    const rows = [row('AI', 'expanding', 6.2), row('Memes', 'fading', -14.25), row('L2', 'quiet', null), row('DeFi', 'quiet', 0.4), row('RWA', 'crowded', 3)]
    expect(narrativesInsight(rows)).toBe('5 narratives by stage: 1 crowded, 1 expanding, 1 fading, 2 quiet; widest 7-day gap to BTC is Memes at −14.3pp.')
  })
  test('no 7-day numbers: counts only; no rows: null', () => {
    expect(narrativesInsight([row('AI', 'unknown', null)])).toBe('1 narrative by stage: 1 unknown.')
    expect(narrativesInsight([])).toBeNull()
  })
})

describe('mindshareInsight', () => {
  test('top mindshare and momentum counts at the ±0.15 edge', () => {
    const s = (label: string, mindshare_score: number, momentum: number) => ({ label, mindshare_score, momentum })
    expect(mindshareInsight([s('AI', 0.31, 0.5), s('Memes', 0.12, -0.15), s('L2', 0.05, 0.1), s('DeFi', 0.2, 0.15)])).toBe(
      'The routine scored 4 sectors: highest mindshare is AI at 0.31; momentum is +0.15 or more on 2 and −0.15 or less on 1.',
    )
    expect(mindshareInsight([])).toBeNull()
  })
})
