import { AnimatedDigits } from '../AnimatedDigits'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { FiringBadge } from '../FiringBadge'
import { RuleText } from '../RuleText'
import {
  ddTone,
  fmtPct0,
  fmtPctSigned,
  holdoutGap,
  sharpeCell,
  sharpeOf,
  stabWord,
  verdictBadge,
  verdictOf,
  wireText,
  type DsrN,
  type MetricDef,
  type RuleEvaluation,
  type Sensitivity,
} from '../../lib/lab'
import { DirectionWord, DsrValue, SharpeValue, VerdictBadge } from './common'
import type { AtSearch } from './WindowStatsTable'

// RuleDrillHeader — DESIGN.md §10.9. The rule at lg; walk-forward Sharpe is
// the view's single xl value with holdout right beside it (rule 1) and the
// gap badge when due, then DSR; the server verdict Badge with its reasons
// listed; FIRING; direction/asset/horizon; the RAW wire text.
// Catalogued rules add the IN CATALOGUE stamp and the Danger REMOVE.
// The badge, DSR and holdout are the fresh evaluation's (server verdict, the
// search's N): the search-time walk-forward / DSR / verdict follow on their
// own AT SEARCH (AT SAVE) line. Until the fresh evaluation lands (or when it
// fails) the numbers shown are the search-time ones, labelled as such.

export function RuleDrillHeader({
  ev,
  metrics,
  sensitivity,
  savedAt,
  onRemove,
  dsrN,
  current,
  atSearch,
}: {
  ev: RuleEvaluation
  metrics: readonly MetricDef[]
  sensitivity: Sensitivity | null
  savedAt: string | null
  onRemove: () => void
  /** N context of `ev`'s deflated Sharpe. */
  dsrN: DsrN
  /** `ev` is the fresh evaluation; false = it is the search-time one (fresh loading or failed). */
  current: boolean
  /** Search-time numbers (their line shows only when `ev` is fresh; its label tags `ev` otherwise). */
  atSearch?: AtSearch | null
}) {
  const wf = sharpeCell(ev.walkForward)
  const verdict = verdictOf(ev)
  // No walk-forward → HIT and MAX DD print `—`, never the in-sample numbers in its place.
  const s = ev.walkForward
  const stab = sensitivity ? stabWord(sensitivity.stability) : null
  const stalePrefix = atSearch?.label ?? 'AT SEARCH'
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <h1 className="flex-1 min-w-[16ch] font-normal">
          <RuleText rule={ev.rule} metrics={metrics} size="lg" className="text-text-primary break-words" />
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {!current && <span className="text-xs text-text-secondary">{stalePrefix}</span>}
          <VerdictBadge ev={ev} />
          <FiringBadge firing={ev.firingNow} />
          <DirectionWord direction={ev.rule.direction} />
          <span>{ev.rule.asset.toUpperCase()}</span>
          <span>{ev.rule.horizonDays}D</span>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 tabular">
        {!current && (
          <span className="text-xs text-text-secondary" title="today's re-evaluation is loading or failed — these are the search-time numbers">
            {stalePrefix}
          </span>
        )}
        <span className="flex items-baseline gap-1.5" title={wf.title}>
          <span className={`text-xl ${wf.tone}`}>
            <AnimatedDigits text={wf.text} />
          </span>
          <span className="text-xs text-text-secondary">WF SHARPE</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-text-secondary">HOLDOUT</span>
          <SharpeValue stats={ev.holdout} className="text-base" />
          {holdoutGap(sharpeOf(ev.walkForward), sharpeOf(ev.holdout)) && <Badge tone="amber">HOLDOUT GAP</Badge>}
        </span>
        <span className="flex items-baseline gap-1.5 text-sm">
          <span className="text-xs text-text-secondary">DSR</span>
          <DsrValue ev={ev} n={dsrN.n} assumedOne={dsrN.assumedOne} />
        </span>
        <span className="flex items-baseline gap-1.5 text-sm" title={s == null ? 'not enough history' : undefined}>
          <span className="text-xs text-text-secondary">HIT</span>
          {fmtPct0(s?.hitRate)}
        </span>
        <span className="flex items-baseline gap-1.5 text-sm" title={s == null ? 'not enough history' : undefined}>
          <span className="text-xs text-text-secondary">MAX DD</span>
          <span className={ddTone(s?.maxDrawdown)}>{fmtPctSigned(s?.maxDrawdown)}</span>
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

      {current && atSearch && <AtSearchLine at={atSearch} />}

      {verdict && verdict.reasons.length > 0 && (
        <ul className="text-xs text-text-secondary flex flex-col gap-0.5" aria-label={`verdict ${verdictBadge(verdict.level).label}`}>
          {verdict.reasons.map((r) => (
            <li key={r} className="flex gap-1.5">
              <span aria-hidden="true">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

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

/** `AT SEARCH  WF +1.52 · DSR 0.93 · CANDIDATE`: the numbers the rule was found (or saved) with, secondary. */
function AtSearchLine({ at }: { at: AtSearch }) {
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary tabular"
      title={`${at.label === 'AT SAVE' ? 'save-time' : 'search-time'} walk-forward, deflated Sharpe and verdict; today's walk-forward is re-run on current data and can differ`}
    >
      <span>{at.label}</span>
      <span className="flex items-baseline gap-1">
        WF <SharpeValue stats={at.ev.walkForward} />
      </span>
      <span aria-hidden="true">·</span>
      <span className="flex items-baseline gap-1">
        DSR <DsrValue ev={at.ev} n={at.dsrN.n} assumedOne={at.dsrN.assumedOne} />
      </span>
      <VerdictBadge ev={at.ev} />
    </p>
  )
}
