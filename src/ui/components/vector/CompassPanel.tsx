import type { Lens, LensInput, VectorResponse } from '../../../shared/vector'
import { HowToRead, type Term } from '../HowToRead'
import { Sparkline } from '../Sparkline'
import { Caret } from './Caret'
import { LABEL, fmtDate, fmtDeltaPts, fmtInt, fmtRaw } from './format'
import { bandColor, bandIndex, INPUT_STALE_MS } from './scales'

// CompassPanel (hl-cycles DESIGN §14.4.4) — the headline compass score with a
// one-year sparkline, then one disclosure tile per lens: the four forward
// lenses on the band ramp, then the standalone ones in monochrome (they have
// no good/bad direction). Each tile opens to its inputs table.

export const COMPASS_TITLE = 'MARKET COMPASS · 7 LENSES · 4Y PERCENTILE'

const COMPASS_TERMS: readonly Term[] = [
  ['Lens', 'A group of related inputs scored together. Tap a lens to see its inputs.'],
  ['Score', '0 to 100. Each input is ranked against its own last 4 years (at least 1 year of data needed), flipped where needed so that high always points at the last band named for that lens, then averaged. A lens needs at least half of its inputs.'],
  ['Band', 'The word beside a score. Edges are fixed at 20, 40, 60 and 80; each lens has its own five words, low to high (Capital Flows: Drained, Light, Neutral, Healthy, Flush). The bar under a lens fills one segment per band.'],
  ['Headline', 'Mean of the four forward lenses: Macro, Capital Flows, Investor Behaviour and On-chain Fundamentals. Its bands, low to high: Risk-Off, Defensive, Neutral, Constructive, Risk-On. The line under it is the headline over the last 365 days.'],
  ['Standalone', 'Cycle Position, Derivatives and Rotation. They are left out of the headline and drawn without colour, because a high score there is a description (late cycle, heavy leverage, alts leading) rather than a better or worse reading.'],
  ['7d · 30d', 'Change in the score over 7 and 30 days, in score points.'],
  ['value', 'The input as measured, in its own unit.'],
  ['percentile', 'Where that value ranks in its own last 4 years: p80 is higher than 80% of them. This is before any flip. Rotation inputs are already shares of alts from 0 to 100 and are shown as they are.'],
  ['as of', 'Date of the input. Amber when it is more than 7 days older than the freshest input of the same lens.'],
  ['insufficient history', 'Fewer than half of the inputs have a year of data yet.'],
]

function fmtInput(i: LensInput): string {
  const v = fmtRaw(i.value)
  if (i.value == null) return v
  if (i.unit === 'pct') return v + '%'
  if (i.unit === 'usd') return '$' + v
  if (i.unit === 'btc') return v + ' BTC'
  return v
}

function Track({ score, color }: { score: number | null; color: string }) {
  const filled = score == null ? 0 : bandIndex(score)
  return (
    <span className="grid grid-cols-5 gap-0.5 w-full" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="h-1" style={{ background: i <= filled ? color : 'var(--color-border)' }} />
      ))}
    </span>
  )
}

function LensTile({ lens }: { lens: Lens }) {
  const has = lens.score != null
  const color = !has ? 'var(--color-text-secondary)' : lens.standalone ? 'var(--color-text-primary)' : bandColor(lens.score!)
  const trackColor = lens.standalone ? 'var(--color-text-secondary)' : color
  const freshest = Math.max(...lens.inputs.map((i) => i.asOf ?? -Infinity))
  return (
    <details className="group border-b border-border-subtle">
      <summary className="list-none cursor-pointer flex flex-col gap-1 px-3 py-[var(--cell-y)] min-h-[var(--tap-min)] hover:bg-hover">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-base text-text-primary flex-1 min-w-0 truncate">{lens.label}</span>
          <span className="text-base tabular" style={{ color }}>
            {has ? fmtInt(lens.score) : '—'}
          </span>
          <span className={`text-sm ${has ? 'text-text-muted' : 'text-text-secondary'}`}>{has ? (lens.band ?? '—') : 'insufficient history'}</span>
          <span className="text-xs text-text-secondary tabular">
            7d {fmtDeltaPts(lens.d7)} · 30d {fmtDeltaPts(lens.d30)}
          </span>
          <span className="text-xs text-text-secondary">
            <Caret />
          </span>
        </span>
        <Track score={lens.score} color={trackColor} />
      </summary>
      <div className="table-scroll px-3 pb-2">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="text-xs text-text-secondary text-left">
              <th className="font-normal py-1 pr-2">input</th>
              <th className="font-normal py-1 pr-2 text-right">value</th>
              <th className="font-normal py-1 pr-2 text-right" title="Where the value ranks in its own last 4 years (p80 = higher than 80% of them)">percentile</th>
              <th className="font-normal py-1 text-right">as of</th>
            </tr>
          </thead>
          <tbody>
            {lens.inputs.map((i) => (
              <tr key={i.key} className="border-t border-border-subtle">
                <td className="py-1 pr-2 text-text-muted">{i.label}</td>
                <td className="py-1 pr-2 text-right text-text-primary whitespace-nowrap">{fmtInput(i)}</td>
                <td className="py-1 pr-2 text-right text-text-primary">{i.pct == null ? '—' : `p${Math.round(i.pct)}`}</td>
                <td className={`py-1 text-right whitespace-nowrap ${i.asOf != null && freshest - i.asOf > INPUT_STALE_MS ? 'text-amber' : 'text-text-secondary'}`}>
                  {fmtDate(i.asOf)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export function CompassPanel({ compass }: { compass: VectorResponse['compass'] }) {
  const { headline } = compass
  const spark = compass.history
    .slice(-365)
    .map((h) => h.headline)
    .filter((v): v is number => v != null)
  const forward = compass.lenses.filter((l) => !l.standalone)
  const standalone = compass.lenses.filter((l) => l.standalone)

  return (
    <div className="flex flex-col">
      <HowToRead className="px-3 py-2 border-b border-border-subtle" terms={COMPASS_TERMS}>
        Seven groups of inputs, each scored 0 to 100 by where its inputs rank against their own last four years. Look for lenses sitting in
        an end band and for large 7-day or 30-day changes.
      </HowToRead>
      <div className="flex flex-col gap-1 p-3 border-b border-border-subtle">
        <span className={LABEL}>Compass · headline</span>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-lg tabular" style={{ color: headline.score == null ? 'var(--color-text-secondary)' : bandColor(headline.score) }}>
            {headline.score == null ? '—' : fmtInt(headline.score)}
          </span>
          <span className="text-base text-text-primary">{headline.score == null ? 'insufficient history' : (headline.band ?? '—')}</span>
          <span className="ml-auto text-xs text-text-secondary tabular">
            7d {fmtDeltaPts(headline.d7)} · 30d {fmtDeltaPts(headline.d30)}
          </span>
        </div>
        {spark.length < 2 ? (
          <span className="text-xs text-text-secondary">No headline history yet. The one-year line appears once two days of scores exist.</span>
        ) : (
          <div role="img" aria-label="Compass headline, last 365 days">
            <Sparkline points={spark} />
          </div>
        )}
      </div>
      {forward.map((l) => (
        <LensTile key={l.key} lens={l} />
      ))}
      {standalone.length > 0 && (
        <>
          <div className={`${LABEL} px-3 pt-3 pb-1 border-b border-border-subtle`}>Standalone · not in headline</div>
          {standalone.map((l) => (
            <LensTile key={l.key} lens={l} />
          ))}
        </>
      )}
    </div>
  )
}
