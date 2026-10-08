import { AnimatedDigits } from '../AnimatedDigits'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { FiringBadge } from '../FiringBadge'
import { RuleText } from '../RuleText'
import { ddTone, fmtPct0, fmtPctSigned, fmtSigned, holdoutGap, signTone, stabWord, wireText, type MetricDef, type RuleEvaluation, type Sensitivity } from '../../lib/lab'
import { DirectionWord } from './common'

// RuleDrillHeader — DESIGN.md §10.9. The rule at lg; walk-forward Sharpe is
// the view's single xl value with holdout right beside it (rule 1) and the
// gap badge when due; FIRING; direction/asset/horizon; the RAW wire text.
// Catalogued rules add the IN CATALOGUE stamp and the Danger REMOVE.

export function RuleDrillHeader({
  ev,
  metrics,
  sensitivity,
  savedAt,
  onRemove,
}: {
  ev: RuleEvaluation
  metrics: readonly MetricDef[]
  sensitivity: Sensitivity | null
  savedAt: string | null
  onRemove: () => void
}) {
  const wf = ev.walkForward?.sharpe ?? null
  const ho = ev.holdout?.sharpe ?? null
  const s = ev.walkForward ?? ev.inSample
  const stab = sensitivity ? stabWord(sensitivity.stability) : null
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <h1 className="flex-1 min-w-[16ch] font-normal">
          <RuleText rule={ev.rule} metrics={metrics} size="lg" className="text-text-primary break-words" />
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <FiringBadge firing={ev.firingNow} />
          <DirectionWord direction={ev.rule.direction} />
          <span>{ev.rule.asset.toUpperCase()}</span>
          <span>{ev.rule.horizonDays}D</span>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 tabular">
        <span className="flex items-baseline gap-1.5" title={wf == null ? 'not enough history' : undefined}>
          <span className={`text-xl ${signTone(wf)}`}>
            <AnimatedDigits text={fmtSigned(wf)} />
          </span>
          <span className="text-xs text-text-secondary">WF SHARPE</span>
        </span>
        <span className="flex items-center gap-1.5" title={ho == null ? 'not enough history' : undefined}>
          <span className="text-xs text-text-secondary">HOLDOUT</span>
          <span className={`text-base ${signTone(ho)}`}>{fmtSigned(ho)}</span>
          {holdoutGap(wf, ho) && <Badge tone="amber">HOLDOUT GAP</Badge>}
        </span>
        <span className="flex items-baseline gap-1.5 text-sm">
          <span className="text-xs text-text-secondary">HIT</span>
          {fmtPct0(s.hitRate)}
        </span>
        <span className="flex items-baseline gap-1.5 text-sm">
          <span className="text-xs text-text-secondary">MAX DD</span>
          <span className={ddTone(s.maxDrawdown)}>{fmtPctSigned(s.maxDrawdown)}</span>
        </span>
        <span className="flex items-baseline gap-1.5 text-sm">
          <span className="text-xs text-text-secondary">STAB</span>
          {stab && sensitivity ? (
            <>
              {sensitivity.stability.toFixed(2)} <span className={stab.tone}>{stab.word}</span>
            </>
          ) : (
            '—'
          )}
        </span>
      </div>

      <p className="text-xs text-text-secondary tabular break-all">RAW {wireText(ev.rule)}</p>

      {savedAt && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">IN CATALOGUE · SAVED {savedAt.slice(0, 10)}</Badge>
          <Button tier="danger" onClick={onRemove}>
            REMOVE
          </Button>
        </div>
      )}
    </div>
  )
}
