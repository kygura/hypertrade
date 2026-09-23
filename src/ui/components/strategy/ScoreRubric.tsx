import { legendText, type LegendValue } from '../../../shared/strategy-protocol'
import { ProbBar } from './ProbBar'
import { fmtProb } from './format'

// ScoreRubric — a score answer on its rubric. The rubric is the ordered list
// of criteria (0..N-1); the score is a real number on that axis. Renders a
// track with a tick + legend text per bucket, a ▼ marker at the score's
// position, the score printed, the nearest legend's text, then one ProbBar
// per bucket. Legend values may be objects — `what` is rendered (PROTOCOL).

export function ScoreRubric({
  score,
  criteria,
  probabilities,
  legend,
}: {
  score: number
  criteria: string[]
  probabilities: Record<string, number>
  legend?: Record<string, LegendValue>
}) {
  const keys = criteria.length > 0 ? criteria.map((_, i) => String(i)) : Object.keys(probabilities).sort()
  const n = keys.length
  const labelFor = (i: number) => legendText(legend?.[keys[i]!]) || criteria[i] || keys[i]!
  const span = Math.max(1, n - 1)
  const clamped = Math.max(0, Math.min(span, score))
  const pos = (clamped / span) * 100
  const nearest = Math.round(clamped)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="label">SCORE</span>
        <span className="tabular text-text-primary text-[13px]">{fmtProb(score)}</span>
        <span className="text-text-secondary">/ {span}</span>
        <span className="text-text-muted">≈ {labelFor(nearest)}</span>
      </div>

      <div className="relative pt-3 pb-5">
        <span
          className="absolute top-0 text-[10px] leading-none text-info -translate-x-1/2"
          style={{ left: `${pos}%` }}
          aria-hidden="true"
        >
          ▼
        </span>
        <div className="relative h-px bg-border">
          {keys.map((k, i) => (
            <span
              key={k}
              className="absolute top-[-3px] w-px h-[7px] bg-text-secondary"
              style={{ left: `${(i / span) * 100}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="relative h-4">
          {keys.map((k, i) => (
            <span
              key={k}
              className={`absolute top-1 text-[10px] uppercase tracking-wider whitespace-nowrap ${
                i === nearest ? 'text-text-primary' : 'text-text-secondary'
              } ${i === 0 ? '' : i === n - 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
              style={{ left: `${(i / span) * 100}%` }}
            >
              {k} {labelFor(i)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {keys.map((k, i) => (
          <ProbBar key={k} label={`${k} ${labelFor(i)}`} p={probabilities[k] ?? 0} chosen={i === nearest} />
        ))}
      </div>
    </div>
  )
}
